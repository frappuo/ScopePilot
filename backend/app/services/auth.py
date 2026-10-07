"""Verify Supabase access tokens (JWTs) against the project's public JWKS.

Nothing here logs: tokens, emails and claims must never reach the logs. Callers
log the short reason codes carried by AuthError instead.
"""

from dataclasses import dataclass
from functools import lru_cache
import threading
import time
from typing import Any
import uuid

import jwt

# Fixed allow-list passed to jwt.decode; the token header's alg is never trusted.
# Excludes "none" and HS256 (a shared secret the backend must not rely on).
ALLOWED_ALGORITHMS = ["ES256", "RS256"]
AUDIENCE = "authenticated"
LEEWAY_SECONDS = 30
JWKS_CACHE_SECONDS = 600
JWKS_TIMEOUT_SECONDS = 5
# Minimum gap between forced JWKS refetches triggered by an unknown kid, so tokens
# with random kids cannot make us hammer Supabase. Trade-off: a valid token signed
# with a newly rotated key can be rejected (401) during the cooldown; the client is
# expected to refresh its session and retry.
REFETCH_COOLDOWN_SECONDS = 30


@dataclass(frozen=True)
class AuthenticatedUser:
    user_id: str
    email: str | None


class AuthError(Exception):
    """The token is not acceptable (401). `reason` is a fixed code, safe to log."""

    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


class JwksUnavailable(Exception):
    """The signing keys could not be fetched or parsed (503)."""


_refetch_lock = threading.Lock()
_last_refetch: float | None = None


def reset_refetch_cooldown() -> None:
    global _last_refetch
    with _refetch_lock:
        _last_refetch = None


def _may_refetch() -> bool:
    global _last_refetch
    with _refetch_lock:
        now = time.monotonic()
        if _last_refetch is not None and now - _last_refetch < REFETCH_COOLDOWN_SECONDS:
            return False
        _last_refetch = now
        return True


@lru_cache
def _jwks_client(supabase_url: str) -> jwt.PyJWKClient:
    return jwt.PyJWKClient(
        f"{supabase_url}/auth/v1/.well-known/jwks.json",
        cache_jwk_set=True,
        lifespan=JWKS_CACHE_SECONDS,
        timeout=JWKS_TIMEOUT_SECONDS,
    )


def _match(keys: list[jwt.PyJWK], kid: str) -> jwt.PyJWK | None:
    return next((key for key in keys if key.key_id == kid), None)


def _signing_key(supabase_url: str, kid: str) -> jwt.PyJWK:
    client = _jwks_client(supabase_url)
    try:
        key = _match(client.get_signing_keys(), kid)
        if key is None and _may_refetch():
            key = _match(client.get_signing_keys(refresh=True), kid)
    except (jwt.PyJWKClientError, jwt.PyJWKSetError):
        raise JwksUnavailable() from None
    if key is None:
        raise AuthError("unknown_kid")
    return key


def _decode(token: str, key: jwt.PyJWK, issuer: str) -> dict[str, Any]:
    try:
        return jwt.decode(
            token,
            key,
            algorithms=ALLOWED_ALGORITHMS,
            audience=AUDIENCE,
            issuer=issuer,
            leeway=LEEWAY_SECONDS,
            options={"require": ["exp", "iss", "aud", "sub"]},
        )
    except jwt.ExpiredSignatureError:
        raise AuthError("expired") from None
    except jwt.InvalidIssuerError:
        raise AuthError("bad_iss") from None
    except jwt.InvalidAudienceError:
        raise AuthError("bad_aud") from None
    except jwt.MissingRequiredClaimError:
        raise AuthError("missing_claim") from None
    except jwt.InvalidSignatureError:
        raise AuthError("bad_signature") from None
    except jwt.PyJWTError:
        raise AuthError("invalid") from None


def verify_access_token(token: str, supabase_url: str) -> AuthenticatedUser:
    """Return the user for a valid Supabase access token.

    Raises AuthError (401) or JwksUnavailable (503). Blocking (JWKS fetch): call it
    from a thread pool in async code.
    """
    try:
        header = jwt.get_unverified_header(token)
    except jwt.PyJWTError:
        raise AuthError("malformed") from None
    # Reject before any JWKS lookup so "none"/HS256 tokens never cause a fetch.
    if header.get("alg") not in ALLOWED_ALGORITHMS:
        raise AuthError("bad_alg")
    kid = header.get("kid")
    if not isinstance(kid, str) or not kid:
        raise AuthError("missing_kid")

    claims = _decode(token, _signing_key(supabase_url, kid), issuer=f"{supabase_url}/auth/v1")

    if claims.get("role") != "authenticated":
        raise AuthError("bad_role")
    # Strict: a missing is_anonymous claim is rejected too. Supabase documents this
    # claim on access tokens; verify against a real project token before relying on it.
    if claims.get("is_anonymous") is not False:
        raise AuthError("anonymous")
    sub = claims.get("sub")
    try:
        user_id = str(uuid.UUID(sub)) if isinstance(sub, str) else None
    except ValueError:
        user_id = None
    if user_id is None:
        raise AuthError("bad_sub")
    email = claims.get("email")
    return AuthenticatedUser(user_id=user_id, email=email if isinstance(email, str) and email else None)
