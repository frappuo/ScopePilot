"""Logbook create/read (/v1/experiments). Hermetic: Supabase is an httpx.MockTransport fake,
the Gemini SDK is mocked, tokens map to fixed users, and every value is a dummy."""

import base64
from datetime import datetime, timedelta, timezone
from io import BytesIO
import json
import logging
from types import SimpleNamespace
from unittest.mock import MagicMock
import uuid

import httpx
import pytest
from fastapi.testclient import TestClient
from google.genai import errors
from PIL import Image
from pydantic import ValidationError

from app.config import Settings
from app.main import app
from app.schemas.analysis import MAX_STORED_ANALYSIS_BYTES, Analysis, StoredAnalysis
from app.services import gemini, images, logbook
from app.services.errors import AnalysisError

from fake_supabase import (
    BUCKET, KEY, RESULT, SECRET, SUPABASE_URL, USER_A, USER_B, FakeSupabase,
    assert_scoped, auth, fake_verify, now, settings, use_settings,
)

NOT_FOUND = {"detail": "Experiment not found."}
UNAVAILABLE = {"detail": "Logbook is temporarily unavailable. Please try again."}
DAILY_LIMIT = {"detail": "Daily AI request limit reached for your account. Try again after 00:00 UTC."}


def png(size=(8, 8), mode="RGB", color="white"):
    stream = BytesIO()
    Image.new(mode, size, color).save(stream, format="PNG")
    return stream.getvalue()


def mpo():
    stream = BytesIO()
    Image.new("RGB", (8, 8), "red").save(
        stream, format="MPO", save_all=True, append_images=[Image.new("RGB", (8, 8), "blue")]
    )
    return stream.getvalue()


def jpeg_with_metadata():
    exif = Image.Exif()
    exif[0x010F] = "SyntheticCam"
    exif.get_ifd(0x8825).update({1: "N", 2: (51.0, 30.0, 0.0), 3: "W", 4: (0.0, 7.0, 0.0)})
    stream = BytesIO()
    Image.new("RGB", (8, 8), "white").save(stream, format="JPEG", exif=exif)
    return stream.getvalue()


@pytest.fixture
def fake(monkeypatch):
    supabase = FakeSupabase()
    monkeypatch.setattr(logbook, "_transport", httpx.MockTransport(supabase))
    monkeypatch.setattr(logbook, "_wait", supabase.waits.append)  # Records instead of sleeping.
    return supabase


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


def create(client, data=None, content_type="image/png", user="A"):
    data = png() if data is None else data
    return client.post("/v1/experiments", files={"image": ("upload", data, content_type)}, headers=auth(user))




# --- create and read -----------------------------------------------------------------


def test_create_and_read_own_experiment(client, fake, sdk):
    response = create(client)
    assert response.status_code == 201
    body = response.json()
    assert body["status"] == "draft"
    assert body["analysis"] == RESULT
    assert body["title"] is None and body["notes"] == ""
    assert body["image_url_expires_in"] == 600
    assert body["image_url"].startswith(f"{SUPABASE_URL}/storage/v1/object/sign/{BUCKET}/{USER_A}/{body['id']}/")
    assert body["thumb_url"].endswith("thumb.jpg?token=signed-token-2")

    row = fake.rows[body["id"]]
    assert row["user_id"] == USER_A
    assert row["model"] == "primary"
    assert row["prompt_version"] == gemini.PROMPT_VERSION
    assert row["image_bytes"] == len(fake.objects[row["image_path"]])
    assert datetime.fromisoformat(row["expires_at"]) - now() > timedelta(hours=23)
    assert sorted(fake.objects) == sorted([row["image_path"], row["thumb_path"]])
    assert sdk.call_count == 1

    again = client.get(f"/v1/experiments/{body['id']}", headers=auth())
    assert again.status_code == 200
    assert again.json()["id"] == body["id"]
    assert again.json()["analysis"] == RESULT


def test_other_users_experiment_is_404_and_requests_are_scoped(client, fake):
    experiment_id = create(client).json()["id"]
    client.get(f"/v1/experiments/{experiment_id}", headers=auth("A"))
    assert_scoped(fake.requests, USER_A, USER_B)

    fake.requests.clear()
    stolen = client.get(f"/v1/experiments/{experiment_id}", headers=auth("B"))
    missing = client.get(f"/v1/experiments/{uuid.uuid4()}", headers=auth("B"))
    assert stolen.status_code == missing.status_code == 404
    assert stolen.json() == missing.json() == NOT_FOUND
    assert_scoped(fake.requests, USER_B, USER_A)


def test_non_uuid_id_is_404_without_supabase(client, fake):
    for bad in ("not-a-uuid", "1", "%2e%2e"):
        response = client.get(f"/v1/experiments/{bad}", headers=auth())
        assert response.status_code == 404
        assert response.json() == NOT_FOUND
    assert fake.requests == []


def test_expired_draft_is_404(client, fake):
    experiment_id = fake.add_draft(USER_A, expires_in=timedelta(seconds=-1))
    assert client.get(f"/v1/experiments/{experiment_id}", headers=auth()).json() == NOT_FOUND


@pytest.mark.parametrize("path", [f"{USER_B}/x/image.jpg", f"{USER_A}/../{USER_B}/x/image.jpg"])
def test_row_with_foreign_storage_path_is_refused(client, fake, path):
    # A ".." path gives the controlled 503, not a 500 from sign_urls.
    experiment_id = fake.add_draft(USER_A)
    fake.rows[experiment_id]["image_path"] = path
    response = client.get(f"/v1/experiments/{experiment_id}", headers=auth())
    assert response.status_code == 503 and response.json() == UNAVAILABLE
    assert fake.by("POST", "/storage/v1/object/sign/") == []


@pytest.mark.parametrize("where", ["read", "insert", "update"])
def test_row_owned_by_another_user_is_refused(client, fake, where):
    experiment_id = fake.add_draft(USER_A, title="Onion")
    foreign = {**fake.rows[experiment_id], "user_id": USER_B}
    if where == "read":
        fake.get_body = json.dumps([foreign]).encode()
        response = client.get(f"/v1/experiments/{experiment_id}", headers=auth())
    elif where == "insert":
        fake.insert_body = json.dumps({"result": "ok", "row": foreign}).encode()
        response = create(client)
    else:
        fake.update_body = json.dumps({"result": "ok", "row": foreign}).encode()
        response = client.patch(f"/v1/experiments/{experiment_id}", json={"notes": "x"}, headers=auth())
    assert response.status_code == 503 and response.json() == UNAVAILABLE
    assert USER_B not in response.text and RESULT["probable_specimen"] not in response.text
    assert fake.by("POST", "/storage/v1/object/sign/") == []


def test_fallback_model_is_recorded(client, fake, sdk):
    sdk.side_effect = [
        errors.ClientError(429, {"error": {"message": "provider detail", "status": "RESOURCE_EXHAUSTED"}}),
        SimpleNamespace(text=json.dumps(RESULT)),
    ]
    experiment_id = create(client).json()["id"]
    assert fake.rows[experiment_id]["model"] == "fb-1"


def test_signing_failure_still_creates(client, fake):
    fake.fail["sign"] = 500
    response = create(client)
    assert response.status_code == 201
    assert response.json()["image_url"] is None and response.json()["thumb_url"] is None
    assert len(fake.rows) == 1


# --- ordering, quota and caps --------------------------------------------------------


@pytest.mark.parametrize("data,content_type,status", [
    (b"\x89PNG\r\n\x1a\nnot really a png", "image/png", 400),
    (b"plain text", "text/plain", 415),
])
def test_rejected_image_consumes_no_quota(client, fake, sdk, data, content_type, status):
    assert create(client, data, content_type).status_code == status
    assert fake.by("POST", "/rest/v1/rpc/") == []
    assert sdk.call_count == 0
    assert fake.objects == {} and fake.rows == {}


def test_per_user_daily_cap(client, fake, sdk):
    fake.quota_body = b"false"
    response = create(client)
    assert response.status_code == 429
    assert response.json() == DAILY_LIMIT
    assert 0 < int(response.headers["retry-after"]) <= 86400
    assert sdk.call_count == 0
    assert fake.by("POST", "/storage/") == [] and fake.rows == {}


@pytest.mark.parametrize("quota_body", [b"null", b'"true"', b"[true]", b"{}", b"1", b"not json"])
def test_quota_fails_closed_on_non_boolean(client, fake, sdk, quota_body):
    fake.quota_body = quota_body
    assert create(client).status_code == 429
    assert sdk.call_count == 0


def test_draft_cap(client, fake, sdk):
    for _ in range(10):
        fake.add_draft(USER_A)
    response = create(client)
    assert response.status_code == 409
    assert response.json() == {"detail": "Too many unsaved drafts. Save or discard one first."}
    assert fake.by("POST", "/rest/v1/rpc/") == []
    assert sdk.call_count == 0


def test_expired_and_other_users_drafts_do_not_count(client, fake):
    for _ in range(9):
        fake.add_draft(USER_A)
    for _ in range(3):
        fake.add_draft(USER_A, expires_in=timedelta(seconds=-1))
    for _ in range(10):
        fake.add_draft(USER_B)
    assert create(client).status_code == 201


def test_draft_count_timestamp_is_url_encoded(client, fake):
    create(client)
    (count,) = [r for r in fake.by("GET", "/rest/v1/experiments")
                if r.url.params.get("expires_at", "").startswith("gt.")]  # Not the purge's lte. query.
    query = count.url.query.decode()
    assert "expires_at=gt." in query
    assert "%2B" in query and "+" not in query
    assert count.url.params["expires_at"].endswith("+00:00")


# --- failure handling ----------------------------------------------------------------


