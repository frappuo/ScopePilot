"""Account deletion (logbook PR 6). Hermetic: Supabase is the in-memory fake in fake_supabase.py,
and every value is a dummy.

The storage sweep of "<uid>/" must remove every object in the user's folder, including orphans
that no row lists, and never anything outside it. delete_account removes rows, objects and the
Auth user in that order, and a retry must finish whatever a failed attempt left.
"""

from datetime import timedelta
from io import BytesIO
import json
import logging
from types import SimpleNamespace
from unittest.mock import MagicMock
import uuid

import httpx
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.config import Settings
from app.main import app
from app.services import gemini, logbook
from app.services.auth import AuthenticatedUser
from app.services.errors import AnalysisError

from fake_supabase import (
    BUCKET, KEY, RESULT, SECRET, USER_A, USER_B, FakeSupabase, assert_scoped, auth, fake_verify, now,
    settings, use_settings,
)


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


def test_an_empty_folder_entry_alone_counts_as_done(fake):
    fake.empty_folders = {f"{USER_A}/ghost/"}
    assert sweep() == (0, 1)
    assert deletes(fake) == []


def test_empty_folder_entries_left_after_deleting_files_count_as_done(fake):
    populate(fake, USER_A)
    fake.empty_folders = {f"{USER_A}/ghost/", f"{USER_A}/a/empty/"}
    deleted, rounds = sweep()
    assert deleted == len(populate_paths(USER_A)) and rounds == 2
    assert owned(fake, USER_A) == {}


def populate_paths(user_id):
    fake = FakeSupabase()
    populate(fake, user_id)
    return list(fake.objects)


def test_files_behind_more_than_a_page_of_empty_folders_are_found(fake):
    fake.empty_folders = {f"{USER_A}/a{index:03}/" for index in range(logbook.SWEEP_PAGE + 50)}
    fake.objects[f"{USER_A}/zzz/image.jpg"] = b"x"
    fake.objects[f"{USER_A}/zzz/thumb.jpg"] = b"x"
    populate(fake, USER_B)
    others = owned(fake, USER_B)

    assert sweep() == (2, 2)

    assert owned(fake, USER_A) == {} and owned(fake, USER_B) == others
    root_offsets = [json_body(r)["offset"] for r in lists(fake) if json_body(r)["prefix"] == f"{USER_A}/"]
    assert logbook.SWEEP_PAGE in root_offsets  # The complete pass read past the first page.
    assert_scoped(fake.requests, USER_A, USER_B)


def test_a_file_still_listed_after_its_delete_is_503_even_behind_empty_folders(fake, caplog):
    fake.empty_folders = {f"{USER_A}/a{index:03}/" for index in range(logbook.SWEEP_PAGE + 50)}
    fake.objects[f"{USER_A}/zzz/image.jpg"] = b"x"
    fake.delete_noop = True
    with caplog.at_level(logging.WARNING, logger="app"), pytest.raises(AnalysisError) as raised:
        sweep()
    assert raised.value.status_code == 503
    assert "op=sweep status=no_progress" in caplog.text
    assert len(deletes(fake)) == 1


def assert_logs_clean(caplog):
    for secret in (USER_A, USER_B, SECRET, "stray.jpg", "deep.jpg"):
        assert secret not in caplog.text


# --- delete_account ------------------------------------------------------------------------


UNAVAILABLE = {"detail": "Logbook is temporarily unavailable. Please try again."}


@pytest.fixture
def sdk(monkeypatch):
    factory = MagicMock()
    generate = factory.return_value.__enter__.return_value.models.generate_content
    generate.return_value = SimpleNamespace(text=json.dumps(RESULT))
    monkeypatch.setattr(gemini.genai, "Client", factory)
    return generate


@pytest.fixture
def client(monkeypatch, fake, sdk):
    monkeypatch.setattr("app.main.get_settings", lambda: Settings(_env_file=None, gemini_api_key=KEY))
    monkeypatch.setattr("app.middleware.verify_access_token", fake_verify)
    use_settings()
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()


