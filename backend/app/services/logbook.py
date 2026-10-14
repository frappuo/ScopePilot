"""Student logbook storage: Supabase PostgREST and Storage over httpx with the secret key.

The tables and the bucket deny everything under RLS, and the secret key bypasses RLS, so
isolation lives here. Every function takes user_id first, every table query filters
user_id=eq.<uid>, and every storage path starts with "<uid>/". Logs carry operation names
and status codes only: never URLs, keys, signed URLs, bodies or user ids.
"""

import base64
from datetime import datetime, time, timedelta, timezone
import json
import logging
import math
from time import monotonic, sleep
from typing import Any
import uuid

import httpx
from pydantic import ValidationError

from app.config import Settings
from app.schemas.analysis import Analysis, StoredAnalysis
from app.schemas.ask import AskResponse
from app.schemas.experiment import Experiment, ExperimentPage, ExperimentSummary, ExperimentUpdate
from app.schemas.me import DailyUsage
from app.schemas.quiz import QuizResponse
from app.services.errors import AnalysisError
from app.services.gemini import PROMPT_VERSION, analyze_image_with_model, answer_question, generate_quiz
from app.services.images import make_display_copies, prepare_image

logger = logging.getLogger(__name__)

SIGNED_URL_SECONDS = 600
SUPABASE_TIMEOUT_SECONDS = 10  # Keep above the service_role statement_timeout (5 s, migration 0002).
USAGE_TIMEOUT_SECONDS = 3  # The usage read is read-only and must not hold /v1/me, the session check.
CREATE_DEADLINE_SECONDS = SUPABASE_TIMEOUT_SECONDS - 2  # create_draft writes nothing after this.
# Cleanup waits this long past the deadline, so the database clock may lag this host's by up to
# about this much (minus the discard call's latency) without a late create slipping through.
DISCARD_MARGIN_SECONDS = 2
PURGE_BATCH = 5
PURGE_GRACE = timedelta(minutes=5)  # Clock-skew margin between this host and the database.
# Account sweep of "<uid>/": a round lists the first page of the user's folder and the folders in
# it, then deletes what it found; the next round lists from offset 0 again, so deletes never shift
# a page. A round that finds only folders pages through everything before calling the folder
# empty. Bounded, so one request cannot run on; a 503 leaves the rest for a retry.
SWEEP_PAGE = 100
SWEEP_DELETE_BATCH = 100  # Storage accepts up to 1000 paths per delete.
SWEEP_MAX_DEPTH = 3  # Folder levels below "<uid>/"; today's layout uses one (<uid>/<id>/file).
SWEEP_MAX_ROUNDS = 50
SWEEP_BUDGET_SECONDS = 25
EXPERIMENT_COLUMNS = (
    "id,user_id,status,title,notes,analysis,created_at,updated_at,saved_at,expires_at,image_path,thumb_path"
)
LIST_COLUMNS = (
    "id,user_id,status,title,created_at,saved_at,expires_at,thumb_path,"
    "probable_specimen:analysis->>probable_specimen"
)
UNAVAILABLE = "Logbook is temporarily unavailable. Please try again."
NOT_FOUND = "Experiment not found."
TOO_MANY_DRAFTS = "Too many unsaved drafts. Save or discard one first."
TOO_MANY_SAVED = "Too many saved experiments. Delete one first."
TITLE_REQUIRED = "A title is required to save."
INVALID_CURSOR = "Invalid cursor."
DAILY_LIMIT = "Daily AI request limit reached for your account. Try again after 00:00 UTC."
INVALID_ANALYSIS = "Gemini returned an invalid or empty analysis. Please try again."
ANALYSIS_TOO_LONG = "This experiment's analysis is too long for follow-up questions."

# Test hooks: tests install an httpx.MockTransport (None uses the real network) and replace
# _wait so that cleanup does not really sleep.
_transport: httpx.BaseTransport | None = None
_wait = sleep


class LogbookPathError(ValueError):
    """A storage path outside the user's own prefix. It is refused before any request."""


