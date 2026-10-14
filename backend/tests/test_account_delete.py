"""Account deletion (logbook PR 6). Hermetic: Supabase is the in-memory fake in fake_supabase.py,
and every value is a dummy.

Stage 1: the storage sweep of "<uid>/", which must remove every object in the user's folder,
including orphans that no row lists, and never anything outside it.
"""

import json
import logging
import uuid

import httpx
import pytest

from app.services import logbook
from app.services.errors import AnalysisError

from fake_supabase import BUCKET, SECRET, USER_A, USER_B, FakeSupabase, assert_scoped, settings


@pytest.fixture
def fake(monkeypatch):
    supabase = FakeSupabase()
    monkeypatch.setattr(logbook, "_transport", httpx.MockTransport(supabase))
    monkeypatch.setattr(logbook, "_wait", supabase.waits.append)
    return supabase


def populate(fake, user_id):
    """A saved experiment, a draft, an orphan folder, a stray top-level file and a nested folder."""
    for experiment_id in (fake.add_saved(user_id), fake.add_draft(user_id)):
        fake.store_objects(experiment_id)
    orphan = uuid.uuid4()
    for key in (f"{user_id}/{orphan}/image.jpg", f"{user_id}/{orphan}/thumb.jpg",
                f"{user_id}/stray.jpg", f"{user_id}/a/b/deep.jpg"):
        fake.objects[key] = b"stored"


def owned(fake, user_id):
    return {key: value for key, value in fake.objects.items() if key.startswith(f"{user_id}/")}


def sweep():
    return logbook._sweep_user_objects(USER_A, settings())


def deletes(fake):
    return fake.by("DELETE", f"/storage/v1/object/{BUCKET}")


def json_body(request):
    return json.loads(request.content)


def lists(fake):
    return fake.by("POST", f"/storage/v1/object/list/{BUCKET}")


def test_sweep_deletes_everything_in_the_users_folder_and_nothing_else(fake):
    populate(fake, USER_A)
    populate(fake, USER_B)
    rows = {key: dict(row) for key, row in fake.rows.items()}
    others = owned(fake, USER_B)
    expected = len(owned(fake, USER_A))

    assert sweep() == (expected, 2)  # Round 1 deletes, round 2 lists the folder empty.

    assert owned(fake, USER_A) == {}
    assert owned(fake, USER_B) == others
    assert fake.rows == rows  # The sweep touches storage only.
    assert_scoped(fake.requests, USER_A, USER_B)
    assert all(request.headers["apikey"] == SECRET and "authorization" not in request.headers
               for request in fake.requests)


def test_sweep_of_an_empty_folder_lists_once_and_deletes_nothing(fake):
    populate(fake, USER_B)
    assert sweep() == (0, 1)
    assert len(lists(fake)) == 1 and deletes(fake) == []


def test_repeat_sweep_is_a_no_op(fake):
    populate(fake, USER_A)
    sweep()
    fake.requests.clear()
    assert sweep() == (0, 1)
    assert deletes(fake) == []


def test_sweep_pages_through_large_folders(fake):
    for _ in range(250):
        folder = uuid.uuid4()
        fake.objects[f"{USER_A}/{folder}/image.jpg"] = b"x"
        fake.objects[f"{USER_A}/{folder}/thumb.jpg"] = b"x"
    for index in range(150):
        fake.objects[f"{USER_A}/big/{index:03}.jpg"] = b"x"
    populate(fake, USER_B)
    others = owned(fake, USER_B)

    deleted, rounds = sweep()

    assert deleted == 650 and owned(fake, USER_A) == {}
    assert 2 < rounds <= logbook.SWEEP_MAX_ROUNDS
    assert owned(fake, USER_B) == others
    assert all(len(json_body(request)["prefixes"]) <= logbook.SWEEP_DELETE_BATCH for request in deletes(fake))
    assert all(json_body(request)["offset"] == 0 and json_body(request)["limit"] == logbook.SWEEP_PAGE
               for request in lists(fake))
    assert_scoped(fake.requests, USER_A, USER_B)


def test_objects_uploaded_during_the_sweep_are_found_by_the_next_round(fake):
    populate(fake, USER_A)
    late = f"{USER_A}/{uuid.uuid4()}/image.jpg"
    fake.hooks["delete"] = lambda: fake.objects.__setitem__(late, b"late")  # A create still running.
    deleted, rounds = sweep()
    assert owned(fake, USER_A) == {}
    assert rounds == 3