def exhaust_global_cap():
    use_settings(gemini_daily_call_limit=1)
    gemini._DAILY_CALLS.take(1, "test")


@pytest.mark.parametrize("break_gemini,status", [
    (lambda sdk: setattr(sdk, "side_effect", errors.ServerError(500, {"error": {"message": "provider detail"}})), 502),
    (lambda sdk: exhaust_global_cap(), 503),
])
def test_gemini_failure_stores_nothing(client, fake, sdk, break_gemini, status):
    break_gemini(sdk)
    assert create(client).status_code == status
    assert len(fake.by("POST", "/rest/v1/rpc/")) == 1  # The quota unit was taken.
    assert fake.by("POST", "/storage/") == []
    assert fake.inserts() == []
    assert fake.objects == {} and fake.rows == {}


def analysis_of_size(total_bytes, base):
    """base with observations padded so that its compact JSON is exactly total_bytes in UTF-8."""
    analysis = {**base, "observations": []}

    def size():
        return len(Analysis(**analysis).model_dump_json().encode("utf-8"))

    while size() + 1003 <= total_bytes:  # A 1000-char item adds 1000 + 2 quotes + 1 comma.
        analysis["observations"].append("o" * 1000)
    analysis["observations"].append("o" * (total_bytes - size() - 3))
    assert size() == total_bytes
    return analysis


OVERSIZE_MARKER = "marker-7f3c"
MARKED = {**RESULT, "probable_specimen": f"Possible {OVERSIZE_MARKER} specimen"}


@pytest.mark.parametrize("analysis", [
    analysis_of_size(MAX_STORED_ANALYSIS_BYTES + 1, MARKED),
    {**MARKED, "observations": ["Rectangular cells"] * 41},
    {**MARKED, "explanation": "x" * 6001},
], ids=["total_size", "41_observations", "long_explanation"])
def test_create_rejects_oversized_analysis(client, fake, sdk, caplog, analysis):
    sdk.return_value = SimpleNamespace(text=json.dumps(analysis))
    with caplog.at_level(logging.DEBUG):
        response = create(client)
    assert response.status_code == 502
    assert response.json() == {"detail": "Gemini returned an invalid or empty analysis. Please try again."}
    assert sdk.call_count == 1 and len(fake.by("POST", "/rest/v1/rpc/consume_gemini_call")) == 1
    assert fake.by("POST", "/storage/") == [] and fake.by("DELETE", "/storage/") == []
    assert fake.inserts() == [] and fake.discards() == []
    assert fake.objects == {} and fake.rows == {}
    assert "Logbook analysis rejected reason=too_long" in caplog.text
    assert OVERSIZE_MARKER not in caplog.text and USER_A not in caplog.text


def test_analysis_at_cap_is_stored_unchanged(client, fake, sdk):
    analysis = analysis_of_size(MAX_STORED_ANALYSIS_BYTES, RESULT)
    sdk.return_value = SimpleNamespace(text=json.dumps(analysis))
    response = create(client)
    assert response.status_code == 201
    body = response.json()
    assert body["analysis"] == analysis
    assert fake.rows[body["id"]]["analysis"] == analysis
    assert client.get(f"/v1/experiments/{body['id']}", headers=auth()).json()["analysis"] == analysis


def test_stored_analysis_cap_counts_utf8_bytes():
    analysis = {**RESULT, "observations": ["é" * 1000] * 17}
    as_json = Analysis(**analysis).model_dump_json()
    assert len(as_json) < MAX_STORED_ANALYSIS_BYTES < len(as_json.encode("utf-8"))
    with pytest.raises(ValidationError, match="too large to store"):
        StoredAnalysis.model_validate(analysis)


@pytest.mark.parametrize("failure", [500, "transport"])
def test_insert_failure_deletes_uploaded_objects(client, fake, failure):
    fake.fail["insert"] = failure
    response = create(client)
    assert response.status_code == 503
    assert response.json() == UNAVAILABLE
    uploads = [r.url.path.removeprefix(f"/storage/v1/object/{BUCKET}/") for r in fake.by("POST", f"/storage/v1/object/{BUCKET}/")]
    assert len(uploads) == 2
    (delete,) = fake.by("DELETE", "/storage/")
    assert json.loads(delete.content) == {"prefixes": uploads}
    assert fake.objects == {} and fake.rows == {}


def test_thumbnail_upload_failure_deletes_both_paths(client, fake, caplog):
    # The failed thumbnail path is included: a failed or timed-out upload may still have been stored.
    fake.fail["upload_thumb"] = 500
    fake.fail["delete"] = 500  # Makes the cleanup log line appear, so the op label is checked.
    with caplog.at_level(logging.WARNING):
        assert create(client).status_code == 503
    (delete,) = fake.by("DELETE", "/storage/")
    image, thumb = json.loads(delete.content)["prefixes"]
    assert image.startswith(f"{USER_A}/") and image.endswith("/image.jpg")
    assert thumb == image.removesuffix("image.jpg") + "thumb.jpg"
    assert "Logbook cleanup failed op=upload objects=2" in caplog.text
    assert fake.inserts() == []
    assert fake.rows == {}


def test_unexpected_insert_error_cleans_up_and_reraises(client, fake, monkeypatch):
    boom = RuntimeError("synthetic failure")

    def fail(*args, **kwargs):
        raise boom

    monkeypatch.setattr(logbook, "insert_experiment", fail)
    with pytest.raises(RuntimeError) as error:
        create(client)  # TestClient re-raises server exceptions by default.
    assert error.value is boom
    (discard,) = fake.discards()
    (delete,) = fake.by("DELETE", "/storage/")
    assert fake.requests.index(discard) < fake.requests.index(delete)
    assert len(json.loads(delete.content)["prefixes"]) == 2
    assert fake.objects == {}


def test_undecodable_insert_response_keeps_objects(client, fake):
    # The insert succeeded, so the row points at the objects: they must not be deleted.
    fake.insert_body = b"<html>not json</html>"
    response = create(client)
    assert response.status_code == 503
    assert response.json() == UNAVAILABLE
    assert fake.by("DELETE", "/storage/") == []
    assert len(fake.objects) == 2 and len(fake.rows) == 1


def test_cleanup_failure_is_logged(client, fake, caplog):
    fake.fail["insert"] = 500
    fake.fail["delete"] = 500
    with caplog.at_level(logging.WARNING):
        assert create(client).status_code == 503
    assert "Logbook cleanup failed op=insert objects=2" in caplog.text


def inserted_id(fake):
    (insert,) = fake.inserts()
    return json.loads(insert.content)["p_id"]


def test_insert_committed_then_response_lost_deletes_row_then_objects(client, fake):
    fake.fail["insert"] = "after_commit"
    response = create(client)
    assert response.status_code == 503 and response.json() == UNAVAILABLE
    (discard,) = fake.discards()
    (object_delete,) = fake.by("DELETE", "/storage/")
    assert fake.requests.index(discard) < fake.requests.index(object_delete)
    assert json.loads(discard.content) == {"p_user": USER_A, "p_id": inserted_id(fake)}
    assert len(json.loads(object_delete.content)["prefixes"]) == 2
    assert fake.rows == {} and fake.objects == {}


def test_cleanup_waits_for_the_create_deadline_before_discarding(client, fake):
    fake.fail["insert"] = 500
    assert create(client).status_code == 503
    (wait,) = fake.waits
    # Until DISCARD_MARGIN_SECONDS past the deadline, so a lagging database clock still sees "late".
    assert 9 < wait <= logbook.CREATE_DEADLINE_SECONDS + logbook.DISCARD_MARGIN_SECONDS
    (insert,) = fake.inserts()
    deadline = datetime.fromisoformat(json.loads(insert.content)["p_deadline"])
    assert timedelta(seconds=7) < deadline - now() <= timedelta(seconds=logbook.CREATE_DEADLINE_SECONDS)
    assert len(fake.discards()) == 1


@pytest.mark.parametrize("outcome,setup", [
    ("late", lambda fake, monkeypatch: monkeypatch.setattr(logbook, "CREATE_DEADLINE_SECONDS", -1)),
    ("invalid_arguments", lambda fake, monkeypatch: setattr(fake, "insert_body", b'{"result": "invalid_arguments"}')),
])
def test_create_draft_wrote_nothing_cleans_images_without_discard(client, fake, monkeypatch, caplog, outcome, setup):
    setup(fake, monkeypatch)
    with caplog.at_level(logging.WARNING):
        response = create(client)
    assert response.status_code == 503 and response.json() == UNAVAILABLE
    assert f"Logbook request failed op=insert status={outcome}" in caplog.text
    assert fake.discards() == [] and fake.waits == []
    (cleanup,) = fake.by("DELETE", "/storage/")
    assert len(json.loads(cleanup.content)["prefixes"]) == 2
    if outcome == "late":
        assert fake.rows == {}
    assert fake.objects == {}


@pytest.mark.parametrize("body", [b'"true"', b"null", b"[true]", b"not json"])
def test_discard_non_boolean_keeps_objects(client, fake, caplog, body):
    fake.fail["insert"] = "after_commit"
    fake.discard_body = body
    with caplog.at_level(logging.WARNING):
        assert create(client).status_code == 503
    assert "Logbook cleanup failed op=row" in caplog.text
    assert fake.by("DELETE", "/storage/") == []
    assert len(fake.rows) == 1 and len(fake.objects) == 2