def _auth_headers(settings: Settings) -> dict[str, str]:
    """Supabase credentials for one request; the only place the secret key is read.

    New-style secret keys are accepted in the apikey header alone (verified live against
    the project on 2026-10-11, PostgREST and Storage).
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


def _canonical_id(experiment_id: object) -> str | None:
    """The canonical UUID string, or None if experiment_id is not a UUID."""
    try:
        return str(uuid.UUID(experiment_id))
    except (TypeError, ValueError, AttributeError):
        return None


def _object_paths(user_id: str, experiment_id: str) -> list[str]:
    """Where create_experiment stores an experiment's images."""
    return [f"{user_id}/{experiment_id}/image.jpg", f"{user_id}/{experiment_id}/thumb.jpg"]


def _utc_timestamp(value: datetime) -> str:
    """UTC ISO 8601 with a Z suffix, so query values never contain "+"."""
    return value.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


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


def _charge_quota(user_id: str, settings: Settings) -> None:
    """Take one unit of the user's daily quota, or raise 429 with Retry-After until 00:00 UTC."""
    if not consume_gemini_call(user_id, settings):
        retry_after = _seconds_until_utc_midnight(datetime.now(timezone.utc))
        raise AnalysisError(429, DAILY_LIMIT, headers={"Retry-After": str(retry_after)})


def get_daily_usage(user_id: str, settings: Settings) -> DailyUsage | None:
    """The user's quota use for the current UTC day, or None if it cannot be read. Never raises.

    No row means nothing used yet. The backend clock picks the day, while consume_gemini_call
    uses the database clock, so the two can disagree for a few seconds around 00:00 UTC.
    """
    now = datetime.now(timezone.utc)
    try:
        rows = _json(_request("usage", settings, "GET", "/rest/v1/usage_daily", params={
            "select": "user_id,gemini_calls",
            "user_id": f"eq.{user_id}",
            "day": f"eq.{now.date().isoformat()}",
        }, timeout=USAGE_TIMEOUT_SECONDS))
    except Exception:
        # /v1/me is the session check: a failed read leaves usage unknown, never fails the request.
        logger.warning("Logbook usage read failed op=usage status=request")
        return None
    if rows == []:
        used = 0
    elif isinstance(rows, list) and len(rows) == 1 and isinstance(rows[0], dict) \
            and rows[0].get("user_id") == user_id and type(rows[0].get("gemini_calls")) is int \
            and rows[0]["gemini_calls"] >= 0:
        used = rows[0]["gemini_calls"]
    else:
        logger.warning("Logbook usage read failed op=usage status=bad_response")
        return None
    limit = settings.user_daily_gemini_limit
    return DailyUsage(used_today=used, daily_limit=limit, remaining=max(0, limit - used),
                      resets_at=_next_utc_midnight(now))


def upload_object(user_id: str, path: str, data: bytes, settings: Settings) -> None:
    _check_paths(user_id, [path])
    _request("upload", settings, "POST", f"/storage/v1/object/{settings.logbook_bucket}/{path}",
             content=data, headers={"content-type": "image/jpeg", "x-upsert": "false"})


def delete_objects(user_id: str, paths: list[str], settings: Settings) -> None:
    _check_paths(user_id, paths)
    # client.request, not client.delete: httpx's delete() cannot send a body.
    _request("delete_objects", settings, "DELETE", f"/storage/v1/object/{settings.logbook_bucket}",
             json={"prefixes": list(paths)})


def _list_folder(user_id: str, folder: str, offset: int, settings: Settings) -> tuple[list[str], list[str]]:
    """(files, subfolders) in the page of folder at offset, as full paths under "<uid>/".

    Storage's list is one level deep: a folder entry has a null id. Every name is checked before
    it is joined, so a listing can never steer a path outside the user's prefix.
    """
    _check_paths(user_id, [folder])
    entries = _json(_request("list_objects", settings, "POST", f"/storage/v1/object/list/{settings.logbook_bucket}",
                             json={"prefix": folder, "limit": SWEEP_PAGE, "offset": offset,
                                   "sortBy": {"column": "name", "order": "asc"}}))
    if not isinstance(entries, list) or len(entries) > SWEEP_PAGE:
        raise _unavailable("list_objects", "bad_response")
    files: list[str] = []
    folders: list[str] = []
    for entry in entries:
        name = entry.get("name") if isinstance(entry, dict) else None
        if not isinstance(name, str) or not name or "/" in name or name in (".", ".."):
            raise _unavailable("list_objects", "bad_name")
        path = f"{folder}{name}"
        try:
            _check_paths(user_id, [path])
        except LogbookPathError:
            raise _unavailable("list_objects", "bad_name") from None
        if entry.get("id") is None:
            folders.append(f"{path}/")
        else:
            files.append(path)
    return files, folders


