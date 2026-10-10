"""Student logbook storage: Supabase PostgREST and Storage over httpx with the secret key.

The tables and the bucket deny everything under RLS, and the secret key bypasses RLS, so
isolation lives here. Every function takes user_id first, every table query filters
user_id=eq.<uid>, and every storage path starts with "<uid>/". Logs carry operation names
and status codes only: never URLs, keys, signed URLs, bodies or user ids.
"""

from datetime import datetime, time, timedelta, timezone
import logging
import math
from typing import Any
import uuid

import httpx
from pydantic import ValidationError

from app.config import Settings
from app.schemas.experiment import Experiment
from app.services.errors import AnalysisError
from app.services.gemini import PROMPT_VERSION, analyze_image_with_model
from app.services.images import make_display_copies, prepare_image

logger = logging.getLogger(__name__)

SIGNED_URL_SECONDS = 600
SUPABASE_TIMEOUT_SECONDS = 10
EXPERIMENT_COLUMNS = (
    "id,user_id,status,title,notes,analysis,created_at,updated_at,saved_at,expires_at,image_path,thumb_path"
)
UNAVAILABLE = "Logbook is temporarily unavailable. Please try again."
NOT_FOUND = "Experiment not found."
TOO_MANY_DRAFTS = "Too many unsaved drafts. Save or discard one first."
DAILY_LIMIT = "Daily analysis limit reached for your account. Try again after 00:00 UTC."

# Test hook: tests install an httpx.MockTransport. None uses the real network.
_transport: httpx.BaseTransport | None = None


class LogbookPathError(ValueError):
    """A storage path outside the user's own prefix. It is refused before any request."""


def _auth_headers(settings: Settings) -> dict[str, str]:
    """Supabase credentials for one request; the only place the secret key is read.

    Assumes new-style secret keys are accepted in the apikey header alone. Not yet
    verified against a real project; change it here if Supabase needs more.
    """
    return {"apikey": settings.supabase_secret_key.get_secret_value().strip()}


def _client(settings: Settings) -> httpx.Client:
    return httpx.Client(base_url=settings.supabase_url, timeout=SUPABASE_TIMEOUT_SECONDS, transport=_transport)


def _unavailable(op: str, status: object) -> AnalysisError:
    logger.warning("Logbook request failed op=%s status=%s", op, status)
    return AnalysisError(503, UNAVAILABLE)


def _request(op: str, settings: Settings, method: str, path: str, *,
             headers: dict[str, str] | None = None, **kwargs: Any) -> httpx.Response:
    try:
        with _client(settings) as client:
            response = client.request(method, path, headers={**_auth_headers(settings), **(headers or {})}, **kwargs)
    except httpx.HTTPError:
        # from None: httpx exceptions carry the request URL.
        raise _unavailable(op, "transport") from None
    if not response.is_success:
        raise _unavailable(op, response.status_code)
    return response


def _json(response: httpx.Response) -> Any:
    try:
        return response.json()
    except ValueError:
        return None


def _check_paths(user_id: str, paths: list[str]) -> None:
    prefix = f"{user_id}/"
    for path in paths:
        if not user_id or not path.startswith(prefix) or ".." in path.split("/"):
            raise LogbookPathError("Storage path is outside the user's prefix.")


def count_live_drafts(user_id: str, settings: Settings) -> int:
    now = datetime.now(timezone.utc).isoformat()
    rows = _json(_request("count_drafts", settings, "GET", "/rest/v1/experiments", params={
        "select": "id",
        "user_id": f"eq.{user_id}",
        "status": "eq.draft",
        "expires_at": f"gt.{now}",
        "limit": str(settings.max_drafts_per_user),
    }))
    if not isinstance(rows, list):
        raise _unavailable("count_drafts", "bad_response")
    return len(rows)


def consume_gemini_call(user_id: str, settings: Settings) -> bool:
    """Take one unit of the user's daily quota. Fails closed: only a JSON true allows the call."""
    response = _request("consume_quota", settings, "POST", "/rest/v1/rpc/consume_gemini_call",
                        json={"p_user": user_id, "p_limit": settings.user_daily_gemini_limit})
    return _json(response) is True