def png():
    stream = BytesIO()
    Image.new("RGB", (8, 8), "white").save(stream, format="PNG")
    return stream.getvalue()


def create(client):
    return client.post("/v1/experiments", files={"image": ("upload", png(), "image/png")}, headers=auth())


def seed(fake, user_id):
    """populate() plus an expired draft and usage rows on two days."""
    populate(fake, user_id)
    fake.add_draft(user_id, expires_in=-timedelta(hours=2))
    fake.usage[(user_id, now().date().isoformat())] = 3
    fake.usage[(user_id, (now() - timedelta(days=1)).date().isoformat())] = 7


def state(fake, user_id):
    """Everything stored for user_id, for before/after comparisons."""
    return {
        "rows": {key: dict(row) for key, row in fake.rows.items() if row["user_id"] == user_id},
        "usage": {key: calls for key, calls in fake.usage.items() if key[0] == user_id},
        "objects": owned(fake, user_id),
        "auth": user_id in fake.auth_users,
    }


def assert_gone(fake, user_id):
    assert state(fake, user_id) == {"rows": {}, "usage": {}, "objects": {}, "auth": False}


def delete_a():
    logbook.delete_account(USER_A, settings())


def ops(fake):
    """The op of each request, with consecutive repeats collapsed."""
    names = [FakeSupabase._op(r.url.path, r.method, r.url.params, r) for r in fake.requests]
    return [name for index, name in enumerate(names) if index == 0 or name != names[index - 1]]


def test_delete_account_removes_everything_for_that_user_only(fake, caplog):
    seed(fake, USER_A)
    seed(fake, USER_B)
    others = state(fake, USER_B)

    with caplog.at_level(logging.INFO, logger="app"):
        delete_a()

    assert_gone(fake, USER_A)
    assert state(fake, USER_B) == others
    assert_scoped(fake.requests, USER_A, USER_B)
    assert ops(fake) == ["delete_rows", "list_objects", "delete", "list_objects",
                         "auth_delete", "list_objects"]
    assert all(request.headers["apikey"] == SECRET and "authorization" not in request.headers
               for request in fake.requests)
    assert "Account deletion op=rows experiments=3" in caplog.text
    assert "Account deletion op=objects deleted=8 rounds=2" in caplog.text
    assert "Account deletion op=auth result=deleted" in caplog.text
    assert "Account deletion op=final_sweep deleted=0 rounds=1" in caplog.text
    assert_logs_clean(caplog)


def test_repeat_delete_after_success_is_a_quiet_no_op(fake, caplog):
    seed(fake, USER_A)
    delete_a()
    with caplog.at_level(logging.INFO, logger="app"):
        delete_a()
    assert "op=rows experiments=0" in caplog.text
    assert "op=auth result=absent" in caplog.text
    assert all(record.levelno < logging.WARNING for record in caplog.records)
    assert_gone(fake, USER_A)


# What each failed step leaves: (experiment rows, usage rows, objects, Auth user) still present.
# usage_daily goes only by the cascade with the Auth user.
@pytest.mark.parametrize("op, failure, left", [
    ("delete_rows", 500, (True, True, True, True)),
    ("delete_rows", "transport", (True, True, True, True)),
    ("delete_rows", "after_commit", (False, True, True, True)),
    ("list_objects", 500, (False, True, True, True)),
    ("list_objects", "transport", (False, True, True, True)),
    ("delete", 500, (False, True, True, True)),
    ("auth_delete", 500, (False, True, False, True)),
    ("auth_delete", "transport", (False, True, False, True)),
    ("auth_delete", "after_commit", (False, False, False, False)),
])
def test_failed_step_stops_the_rest_and_a_retry_finishes(fake, caplog, op, failure, left):
    seed(fake, USER_A)
    seed(fake, USER_B)
    others = state(fake, USER_B)
    fake.fail[op] = failure

    with caplog.at_level(logging.INFO, logger="app"), pytest.raises(AnalysisError) as raised:
        delete_a()

    assert raised.value.status_code == 503
    remaining = state(fake, USER_A)
    assert (bool(remaining["rows"]), bool(remaining["usage"]), bool(remaining["objects"]), remaining["auth"]) == left
    assert_logs_clean(caplog)

    fake.fail.clear()
    delete_a()  # The same user, as with the same still-valid access token.
    assert_gone(fake, USER_A)
    assert state(fake, USER_B) == others