def _sweep_pass(user_id: str, complete: bool, deadline: float, settings: Settings) -> tuple[list[str], bool]:
    """(files found, whether "<uid>/" listed empty) from one pass over the user's folder tree.

    A quick pass reads only the first page of each folder. A complete pass reads every folder
    with increasing offsets until a page comes back short, so nothing past the first page is missed.
    Nothing is deleted during a pass, so its offsets stay valid.
    """
    root = f"{user_id}/"
    found: list[str] = []
    pending = [(root, 0)]
    while pending:
        folder, depth = pending.pop()
        if depth > SWEEP_MAX_DEPTH:
            raise _unavailable("sweep", "too_deep")
        offset = 0
        while True:
            if monotonic() > deadline:
                raise _unavailable("sweep", "budget")
            files, folders = _list_folder(user_id, folder, offset, settings)
            if folder == root and offset == 0 and not files and not folders:
                return [], True
            found.extend(files)
            pending.extend((sub, depth + 1) for sub in folders)
            if not complete or len(files) + len(folders) < SWEEP_PAGE:
                break
            offset += SWEEP_PAGE
    return list(dict.fromkeys(found)), False


def _sweep_user_objects(user_id: str, settings: Settings) -> tuple[int, int]:
    """Delete every object under "<uid>/", including orphans no row lists. Returns (deleted, rounds).

    Each round makes a quick pass and deletes the files it found. The sweep is done when the
    user's folder lists empty, or when a round's quick pass finds only folders and a complete
    paginated pass then finds no file anywhere: Storage can list a folder that holds nothing,
    which must not block a deletion. Raises 503 (AnalysisError) if a listing is malformed, a
    folder is nested deeper than SWEEP_MAX_DEPTH, a pass finds only paths already deleted (no
    progress), or SWEEP_MAX_ROUNDS or SWEEP_BUDGET_SECONDS run out. Safe to repeat: what is
    already gone is simply not listed again.
    """
    if not user_id or _canonical_id(user_id) != user_id:
        raise ValueError("user_id must be a canonical UUID.")
    deadline = monotonic() + SWEEP_BUDGET_SECONDS
    requested: set[str] = set()
    for round_number in range(1, SWEEP_MAX_ROUNDS + 1):
        found, empty = _sweep_pass(user_id, False, deadline, settings)
        if empty:
            return len(requested), round_number
        if not found:
            # Only folders on the first pages: files may sit past a first page or under one of them.
            found, _ = _sweep_pass(user_id, True, deadline, settings)
            if not found:
                return len(requested), round_number
        fresh = [path for path in found if path not in requested]
        if not fresh:
            # Files listed again after their delete was requested: the delete did not take.
            raise _unavailable("sweep", "no_progress")
        for start in range(0, len(fresh), SWEEP_DELETE_BATCH):
            if monotonic() > deadline:
                raise _unavailable("sweep", "budget")
            delete_objects(user_id, fresh[start:start + SWEEP_DELETE_BATCH], settings)
            requested.update(fresh[start:start + SWEEP_DELETE_BATCH])
    raise _unavailable("sweep", "rounds")


def _delete_user_experiments(user_id: str, settings: Settings) -> int:
    """Delete every experiment row owned by user_id; the number removed. 503 if any returned row is foreign."""
    rows = _json(_request("delete_rows", settings, "DELETE", "/rest/v1/experiments",
                          params={"select": "user_id", "user_id": f"eq.{user_id}"},
                          headers={"Prefer": "return=representation"}))
    if not isinstance(rows, list) or any(not isinstance(row, dict) or row.get("user_id") != user_id for row in rows):
        raise _unavailable("delete_rows", "bad_response")
    return len(rows)


