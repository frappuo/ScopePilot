"""Logbook create/read (/v1/experiments). Hermetic: Supabase is an httpx.MockTransport fake,
the Gemini SDK is mocked, tokens map to fixed users, and every value is a dummy."""

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

from app.config import Settings, get_settings
from app.main import app
from app.services import gemini, images, logbook
from app.services.auth import AuthenticatedUser, AuthError
from app.services.errors import AnalysisError

KEY = "test-key-not-real"
SUPABASE_URL = "https://example-project.supabase.co"
SECRET = "dummy-supabase-secret-for-tests"
BUCKET = "experiment-images"
USER_A = "0b7c2f1e-4a5d-4c3b-9e8f-1a2b3c4d5e6f"
USER_B = "9e8d7c6b-5a4f-4e3d-8c2b-6f5e4d3c2b1a"
TOKENS = {"token-A": USER_A, "token-B": USER_B}
RESULT = {
    "probable_specimen": "Possible onion epidermis",
    "visible_structures": ["Cell walls"],
    "observations": ["Rectangular cells"],
    "explanation": "Plant cell walls define cell boundaries.",
    "limitations": ["Tentative AI output; verify with an instructor."],
}
NOT_FOUND = {"detail": "Experiment not found."}
UNAVAILABLE = {"detail": "Logbook is temporarily unavailable. Please try again."}


def now():
    return datetime.now(timezone.utc)


