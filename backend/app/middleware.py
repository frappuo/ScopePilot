"""Reject unauthorized clients and oversized request bodies before FastAPI reads or parses them."""

import hmac
import json
import logging
from collections.abc import Awaitable, Callable, MutableMapping
from typing import Any

from starlette.concurrency import run_in_threadpool

from app.config import Settings, get_settings
from app.services.auth import AuthError, JwksUnavailable, verify_access_token

logger = logging.getLogger(__name__)

Scope = MutableMapping[str, Any]
Message = MutableMapping[str, Any]
Receive = Callable[[], Awaitable[Message]]
Send = Callable[[Message], Awaitable[None]]

MULTIPART_OVERHEAD_BYTES = 64 * 1024
EXEMPT_PATHS = frozenset({"/health"})
KNOWN_PATHS = frozenset({"/analyze", "/ask", "/quiz", "/v1/me"})
TOKEN_HEADER = b"x-scopepilot-token"
MAX_BEARER_TOKEN_BYTES = 8 * 1024
INVALID_SESSION = {"detail": "Session expired or invalid."}


def body_limit(path: str, settings: Settings) -> int:
    if path == "/analyze":
        return settings.max_image_bytes + MULTIPART_OVERHEAD_BYTES
    return settings.max_json_body_bytes


def _settings_for(scope: Scope) -> Settings:
    # Honour FastAPI dependency overrides (used by tests) as well as the cached settings.
    overrides = getattr(scope.get("app"), "dependency_overrides", {})
    return overrides.get(get_settings, get_settings)()


def _header(scope: Scope, wanted: bytes) -> bytes | None:
    for name, value in scope.get("headers", []):
        if name.lower() == wanted:
            return value
    return None


def _content_length(scope: Scope) -> int | None:
    value = _header(scope, b"content-length")
    if value is None:
        return None
    try:
        return int(value)
    except ValueError:
        return None  # Fall back to counting streamed bytes.


def _log_path(scope: Scope) -> str:
    return scope["path"] if scope["path"] in KNOWN_PATHS else "other"


async def _send_json(send: Send, status: int, payload: dict[str, str],
                     extra_headers: tuple[tuple[bytes, bytes], ...] = ()) -> None:
    body = json.dumps(payload).encode()
    await send({
        "type": "http.response.start",
        "status": status,
        "headers": [
            (b"content-type", b"application/json"),
            (b"content-length", str(len(body)).encode()),
            (b"connection", b"close"),
            *extra_headers,
        ],
    })
    await send({"type": "http.response.body", "body": body})


async def _send_413(send: Send, scope: Scope, limit: int, reason: str) -> None:
    logger.warning("Request body rejected path=%s limit=%s reason=%s", _log_path(scope), limit, reason)
    await _send_json(send, 413, {"detail": f"Request body exceeds the {limit:,}-byte limit."})


class AppTokenMiddleware:
    """401 unless X-ScopePilot-Token matches APP_TOKEN; off while APP_TOKEN is empty.

    Runs before the body is read, so rejected requests cost nothing. The token ships
    inside the app bundle: it deters casual clients and is not authentication.
    """

    def __init__(self, app: Callable[[Scope, Receive, Send], Awaitable[None]],
                 settings_for: Callable[[Scope], Settings] = _settings_for) -> None:
        self.app = app
        self.settings_for = settings_for

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or scope["path"] in EXEMPT_PATHS:
            await self.app(scope, receive, send)
            return
        expected = self.settings_for(scope).app_token.get_secret_value().strip()
        if not expected:
            await self.app(scope, receive, send)
            return
        provided = _header(scope, TOKEN_HEADER)
        if provided is not None and hmac.compare_digest(provided.strip(), expected.encode()):
            await self.app(scope, receive, send)
            return
        reason = "missing" if provided is None else "mismatch"
        logger.warning("Request rejected rule=app_token path=%s reason=%s", _log_path(scope), reason)
        await _send_json(send, 401, {"detail": "Unauthorized client."})