def _auth_error_code(response: httpx.Response) -> object:
    body = _json(response)
    return body.get("error_code") if isinstance(body, dict) else None


def _delete_auth_user(user_id: str, settings: Settings) -> bool:
    """Hard-delete the Supabase Auth user through the Admin API. True if deleted, False if already gone.

    Only a 404 whose error_code is "user_not_found" counts as already gone; any other 404 (a wrong
    route, say) or error is a 503, so a misconfiguration can never pass for a finished deletion.
    """
    try:
        with _client(settings) as client:
            response = client.request("DELETE", f"/auth/v1/admin/users/{user_id}",
                                      headers=_auth_headers(settings), json={"should_soft_delete": False})
    except httpx.HTTPError:
        raise _unavailable("auth_delete", "transport") from None
    if response.is_success:
        return True
    if response.status_code == 404 and _auth_error_code(response) == "user_not_found":
        return False
    raise _unavailable("auth_delete", response.status_code)


def delete_account(user_id: str, settings: Settings) -> None:
    """Permanently delete the user's logbook data and Supabase Auth user. 503 (AnalysisError) if a step fails.

    Order: experiment rows, a sweep of every object under "<uid>/", the Auth user, then a final
    sweep for objects a create still running may have uploaded meanwhile. usage_daily rows go by
    the on-delete cascade with the Auth user, so a deletion that fails earlier leaves the day's
    quota count in place. A failed step stops the rest. Every step is safe to repeat (no rows,
    an empty folder, an Auth user that is already gone), so a retry with the same access token,
    still valid until it expires, finishes a half-deleted account. The Auth user goes last
    because, once it is gone, sessions cannot be refreshed; from then on the FKs to auth.users
    reject any new row or quota use.
    """
    if not user_id or _canonical_id(user_id) != user_id:
        raise ValueError("user_id must be a canonical UUID.")
    experiments = _delete_user_experiments(user_id, settings)
    logger.info("Account deletion op=rows experiments=%s", experiments)
    deleted, rounds = _sweep_user_objects(user_id, settings)
    logger.info("Account deletion op=objects deleted=%s rounds=%s", deleted, rounds)
    removed = _delete_auth_user(user_id, settings)
    logger.info("Account deletion op=auth result=%s", "deleted" if removed else "absent")
    try:
        deleted, rounds = _sweep_user_objects(user_id, settings)
    except AnalysisError:
        logger.warning("Account deletion failed op=final_sweep")
        raise
    logger.info("Account deletion op=final_sweep deleted=%s rounds=%s", deleted, rounds)


def insert_experiment(user_id: str, row: dict[str, Any], settings: Settings) -> Any:
    """Create a draft owned by user_id through create_draft (migration 0002).

    The function enforces the draft cap under a per-user lock, sets expires_at, and writes
    nothing once row["deadline"] has passed. Returns the decoded result: {"result": "ok",
    "row": {...}}, or "draft_limit", "late" or "invalid_arguments" with nothing written;
    anything else (None if undecodable) is a bad response.
    """
    response = _request("insert", settings, "POST", "/rest/v1/rpc/create_draft", json={
        "p_user": user_id,
        "p_id": row["id"],
        "p_max_drafts": settings.max_drafts_per_user,
        "p_ttl_hours": settings.draft_ttl_hours,
        "p_deadline": _utc_timestamp(row["deadline"]),
        "p_analysis": row["analysis"],
        "p_model": row["model"],
        "p_prompt_version": row["prompt_version"],
        "p_image_path": row["image_path"],
        "p_thumb_path": row["thumb_path"],
        "p_image_bytes": row["image_bytes"],
    })
    return _json(response)