class FakeSupabase:
    """In-memory PostgREST + Storage. Records every request; `fail` maps an op to a status or "transport"
    ("insert" also takes "after_commit": the row is stored, then the response is lost)."""

    def __init__(self):
        self.rows: dict[str, dict] = {}
        self.objects: dict[str, bytes] = {}
        self.requests: list[httpx.Request] = []
        self.fail: dict[str, object] = {}
        self.quota_body = b"true"
        self.insert_body: bytes | None = None  # Raw 201 body for the insert; None returns the row.
        self.get_body: bytes | None = None  # Raw 200 body for the experiment GET; None filters rows.
        self.signed = 0

    def add_draft(self, user_id, expires_in=timedelta(hours=1)):
        experiment_id = str(uuid.uuid4())
        self.rows[experiment_id] = {
            "id": experiment_id, "user_id": user_id, "status": "draft", "title": None, "notes": "",
            "analysis": RESULT, "model": "primary", "prompt_version": gemini.PROMPT_VERSION,
            "image_path": f"{user_id}/{experiment_id}/image.jpg", "thumb_path": f"{user_id}/{experiment_id}/thumb.jpg",
            "image_bytes": 1, "created_at": now().isoformat(), "updated_at": now().isoformat(),
            "saved_at": None, "expires_at": (now() + expires_in).isoformat(),
        }
        return experiment_id

    def by(self, method, prefix):
        return [r for r in self.requests if r.method == method and r.url.path.startswith(prefix)]

    def _failure(self, op, request):
        outcome = self.fail.get(op)
        if outcome == "transport":
            raise httpx.ConnectError("fake outage", request=request)
        if outcome:
            return httpx.Response(outcome, json={"message": "fake failure"})
        return None

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        assert request.headers["apikey"] == SECRET
        path, method, params = request.url.path, request.method, request.url.params
        body = json.loads(request.content) if request.headers.get("content-type") == "application/json" else None

        if path == "/rest/v1/rpc/consume_gemini_call":
            return self._failure("rpc", request) or httpx.Response(
                200, content=self.quota_body, headers={"content-type": "application/json"})
        if path == "/rest/v1/experiments" and method == "GET" and "status" in params:
            failure = self._failure("count", request)
            if failure:
                return failure
            cutoff = datetime.fromisoformat(params["expires_at"].removeprefix("gt."))
            live = [r for r in self.rows.values()
                    if f"eq.{r['user_id']}" == params["user_id"] and f"eq.{r['status']}" == params["status"]
                    and datetime.fromisoformat(r["expires_at"]) > cutoff]
            return httpx.Response(200, json=[{"id": r["id"]} for r in live][: int(params["limit"])])
        if path == "/rest/v1/experiments" and method == "GET":
            failure = self._failure("get", request)
            if failure:
                return failure
            if self.get_body is not None:
                return httpx.Response(200, content=self.get_body)
            columns = params["select"].split(",")
            found = [{c: r[c] for c in columns} for r in self.rows.values()
                     if f"eq.{r['id']}" == params["id"] and f"eq.{r['user_id']}" == params["user_id"]]
            return httpx.Response(200, json=found)
        if path == "/rest/v1/experiments" and method == "POST":
            # "after_commit": the row is stored, then the response is lost (timeout or reset).
            committed_then_lost = self.fail.get("insert") == "after_commit"
            failure = None if committed_then_lost else self._failure("insert", request)
            if failure:
                return failure
            row = {"title": None, "notes": "", "saved_at": None,
                   "created_at": now().isoformat(), "updated_at": now().isoformat(), **body}
            self.rows[row["id"]] = row
            if committed_then_lost:
                raise httpx.ReadTimeout("fake lost response", request=request)
            if self.insert_body is not None:
                return httpx.Response(201, content=self.insert_body)
            columns = params["select"].split(",")
            return httpx.Response(201, json=[{c: row[c] for c in columns}])
        if path == "/rest/v1/experiments" and method == "DELETE":
            failure = self._failure("delete_row", request)
            if failure:
                return failure
            for experiment_id in [i for i, r in self.rows.items()
                                  if f"eq.{i}" == params["id"] and f"eq.{r['user_id']}" == params["user_id"]]:
                del self.rows[experiment_id]
            return httpx.Response(204)
        if path == f"/storage/v1/object/sign/{BUCKET}":
            failure = self._failure("sign", request)
            if failure:
                return failure
            signed = []
            for object_path in body["paths"]:
                self.signed += 1
                signed.append({"path": object_path, "error": None,
                               "signedURL": f"/object/sign/{BUCKET}/{object_path}?token=signed-token-{self.signed}"})
            return httpx.Response(200, json=signed)
        if path == f"/storage/v1/object/{BUCKET}" and method == "DELETE":
            failure = self._failure("delete", request)
            if failure:
                return failure
            for prefix in body["prefixes"]:
                self.objects.pop(prefix, None)
            return httpx.Response(200, json=[])
        if path.startswith(f"/storage/v1/object/{BUCKET}/") and method == "POST":
            object_path = path.removeprefix(f"/storage/v1/object/{BUCKET}/")
            failure = self._failure("upload_thumb" if object_path.endswith("thumb.jpg") else "upload_image", request)
            if failure:
                return failure
            self.objects[object_path] = request.content
            return httpx.Response(200, json={"Key": f"{BUCKET}/{object_path}"})
        raise AssertionError(f"unexpected request {method} {path}")


def fake_verify(token, supabase_url):
    if token not in TOKENS:
        raise AuthError("invalid")
    return AuthenticatedUser(user_id=TOKENS[token], email=None)


def settings(**overrides):
    values = {
        "supabase_url": SUPABASE_URL, "supabase_secret_key": SECRET,
        "gemini_model": "primary", "gemini_fallback_models": "fb-1", **overrides,
    }
    return Settings(_env_file=None, gemini_api_key=KEY, **values)


def use_settings(**overrides):
    app.dependency_overrides[get_settings] = lambda: settings(**overrides)


def auth(user="A"):
    return {"Authorization": f"Bearer token-{user}"}


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