@pytest.mark.parametrize("entry", [
    {"name": "a/b", "id": "file"},
    {"name": f"../{USER_B}", "id": None},
    {"name": "..", "id": None},
    {"name": ".", "id": "file"},
    {"name": "", "id": "file"},
    {"name": None, "id": "file"},
    {"id": "file"},
    "not-an-object",
])
def test_hostile_listing_entry_is_refused_before_any_delete(fake, caplog, entry):
    populate(fake, USER_A)
    populate(fake, USER_B)
    before = dict(fake.objects)
    fake.list_extra_objects = [entry]
    with caplog.at_level(logging.WARNING, logger="app"), pytest.raises(AnalysisError) as raised:
        sweep()
    assert raised.value.status_code == 503
    assert deletes(fake) == [] and fake.objects == before
    assert "op=list_objects status=bad_name" in caplog.text
    assert_logs_clean(caplog)


@pytest.mark.parametrize("body", [b'{"error": "nope"}', b"not json", b"null"])
def test_malformed_listing_is_503(fake, body):
    populate(fake, USER_A)
    fake.list_objects_body = body
    with pytest.raises(AnalysisError) as raised:
        sweep()
    assert raised.value.status_code == 503 and deletes(fake) == []


def test_listing_longer_than_a_page_is_503(fake):
    fake.list_extra_objects = [{"name": f"f{index}", "id": "file"} for index in range(logbook.SWEEP_PAGE + 1)]
    with pytest.raises(AnalysisError):
        sweep()
    assert deletes(fake) == []


def test_delete_that_does_not_take_stops_with_no_progress(fake, caplog):
    populate(fake, USER_A)
    fake.delete_noop = True
    with caplog.at_level(logging.WARNING, logger="app"), pytest.raises(AnalysisError) as raised:
        sweep()
    assert raised.value.status_code == 503
    assert "op=sweep status=no_progress" in caplog.text
    assert len(deletes(fake)) == 1  # Bounded: one delete, then the re-list finds nothing new.
    assert_logs_clean(caplog)


@pytest.mark.parametrize("failure", [500, "transport"])
@pytest.mark.parametrize("op", ["list_objects", "delete"])
def test_failed_step_is_503_and_a_retry_finishes(fake, op, failure):
    populate(fake, USER_A)
    populate(fake, USER_B)
    others = owned(fake, USER_B)
    fake.fail[op] = failure
    with pytest.raises(AnalysisError) as raised:
        sweep()
    assert raised.value.status_code == 503

    fake.fail.clear()
    sweep()
    assert owned(fake, USER_A) == {} and owned(fake, USER_B) == others


def test_failure_after_a_partial_round_resumes_on_retry(fake):
    populate(fake, USER_A)
    fake.hooks["delete"] = lambda: fake.fail.__setitem__("list_objects", "transport")
    with pytest.raises(AnalysisError):
        sweep()
    fake.fail.clear()
    deleted, _ = sweep()
    assert deleted == 0 and owned(fake, USER_A) == {}  # The first attempt's delete had already run.


def test_nesting_up_to_the_depth_limit_is_swept(fake):
    fake.objects[f"{USER_A}/a/b/c/file.jpg"] = b"x"
    sweep()
    assert owned(fake, USER_A) == {}


def test_nesting_beyond_the_depth_limit_is_503(fake, caplog):
    fake.objects[f"{USER_A}/a/b/c/d/file.jpg"] = b"x"
    with caplog.at_level(logging.WARNING, logger="app"), pytest.raises(AnalysisError):
        sweep()
    assert "op=sweep status=too_deep" in caplog.text


def test_time_budget_is_enforced(fake, monkeypatch, caplog):
    populate(fake, USER_A)
    monkeypatch.setattr(logbook, "SWEEP_BUDGET_SECONDS", -1)
    with caplog.at_level(logging.WARNING, logger="app"), pytest.raises(AnalysisError):
        sweep()
    assert fake.requests == []
    assert "op=sweep status=budget" in caplog.text


def test_round_limit_is_enforced_and_a_retry_confirms_empty(fake, monkeypatch, caplog):
    populate(fake, USER_A)
    monkeypatch.setattr(logbook, "SWEEP_MAX_ROUNDS", 1)
    with caplog.at_level(logging.WARNING, logger="app"), pytest.raises(AnalysisError):
        sweep()
    assert "op=sweep status=rounds" in caplog.text
    assert logbook._sweep_user_objects(USER_A, settings()) == (0, 1)


@pytest.mark.parametrize("user_id", ["", "A", USER_A.upper(), f"{USER_A}/..", f" {USER_A}", None])
def test_non_canonical_user_id_is_refused_before_any_request(fake, user_id):
    with pytest.raises(ValueError):
        logbook._sweep_user_objects(user_id, settings())
    assert fake.requests == []


def assert_logs_clean(caplog):
    for secret in (USER_A, USER_B, SECRET, "stray.jpg", "deep.jpg"):
        assert secret not in caplog.text