@pytest.mark.parametrize("failure", [500, "transport"])
def test_row_delete_failure_keeps_objects(client, fake, caplog, monkeypatch, failure):
    # The row may still exist, so its images must not be deleted out from under it.
    # The insert commits, then fails with a sentinel, so the test can tell the original
    # exception apart from the row delete's 503.
    boom = RuntimeError("synthetic failure after commit")
    real_insert = logbook.insert_experiment

    def commit_then_fail(*args, **kwargs):
        real_insert(*args, **kwargs)
        raise boom

    monkeypatch.setattr(logbook, "insert_experiment", commit_then_fail)
    fake.fail["discard_draft"] = failure
    with caplog.at_level(logging.WARNING):
        with pytest.raises(RuntimeError) as error:
            create(client)  # TestClient re-raises server exceptions by default.
    assert error.value is boom
    assert len(fake.discards()) == 1
    assert fake.by("DELETE", "/storage/") == []
    assert len(fake.rows) == 1 and len(fake.objects) == 2
    assert "Logbook cleanup failed op=row" in caplog.text
    (experiment_id,) = fake.rows
    assert experiment_id not in caplog.text and USER_A not in caplog.text


@pytest.mark.parametrize("status", [413, 503])
def test_display_copy_failure_consumes_no_quota(client, fake, sdk, monkeypatch, status):
    if status == 413:
        monkeypatch.setattr(images, "DISPLAY_MAX_BYTES", 10)  # The real too-large path.
    else:
        # Holding _DECODE_SLOTS would make prepare_image fail first, so stub the busy error here.
        def busy(*args, **kwargs):
            raise AnalysisError(503, images._BUSY_DETAIL)

        monkeypatch.setattr(logbook, "make_display_copies", busy)
    assert create(client).status_code == status
    assert fake.by("POST", "/rest/v1/rpc/") == []
    assert sdk.call_count == 0
    assert fake.by("POST", "/storage/") == []
    assert fake.objects == {} and fake.rows == {}


def test_image_upload_failure_cleans_up(client, fake):
    fake.fail["upload_image"] = 500
    response = create(client)
    assert response.status_code == 503 and response.json() == UNAVAILABLE
    assert len(fake.by("POST", f"/storage/v1/object/{BUCKET}/")) == 1  # Thumbnail never attempted.
    (delete,) = fake.by("DELETE", "/storage/")
    (path,) = json.loads(delete.content)["prefixes"]
    assert path.startswith(f"{USER_A}/") and path.endswith("/image.jpg")
    assert fake.discards() == []  # Upload stage: no row to discard.
    assert fake.inserts() == []
    assert fake.objects == {} and fake.rows == {}


def test_storage_paths_outside_user_prefix_are_refused(fake):
    s = settings()
    foreign = f"{USER_B}/{uuid.uuid4()}/image.jpg"
    with pytest.raises(logbook.LogbookPathError):
        logbook.upload_object(USER_A, foreign, b"x", s)
    with pytest.raises(logbook.LogbookPathError):
        logbook.delete_objects(USER_A, [f"{USER_A}/x/image.jpg", foreign], s)
    with pytest.raises(logbook.LogbookPathError):
        logbook.delete_objects(USER_A, [f"{USER_A}/../{USER_B}/x/image.jpg"], s)
    with pytest.raises(logbook.LogbookPathError):
        logbook.sign_urls(USER_A, [foreign], s)
    with pytest.raises(logbook.LogbookPathError):
        logbook.upload_object("", "/x/image.jpg", b"x", s)
    assert fake.requests == []


@pytest.mark.parametrize("user_id,experiment_id", [
    ("", str(uuid.uuid4())),
    (USER_A, ""),
    (USER_A, "not-a-uuid"),
    (USER_A, f"{uuid.uuid4()}&user_id=eq.{USER_B}"),
])
def test_discard_refuses_bad_arguments(fake, user_id, experiment_id):
    with pytest.raises(ValueError):
        logbook.discard_draft(user_id, experiment_id, settings())
    assert fake.requests == []


def test_discard_sends_canonical_id(fake):
    experiment_id = uuid.uuid4()
    assert logbook.discard_draft(USER_A, "{" + str(experiment_id).upper() + "}", settings()) is False
    (request,) = fake.requests
    assert json.loads(request.content) == {"p_user": USER_A, "p_id": str(experiment_id)}


def test_discard_never_removes_a_saved_row(fake):
    experiment_id = fake.add_saved(USER_A)
    assert logbook.discard_draft(USER_A, experiment_id, settings()) is False
    assert experiment_id in fake.rows


# --- draft cap (database) ----------------------------------------------------------


def test_create_draft_rpc_arguments(client, fake):
    create(client)
    (insert,) = fake.inserts()
    body = json.loads(insert.content)
    assert body["p_user"] == USER_A
    assert body["p_max_drafts"] == 10 and body["p_ttl_hours"] == 24
    assert body["p_image_path"] == f"{USER_A}/{body['p_id']}/image.jpg"
    assert body["p_thumb_path"] == f"{USER_A}/{body['p_id']}/thumb.jpg"
    assert body["p_analysis"] == RESULT and body["p_model"] == "primary"
    deadline = datetime.fromisoformat(body["p_deadline"])
    assert body["p_deadline"].endswith("Z")
    assert timedelta(seconds=7) < deadline - now() <= timedelta(seconds=8)


def test_draft_cap_race_is_409_and_cleans_up(client, fake, sdk):
    # The pre-check sees 9 drafts; a concurrent create takes the last slot before create_draft runs.
    for _ in range(9):
        fake.add_draft(USER_A)
    fake.hooks["create_draft"] = lambda: fake.add_draft(USER_A)
    response = create(client)
    assert response.status_code == 409
    assert response.json() == {"detail": "Too many unsaved drafts. Save or discard one first."}
    assert len(fake.rows) == 10
    assert sdk.call_count == 1 and len(fake.by("POST", "/rest/v1/rpc/consume_gemini_call")) == 1
    assert fake.discards() == [] and fake.waits == []  # No row was written, so nothing to discard.
    (cleanup,) = fake.by("DELETE", "/storage/")
    assert len(json.loads(cleanup.content)["prefixes"]) == 2
    assert fake.objects == {}


# --- list ----------------------------------------------------------------------------


def list_page(client, user="A", **params):
    return client.get("/v1/experiments", params=params, headers=auth(user))


def cursor_of(value):
    return base64.urlsafe_b64encode(value.encode()).decode()


def test_list_own_saved_and_live_drafts_newest_first(client, fake):
    base = now() - timedelta(hours=1)
    saved = fake.add_saved(USER_A, created_at=base)
    draft = fake.add_draft(USER_A, created_at=base + timedelta(minutes=1))
    fake.add_draft(USER_A, expires_in=timedelta(seconds=-1), created_at=base + timedelta(minutes=2))
    fake.add_saved(USER_B, created_at=base + timedelta(minutes=3))
    response = list_page(client)
    assert response.status_code == 200
    body = response.json()
    assert [item["id"] for item in body["items"]] == [draft, saved]
    assert body["next_cursor"] is None and body["thumb_url_expires_in"] == 600
    first, second = body["items"]
    assert first["status"] == "draft" and first["expires_at"] and first["saved_at"] is None
    assert second["status"] == "saved" and second["title"] == "Onion epidermis" and second["expires_at"] is None
    assert first["probable_specimen"] == RESULT["probable_specimen"]
    assert first["thumb_url"].startswith(f"{SUPABASE_URL}/storage/v1/object/sign/{BUCKET}/{USER_A}/{draft}/thumb.jpg?")
    assert all("image_url" not in item for item in body["items"])
    (sign,) = fake.by("POST", "/storage/v1/object/sign/")
    assert all(path.endswith("/thumb.jpg") for path in json.loads(sign.content)["paths"])
    assert_scoped(fake.requests, USER_A, USER_B)


def test_list_paging_with_cursor(client, fake):
    base = now() - timedelta(hours=1)
    tie = base + timedelta(minutes=2)
    ids = [fake.add_saved(USER_A, created_at=base + timedelta(minutes=minute)) for minute in (0, 1, 3)]
    ids += [fake.add_saved(USER_A, created_at=tie) for _ in range(2)]  # Same created_at: id breaks the tie.
    expected = sorted(ids, key=lambda i: (fake.rows[i]["created_at"], i), reverse=True)
    seen, cursor, pages = [], None, 0
    while True:
        body = list_page(client, limit=2, **({"cursor": cursor} if cursor else {})).json()
        seen += [item["id"] for item in body["items"]]
        pages += 1
        cursor = body["next_cursor"]
        if cursor is None:
            break
    assert seen == expected
    assert pages == 3


@pytest.mark.parametrize("cursor", [
    "not base64 at all!",
    cursor_of("not json"),
    cursor_of(json.dumps([1, 2])),
    cursor_of(json.dumps({"i": str(uuid.uuid4())})),
    cursor_of(json.dumps({"c": "2026-10-12T10:00:00+00:00", "i": "not-a-uuid"})),
    cursor_of(json.dumps({"c": "2026-10-12T10:00:00", "i": str(uuid.uuid4())})),  # No timezone.
    cursor_of(json.dumps({"c": '2026-10-12T10:00:00+00:00",id.gt.0', "i": str(uuid.uuid4())})),
    cursor_of(json.dumps({"c": "0001-01-01T00:00:00+05:00", "i": str(uuid.uuid4())})),  # Overflows in UTC.
    cursor_of(json.dumps({"c": "1999-12-31T00:00:00+00:00", "i": str(uuid.uuid4())})),
    cursor_of(json.dumps({"c": "9999-12-31T00:00:00+00:00", "i": str(uuid.uuid4())})),
])
def test_list_invalid_cursor_is_400_without_supabase(client, fake, cursor):
    response = list_page(client, cursor=cursor)
    assert response.status_code == 400
    assert response.json() == {"detail": "Invalid cursor."}
    assert fake.requests == []