def discard_draft(user_id: str, experiment_id: str, settings: Settings) -> bool:
    """Delete the user's draft through discard_draft (migration 0002); True if a row was removed.

    The function takes the same per-user lock as create_draft, so a create still running
    finishes first. An empty user_id or a non-UUID experiment_id is refused before any request.
    """
    if not user_id:
        raise ValueError("user_id is required.")
    canonical = _canonical_id(experiment_id)
    if canonical is None:
        raise ValueError("experiment_id must be a UUID.")
    removed = _json(_request("discard_draft", settings, "POST", "/rest/v1/rpc/discard_draft",
                             json={"p_user": user_id, "p_id": canonical}))
    if not isinstance(removed, bool):
        raise _unavailable("discard_draft", "bad_response")
    return removed


def _owns(user_id: str, row: Any, path_keys: tuple[str, ...]) -> bool:
    """True if row belongs to user_id and each named storage path passes _check_paths."""
    if not isinstance(row, dict) or row.get("user_id") != user_id:
        return False
    paths = [row.get(key) for key in path_keys]
    if not all(isinstance(path, str) for path in paths):
        return False
    try:
        _check_paths(user_id, paths)
    except LogbookPathError:
        return False
    return True


def _owned_row(user_id: str, rows: Any) -> dict[str, Any] | None:
    """The single row if it belongs to user_id and its storage paths sit under the user's prefix."""
    if not isinstance(rows, list) or len(rows) != 1:
        return None
    return rows[0] if _owns(user_id, rows[0], ("image_path", "thumb_path")) else None


def _rpc_row(user_id: str, result: Any) -> dict[str, Any] | None:
    """The owned row from an RPC result {"result": "ok", "row": {...}}, else None."""
    if not isinstance(result, dict) or result.get("result") != "ok":
        return None
    return _owned_row(user_id, [result.get("row")])


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
            return None  # Expired drafts are deleted lazily by purge_expired_drafts.
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


def _next_utc_midnight(now: datetime) -> datetime:
    return datetime.combine(now.date() + timedelta(days=1), time.min, tzinfo=timezone.utc)


def _seconds_until_utc_midnight(now: datetime) -> int:
    return max(1, math.ceil((_next_utc_midnight(now) - now).total_seconds()))


def _cleanup(user_id: str, paths: list[str], settings: Settings, op: str) -> None:
    """Best effort: a failed cleanup is logged and never replaces the caller's exception."""
    try:
        delete_objects(user_id, paths, settings)
    except Exception:
        logger.warning("Logbook cleanup failed op=%s objects=%s", op, len(paths))


def _discard_quietly(user_id: str, experiment_id: str, deadline: datetime, settings: Settings) -> bool:
    """Best effort after a failed insert: True if the row is gone (or was never stored).

    Waits until DISCARD_MARGIN_SECONDS past the create deadline first: a create_draft call still
    queued then returns "late" without writing, and one already running holds the lock that
    discard_draft waits for. Costs up to about 10 s, holding this worker, on this rare failure path.
    """
    try:
        _wait(max(0.0, (deadline - datetime.now(timezone.utc)).total_seconds()) + DISCARD_MARGIN_SECONDS)
        discard_draft(user_id, experiment_id, settings)
    except Exception:
        logger.warning("Logbook cleanup failed op=row")
        return False
    return True


