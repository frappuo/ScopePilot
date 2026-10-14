"""In-memory Supabase (PostgREST, Storage) for the logbook tests, plus shared users and helpers.
Hermetic: an httpx.MockTransport target, every value a dummy."""

from datetime import datetime, timedelta, timezone
import json
import re
import uuid

import httpx

from app.config import Settings, get_settings
from app.main import app
from app.services import gemini
from app.services.auth import AuthenticatedUser, AuthError

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


def now():
    return datetime.now(timezone.utc)


class FakeSupabase:
    """In-memory PostgREST + Storage, mirroring the SQL in supabase/migrations. Records every request.

    `fail` maps an op to a status or "transport" ("insert" also takes "after_commit": the row is
    stored, then the response is lost). `hooks` maps an op to a callable run just before it, to
    simulate a concurrent request.
    """

    def __init__(self):
        self.rows: dict[str, dict] = {}
        self.objects: dict[str, bytes] = {}
        self.requests: list[httpx.Request] = []
        self.fail: dict[str, object] = {}
        self.hooks: dict[str, object] = {}
        self.quota_body = b"true"
        self.insert_body: bytes | None = None  # Raw body for create_draft; None runs the function.
        self.update_body: bytes | None = None  # Raw body for update_experiment; None runs the function.
        self.discard_body: bytes | None = None  # Raw body for discard_draft; None runs the function.
        self.delete_body: bytes | None = None  # Raw body for the experiment DELETE; None returns the rows.
        self.waits: list[float] = []  # Seconds logbook._wait was asked to sleep.
        self.get_body: bytes | None = None  # Raw 200 body for the experiment GET; None filters rows.
        self.list_extra: list[dict] = []  # Rows appended to every list response.
        self.usage: dict[tuple[str, str], int] = {}  # usage_daily: (user_id, UTC date) -> gemini_calls.
        self.usage_body: bytes | None = None  # Raw 200 body for the usage_daily GET; None filters rows.
        self.signed = 0
        self.list_extra_objects: list[dict] = []  # Entries appended to every storage listing.
        self.delete_noop = False  # The storage delete answers 200 but removes nothing.
        self.list_objects_body: bytes | None = None  # Raw 200 body for the storage list; None lists objects.

    def add_draft(self, user_id, expires_in=timedelta(hours=1), created_at=None, **fields):
        experiment_id = str(uuid.uuid4())
        created = (created_at or now()).isoformat()
        self.rows[experiment_id] = {
            "id": experiment_id, "user_id": user_id, "status": "draft", "title": None, "notes": "",
            "analysis": RESULT, "model": "primary", "prompt_version": gemini.PROMPT_VERSION,
            "image_path": f"{user_id}/{experiment_id}/image.jpg", "thumb_path": f"{user_id}/{experiment_id}/thumb.jpg",
            "image_bytes": 1, "created_at": created, "updated_at": created,
            "saved_at": None, "expires_at": (now() + expires_in).isoformat(), **fields,
        }
        return experiment_id

    def add_saved(self, user_id, title="Onion epidermis", **fields):
        return self.add_draft(user_id, **{"status": "saved", "title": title, "saved_at": now().isoformat(),
                                          "expires_at": None, **fields})

    def store_objects(self, experiment_id):
        row = self.rows[experiment_id]
        for key in ("image_path", "thumb_path"):
            self.objects[row[key]] = b"stored"

    def by(self, method, prefix):
        return [r for r in self.requests if r.method == method and r.url.path.startswith(prefix)]

    def inserts(self):
        return self.by("POST", "/rest/v1/rpc/create_draft")

    def discards(self):
        return self.by("POST", "/rest/v1/rpc/discard_draft")

    @staticmethod
    def _live(row, at):
        return row["status"] == "saved" or datetime.fromisoformat(row["expires_at"]) > at

    def _list(self, params):
        # The exact logic tree list_experiments sends; anything else is a test failure.
        match = re.fullmatch(
            r'\(or\(status\.eq\.saved,expires_at\.gt\."(?P<now>[^"]+)"\)'
            r'(?:,or\(created_at\.lt\."(?P<c>[^"]+)",and\(created_at\.eq\."(?P=c)",id\.lt\.(?P<i>[0-9a-f-]{36})\)\))?\)',
            params["and"])
        assert match, f"unexpected list filter {params['and']}"
        at = datetime.fromisoformat(match["now"])
        rows = [r for r in self.rows.values() if f"eq.{r['user_id']}" == params["user_id"] and self._live(r, at)]
        if match["c"]:
            after = (datetime.fromisoformat(match["c"]), match["i"])
            rows = [r for r in rows if (datetime.fromisoformat(r["created_at"]), r["id"]) < after]
        assert params["order"] == "created_at.desc,id.desc"
        rows.sort(key=lambda r: (datetime.fromisoformat(r["created_at"]), r["id"]), reverse=True)
        selected = []
        for row in rows[: int(params["limit"])]:
            item = {}
            for column in params["select"].split(","):
                alias, _, expression = column.partition(":")
                if expression:
                    assert expression == "analysis->>probable_specimen"
                    item[alias] = row["analysis"]["probable_specimen"]
                else:
                    item[column] = row[column]
            selected.append(item)
        return selected + self.list_extra

    def _list_objects(self, body):
        """One level of the folder body["prefix"] (which must end in "/"), as Storage's list returns
        it: files with an id and metadata, sub-folders with a null id, sorted by name, then offset/limit."""
        prefix = body["prefix"]
        assert prefix.endswith("/") and body["sortBy"] == {"column": "name", "order": "asc"}
        entries: dict[str, dict] = {}
        for key in self.objects:
            if not key.startswith(prefix):
                continue
            name, slash, _ = key.removeprefix(prefix).partition("/")
            entries[name] = {"name": name, "id": None, "metadata": None} if slash else \
                {"name": name, "id": str(uuid.uuid5(uuid.NAMESPACE_URL, key)), "metadata": {"size": 1}}
        page = sorted(entries.values(), key=lambda e: e["name"])[body["offset"]:body["offset"] + body["limit"]]
        return page + self.list_extra_objects

    def _matching(self, params):
        """Rows matched by a DELETE's id (eq. or in.), user_id and optional status/expires_at filters."""
        id_filter = params["id"]
        ids = set(id_filter.removeprefix("in.(").removesuffix(")").split(",")) if id_filter.startswith("in.") \
            else {id_filter.removeprefix("eq.")}
        found = [r for r in self.rows.values() if r["id"] in ids and f"eq.{r['user_id']}" == params["user_id"]]
        if "status" in params:
            found = [r for r in found if f"eq.{r['status']}" == params["status"]]
        if "expires_at" in params:
            cutoff = datetime.fromisoformat(params["expires_at"].removeprefix("lte."))
            found = [r for r in found if r["expires_at"] and datetime.fromisoformat(r["expires_at"]) <= cutoff]
        return found

    def _create_draft(self, request, body):
        committed_then_lost = self.fail.get("insert") == "after_commit"
        failure = None if committed_then_lost else self._failure("insert", request)
        if failure:
            return failure
        user, experiment_id = body["p_user"], body["p_id"]
        if not user or not experiment_id or not body["p_ttl_hours"] or body["p_ttl_hours"] <= 0 \
                or body["p_image_path"] != f"{user}/{experiment_id}/image.jpg" \
                or body["p_thumb_path"] != f"{user}/{experiment_id}/thumb.jpg":
            return httpx.Response(200, json={"result": "invalid_arguments"})
        if body["p_deadline"] is None or now() > datetime.fromisoformat(body["p_deadline"]):
            return httpx.Response(200, json={"result": "late"})
        live = [r for r in self.rows.values()
                if r["user_id"] == user and r["status"] == "draft" and self._live(r, now())]
        if body["p_max_drafts"] is None or len(live) >= body["p_max_drafts"]:
            return httpx.Response(200, json={"result": "draft_limit"})
        row = {
            "id": body["p_id"], "user_id": user, "status": "draft", "title": None, "notes": "",
            "analysis": body["p_analysis"], "model": body["p_model"], "prompt_version": body["p_prompt_version"],
            "image_path": body["p_image_path"], "thumb_path": body["p_thumb_path"],
            "image_bytes": body["p_image_bytes"], "created_at": now().isoformat(), "updated_at": now().isoformat(),
            "saved_at": None, "expires_at": (now() + timedelta(hours=body["p_ttl_hours"])).isoformat(),
        }
        self.rows[row["id"]] = row
        if committed_then_lost:
            raise httpx.ReadTimeout("fake lost response", request=request)
        if self.insert_body is not None:  # The row is stored; only the response is replaced.
            return httpx.Response(200, content=self.insert_body)
        return httpx.Response(200, json={"result": "ok", "row": row})

    def _discard_draft(self, request, body):
        failure = self._failure("discard_draft", request)
        if failure:
            return failure
        if self.discard_body is not None:
            return httpx.Response(200, content=self.discard_body)
        row = self.rows.get(body["p_id"])
        if row is None or row["user_id"] != body["p_user"] or row["status"] != "draft":
            return httpx.Response(200, json=False)
        del self.rows[body["p_id"]]
        return httpx.Response(200, json=True)

    def _update_experiment(self, request, body):
        failure = self._failure("update", request)
        if failure:
            return failure
        if self.update_body is not None:
            return httpx.Response(200, content=self.update_body)
        row = self.rows.get(body["p_id"])
        if row is None or row["user_id"] != body["p_user"] or not self._live(row, now()):
            return httpx.Response(200, json={"result": "not_found"})
        saving = body["p_save"] and row["status"] == "draft"
        if saving:
            if (body["p_title"] if body["p_title"] is not None else row["title"]) is None:
                return httpx.Response(200, json={"result": "title_required"})
            saved = [r for r in self.rows.values() if r["user_id"] == body["p_user"] and r["status"] == "saved"]
            if body["p_max_saved"] is None or len(saved) >= body["p_max_saved"]:
                return httpx.Response(200, json={"result": "saved_limit"})
        if body["p_title"] is not None:
            row["title"] = body["p_title"]
        if body["p_notes"] is not None:
            row["notes"] = body["p_notes"]
        if saving:
            row.update(status="saved", saved_at=now().isoformat())
        if body["p_save"]:
            row["expires_at"] = None
        row["updated_at"] = now().isoformat()
        return httpx.Response(200, json={"result": "ok", "row": row})

    @staticmethod
    def _op(path, method, params, request):
        """Names the request the way logbook.py does, for `fail` and `hooks`."""
        if path.startswith("/rest/v1/rpc/"):
            return path.removeprefix("/rest/v1/rpc/")
        if path == "/rest/v1/usage_daily":
            return "usage"
        if path == f"/storage/v1/object/list/{BUCKET}":
            return "list_objects"
        if path == f"/storage/v1/object/{BUCKET}" and method == "DELETE":
            return "delete"
        if path != "/rest/v1/experiments":
            return None
        if method == "GET":
            if "and" in params:
                return "list"
            if "status" in params:
                return "purge_select" if params["expires_at"].startswith("lte.") else "count"
            return "purge_recheck" if params.get("id", "").startswith("in.") else "get"
        if method == "DELETE" and request.headers.get("prefer") == "return=representation":
            return "purge_delete" if params["id"].startswith("in.") else "delete_experiment"
        return None

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

        op = self._op(path, method, params, request)
        if op in self.hooks:
            self.hooks.pop(op)()

        if path == "/rest/v1/rpc/consume_gemini_call":
            failure = self._failure("rpc", request)
            if failure:
                return failure
            if self.quota_body == b"true":  # The unit was taken: count it as the SQL function does.
                key = (body["p_user"], now().date().isoformat())
                self.usage[key] = self.usage.get(key, 0) + 1
            return httpx.Response(200, content=self.quota_body, headers={"content-type": "application/json"})
        if op == "usage":
            failure = self._failure("usage", request)
            if failure:
                return failure
            if self.usage_body is not None:
                return httpx.Response(200, content=self.usage_body)
            assert method == "GET" and params["select"] == "user_id,gemini_calls"
            found = [{"user_id": user, "gemini_calls": calls} for (user, day), calls in self.usage.items()
                     if params["user_id"] == f"eq.{user}" and params["day"] == f"eq.{day}"]
            return httpx.Response(200, json=found)
        if path == "/rest/v1/rpc/create_draft":
            return self._create_draft(request, body)
        if path == "/rest/v1/rpc/update_experiment":
            return self._update_experiment(request, body)
        if path == "/rest/v1/rpc/discard_draft":
            return self._discard_draft(request, body)
        if op == "list":
            return self._failure("list", request) or httpx.Response(200, json=self._list(params))
        if op == "purge_select":
            failure = self._failure("purge_select", request)
            if failure:
                return failure
            cutoff = datetime.fromisoformat(params["expires_at"].removeprefix("lte."))
            expired = sorted((r for r in self.rows.values()
                              if f"eq.{r['user_id']}" == params["user_id"] and r["status"] == "draft"
                              and datetime.fromisoformat(r["expires_at"]) <= cutoff),
                             key=lambda r: r["expires_at"])
            return httpx.Response(200, json=[{"id": r["id"]} for r in expired][: int(params["limit"])])
        if op == "purge_recheck":
            failure = self._failure("purge_recheck", request)
            if failure:
                return failure
            ids = set(params["id"].removeprefix("in.(").removesuffix(")").split(","))
            return httpx.Response(200, json=[{"id": r["id"]} for r in self.rows.values()
                                             if r["id"] in ids and f"eq.{r['user_id']}" == params["user_id"]])
        if op in ("delete_experiment", "purge_delete"):
            # "after_commit": the rows are deleted, then the response is lost.
            committed_then_lost = self.fail.get(op) == "after_commit"
            failure = None if committed_then_lost else self._failure(op, request)
            if failure:
                return failure
            found = self._matching(params)
            for row in found:
                del self.rows[row["id"]]
            if committed_then_lost:
                raise httpx.ReadTimeout("fake lost response", request=request)
            if op == "delete_experiment" and self.delete_body is not None:
                return httpx.Response(200, content=self.delete_body)
            return httpx.Response(200, json=[{"id": row["id"]} for row in found])
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
            if self.delete_noop:
                return httpx.Response(200, json=[])
            # Exact paths only, as Storage deletes them; the response lists what was removed.
            removed = [p for p in body["prefixes"] if self.objects.pop(p, None) is not None]
            return httpx.Response(200, json=[{"name": p} for p in removed])
        if path == f"/storage/v1/object/list/{BUCKET}" and method == "POST":
            failure = self._failure("list_objects", request)
            if failure:
                return failure
            if self.list_objects_body is not None:
                return httpx.Response(200, content=self.list_objects_body)
            return httpx.Response(200, json=self._list_objects(body))
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