@pytest.mark.parametrize("params", [{"limit": 0}, {"limit": 51}, {"limit": "x"}, {"cursor": ""}, {"cursor": "a" * 201}])
def test_list_bad_query_is_422_without_supabase(client, fake, params):
    assert list_page(client, **params).status_code == 422
    assert fake.requests == []


def test_list_limits(client, fake):
    for _ in range(3):
        fake.add_saved(USER_A)
    list_page(client)
    list_page(client, limit=50)
    first, second = [r for r in fake.by("GET", "/rest/v1/experiments") if "and" in r.url.params]
    assert first.url.params["limit"] == "21" and second.url.params["limit"] == "51"  # One extra row means more.


@pytest.mark.parametrize("extra", [
    {"user_id": USER_B, "thumb_path": f"{USER_B}/x/thumb.jpg"},
    {"user_id": USER_A, "thumb_path": f"{USER_B}/x/thumb.jpg"},
    {"user_id": USER_A, "thumb_path": f"{USER_A}/../{USER_B}/x/thumb.jpg"},
])
def test_list_refuses_foreign_rows(client, fake, extra):
    fake.add_saved(USER_A)
    fake.list_extra = [{"id": str(uuid.uuid4()), "status": "saved", "title": "x", "created_at": now().isoformat(),
                        "saved_at": now().isoformat(), "expires_at": None, "probable_specimen": "x", **extra}]
    response = list_page(client)
    assert response.status_code == 503 and response.json() == UNAVAILABLE
    assert USER_B not in response.text
    assert fake.by("POST", "/storage/v1/object/sign/") == []


def test_list_signing_failure_gives_null_thumbs(client, fake):
    fake.add_saved(USER_A)
    fake.fail["sign"] = 500
    response = list_page(client)
    assert response.status_code == 200
    assert [item["thumb_url"] for item in response.json()["items"]] == [None]


def test_list_empty(client, fake):
    response = list_page(client)
    assert response.json() == {"items": [], "next_cursor": None, "thumb_url_expires_in": 600}
    assert fake.by("POST", "/storage/") == []


# --- edit and save -------------------------------------------------------------------


def patch(client, experiment_id, body, user="A"):
    return client.patch(f"/v1/experiments/{experiment_id}", json=body, headers=auth(user))


def test_patch_edits_draft_without_saving(client, fake):
    experiment_id = fake.add_draft(USER_A)
    expires_at = fake.rows[experiment_id]["expires_at"]
    response = patch(client, experiment_id, {"title": "  Onion epidermis  ", "notes": "Stained with iodine."})
    assert response.status_code == 200
    body = response.json()
    assert body["title"] == "Onion epidermis" and body["notes"] == "Stained with iodine."
    assert body["status"] == "draft" and body["saved_at"] is None
    assert datetime.fromisoformat(body["expires_at"]) == datetime.fromisoformat(expires_at)
    assert body["image_url"] and body["thumb_url"]
    (call,) = fake.by("POST", "/rest/v1/rpc/update_experiment")
    assert json.loads(call.content) == {
        "p_user": USER_A, "p_id": experiment_id, "p_title": "Onion epidermis", "p_notes": "Stained with iodine.",
        "p_save": False, "p_max_saved": 50,
    }


def test_patch_saves_draft(client, fake):
    experiment_id = fake.add_draft(USER_A)
    response = patch(client, experiment_id, {"status": "saved", "title": "Onion epidermis"})
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "saved" and body["title"] == "Onion epidermis"
    assert body["saved_at"] is not None and body["expires_at"] is None
    row = fake.rows[experiment_id]
    assert row["status"] == "saved" and row["expires_at"] is None


def test_resaving_keeps_saved_at(client, fake):
    experiment_id = fake.add_saved(USER_A, saved_at="2026-10-01T09:00:00+00:00")
    response = patch(client, experiment_id, {"status": "saved", "notes": "Second look."})
    assert response.status_code == 200
    assert datetime.fromisoformat(response.json()["saved_at"]) == datetime.fromisoformat("2026-10-01T09:00:00+00:00")
    assert fake.rows[experiment_id]["notes"] == "Second look."


def test_save_without_title_is_422(client, fake):
    experiment_id = fake.add_draft(USER_A)
    response = patch(client, experiment_id, {"status": "saved"})
    assert response.status_code == 422
    assert response.json() == {"detail": "A title is required to save."}
    assert fake.rows[experiment_id]["status"] == "draft"


def test_saved_cap_is_409(client, fake):
    use_settings(max_saved_experiments_per_user=2)
    for _ in range(2):
        fake.add_saved(USER_A)
    for _ in range(3):
        fake.add_saved(USER_B)  # Other users' saved experiments do not count.
    experiment_id = fake.add_draft(USER_A, title="Onion")
    response = patch(client, experiment_id, {"status": "saved"})
    assert response.status_code == 409
    assert response.json() == {"detail": "Too many saved experiments. Delete one first."}
    assert fake.rows[experiment_id]["status"] == "draft"
    (call,) = fake.by("POST", "/rest/v1/rpc/update_experiment")
    assert json.loads(call.content)["p_max_saved"] == 2


@pytest.mark.parametrize("target", ["other_user", "missing", "expired"])
def test_patch_not_found(client, fake, target):
    if target == "other_user":
        experiment_id = fake.add_draft(USER_B, title="Theirs")
    elif target == "expired":
        experiment_id = fake.add_draft(USER_A, title="Theirs", expires_in=timedelta(seconds=-1))
    else:
        experiment_id = str(uuid.uuid4())
    response = patch(client, experiment_id, {"title": "Mine now"})
    assert response.status_code == 404 and response.json() == NOT_FOUND
    if target != "missing":
        assert fake.rows[experiment_id]["title"] == "Theirs"
    assert_scoped(fake.requests, USER_A, USER_B)


def test_patch_non_uuid_is_404_without_supabase(client, fake):
    for bad in ("not-a-uuid", "1"):
        response = patch(client, bad, {"title": "x"})
        assert response.status_code == 404 and response.json() == NOT_FOUND
    assert fake.requests == []


@pytest.mark.parametrize("body", [
    {}, {"title": None, "notes": None}, {"title": "x" * 121}, {"title": "   "}, {"notes": "x" * 5001},
    {"status": "draft"}, {"title": "ok", "user_id": USER_B}, [],
    {"title": "a\x00b"}, {"title": "two\nlines"}, {"notes": "a\x00b"}, {"notes": "bell\x07"},
    # Invisible or reordering characters: right-to-left override, zero-width space, C1 next line,
    # line separator.
    {"title": "file‮txt.exe"}, {"title": "zero​width"}, {"title": "c1\x85next"}, {"title": "line sep"},
])
def test_patch_invalid_body_is_422_without_supabase(client, fake, body):
    experiment_id = fake.add_draft(USER_A)
    assert patch(client, experiment_id, body).status_code == 422
    assert fake.requests == []


def test_patch_accepts_maximum_lengths(client, fake):
    experiment_id = fake.add_draft(USER_A)
    response = patch(client, experiment_id, {"title": "t" * 120, "notes": "n" * 5000})
    assert response.status_code == 200


# --- delete --------------------------------------------------------------------------


def delete(client, experiment_id, user="A"):
    return client.delete(f"/v1/experiments/{experiment_id}", headers=auth(user))


def test_delete_own_experiment(client, fake):
    experiment_id = fake.add_saved(USER_A)
    fake.store_objects(experiment_id)
    response = delete(client, experiment_id)
    assert response.status_code == 204 and response.content == b""
    assert experiment_id not in fake.rows and fake.objects == {}
    (row_delete,) = fake.by("DELETE", "/rest/v1/experiments")
    (object_delete,) = fake.by("DELETE", "/storage/")
    assert fake.requests.index(row_delete) < fake.requests.index(object_delete)
    assert row_delete.url.params["id"] == f"eq.{experiment_id}"
    assert row_delete.url.params["user_id"] == f"eq.{USER_A}"
    assert json.loads(object_delete.content)["prefixes"] == [
        f"{USER_A}/{experiment_id}/image.jpg", f"{USER_A}/{experiment_id}/thumb.jpg"]


def test_delete_other_users_experiment_is_404(client, fake):
    experiment_id = fake.add_saved(USER_B)
    fake.store_objects(experiment_id)
    response = delete(client, experiment_id)
    assert response.status_code == 404 and response.json() == NOT_FOUND
    assert experiment_id in fake.rows and len(fake.objects) == 2
    assert_scoped(fake.requests, USER_A, USER_B)


def test_delete_missing_and_non_uuid(client, fake):
    assert delete(client, uuid.uuid4()).json() == NOT_FOUND
    fake.requests.clear()
    for bad in ("not-a-uuid", "1"):
        response = delete(client, bad)
        assert response.status_code == 404 and response.json() == NOT_FOUND
    assert fake.requests == []


def test_delete_expired_draft_is_204(client, fake):
    experiment_id = fake.add_draft(USER_A, expires_in=timedelta(seconds=-1))
    assert delete(client, experiment_id).status_code == 204
    assert experiment_id not in fake.rows


def test_delete_storage_failure_still_204(client, fake, caplog):
    experiment_id = fake.add_saved(USER_A)
    fake.store_objects(experiment_id)
    fake.fail["delete"] = 500
    with caplog.at_level(logging.WARNING):
        assert delete(client, experiment_id).status_code == 204
    assert experiment_id not in fake.rows and len(fake.objects) == 2
    assert "Logbook cleanup failed op=delete objects=2" in caplog.text
    assert experiment_id not in caplog.text and USER_A not in caplog.text


def test_delete_retry_removes_leftover_objects(client, fake):
    experiment_id = fake.add_saved(USER_A)
    fake.store_objects(experiment_id)
    fake.fail["delete"] = 500
    assert delete(client, experiment_id).status_code == 204
    fake.fail.clear()
    assert delete(client, experiment_id).status_code == 404
    assert fake.objects == {}