def create_experiment(user_id: str, data: bytes, content_type: str | None, settings: Settings) -> Experiment:
    """Analyze an upload and store it as a draft.

    Order: draft cap, image validation, display copies, quota, Gemini, stored-analysis cap,
    uploads, insert. A rejected image, or one whose display copies cannot be made (busy,
    too large), costs no quota. If Gemini fails, or its analysis exceeds the StoredAnalysis
    caps (field caps, 32 KiB in total), nothing is stored and the quota unit stays spent.
    If an upload fails, the objects already uploaded are deleted. create_draft writes
    nothing after a deadline 8 s out. If the insert fails, cleanup waits for that deadline,
    removes the row with discard_draft (the insert may have committed before its response
    was lost), then the objects; if the discard fails, the objects are kept so a surviving
    row never loses its images. A draft_limit, late or invalid_arguments result means no
    row, so only objects go.
    """
    if count_live_drafts(user_id, settings) >= settings.max_drafts_per_user:
        raise AnalysisError(409, TOO_MANY_DRAFTS)
    cleaned, mime_type = prepare_image(data, content_type, settings)
    display, thumb = make_display_copies(cleaned, mime_type)
    _charge_quota(user_id, settings)
    analysis, model = analyze_image_with_model(cleaned, mime_type, settings)
    try:
        stored = StoredAnalysis.model_validate(analysis.model_dump())
    except ValidationError:
        # No content or ids in the log; "from None" keeps the input values out of tracebacks.
        logger.warning("Logbook analysis rejected reason=too_long")
        raise AnalysisError(502, INVALID_ANALYSIS) from None

    experiment_id = str(uuid.uuid4())
    image_path, thumb_path = _object_paths(user_id, experiment_id)
    uploaded: list[str] = []
    stage = "upload"
    try:
        for path, content in ((image_path, display), (thumb_path, thumb)):
            # Recorded before the call: a timed-out upload may still have reached storage.
            uploaded.append(path)
            upload_object(user_id, path, content, settings)
        stage = "insert"
        deadline = datetime.now(timezone.utc) + timedelta(seconds=CREATE_DEADLINE_SECONDS)
        result = insert_experiment(user_id, {
            "id": experiment_id,
            "analysis": stored.model_dump(),
            "model": model,
            "prompt_version": PROMPT_VERSION,
            "image_path": image_path,
            "thumb_path": thumb_path,
            "image_bytes": len(display),
            "deadline": deadline,
        }, settings)
        outcome = result.get("result") if isinstance(result, dict) else None
        if outcome in ("draft_limit", "late", "invalid_arguments"):
            # create_draft wrote nothing (draft_limit: a concurrent create took the last slot
            # after the pre-check), so only the images need deleting, with no discard.
            stage = outcome
            if outcome == "draft_limit":
                raise AnalysisError(409, TOO_MANY_DRAFTS)
            raise _unavailable("insert", outcome)
    except Exception:
        # Delete what may have been stored, then re-raise unchanged. After an insert failure the
        # row may exist anyway (committed, response lost): discard it first, and keep the
        # objects if that fails, so a surviving row never points at missing images.
        if stage == "insert" and not _discard_quietly(user_id, experiment_id, deadline, settings):
            raise
        if uploaded:
            _cleanup(user_id, uploaded, settings, stage)
        raise
    # The row exists from here on, so a bad representation is reported but the objects stay.
    row = _rpc_row(user_id, result)
    if row is None:
        raise _unavailable("insert", "bad_response")
    return _experiment(user_id, row, settings)


def read_experiment(user_id: str, experiment_id: str, settings: Settings) -> Experiment:
    """The user's own experiment, or 404. Another user's ID also gives 404, never 403."""
    canonical = _canonical_id(experiment_id)
    if canonical is None:
        raise AnalysisError(404, NOT_FOUND)
    row = get_experiment(user_id, canonical, settings)
    if row is None:
        raise AnalysisError(404, NOT_FOUND)
    return _experiment(user_id, row, settings)


def _followup_analysis(user_id: str, experiment_id: str, settings: Settings) -> StoredAnalysis:
    """The stored analysis of the user's own experiment, with one quota unit charged.

    404 for a non-UUID (before any request), another user's ID, a missing row or an expired
    draft; 503 for an unparsable stored analysis; 422 if it exceeds the StoredAnalysis caps.
    None of these costs quota. After the charge, a Gemini failure or the server-wide cap keeps
    the unit spent, as in create.
    """
    canonical = _canonical_id(experiment_id)
    if canonical is None:
        raise AnalysisError(404, NOT_FOUND)
    row = get_experiment(user_id, canonical, settings)
    if row is None:
        raise AnalysisError(404, NOT_FOUND)
    try:
        analysis = Analysis.model_validate(row.get("analysis"))
    except ValidationError:
        raise _unavailable("parse_row", "bad_response") from None
    try:
        stored = StoredAnalysis.model_validate(analysis.model_dump())
    except ValidationError:
        # No content or ids in the log; "from None" keeps the stored values out of tracebacks.
        logger.warning("Logbook stored analysis rejected reason=too_long")
        raise AnalysisError(422, ANALYSIS_TOO_LONG) from None
    _charge_quota(user_id, settings)
    return stored


