"""Reject oversized request bodies before FastAPI reads or parses them."""

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


def body_limit(path: str, settings: Settings) -> int:
    if path == "/analyze":
        return settings.max_image_bytes + MULTIPART_OVERHEAD_BYTES
    return settings.max_json_body_bytes


def _settings_for(scope: Scope) -> Settings:
    # Honour FastAPI dependency overrides (used by tests) as well as the cached settings.
    overrides = getattr(scope.get("app"), "dependency_overrides", {})
    return overrides.get(get_settings, get_settings)()


def _content_length(scope: Scope) -> int | None:
    for name, value in scope.get("headers", []):
        if name.lower() == b"content-length":
            try:
                return int(value)
            except ValueError:
                return None  # Fall back to counting streamed bytes.
    return None


async def _send_413(send: Send, scope: Scope, limit: int, reason: str) -> None:
    path = scope["path"] if scope["path"] in KNOWN_PATHS else "other"
    logger.warning("Request body rejected path=%s limit=%s reason=%s", path, limit, reason)
    body = json.dumps({"detail": f"Request body exceeds the {limit:,}-byte limit."}).encode()
    await send({
        "type": "http.response.start",
        "status": 413,
        "headers": [
            (b"content-type", b"application/json"),
            (b"content-length", str(len(body)).encode()),
            (b"connection", b"close"),
        ],
    })
    await send({"type": "http.response.body", "body": body})


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