@pytest.mark.parametrize("failure", [500, "transport"])
def test_delete_row_failure_is_503_and_keeps_objects(client, fake, failure):
    experiment_id = fake.add_saved(USER_A)
    fake.store_objects(experiment_id)
    fake.fail["delete_experiment"] = failure
    response = delete(client, experiment_id)
    assert response.status_code == 503 and response.json() == UNAVAILABLE
    assert fake.by("DELETE", "/storage/") == []
    assert experiment_id in fake.rows and len(fake.objects) == 2


@pytest.mark.parametrize("rows", [[{"id": "other"}], [{"id": "same"}, {"id": "same"}], {"id": "same"}])
def test_delete_wrong_response_is_503_and_keeps_objects(client, fake, rows):
    experiment_id = fake.add_saved(USER_A)
    fake.store_objects(experiment_id)
    other = str(uuid.uuid4())
    substitute = {"other": other, "same": experiment_id}
    if isinstance(rows, list):
        rows = [{"id": substitute[row["id"]]} for row in rows]
    else:
        rows = {"id": substitute[rows["id"]]}
    fake.delete_body = json.dumps(rows).encode()
    response = delete(client, experiment_id)
    assert response.status_code == 503 and response.json() == UNAVAILABLE
    assert fake.by("DELETE", "/storage/") == []
    assert len(fake.objects) == 2


def test_patch_wrong_id_response_is_503(client, fake):
    experiment_id = fake.add_draft(USER_A, title="Mine")
    other = fake.add_draft(USER_A, title="Other")  # Same user, valid paths, different id.
    fake.update_body = json.dumps({"result": "ok", "row": fake.rows[other]}).encode()
    response = patch(client, experiment_id, {"notes": "x"})
    assert response.status_code == 503 and response.json() == UNAVAILABLE
    assert fake.by("POST", "/storage/v1/object/sign/") == []


def test_patch_accepts_multiline_notes(client, fake):
    experiment_id = fake.add_draft(USER_A)
    response = patch(client, experiment_id, {"notes": "Line one\nLine two\twith a tab\r\n"})
    assert response.status_code == 200
    assert fake.rows[experiment_id]["notes"] == "Line one\nLine two\twith a tab\r\n"


# --- purge of expired drafts ---------------------------------------------------------


def expired_draft(fake, user_id=USER_A, ago=timedelta(minutes=10)):
    # Past the 5-minute purge margin (logbook.PURGE_GRACE) unless ago says otherwise.
    experiment_id = fake.add_draft(user_id, expires_in=-ago)
    fake.store_objects(experiment_id)
    return experiment_id


def test_purge_margin_keeps_recently_expired_drafts(client, fake):
    recent = expired_draft(fake, ago=timedelta(minutes=1))
    old = expired_draft(fake)
    body = list_page(client).json()
    assert body["items"] == []  # Both are hidden from the list at once.
    assert recent in fake.rows and old not in fake.rows
    assert sorted(fake.objects) == sorted([fake.rows[recent]["image_path"], fake.rows[recent]["thumb_path"]])
    (select,) = [r for r in fake.by("GET", "/rest/v1/experiments") if r.url.params.get("order") == "expires_at.asc"]
    cutoff = datetime.fromisoformat(select.url.params["expires_at"].removeprefix("lte."))
    assert timedelta(minutes=4, seconds=50) < now() - cutoff <= timedelta(minutes=5, seconds=10)


def test_purge_delete_response_lost_still_removes_images(client, fake, caplog):
    experiment_id = expired_draft(fake)
    fake.fail["purge_delete"] = "after_commit"
    with caplog.at_level(logging.WARNING):
        assert list_page(client).status_code == 200
    assert experiment_id not in fake.rows and fake.objects == {}
    (recheck,) = [r for r in fake.by("GET", "/rest/v1/experiments") if r.url.params.get("id", "").startswith("in.")]
    assert recheck.url.params["user_id"] == f"eq.{USER_A}"
    assert "Logbook purge failed op=delete" in caplog.text
    assert experiment_id not in caplog.text and USER_A not in caplog.text


def test_purge_delete_failure_keeps_images_of_remaining_rows(client, fake):
    experiment_id = expired_draft(fake)
    fake.fail["purge_delete"] = 500
    assert list_page(client).status_code == 200
    assert experiment_id in fake.rows and len(fake.objects) == 2
    assert fake.by("DELETE", "/storage/") == []


def test_purge_recheck_failure_keeps_images(client, fake, caplog):
    experiment_id = expired_draft(fake)
    fake.fail["purge_delete"] = "after_commit"
    fake.fail["purge_recheck"] = 500
    with caplog.at_level(logging.WARNING):
        assert list_page(client).status_code == 200
    assert "Logbook purge failed op=recheck" in caplog.text
    assert experiment_id not in fake.rows and len(fake.objects) == 2  # Orphaned until a sweeper exists.
    assert fake.by("DELETE", "/storage/") == []


def test_list_purges_callers_expired_drafts(client, fake):
    expired = [expired_draft(fake) for _ in range(2)]
    other = expired_draft(fake, USER_B)
    live = fake.add_draft(USER_A)
    fake.store_objects(live)
    assert list_page(client).status_code == 200
    assert all(experiment_id not in fake.rows for experiment_id in expired)
    assert other in fake.rows and live in fake.rows
    assert sorted(fake.objects) == sorted(
        [fake.rows[other]["image_path"], fake.rows[other]["thumb_path"],
         fake.rows[live]["image_path"], fake.rows[live]["thumb_path"]])
    (purge,) = [r for r in fake.by("DELETE", "/rest/v1/experiments") if r.url.params["id"].startswith("in.")]
    assert purge.url.params["user_id"] == f"eq.{USER_A}"
    assert purge.url.params["status"] == "eq.draft"
    assert purge.url.params["expires_at"].startswith("lte.")
    assert_scoped(fake.requests, USER_A, USER_B)


def test_create_purges_expired_drafts(client, fake):
    experiment_id = expired_draft(fake)
    assert create(client).status_code == 201
    assert experiment_id not in fake.rows
    assert len(fake.objects) == 2  # Only the new experiment's images remain.


def test_purge_is_bounded(client, fake):
    for _ in range(7):
        expired_draft(fake)
    list_page(client)
    (select,) = [r for r in fake.by("GET", "/rest/v1/experiments") if "order" in r.url.params
                 and r.url.params["order"] == "expires_at.asc"]
    assert select.url.params["limit"] == "5"
    assert len(fake.rows) == 2


def test_purge_keeps_a_draft_saved_meanwhile(client, fake):
    experiment_id = expired_draft(fake)

    def save():
        fake.rows[experiment_id].update(status="saved", title="Kept", saved_at=now().isoformat(), expires_at=None)

    fake.hooks["purge_delete"] = save
    assert list_page(client).status_code == 200
    assert fake.rows[experiment_id]["status"] == "saved"
    assert len(fake.objects) == 2 and fake.by("DELETE", "/storage/") == []


@pytest.mark.parametrize("op,label", [("purge_select", "select"), ("purge_delete", "delete"), ("delete", "objects")])
def test_purge_failure_does_not_affect_list(client, fake, caplog, op, label):
    experiment_id = expired_draft(fake)
    fake.fail[op] = 500
    with caplog.at_level(logging.WARNING):
        response = list_page(client)
    assert response.status_code == 200
    assert f"Logbook purge failed op={label}" in caplog.text
    assert experiment_id not in caplog.text and USER_A not in caplog.text


# --- new routes: auth, limits, logs --------------------------------------------------


def test_new_routes_need_bearer(client, fake):
    experiment_id = uuid.uuid4()
    assert client.get("/v1/experiments").status_code == 401
    assert client.patch(f"/v1/experiments/{experiment_id}", json={"title": "x"}).status_code == 401
    assert client.delete(f"/v1/experiments/{experiment_id}").status_code == 401
    assert client.post(f"/v1/experiments/{experiment_id}/ask", json={"question": "Why?"}).status_code == 401
    assert client.post(f"/v1/experiments/{experiment_id}/quiz").status_code == 401
    assert fake.requests == []


def test_patch_body_limit(client, fake):
    use_settings(max_json_body_bytes=100)
    response = client.patch(f"/v1/experiments/{uuid.uuid4()}", json={"notes": "x" * 200}, headers=auth())
    assert response.status_code == 413
    assert fake.requests == []


def test_list_patch_delete_never_log_ids_or_urls(client, fake, caplog):
    experiment_id = fake.add_draft(USER_A, title="Onion")
    fake.store_objects(experiment_id)
    with caplog.at_level(logging.DEBUG):
        page = list_page(client).json()
        list_page(client, limit=1, cursor=cursor_of(json.dumps({"c": now().isoformat(), "i": experiment_id})))
        patch(client, experiment_id, {"status": "saved"})
        delete(client, experiment_id)
        delete(client, experiment_id)
    assert page["items"][0]["thumb_url"]
    for private in (SUPABASE_URL, USER_A, experiment_id, page["items"][0]["thumb_url"], "token="):
        assert private not in caplog.text


# --- experiment ask and quiz ---------------------------------------------------------


STORED_MARKER = "Stored marker-a91e"
STORED = {**RESULT, "probable_specimen": f"{STORED_MARKER} specimen"}
CLIENT_MARKER = "Client marker-77b0"
QUESTION = "Why are the cells rectangular?"
ANSWER = "Plant cells have rigid walls."
QUIZ = {"questions": [
    {"question": f"Question {n}?", "options": ["Cell wall", "Nucleus", "Vacuole", "Chloroplast"],
     "correct_answer": "Cell wall", "explanation": "Walls outline each cell."}
    for n in (1, 2, 3)
]}
ACTIONS = ("ask", "quiz")
TOO_LONG = {"detail": "This experiment's analysis is too long for follow-up questions."}