def ask_experiment(user_id: str, experiment_id: str, question: str, settings: Settings) -> AskResponse:
    """Answer a question about the user's own experiment from its stored analysis. Stores nothing."""
    return answer_question(_followup_analysis(user_id, experiment_id, settings), question, settings)


def quiz_experiment(user_id: str, experiment_id: str, settings: Settings) -> QuizResponse:
    """A quiz on the user's own experiment from its stored analysis. Stores nothing."""
    return generate_quiz(_followup_analysis(user_id, experiment_id, settings), settings)


def _encode_cursor(created_at: datetime, experiment_id: str) -> str:
    raw = json.dumps({"c": _utc_timestamp(created_at), "i": experiment_id}, separators=(",", ":"))
    return base64.urlsafe_b64encode(raw.encode()).decode().rstrip("=")


def _decode_cursor(cursor: str) -> tuple[str, str] | None:
    """(created_at as a UTC Z timestamp, canonical id) from a cursor, or None if it is malformed."""
    try:
        data = json.loads(base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)))
        created_at = datetime.fromisoformat(data["c"])
        experiment_id = _canonical_id(data["i"])
        if experiment_id is None or created_at.tzinfo is None or not 2020 <= created_at.year <= 9998:
            return None
        return _utc_timestamp(created_at), experiment_id
    except (ValueError, TypeError, KeyError, OverflowError):
        return None


def list_experiments(user_id: str, limit: int, cursor: str | None, settings: Settings) -> ExperimentPage:
    """The user's saved experiments and live drafts, newest first, with signed thumbnail URLs only.

    Keyset paging on (created_at, id). A malformed cursor is a 400 before any request.
    """
    position = None
    if cursor is not None:
        position = _decode_cursor(cursor)
        if position is None:
            raise AnalysisError(400, INVALID_CURSOR)
    # Values inside PostgREST logic trees are quoted: timestamps contain the reserved "." and ":".
    conditions = f'or(status.eq.saved,expires_at.gt."{_utc_timestamp(datetime.now(timezone.utc))}")'
    if position is not None:
        created_at, after_id = position
        conditions += f',or(created_at.lt."{created_at}",and(created_at.eq."{created_at}",id.lt.{after_id}))'
    rows = _json(_request("list", settings, "GET", "/rest/v1/experiments", params={
        "select": LIST_COLUMNS,
        "user_id": f"eq.{user_id}",
        "and": f"({conditions})",
        "order": "created_at.desc,id.desc",
        "limit": str(limit + 1),
    }))
    if not isinstance(rows, list) or len(rows) > limit + 1 \
            or not all(_owns(user_id, row, ("thumb_path",)) for row in rows):
        raise _unavailable("list", "bad_response")
    page = rows[:limit]
    thumbs = sign_urls(user_id, [row["thumb_path"] for row in page], settings) if page else []
    try:
        items = [ExperimentSummary.model_validate({**row, "thumb_url": thumb}) for row, thumb in zip(page, thumbs)]
    except ValidationError:
        raise _unavailable("list", "bad_response") from None
    next_cursor = _encode_cursor(items[-1].created_at, items[-1].id) if len(rows) > limit else None
    return ExperimentPage(items=items, next_cursor=next_cursor, thumb_url_expires_in=SIGNED_URL_SECONDS)


def update_experiment(user_id: str, experiment_id: str, update: ExperimentUpdate,
                      settings: Settings) -> Experiment:
    """Edit title/notes and optionally save a draft, through update_experiment (migration 0002).

    The function enforces the saved cap under the same per-user lock as create.
    """
    canonical = _canonical_id(experiment_id)
    if canonical is None:
        raise AnalysisError(404, NOT_FOUND)
    result = _json(_request("update", settings, "POST", "/rest/v1/rpc/update_experiment", json={
        "p_user": user_id,
        "p_id": canonical,
        "p_title": update.title,
        "p_notes": update.notes,
        "p_save": update.status == "saved",
        "p_max_saved": settings.max_saved_experiments_per_user,
    }))
    outcome = result.get("result") if isinstance(result, dict) else None
    if outcome == "not_found":
        raise AnalysisError(404, NOT_FOUND)
    if outcome == "title_required":
        raise AnalysisError(422, TITLE_REQUIRED)
    if outcome == "saved_limit":
        raise AnalysisError(409, TOO_MANY_SAVED)
    row = _rpc_row(user_id, result)
    if row is None or row.get("id") != canonical:
        raise _unavailable("update", "bad_response")
    return _experiment(user_id, row, settings)