def test_failed_final_sweep_is_finished_by_a_retry_after_the_auth_user_is_gone(fake, caplog):
    seed(fake, USER_A)
    late = f"{USER_A}/{uuid.uuid4()}/image.jpg"

    def create_finishing_meanwhile():
        fake.objects[late] = b"late"
        fake.fail["list_objects"] = 500

    fake.hooks["auth_delete"] = create_finishing_meanwhile
    with caplog.at_level(logging.INFO, logger="app"), pytest.raises(AnalysisError):
        delete_a()
    assert "Account deletion failed op=final_sweep" in caplog.text
    assert USER_A not in fake.auth_users and late in fake.objects

    fake.fail.clear()
    caplog.clear()
    with caplog.at_level(logging.INFO, logger="app"):
        delete_a()
    assert "op=auth result=absent" in caplog.text
    assert_gone(fake, USER_A)


@pytest.mark.parametrize("body", [
    {"message": "no Route matched with those values"},
    {"code": 404, "msg": "User not found"},
    {"error_code": "not_found"},
    None,
])
def test_auth_404_counts_as_gone_only_for_user_not_found(fake, caplog, body):
    fake.auth_users.discard(USER_A)
    fake.auth_404_body = body
    with caplog.at_level(logging.WARNING, logger="app"), pytest.raises(AnalysisError) as raised:
        delete_a()
    assert raised.value.status_code == 503
    assert "op=auth_delete status=404" in caplog.text


@pytest.mark.parametrize("status", [400, 401, 403, 422, 500, 503])
def test_auth_errors_are_503(fake, status):
    fake.fail["auth_delete"] = status
    with pytest.raises(AnalysisError) as raised:
        delete_a()
    assert raised.value.status_code == 503 and USER_A in fake.auth_users


@pytest.mark.parametrize("body", [
    json.dumps([{"user_id": USER_B}]).encode(),
    json.dumps([{"user_id": USER_A}, {"id": "x"}]).encode(),
    b'{"user_id": "x"}',
    b"not json",
])
def test_unexpected_row_delete_response_stops_before_storage_and_auth(fake, body):
    seed(fake, USER_A)
    objects = owned(fake, USER_A)
    fake.delete_rows_body = body
    with pytest.raises(AnalysisError) as raised:
        delete_a()
    assert raised.value.status_code == 503
    assert owned(fake, USER_A) == objects and USER_A in fake.auth_users
    assert lists(fake) == []


@pytest.mark.parametrize("user_id", ["", "A", USER_A.upper(), f"{USER_A}/..", None])
def test_delete_account_refuses_a_non_canonical_user_id_before_any_request(fake, user_id):
    with pytest.raises(ValueError):
        logbook.delete_account(user_id, settings())
    assert fake.requests == []


# --- concurrency ---------------------------------------------------------------------------


def test_create_that_lands_just_before_the_auth_delete_is_removed_too(fake):
    seed(fake, USER_A)
    fake.hooks["auth_delete"] = lambda: fake.store_objects(fake.add_draft(USER_A))
    delete_a()
    assert_gone(fake, USER_A)  # The cascade takes the row, the final sweep its images.