def follow_up(client, action, experiment_id, user="A", question=QUESTION, **kwargs):
    path = f"/v1/experiments/{experiment_id}/{action}"
    if action == "ask":
        kwargs.setdefault("json", {"question": question})
    return client.post(path, headers=kwargs.pop("headers", auth(user)), **kwargs)


def quota_calls(fake):
    return fake.by("POST", "/rest/v1/rpc/consume_gemini_call")


@pytest.fixture
def answers(sdk):
    """The mocked SDK answers ask with ANSWER and quiz with QUIZ, told apart by the system prompt."""
    def respond(*, model, contents, config):
        if config.system_instruction == gemini.QUIZ_PROMPT:
            return SimpleNamespace(text=json.dumps(QUIZ))
        assert config.system_instruction == gemini.ASK_PROMPT
        return SimpleNamespace(text=ANSWER)

    sdk.side_effect = respond
    return sdk


def test_user_daily_gemini_limit_default():
    assert Settings.model_fields["user_daily_gemini_limit"].default == 40


@pytest.mark.parametrize("action", ACTIONS)
@pytest.mark.parametrize("add", ["add_draft", "add_saved"])
def test_follow_up_on_own_experiment_uses_stored_analysis(client, fake, answers, action, add):
    experiment_id = getattr(fake, add)(USER_A, analysis=STORED)
    fake.store_objects(experiment_id)
    rows, objects = json.loads(json.dumps(fake.rows)), dict(fake.objects)
    response = follow_up(client, action, experiment_id)
    assert response.status_code == 200
    assert response.json() == ({"answer": ANSWER, "sources": []} if action == "ask" else QUIZ)

    (quota,) = quota_calls(fake)
    assert json.loads(quota.content) == {"p_user": USER_A, "p_limit": settings().user_daily_gemini_limit}
    assert answers.call_count == 1
    call = answers.call_args.kwargs
    assert call["config"].system_instruction == (gemini.ASK_PROMPT if action == "ask" else gemini.QUIZ_PROMPT)
    assert StoredAnalysis.model_validate(STORED).model_dump_json() in call["contents"]
    assert (QUESTION in call["contents"]) == (action == "ask")

    # Nothing is persisted: one read and one quota call, rows and objects unchanged.
    assert [(r.method, r.url.path) for r in fake.requests] == [
        ("GET", "/rest/v1/experiments"), ("POST", "/rest/v1/rpc/consume_gemini_call")]
    assert fake.rows == rows and fake.objects == objects
    assert_scoped(fake.requests, USER_A, USER_B)


def test_quiz_ignores_a_client_supplied_analysis(client, fake, answers):
    experiment_id = fake.add_draft(USER_A, analysis=STORED)
    client_analysis = {**RESULT, "probable_specimen": CLIENT_MARKER}
    response = follow_up(client, "quiz", experiment_id, json={"analysis": client_analysis})
    assert response.status_code == 200
    contents = answers.call_args.kwargs["contents"]
    assert STORED_MARKER in contents and CLIENT_MARKER not in contents


def test_ask_rejects_a_client_supplied_analysis(client, fake, answers):
    experiment_id = fake.add_draft(USER_A, analysis=STORED)
    response = follow_up(client, "ask", experiment_id,
                         json={"question": QUESTION, "analysis": {**RESULT, "probable_specimen": CLIENT_MARKER}})
    assert response.status_code == 422
    assert fake.requests == []
    assert answers.call_count == 0


@pytest.mark.parametrize("body", [{"question": ""}, {"question": "   "}, {"question": "x" * 501}, {}, {"question": None}])
def test_ask_invalid_question_is_422_without_supabase(client, fake, answers, body):
    response = follow_up(client, "ask", fake.add_draft(USER_A), json=body)
    assert response.status_code == 422
    assert fake.requests == []
    assert answers.call_count == 0


def test_ask_accepts_a_500_char_question(client, fake, answers):
    response = follow_up(client, "ask", fake.add_draft(USER_A), question="x" * 500)
    assert response.status_code == 200
    assert "x" * 500 in answers.call_args.kwargs["contents"]


@pytest.mark.parametrize("action", ACTIONS)
def test_follow_up_on_other_users_experiment_is_404(client, fake, answers, action):
    experiment_id = fake.add_draft(USER_A, analysis=STORED)
    stolen = follow_up(client, action, experiment_id, user="B")
    missing = follow_up(client, action, uuid.uuid4(), user="B")
    assert stolen.status_code == missing.status_code == 404
    assert stolen.json() == missing.json() == NOT_FOUND
    assert quota_calls(fake) == []
    assert answers.call_count == 0
    assert_scoped(fake.requests, USER_B, USER_A)
    assert STORED_MARKER not in stolen.text


@pytest.mark.parametrize("action", ACTIONS)
def test_follow_up_non_uuid_is_404_without_supabase(client, fake, answers, action):
    for bad in ("not-a-uuid", "1"):
        response = follow_up(client, action, bad)
        assert response.status_code == 404 and response.json() == NOT_FOUND
    assert fake.requests == []
    assert answers.call_count == 0


@pytest.mark.parametrize("action", ACTIONS)
def test_follow_up_on_expired_draft_is_404(client, fake, answers, action):
    experiment_id = fake.add_draft(USER_A, expires_in=timedelta(seconds=-1))
    response = follow_up(client, action, experiment_id)
    assert response.status_code == 404 and response.json() == NOT_FOUND
    assert quota_calls(fake) == []
    assert answers.call_count == 0


@pytest.mark.parametrize("action", ACTIONS)
@pytest.mark.parametrize("tamper", ["foreign_path", "dotdot_path", "foreign_user"])
def test_follow_up_refuses_foreign_rows(client, fake, answers, action, tamper):
    experiment_id = fake.add_draft(USER_A, analysis=STORED)
    if tamper == "foreign_user":
        fake.get_body = json.dumps([{**fake.rows[experiment_id], "user_id": USER_B}]).encode()
    else:
        fake.rows[experiment_id]["image_path"] = (
            f"{USER_B}/x/image.jpg" if tamper == "foreign_path" else f"{USER_A}/../{USER_B}/x/image.jpg")
    response = follow_up(client, action, experiment_id)
    assert response.status_code == 503 and response.json() == UNAVAILABLE
    assert quota_calls(fake) == []
    assert answers.call_count == 0
    assert fake.by("POST", "/storage/v1/object/sign/") == []


@pytest.mark.parametrize("action", ACTIONS)
def test_follow_up_unparsable_stored_analysis_is_503(client, fake, answers, action):
    broken = {key: value for key, value in STORED.items() if key != "limitations"}
    response = follow_up(client, action, fake.add_draft(USER_A, analysis=broken))
    assert response.status_code == 503 and response.json() == UNAVAILABLE
    assert quota_calls(fake) == []
    assert answers.call_count == 0


@pytest.mark.parametrize("action", ACTIONS)
@pytest.mark.parametrize("analysis", [
    analysis_of_size(MAX_STORED_ANALYSIS_BYTES + 1, STORED),
    {**STORED, "observations": ["Rectangular cells"] * 41},
], ids=["total_size", "41_observations"])
def test_follow_up_over_cap_stored_analysis_is_422(client, fake, answers, caplog, action, analysis):
    experiment_id = fake.add_draft(USER_A, analysis=analysis)
    with caplog.at_level(logging.DEBUG):
        response = follow_up(client, action, experiment_id)
    assert response.status_code == 422 and response.json() == TOO_LONG
    assert quota_calls(fake) == []
    assert answers.call_count == 0
    assert "Logbook stored analysis rejected reason=too_long" in caplog.text
    for private in (STORED_MARKER, USER_A, experiment_id):
        assert private not in caplog.text


@pytest.mark.parametrize("action", ACTIONS)
def test_follow_up_analysis_at_cap_is_accepted(client, fake, answers, action):
    analysis = analysis_of_size(MAX_STORED_ANALYSIS_BYTES, STORED)
    response = follow_up(client, action, fake.add_draft(USER_A, analysis=analysis))
    assert response.status_code == 200
    assert StoredAnalysis.model_validate(analysis).model_dump_json() in answers.call_args.kwargs["contents"]


@pytest.mark.parametrize("action", ACTIONS)
def test_follow_up_per_user_daily_cap(client, fake, answers, action):
    fake.quota_body = b"false"
    response = follow_up(client, action, fake.add_draft(USER_A))
    assert response.status_code == 429
    assert response.json() == DAILY_LIMIT
    assert 0 < int(response.headers["retry-after"]) <= 86400
    assert answers.call_count == 0


@pytest.mark.parametrize("action", ACTIONS)
@pytest.mark.parametrize("quota_body", [b"null", b'"true"', b"[true]", b"{}", b"1", b"not json"])
def test_follow_up_quota_fails_closed_on_non_boolean(client, fake, answers, action, quota_body):
    fake.quota_body = quota_body
    assert follow_up(client, action, fake.add_draft(USER_A)).status_code == 429
    assert answers.call_count == 0


@pytest.mark.parametrize("action", ACTIONS)
def test_follow_up_quota_rpc_failure_is_503(client, fake, answers, action):
    fake.fail["rpc"] = 500
    response = follow_up(client, action, fake.add_draft(USER_A))
    assert response.status_code == 503 and response.json() == UNAVAILABLE
    assert answers.call_count == 0