def delete_experiment(user_id: str, experiment_id: str, settings: Settings) -> None:
    """Delete the user's experiment: the row first, then its images. 404 if there was no row.

    The image delete also runs after a 404, so retrying a delete whose image cleanup failed
    removes the leftovers; it only reaches the caller's own <user_id>/<id>/ prefix. If the
    row delete fails or its response is unclear, the images are kept.
    """
    canonical = _canonical_id(experiment_id)
    if canonical is None:
        raise AnalysisError(404, NOT_FOUND)
    rows = _json(_request("delete", settings, "DELETE", "/rest/v1/experiments",
                          params={"select": "id", "id": f"eq.{canonical}", "user_id": f"eq.{user_id}"},
                          headers={"Prefer": "return=representation"}))
    if not isinstance(rows, list) or len(rows) > 1 \
            or any(not isinstance(row, dict) or row.get("id") != canonical for row in rows):
        raise _unavailable("delete", "bad_response")
    _cleanup(user_id, _object_paths(user_id, canonical), settings, "delete")
    if not rows:
        raise AnalysisError(404, NOT_FOUND)


def _ids(rows: Any) -> list[str]:
    """Canonical ids from [{"id": ...}, ...]; ValueError on anything else."""
    if not isinstance(rows, list):
        raise ValueError("bad_response")
    ids = [_canonical_id(row.get("id")) if isinstance(row, dict) else None for row in rows]
    if None in ids:
        raise ValueError("bad_response")
    return ids


def purge_expired_drafts(user_id: str, settings: Settings) -> None:
    """Delete up to PURGE_BATCH of the user's expired drafts and their images. Never raises.

    Best effort, run after the response. Only drafts expired for PURGE_GRACE are taken, so a
    clock ahead of the database's cannot purge a draft the database still counts as live.
    The delete repeats the draft and expiry filters, so a draft saved in the meantime is kept,
    and images are deleted only for rows it removed.
    """
    op = "select"
    try:
        expired = {
            "user_id": f"eq.{user_id}",
            "status": "eq.draft",
            "expires_at": f"lte.{_utc_timestamp(datetime.now(timezone.utc) - PURGE_GRACE)}",
        }
        ids = _ids(_json(_request("purge_select", settings, "GET", "/rest/v1/experiments", params={
            "select": "id", **expired, "order": "expires_at.asc", "limit": str(PURGE_BATCH),
        })))[:PURGE_BATCH]
        if not ids:
            return
        op = "delete"
        try:
            deleted = _ids(_json(_request("purge_delete", settings, "DELETE", "/rest/v1/experiments",
                                          params={"select": "id", "id": f"in.({','.join(ids)})", **expired},
                                          headers={"Prefer": "return=representation"})))
        except Exception:
            # The delete may have committed with its response lost. Rows now gone were the only
            # reference to their images, so find them and delete their images below.
            logger.warning("Logbook purge failed op=delete")
            op = "recheck"
            present = set(_ids(_json(_request("purge_recheck", settings, "GET", "/rest/v1/experiments", params={
                "select": "id", "user_id": f"eq.{user_id}", "id": f"in.({','.join(ids)})",
            }))))
            deleted = [experiment_id for experiment_id in ids if experiment_id not in present]
        op = "objects"
        paths = [path for experiment_id in deleted if experiment_id in ids
                 for path in _object_paths(user_id, experiment_id)]
        if paths:
            delete_objects(user_id, paths, settings)
    except Exception:
        logger.warning("Logbook purge failed op=%s", op)