def test_create_whose_insert_comes_after_the_deletion_fails_and_cleans_up(client, fake, sdk):
    fake.hooks["create_draft"] = delete_a  # The account is deleted between upload and insert.
    response = create(client)
    assert response.status_code == 503 and response.json() == UNAVAILABLE
    assert len(fake.discards()) == 1  # Insert-failure cleanup ran: discard, then the images.
    assert_gone(fake, USER_A)


def test_create_whose_quota_step_comes_after_the_deletion_stores_nothing(client, fake, sdk):
    fake.hooks["consume_gemini_call"] = delete_a
    response = create(client)
    assert response.status_code == 503 and sdk.call_count == 0
    assert [r for r in fake.requests
            if r.method == "POST" and r.url.path.startswith(f"/storage/v1/object/{BUCKET}/")] == []
    assert_gone(fake, USER_A)


def test_ask_racing_the_deletion_gets_503_without_gemini(client, fake, sdk):
    experiment_id = fake.add_saved(USER_A)
    fake.hooks["consume_gemini_call"] = delete_a  # The row was read; the account goes before the charge.
    response = client.post(f"/v1/experiments/{experiment_id}/ask", json={"question": "What is this?"},
                           headers=auth())
    assert response.status_code == 503 and sdk.call_count == 0
    assert_gone(fake, USER_A)


def test_still_valid_token_after_deletion_can_store_nothing(client, fake, sdk):
    experiment_id = fake.add_saved(USER_A)
    fake.store_objects(experiment_id)
    delete_a()

    assert create(client).status_code == 503 and sdk.call_count == 0
    assert client.post(f"/v1/experiments/{experiment_id}/ask", json={"question": "What is this?"},
                       headers=auth()).status_code == 404
    assert client.get("/v1/experiments", headers=auth()).json()["items"] == []
    me = client.get("/v1/me", headers=auth())
    assert me.status_code == 200 and me.json()["usage"]["used_today"] == 0
    assert_gone(fake, USER_A)


# --- DELETE /v1/me -------------------------------------------------------------------------


CONFIRM = {"confirm": "DELETE MY ACCOUNT"}
UNFINISHED = {"detail": "Account deletion did not finish. Please try again."}


def delete_me(client, user="A", **kwargs):
    kwargs.setdefault("json", CONFIRM)
    return client.request("DELETE", "/v1/me", headers=auth(user) if user else {}, **kwargs)


@pytest.mark.parametrize("kwargs", [
    {"json": None},  # No body at all.
    {"json": {}},
    {"json": {"confirm": "DELETE"}},
    {"json": {"confirm": "delete my account"}},
    {"json": {"confirm": " DELETE MY ACCOUNT"}},
    {"json": {"confirm": "DELETE MY ACCOUNT", "user_id": USER_B}},
    {"json": {"confirm": True}},
    {"json": ["DELETE MY ACCOUNT"]},
    {"json": None, "content": b"DELETE MY ACCOUNT", "headers_extra": {"content-type": "text/plain"}},
    {"json": None, "content": b'{"confirm": "DELETE MY ACCOUNT"', "headers_extra": {"content-type": "application/json"}},
])
def test_without_the_exact_confirmation_nothing_is_deleted(client, fake, kwargs):
    seed(fake, USER_A)
    before = state(fake, USER_A)
    headers = {**auth(), **kwargs.pop("headers_extra", {})}
    response = client.request("DELETE", "/v1/me", headers=headers, **kwargs)
    assert response.status_code == 422
    assert fake.requests == []
    assert state(fake, USER_A) == before


def test_delete_without_a_token_is_401_and_touches_nothing(client, fake):
    response = delete_me(client, user=None)
    assert response.status_code == 401 and response.headers["www-authenticate"] == "Bearer"
    assert fake.requests == [] and USER_A in fake.auth_users


def test_delete_when_the_logbook_is_not_configured_is_503(client, fake):
    use_settings(supabase_url="", supabase_secret_key="")
    response = delete_me(client)
    assert response.status_code == 503 and response.json() == {"detail": "Logbook not configured."}
    assert fake.requests == []