@pytest.mark.parametrize("action", ACTIONS)
@pytest.mark.parametrize("failure,status", [
    (errors.ServerError(500, {"error": {"message": "provider detail"}}), 502),
    (httpx.ReadTimeout("provider detail"), 504),
], ids=["server_error", "timeout"])
def test_follow_up_gemini_failure_still_costs_quota(client, fake, sdk, action, failure, status):
    sdk.side_effect = failure
    response = follow_up(client, action, fake.add_draft(USER_A))
    assert response.status_code == status
    assert "provider detail" not in response.text
    assert len(quota_calls(fake)) == 1
    assert sdk.call_count == 1


@pytest.mark.parametrize("action", ACTIONS)
def test_follow_up_global_daily_cap_is_503_and_costs_quota(client, fake, answers, action):
    exhaust_global_cap()
    response = follow_up(client, action, fake.add_draft(USER_A))
    assert response.status_code == 503
    assert response.json()["detail"].startswith("Daily Gemini request limit for this server")
    assert 0 < int(response.headers["retry-after"]) <= 86400
    assert len(quota_calls(fake)) == 1
    assert answers.call_count == 0


def test_follow_up_body_limit_is_the_json_limit(client, fake, answers):
    use_settings(max_json_body_bytes=100)
    response = follow_up(client, "ask", uuid.uuid4(), json={"question": "x" * 200})
    assert response.status_code == 413
    assert response.json() == {"detail": "Request body exceeds the 100-byte limit."}
    assert fake.requests == []
    assert answers.call_count == 0


@pytest.mark.parametrize("action", ACTIONS)
def test_follow_up_needs_app_token_when_set(client, fake, answers, action):
    use_settings(app_token="dummy-app-token-for-tests")
    response = follow_up(client, action, fake.add_draft(USER_A))
    assert response.status_code == 401 and response.json() == {"detail": "Unauthorized client."}
    accepted = follow_up(client, action, fake.add_draft(USER_A),
                         headers={**auth(), "X-ScopePilot-Token": "dummy-app-token-for-tests"})
    assert accepted.status_code == 200
    assert len(quota_calls(fake)) == 1


def test_quiz_without_a_body(client, fake, answers):
    response = client.post(f"/v1/experiments/{fake.add_draft(USER_A)}/quiz", headers=auth())
    assert response.status_code == 200 and response.json() == QUIZ


def test_follow_up_bearer_rejection_logs_templated_paths(client, fake, caplog):
    experiment_id = str(uuid.uuid4())
    with caplog.at_level(logging.DEBUG):
        client.post(f"/v1/experiments/{experiment_id}/ask", json={"question": QUESTION})
        client.post(f"/v1/experiments/{experiment_id}/quiz")
    app_lines = [r.getMessage() for r in caplog.records if r.name.startswith("app")]
    assert "Request rejected rule=bearer path=/v1/experiments/{id}/ask reason=missing" in app_lines
    assert "Request rejected rule=bearer path=/v1/experiments/{id}/quiz reason=missing" in app_lines
    assert not any(experiment_id in line for line in app_lines)


@pytest.mark.parametrize("action", ACTIONS)
def test_follow_up_never_logs_private_values(client, fake, sdk, caplog, action):
    experiment_id = fake.add_draft(USER_A, analysis=STORED)
    responses = {}

    def respond(*, model, contents, config):
        return SimpleNamespace(text=json.dumps(QUIZ) if action == "quiz" else ANSWER)

    with caplog.at_level(logging.DEBUG):
        sdk.side_effect = respond
        responses["ok"] = follow_up(client, action, experiment_id)
        responses["other_user"] = follow_up(client, action, experiment_id, user="B")
        responses["too_long"] = follow_up(client, action, fake.add_draft(
            USER_A, analysis={**STORED, "observations": ["Rectangular cells"] * 41}))
        sdk.side_effect = errors.ServerError(500, {"error": {"message": "provider detail"}})
        responses["gemini"] = follow_up(client, action, experiment_id)
        fake.quota_body = b"false"
        responses["quota"] = follow_up(client, action, experiment_id)
    assert {name: r.status_code for name, r in responses.items()} == {
        "ok": 200, "other_user": 404, "too_long": 422, "gemini": 502, "quota": 429}
    for private in (STORED_MARKER, SUPABASE_URL, USER_A, USER_B, experiment_id, QUESTION):
        assert private not in caplog.text


# --- /v1/me usage --------------------------------------------------------------------


def freeze(monkeypatch, utc, local):
    """Freeze logbook's clock: now(tz) is the instant utc, now() is a naive local time on another date."""
    class Frozen(datetime):
        @classmethod
        def now(cls, tz=None):
            return local if tz is None else utc.astimezone(tz)

    monkeypatch.setattr(logbook, "datetime", Frozen)


def me(client, user="A"):
    response = client.get("/v1/me", headers=auth(user))
    assert response.status_code == 200
    return response.json()["usage"]


def usage_requests(fake):
    return fake.by("GET", "/rest/v1/usage_daily")


def test_me_usage_without_a_row(client, fake):
    limit = settings().user_daily_gemini_limit
    assert {k: v for k, v in me(client).items() if k != "resets_at"} == {
        "used_today": 0, "daily_limit": limit, "remaining": limit}
    (request,) = fake.requests
    assert request.method == "GET" and request.url.path == "/rest/v1/usage_daily"
    assert dict(request.url.params) == {"select": "user_id,gemini_calls", "user_id": f"eq.{USER_A}",
                                        "day": f"eq.{now().date().isoformat()}"}
    assert "authorization" not in request.headers and "token-A" not in str(request.headers)


def test_me_usage_request_uses_the_short_timeout(client, fake):
    me(client)
    (request,) = usage_requests(fake)
    assert request.extensions["timeout"] == dict.fromkeys(("connect", "read", "write", "pool"),
                                                          logbook.USAGE_TIMEOUT_SECONDS)
    assert logbook.USAGE_TIMEOUT_SECONDS == 3


@pytest.mark.parametrize("used,limit,remaining", [(7, 10, 3), (10, 10, 0), (45, 10, 0)])
def test_me_usage_counts(client, fake, used, limit, remaining):
    use_settings(user_daily_gemini_limit=limit)
    fake.usage[(USER_A, now().date().isoformat())] = used
    fake.usage[(USER_B, now().date().isoformat())] = 1  # Another user's row is never read.
    fake.usage[(USER_A, (now().date() - timedelta(days=1)).isoformat())] = 9  # Nor yesterday's.
    usage = me(client)
    assert (usage["used_today"], usage["daily_limit"], usage["remaining"]) == (used, limit, remaining)
    assert_scoped(fake.requests, USER_A, USER_B)


@pytest.mark.parametrize("utc,local,day,resets_at", [
    (datetime(2026, 10, 12, 23, 59, 30, tzinfo=timezone.utc), datetime(2026, 10, 13, 4, 59, 30),
     "2026-10-12", datetime(2026, 10, 13, tzinfo=timezone.utc)),
    (datetime(2026, 10, 13, 0, 0, 30, tzinfo=timezone.utc), datetime(2026, 10, 12, 19, 0, 30),
     "2026-10-13", datetime(2026, 10, 14, tzinfo=timezone.utc)),
    (datetime(2026, 10, 12, 12, 0, tzinfo=timezone.utc), datetime(2026, 10, 11, 12, 0),
     "2026-10-12", datetime(2026, 10, 13, tzinfo=timezone.utc)),
], ids=["before_midnight", "after_midnight", "midday"])
def test_me_usage_uses_the_utc_day(client, fake, monkeypatch, utc, local, day, resets_at):
    freeze(monkeypatch, utc, local)
    fake.usage[(USER_A, day)] = 4
    usage = me(client)
    assert usage["used_today"] == 4
    (request,) = usage_requests(fake)
    assert request.url.params["day"] == f"eq.{day}"
    parsed = datetime.fromisoformat(usage["resets_at"])
    assert parsed == resets_at and parsed.utcoffset() == timedelta(0)


@pytest.mark.parametrize("body", [
    json.dumps([{"user_id": USER_B, "gemini_calls": 1}]).encode(),
    json.dumps([{"user_id": USER_A, "gemini_calls": True}]).encode(),
    json.dumps([{"user_id": USER_A, "gemini_calls": -1}]).encode(),
    json.dumps([{"user_id": USER_A, "gemini_calls": "3"}]).encode(),
    json.dumps([{"user_id": USER_A, "gemini_calls": 1.5}]).encode(),
    json.dumps([{"user_id": USER_A, "gemini_calls": None}]).encode(),
    json.dumps([{"user_id": USER_A, "gemini_calls": 1}] * 2).encode(),
    b"{}",
    b"[1]",
    b"not json",
], ids=["foreign_user", "bool", "negative", "string", "float", "null", "two_rows", "object", "not_a_row", "not_json"])
def test_me_usage_bad_response_is_null(client, fake, caplog, body):
    fake.usage_body = body
    with caplog.at_level(logging.DEBUG):
        assert me(client) is None
    assert "Logbook usage read failed op=usage status=bad_response" in caplog.text
    for private in (USER_A, USER_B, SUPABASE_URL, SECRET):
        assert private not in caplog.text


def raise_timeout():
    raise httpx.ReadTimeout("fake timeout")


@pytest.mark.parametrize("failure", [500, "transport", "timeout"])
def test_me_usage_read_failure_is_200_with_null_usage(client, fake, caplog, failure):
    if failure == "timeout":
        fake.hooks["usage"] = raise_timeout
    else:
        fake.fail["usage"] = failure
    with caplog.at_level(logging.DEBUG):
        response = client.get("/v1/me", headers=auth())
    assert response.status_code == 200
    assert response.json() == {"user_id": USER_A, "email": None, "usage": None}
    assert "Logbook usage read failed op=usage status=request" in caplog.text
    for private in (USER_A, SUPABASE_URL, SECRET):
        assert private not in caplog.text