def upload_object(user_id: str, path: str, data: bytes, settings: Settings) -> None:
    _check_paths(user_id, [path])
    _request("upload", settings, "POST", f"/storage/v1/object/{settings.logbook_bucket}/{path}",
             content=data, headers={"content-type": "image/jpeg", "x-upsert": "false"})


def delete_objects(user_id: str, paths: list[str], settings: Settings) -> None:
    _check_paths(user_id, paths)
    # client.request, not client.delete: httpx's delete() cannot send a body.
    _request("delete_objects", settings, "DELETE", f"/storage/v1/object/{settings.logbook_bucket}",
             json={"prefixes": list(paths)})


def insert_experiment(user_id: str, row: dict[str, Any], settings: Settings) -> Any:
    """Insert one row owned by user_id and return the decoded representation (None if undecodable)."""
    response = _request("insert", settings, "POST", "/rest/v1/experiments",
                        params={"select": EXPERIMENT_COLUMNS},
                        json={**row, "user_id": user_id},
                        headers={"Prefer": "return=representation"})
    return _json(response)


def delete_experiment_row(user_id: str, experiment_id: str, settings: Settings) -> None:
    """Delete one row owned by user_id. Idempotent: a row that does not exist is not an error.

    An empty user_id or a non-UUID experiment_id is refused before any request.
    """
    if not user_id:
        raise ValueError("user_id is required.")
    try:
        canonical = str(uuid.UUID(experiment_id))
    except (TypeError, ValueError, AttributeError):
        raise ValueError("experiment_id must be a UUID.") from None
    _request("delete_row", settings, "DELETE", "/rest/v1/experiments",
             params={"id": f"eq.{canonical}", "user_id": f"eq.{user_id}"},
             headers={"Prefer": "return=minimal"})


def _owned_row(user_id: str, rows: Any) -> dict[str, Any] | None:
    """The single row if it belongs to user_id and its storage paths sit under the user's prefix."""
    if not isinstance(rows, list) or len(rows) != 1 or not isinstance(rows[0], dict):
        return None
    row = rows[0]
    prefix = f"{user_id}/"
    if row.get("user_id") != user_id or not all(
        isinstance(row.get(key), str) and row[key].startswith(prefix) for key in ("image_path", "thumb_path")
    ):
        return None
    return row


def get_experiment(user_id: str, experiment_id: str, settings: Settings) -> dict[str, Any] | None:
    response = _request("get_experiment", settings, "GET", "/rest/v1/experiments", params={
        "select": EXPERIMENT_COLUMNS,
        "id": f"eq.{experiment_id}",
        "user_id": f"eq.{user_id}",
        "limit": "1",
    })
    rows = _json(response)
    if rows == []:
        return None
    row = _owned_row(user_id, rows)
    if row is None:
        raise _unavailable("get_experiment", "bad_response")
    if row.get("status") == "draft":
        try:
            expired = datetime.fromisoformat(row["expires_at"]) <= datetime.now(timezone.utc)
        except (KeyError, TypeError, ValueError):
            raise _unavailable("get_experiment", "bad_response") from None
        if expired:
            return None  # Lazy deletion of expired drafts arrives in PR 4.
    return row


def sign_urls(user_id: str, paths: list[str], settings: Settings) -> list[str | None]:
    """Signed URLs in the order of paths. None for any path that could not be signed."""
    _check_paths(user_id, paths)
    try:
        response = _request("sign_urls", settings, "POST", f"/storage/v1/object/sign/{settings.logbook_bucket}",
                            json={"expiresIn": SIGNED_URL_SECONDS, "paths": list(paths)})
    except AnalysisError:
        return [None] * len(paths)
    signed: dict[str, str] = {}
    items = _json(response)
    for item in items if isinstance(items, list) else []:
        if isinstance(item, dict) and not item.get("error") and isinstance(item.get("path"), str) \
                and isinstance(item.get("signedURL"), str) and item["signedURL"].startswith("/object/sign/"):
            signed[item["path"]] = f"{settings.supabase_url}/storage/v1{item['signedURL']}"
    return [signed.get(path) for path in paths]


def _experiment(user_id: str, row: dict[str, Any], settings: Settings) -> Experiment:
    image_url, thumb_url = sign_urls(user_id, [row["image_path"], row["thumb_path"]], settings)
    try:
        return Experiment.model_validate({
            **row, "image_url": image_url, "thumb_url": thumb_url, "image_url_expires_in": SIGNED_URL_SECONDS,
        })
    except ValidationError:
        raise _unavailable("parse_row", "bad_response") from None