def assert_scoped(requests, user_id, other_id):
    """Every request is confined to user_id and never mentions other_id."""
    prefix = f"{user_id}/"
    for request in requests:
        path = request.url.path
        body = json.loads(request.content) if request.headers.get("content-type") == "application/json" else None
        if path == "/rest/v1/experiments" and request.method == "POST":
            assert body["user_id"] == user_id
            assert body["image_path"].startswith(prefix) and body["thumb_path"].startswith(prefix)
        elif path == "/rest/v1/experiments":
            assert request.url.params["user_id"] == f"eq.{user_id}"
        elif path == "/rest/v1/rpc/consume_gemini_call":
            assert body["p_user"] == user_id
        elif path == f"/storage/v1/object/sign/{BUCKET}":
            assert all(p.startswith(prefix) for p in body["paths"])
        elif path == f"/storage/v1/object/{BUCKET}":
            assert all(p.startswith(prefix) for p in body["prefixes"])
        else:
            assert path.startswith(f"/storage/v1/object/{BUCKET}/{prefix}")
        assert other_id not in str(request.url)
        assert other_id.encode() not in request.content


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


def test_row_with_foreign_storage_path_is_refused(client, fake):
    experiment_id = fake.add_draft(USER_A)
    fake.rows[experiment_id]["image_path"] = f"{USER_B}/{experiment_id}/image.jpg"
    response = client.get(f"/v1/experiments/{experiment_id}", headers=auth())
    assert response.status_code == 503
    assert fake.by("POST", "/storage/v1/object/sign/") == []


@pytest.mark.parametrize("where", ["read", "insert"])
def test_row_owned_by_another_user_is_refused(client, fake, where):
    experiment_id = fake.add_draft(USER_A)
    foreign = {**fake.rows[experiment_id], "user_id": USER_B}
    body = json.dumps([foreign]).encode()
    if where == "read":
        fake.get_body = body
        response = client.get(f"/v1/experiments/{experiment_id}", headers=auth())
    else:
        fake.insert_body = body
        response = create(client)
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
    assert response.json() == {"detail": "Daily analysis limit reached for your account. Try again after 00:00 UTC."}
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
    (count,) = [r for r in fake.by("GET", "/rest/v1/experiments") if "status" in r.url.params]
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
    assert fake.by("POST", "/rest/v1/experiments") == []
    assert fake.objects == {} and fake.rows == {}


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
    assert fake.by("POST", "/rest/v1/experiments") == []
    assert fake.rows == {}


def test_unexpected_error_before_insert_cleans_up_and_reraises(client, fake, monkeypatch):
    boom = RuntimeError("synthetic failure")

    def fail(*args, **kwargs):
        raise boom

    monkeypatch.setattr(logbook, "insert_experiment", fail)
    with pytest.raises(RuntimeError) as error:
        create(client)  # TestClient re-raises server exceptions by default.
    assert error.value is boom
    (delete,) = fake.by("DELETE", "/storage/")
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
    (insert,) = fake.by("POST", "/rest/v1/experiments")
    return json.loads(insert.content)["id"]


def test_insert_committed_then_response_lost_deletes_row_then_objects(client, fake):
    fake.fail["insert"] = "after_commit"
    response = create(client)
    assert response.status_code == 503 and response.json() == UNAVAILABLE
    (row_delete,) = fake.by("DELETE", "/rest/v1/experiments")
    (object_delete,) = fake.by("DELETE", "/storage/")
    assert fake.requests.index(row_delete) < fake.requests.index(object_delete)
    assert row_delete.url.params["id"] == f"eq.{inserted_id(fake)}"
    assert row_delete.url.params["user_id"] == f"eq.{USER_A}"
    assert row_delete.headers["prefer"] == "return=minimal"
    assert len(json.loads(object_delete.content)["prefixes"]) == 2
    assert fake.rows == {} and fake.objects == {}


@pytest.mark.parametrize("failure", [500, "transport"])
def test_row_delete_failure_keeps_objects(client, fake, caplog, failure):
    # The row may still exist, so its images must not be deleted out from under it.
    fake.fail["insert"] = "after_commit"
    fake.fail["delete_row"] = failure
    with caplog.at_level(logging.WARNING):
        assert create(client).status_code == 503
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
    assert fake.by("DELETE", "/rest/v1/experiments") == []  # Upload stage: no row delete.
    assert fake.by("POST", "/rest/v1/experiments") == []
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