def _bearer_token(scope: Scope) -> str | None:
    """The token from exactly "Bearer <token>" (scheme case-insensitive), else None."""
    value = _header(scope, b"authorization")
    if value is None or len(value) > MAX_BEARER_TOKEN_BYTES:
        return None
    try:
        scheme, token = value.decode("ascii").split(" ")
    except (UnicodeDecodeError, ValueError):
        return None
    if scheme.lower() != "bearer" or not token:
        return None
    return token


class BearerAuthMiddleware:
    """Supabase session check for /v1/*; puts user_id and email in scope["state"].

    Runs after AppTokenMiddleware and before the body is read. A missing logbook
    configuration is reported before any token is examined, so it needs no JWKS.
    Logs reason codes only: never tokens, emails or claims.
    """

    def __init__(self, app: Callable[[Scope, Receive, Send], Awaitable[None]],
                 settings_for: Callable[[Scope], Settings] = _settings_for) -> None:
        self.app = app
        self.settings_for = settings_for

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        path = scope.get("path", "")
        if scope["type"] != "http" or not (path == "/v1" or path.startswith("/v1/")):
            await self.app(scope, receive, send)
            return
        settings = self.settings_for(scope)
        if not settings.logbook_configured:
            self._log_rejection(scope, "not_configured")
            await _send_json(send, 503, {"detail": "Logbook not configured."})
            return
        token = _bearer_token(scope)
        if token is None:
            reason = "missing" if _header(scope, b"authorization") is None else "malformed"
            await self._reject_session(send, scope, reason)
            return
        try:
            user = await run_in_threadpool(verify_access_token, token, settings.supabase_url)
        except AuthError as exc:
            await self._reject_session(send, scope, exc.reason)
            return
        except JwksUnavailable:
            self._log_rejection(scope, "jwks_unavailable")
            await _send_json(send, 503, {"detail": "Sign-in is temporarily unavailable."},
                             ((b"retry-after", b"30"),))
            return
        state = scope.setdefault("state", {})
        state["user_id"] = user.user_id
        state["email"] = user.email
        await self.app(scope, receive, send)

    @staticmethod
    def _log_rejection(scope: Scope, reason: str) -> None:
        logger.warning("Request rejected rule=bearer path=%s reason=%s", _log_path(scope), reason)

    async def _reject_session(self, send: Send, scope: Scope, reason: str) -> None:
        self._log_rejection(scope, reason)
        await _send_json(send, 401, INVALID_SESSION, ((b"www-authenticate", b"Bearer"),))


class BodySizeLimitMiddleware:
    """413 when Content-Length exceeds the path's limit, or once a streamed body does."""

    def __init__(self, app: Callable[[Scope, Receive, Send], Awaitable[None]],
                 settings_for: Callable[[Scope], Settings] = _settings_for) -> None:
        self.app = app
        self.settings_for = settings_for

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or scope["path"] in EXEMPT_PATHS:
            await self.app(scope, receive, send)
            return
        limit = body_limit(scope["path"], self.settings_for(scope))
        declared = _content_length(scope)
        if declared is not None and declared > limit:
            await _send_413(send, scope, limit, "content_length")
            return

        received = 0
        rejected = False
        started = False

        async def limited_receive() -> Message:
            nonlocal received, rejected
            if rejected:
                return {"type": "http.disconnect"}
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > limit and not started:
                    rejected = True
                    await _send_413(send, scope, limit, "streamed")
                    # The app sees a disconnect and stops reading; its own response is dropped.
                    return {"type": "http.disconnect"}
            return message

        async def guarded_send(message: Message) -> None:
            nonlocal started
            if rejected:
                return
            if message["type"] == "http.response.start":
                started = True
            await send(message)

        try:
            await self.app(scope, limited_receive, guarded_send)
        except Exception:
            if not rejected:
                raise