def test_delete_me_removes_the_account_end_to_end(client, fake):
    seed(fake, USER_A)
    seed(fake, USER_B)
    others = state(fake, USER_B)

    response = delete_me(client)

    assert response.status_code == 204 and response.content == b""
    assert_gone(fake, USER_A)
    assert state(fake, USER_B) == others
    assert_scoped(fake.requests, USER_A, USER_B)


def test_repeat_delete_me_is_204(client, fake):
    seed(fake, USER_A)
    assert delete_me(client).status_code == 204
    assert delete_me(client).status_code == 204
    assert_gone(fake, USER_A)


@pytest.mark.parametrize("op", ["delete_rows", "list_objects", "auth_delete"])
def test_unfinished_delete_is_503_and_the_same_token_finishes_it(client, fake, op):
    seed(fake, USER_A)
    fake.fail[op] = 500
    response = delete_me(client)
    assert response.status_code == 503 and response.json() == UNFINISHED

    fake.fail.clear()
    assert delete_me(client).status_code == 204
    assert_gone(fake, USER_A)


def test_after_delete_me_the_old_token_can_store_nothing(client, fake, sdk):
    experiment_id = fake.add_saved(USER_A)
    fake.store_objects(experiment_id)
    assert delete_me(client).status_code == 204

    assert create(client).status_code == 503 and sdk.call_count == 0
    assert client.post(f"/v1/experiments/{experiment_id}/ask", json={"question": "What is this?"},
                       headers=auth()).status_code == 404
    me = client.get("/v1/me", headers=auth())
    assert me.status_code == 200 and me.json()["usage"]["used_today"] == 0
    assert_gone(fake, USER_A)


def test_delete_me_logs_no_ids_emails_paths_or_secrets(client, fake, monkeypatch, caplog):
    email = "student@example.com"
    monkeypatch.setattr("app.middleware.verify_access_token",
                        lambda token, url: AuthenticatedUser(user_id=USER_A, email=email))
    seed(fake, USER_A)
    fake.fail["auth_delete"] = 500
    with caplog.at_level(logging.INFO):
        assert delete_me(client).status_code == 503
        fake.fail.clear()
        assert delete_me(client).status_code == 204
    # Only app.* loggers: the test client's own httpx logger prints the URLs it requested.
    app_lines = [record.getMessage() for record in caplog.records if record.name.startswith("app")]
    assert any("op=auth_delete status=500" in line for line in app_lines)
    assert any("Account deletion op=auth result=deleted" in line for line in app_lines)
    for secret in (USER_A, email, SECRET, "token-A", "stray.jpg", "deep.jpg", "image.jpg", BUCKET):
        assert not any(secret in line for line in app_lines), secret


def test_supabase_never_receives_the_users_bearer_token(client, fake):
    seed(fake, USER_A)
    assert delete_me(client).status_code == 204
    assert fake.requests
    for request in fake.requests:
        assert "authorization" not in request.headers
        assert "token-A" not in str(request.headers) and b"token-A" not in request.content
        assert request.headers["apikey"] == SECRET


def test_delete_me_with_only_an_empty_folder_entry_left_is_204(client, fake):
    seed(fake, USER_A)
    fake.empty_folders = {f"{USER_A}/ghost/"}
    assert delete_me(client).status_code == 204
    assert_gone(fake, USER_A)


@pytest.mark.parametrize("op", ["list_objects", "delete", "auth_delete"])
def test_failed_delete_after_the_row_step_keeps_the_days_quota(client, fake, op):
    seed(fake, USER_A)
    usage = state(fake, USER_A)["usage"]
    fake.fail[op] = 500

    assert delete_me(client).status_code == 503

    assert state(fake, USER_A)["usage"] == usage
    assert client.get("/v1/me", headers=auth()).json()["usage"]["used_today"] == 3
    assert not any(r.method == "DELETE" and r.url.path == "/rest/v1/usage_daily" for r in fake.requests)