def test_me_usage_counts_experiment_ask_and_quiz(client, fake, sdk):
    sdk.side_effect = lambda *, model, contents, config: SimpleNamespace(
        text=json.dumps(QUIZ) if config.system_instruction == gemini.QUIZ_PROMPT else ANSWER)
    limit = settings().user_daily_gemini_limit
    experiment_id = fake.add_draft(USER_A)
    assert follow_up(client, "ask", experiment_id).status_code == 200
    usage = me(client)
    assert (usage["used_today"], usage["remaining"]) == (1, limit - 1)
    assert follow_up(client, "quiz", experiment_id).status_code == 200
    assert me(client)["used_today"] == 2

    fake.requests.clear()
    assert me(client, user="B")["used_today"] == 0
    assert_scoped(fake.requests, USER_B, USER_A)


def test_me_without_valid_bearer_makes_no_supabase_request(client, fake):
    assert client.get("/v1/me").status_code == 401
    assert client.get("/v1/me", headers=auth("nobody")).status_code == 401
    assert fake.requests == []


# --- display copies ------------------------------------------------------------------


def stored_images(fake, experiment_id):
    row = fake.rows[experiment_id]
    return fake.objects[row["image_path"]], fake.objects[row["thumb_path"]]


def test_display_copies_carry_no_metadata(client, fake):
    experiment_id = create(client, jpeg_with_metadata(), "image/jpeg").json()["id"]
    for data in stored_images(fake, experiment_id):
        for marker in (b"SyntheticCam", b"Exif\x00\x00"):
            assert marker not in data
        with Image.open(BytesIO(data)) as output:
            assert output.format == "JPEG"
            assert not output.getexif()
            assert not output.getexif().get_ifd(0x8825)


def test_mpo_input_is_stored_as_single_frame_jpeg(client, fake, sdk):
    response = create(client, mpo(), "image/jpeg")
    assert response.status_code == 201
    assert sdk.call_args.kwargs["contents"][0].inline_data.mime_type == "image/jpeg"
    for data in stored_images(fake, response.json()["id"]):
        with Image.open(BytesIO(data)) as output:
            assert (output.format, getattr(output, "n_frames", 1)) == ("JPEG", 1)


def copies_of(data, content_type="image/png"):
    cleaned, mime = images.prepare_image(data, content_type, settings())
    return [Image.open(BytesIO(copy)) for copy in images.make_display_copies(cleaned, mime)]


def test_display_copy_sizes():
    display, thumb = copies_of(png((3000, 1000)))
    assert display.size == (2048, 683)
    assert thumb.size == (256, 85)
    small_display, small_thumb = copies_of(png((100, 50)))
    assert small_display.size == (100, 50)  # Never enlarged.
    assert small_thumb.size == (100, 50)


def test_transparent_png_composited_on_white():
    display, thumb = copies_of(png(mode="RGBA", color=(255, 0, 0, 0)))
    assert display.mode == thumb.mode == "RGB"
    assert all(channel > 245 for channel in display.getpixel((4, 4)))


def test_16_bit_grayscale_png():
    image = Image.new("I;16", (8, 8))
    for x in range(8):
        for y in range(8):
            image.putpixel((x, y), 40000)
    stream = BytesIO()
    image.save(stream, format="PNG")
    display, _ = copies_of(stream.getvalue())
    assert display.mode == "RGB"
    assert all(abs(channel - 40000 // 256) <= 3 for channel in display.getpixel((4, 4)))


def test_16_bit_gradient_keeps_tonal_range():
    gradient = Image.new("I;16", (256, 32))
    for x in range(256):
        for y in range(32):
            gradient.putpixel((x, y), x * 257)  # 0 .. 65535 across the width.
    stream = BytesIO()
    gradient.save(stream, format="PNG")
    cleaned, mime = images.prepare_image(stream.getvalue(), "image/png", settings())
    with Image.open(BytesIO(cleaned)) as source:
        assert source.mode == "I;16"  # The 16-bit path really is exercised.
    for data in images.make_display_copies(cleaned, mime):
        with Image.open(BytesIO(data)) as output:
            assert output.format == "JPEG"
            low, high = output.convert("L").getextrema()
            assert low != high
            assert low < 32 and high > 223  # Spans near-black to near-white.


def test_display_copies_busy_lock(monkeypatch):
    monkeypatch.setattr(images, "_DECODE_WAIT_SECONDS", 0.01)
    cleaned, mime = images.prepare_image(png(), "image/png", settings())
    assert images._DECODE_SLOTS.acquire(timeout=1)
    try:
        with pytest.raises(AnalysisError) as error:
            images.make_display_copies(cleaned, mime)
    finally:
        images._DECODE_SLOTS.release()
    assert error.value.status_code == 503
    images.make_display_copies(cleaned, mime)  # The slot was not leaked.


def test_display_copy_over_bucket_limit(monkeypatch):
    monkeypatch.setattr(images, "DISPLAY_MAX_BYTES", 10)
    cleaned, mime = images.prepare_image(png(), "image/png", settings())
    with pytest.raises(AnalysisError) as error:
        images.make_display_copies(cleaned, mime)
    assert error.value.status_code == 413
    assert images._DECODE_SLOTS.acquire(timeout=1)
    images._DECODE_SLOTS.release()


# --- request validation, config, middleware ------------------------------------------


@pytest.mark.parametrize("kwargs", [{}, {"data": {"image": "not a file"}}])
def test_missing_or_non_file_image_is_422(client, fake, sdk, kwargs):
    response = client.post("/v1/experiments", headers=auth(), **kwargs)
    assert response.status_code == 422
    assert fake.requests == []
    assert sdk.call_count == 0


def test_not_configured(client, fake, sdk):
    use_settings(supabase_url="", supabase_secret_key="")
    assert create(client).json() == {"detail": "Logbook not configured."}
    response = client.get(f"/v1/experiments/{uuid.uuid4()}", headers=auth())
    assert response.status_code == 503
    assert response.json() == {"detail": "Logbook not configured."}
    assert client.get("/v1/me", headers=auth()).json() == {"detail": "Logbook not configured."}
    assert fake.requests == []
    assert sdk.call_count == 0


def test_missing_bearer_is_401(client, fake, sdk):
    response = client.post("/v1/experiments", files={"image": ("upload", png(), "image/png")})
    assert response.status_code == 401
    assert response.headers["www-authenticate"] == "Bearer"
    assert client.get(f"/v1/experiments/{uuid.uuid4()}").status_code == 401
    assert fake.requests == []
    assert sdk.call_count == 0


def test_body_limits(client, fake):
    use_settings(max_json_body_bytes=100)
    image = png((64, 64), color="red")
    assert create(client, image).status_code == 201  # Over the JSON limit, within the image limit.
    assert client.post("/v1/me", content=b"x" * 200, headers=auth()).status_code == 413

    use_settings(max_image_bytes=1000)
    oversized = client.post("/v1/experiments", content=b"x" * (1000 + 64 * 1024 + 1),
                            headers={**auth(), "content-type": "multipart/form-data; boundary=x"})
    assert oversized.status_code == 413
    assert oversized.json() == {"detail": f"Request body exceeds the {1000 + 64 * 1024:,}-byte limit."}


def test_experiment_id_never_logged(client, caplog):
    experiment_id = str(uuid.uuid4())
    with caplog.at_level(logging.DEBUG):
        client.get(f"/v1/experiments/{experiment_id}")
    app_lines = [r.getMessage() for r in caplog.records if r.name.startswith("app")]
    assert "Request rejected rule=bearer path=/v1/experiments/{id} reason=missing" in app_lines
    # Only app.* loggers: the test client's own httpx logger prints the URL it requested.
    assert not any(experiment_id in line for line in app_lines)


# --- secrets and signed URLs ---------------------------------------------------------


def test_secret_key_never_leaks(client, fake, caplog):
    responses = []
    with caplog.at_level(logging.DEBUG):
        created = create(client)
        responses += [created, client.get(f"/v1/experiments/{created.json()['id']}", headers=auth())]
        for op, outcome in (("insert", 500), ("count", "transport"), ("rpc", 500), ("get", "transport")):
            fake.fail = {op: outcome}
            responses += [create(client), client.get(f"/v1/experiments/{uuid.uuid4()}", headers=auth())]
    assert all(r.headers["apikey"] == SECRET for r in fake.requests)
    assert all("authorization" not in r.headers for r in fake.requests)
    assert SECRET not in caplog.text
    for response in responses:
        assert SECRET not in response.text
        assert SECRET not in str(response.headers)
    s = settings()
    assert SECRET not in repr(s) and SECRET not in str(s)

    fake.fail = {"count": "transport"}
    with pytest.raises(AnalysisError) as error:
        logbook.count_live_drafts(USER_A, s)
    assert SECRET not in repr(error.value) and SECRET not in str(error.value)
    assert error.value.__cause__ is None and error.value.__suppress_context__


def test_supabase_urls_and_user_ids_never_logged(client, fake, caplog):
    with caplog.at_level(logging.DEBUG):
        experiment_id = create(client).json()["id"]
        client.get(f"/v1/experiments/{experiment_id}", headers=auth())
    assert SUPABASE_URL not in caplog.text
    assert USER_A not in caplog.text and experiment_id not in caplog.text


def test_signed_urls_never_logged(client, fake, caplog):
    with caplog.at_level(logging.DEBUG):
        created = create(client).json()
        read = client.get(f"/v1/experiments/{created['id']}", headers=auth()).json()
    urls = [created["image_url"], created["thumb_url"], read["image_url"], read["thumb_url"]]
    assert all(urls)
    for url in urls:
        assert url not in caplog.text
        assert url.split("token=")[1] not in caplog.text
    assert "token=" not in caplog.text
