"""Reject unauthorized clients and oversized request bodies before FastAPI reads or parses them."""

import hmac
import json
import logging
from collections.abc import Awaitable, Callable, MutableMapping
from typing import Any

from app.config import Settings, get_settings

logger = logging.getLogger(__name__)

Scope = MutableMapping[str, Any]
Message = MutableMapping[str, Any]
Receive = Callable[[], Awaitable[Message]]
Send = Callable[[Message], Awaitable[None]]

MULTIPART_OVERHEAD_BYTES = 64 * 1024
EXEMPT_PATHS = frozenset({"/health"})
KNOWN_PATHS = frozenset({"/analyze", "/ask", "/quiz"})
TOKEN_HEADER = b"x-scopepilot-token"


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


async def _send_json(send: Send, status: int, payload: dict[str, str]) -> None:
    body = json.dumps(payload).encode()
    await send({
        "type": "http.response.start",
        "status": status,
        "headers": [
            (b"content-type", b"application/json"),
            (b"content-length", str(len(body)).encode()),
            (b"connection", b"close"),
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