def assert_scoped(requests, user_id, other_id):
    """Every request is confined to user_id and never mentions other_id."""
    prefix = f"{user_id}/"
    for request in requests:
        path = request.url.path
        body = json.loads(request.content) if request.headers.get("content-type") == "application/json" else None
        if path == "/rest/v1/rpc/create_draft":
            assert body["p_user"] == user_id
            assert body["p_image_path"].startswith(prefix) and body["p_thumb_path"].startswith(prefix)
        elif path in ("/rest/v1/experiments", "/rest/v1/usage_daily"):
            assert request.url.params["user_id"] == f"eq.{user_id}"
        elif path in ("/rest/v1/rpc/consume_gemini_call", "/rest/v1/rpc/update_experiment",
                      "/rest/v1/rpc/discard_draft"):
            assert body["p_user"] == user_id
        elif path == f"/storage/v1/object/sign/{BUCKET}":
            assert all(p.startswith(prefix) for p in body["paths"])
        elif path == f"/storage/v1/object/{BUCKET}":
            assert all(p.startswith(prefix) for p in body["prefixes"])
        elif path == f"/storage/v1/object/list/{BUCKET}":
            assert body["prefix"].startswith(prefix)
        else:
            assert path.startswith(f"/storage/v1/object/{BUCKET}/{prefix}")
        assert other_id not in str(request.url)
        assert other_id.encode() not in request.content