def _seconds_until_utc_midnight(now: datetime) -> int:
    midnight = datetime.combine(now.date() + timedelta(days=1), time.min, tzinfo=timezone.utc)
    return max(1, math.ceil((midnight - now).total_seconds()))


def _cleanup(user_id: str, paths: list[str], settings: Settings, op: str) -> None:
    """Best effort: a failed cleanup is logged and never replaces the caller's exception."""
    try:
        delete_objects(user_id, paths, settings)
    except Exception:
        logger.warning("Logbook cleanup failed op=%s objects=%s", op, len(paths))


def _delete_row_quietly(user_id: str, experiment_id: str, settings: Settings) -> bool:
    """Best effort after a failed insert: True if the row is gone (or was never stored)."""
    try:
        delete_experiment_row(user_id, experiment_id, settings)
    except Exception:
        logger.warning("Logbook cleanup failed op=row")
        return False
    return True


def create_experiment(user_id: str, data: bytes, content_type: str | None, settings: Settings) -> Experiment:
    """Analyze an upload and store it as a draft.

    Order: draft cap, image validation, display copies, quota, Gemini, uploads, insert.
    A rejected image, or one whose display copies cannot be made (busy, too large),
    costs no quota. If Gemini fails, nothing is stored. If an upload fails, the objects
    already uploaded are deleted. If the insert fails, the row is deleted first (the
    insert may have committed before its response was lost), then the objects; if the
    row delete fails, the objects are kept so a surviving row never loses its images.
    """
    if count_live_drafts(user_id, settings) >= settings.max_drafts_per_user:
        raise AnalysisError(409, TOO_MANY_DRAFTS)
    cleaned, mime_type = prepare_image(data, content_type, settings)
    display, thumb = make_display_copies(cleaned, mime_type)
    if not consume_gemini_call(user_id, settings):
        retry_after = _seconds_until_utc_midnight(datetime.now(timezone.utc))
        raise AnalysisError(429, DAILY_LIMIT, headers={"Retry-After": str(retry_after)})
    analysis, model = analyze_image_with_model(cleaned, mime_type, settings)

    experiment_id = str(uuid.uuid4())
    image_path = f"{user_id}/{experiment_id}/image.jpg"
    thumb_path = f"{user_id}/{experiment_id}/thumb.jpg"
    uploaded: list[str] = []
    stage = "upload"
    try:
        for path, content in ((image_path, display), (thumb_path, thumb)):
            # Recorded before the call: a timed-out upload may still have reached storage.
            uploaded.append(path)
            upload_object(user_id, path, content, settings)
        stage = "insert"
        rows = insert_experiment(user_id, {
            "id": experiment_id,
            "status": "draft",
            "analysis": analysis.model_dump(),
            "model": model,
            "prompt_version": PROMPT_VERSION,
            "image_path": image_path,
            "thumb_path": thumb_path,
            "image_bytes": len(display),
            "expires_at": (datetime.now(timezone.utc) + timedelta(hours=settings.draft_ttl_hours)).isoformat(),
        }, settings)
    except Exception:
        # Delete what may have been stored, then re-raise unchanged. After an insert failure the
        # row may exist anyway (committed, response lost): delete it first, and keep the
        # objects if that fails, so a surviving row never points at missing images.
        if stage == "insert" and not _delete_row_quietly(user_id, experiment_id, settings):
            raise
        if uploaded:
            _cleanup(user_id, uploaded, settings, stage)
        raise
    # The row exists from here on, so a bad representation is reported but the objects stay.
    row = _owned_row(user_id, rows)
    if row is None:
        raise _unavailable("insert", "bad_response")
    return _experiment(user_id, row, settings)


def read_experiment(user_id: str, experiment_id: str, settings: Settings) -> Experiment:
    """The user's own experiment, or 404. Another user's ID also gives 404, never 403."""
    try:
        canonical = str(uuid.UUID(experiment_id))
    except ValueError:
        raise AnalysisError(404, NOT_FOUND) from None
    row = get_experiment(user_id, canonical, settings)
    if row is None:
        raise AnalysisError(404, NOT_FOUND)
    return _experiment(user_id, row, settings)
