"""Bearer auth for /v1/*. Hermetic: locally generated keys, fake JWKS, dummy values, no network."""

import base64
from datetime import datetime, timedelta, timezone
import json
import logging
import uuid

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import ec
from fastapi.testclient import TestClient

from app.config import Settings, get_settings
from app.dependencies import current_user
from app.main import app
from app.services import auth
from app.services.auth import AuthenticatedUser

KEY = "test-key-not-real"
SUPABASE_URL = "https://example-project.supabase.co"
ISSUER = f"{SUPABASE_URL}/auth/v1"
SECRET_KEY = "dummy-supabase-secret-for-tests"
APP_TOKEN = "dummy-app-token-for-tests"
USER_ID = "8f14e45f-ceea-4e7a-9a3b-2b6f0d1c5e77"
EMAIL = "student@example.test"
INVALID = {"detail": "Session expired or invalid."}


def use_settings(**overrides):
    values = {"supabase_url": SUPABASE_URL, "supabase_secret_key": SECRET_KEY, **overrides}
    app.dependency_overrides[get_settings] = lambda: Settings(_env_file=None, gemini_api_key=KEY, **values)


def new_key(kid):
    private = ec.generate_private_key(ec.SECP256R1())
    jwk = json.loads(jwt.algorithms.ECAlgorithm.to_jwk(private.public_key()))
    return private, {**jwk, "kid": kid, "alg": "ES256", "use": "sig"}


SIGNING_KEY, SIGNING_JWK = new_key("kid-current")
ROTATED_KEY, ROTATED_JWK = new_key("kid-rotated")


def mint(key=SIGNING_KEY, kid="kid-current", algorithm="ES256", drop=(), **claims):
    now = datetime.now(timezone.utc)
    payload = {
        "sub": USER_ID,
        "email": EMAIL,
        "iss": ISSUER,
        "aud": "authenticated",
        "role": "authenticated",
        "is_anonymous": False,
        "iat": now,
        "exp": now + timedelta(hours=1),
        **claims,
    }
    for name in drop:
        payload.pop(name)
    return jwt.encode(payload, key, algorithm=algorithm, headers={"kid": kid})


def bearer(token):
    return {"Authorization": f"Bearer {token}"}


class FakeJwks:
    """Stands in for PyJWKClient.fetch_data: serves `keys` or raises, and counts calls."""

    def __init__(self):
        self.keys = [SIGNING_JWK]
        self.calls = 0
        self.unreachable = False

    def __call__(self, client):
        self.calls += 1
        assert client.uri == f"{ISSUER}/.well-known/jwks.json"
        if self.unreachable:
            raise jwt.PyJWKClientConnectionError("fake outage")
        return {"keys": list(self.keys)}


@pytest.fixture
def jwks(monkeypatch):
    fake = FakeJwks()
    monkeypatch.setattr(jwt.PyJWKClient, "fetch_data", lambda client: fake(client))
    auth._jwks_client.cache_clear()
    auth.reset_refetch_cooldown()
    yield fake
    auth._jwks_client.cache_clear()
    auth.reset_refetch_cooldown()


@pytest.fixture
def client(monkeypatch, jwks):
    monkeypatch.setattr("app.main.get_settings", lambda: Settings(_env_file=None, gemini_api_key=KEY))
    use_settings()
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()


def assert_invalid(response):
    assert response.status_code == 401
    assert response.json() == INVALID
    assert response.headers["www-authenticate"] == "Bearer"


def test_valid_token_returns_user(client, jwks):
    response = client.get("/v1/me", headers=bearer(mint()))
    assert response.status_code == 200
    assert response.json() == {"user_id": USER_ID, "email": EMAIL}
    assert jwks.calls == 1
    client.get("/v1/me", headers=bearer(mint()))
    assert jwks.calls == 1  # JWKS cached


def test_token_without_email(client):
    response = client.get("/v1/me", headers=bearer(mint(drop=("email",))))
    assert response.json() == {"user_id": USER_ID, "email": None}


def test_missing_header(client, jwks):
    assert_invalid(client.get("/v1/me"))
    assert jwks.calls == 0


@pytest.mark.parametrize("value", [
    "Basic dXNlcjpwYXNz", "Bearer", "Bearer ", "Bearer a b", "Bearer  token", "Token abc", "bearer",
], ids=["basic", "no-token", "empty-token", "two-tokens", "double-space", "other-scheme", "lowercase-only"])
def test_malformed_header(client, jwks, value):
    assert_invalid(client.get("/v1/me", headers={"Authorization": value}))
    assert jwks.calls == 0


def test_scheme_is_case_insensitive(client):
    assert client.get("/v1/me", headers={"Authorization": f"bearer {mint()}"}).status_code == 200


def test_not_a_jwt(client, jwks):
    assert_invalid(client.get("/v1/me", headers=bearer("not.a.jwt")))
    assert jwks.calls == 0


def test_oversized_header(client, jwks):
    assert_invalid(client.get("/v1/me", headers=bearer("a" * 9000)))
    assert jwks.calls == 0


def test_expired(client):
    past = datetime.now(timezone.utc) - timedelta(minutes=5)
    assert_invalid(client.get("/v1/me", headers=bearer(mint(exp=past, iat=past - timedelta(hours=1)))))


def test_expired_within_leeway_accepted(client):
    just_expired = datetime.now(timezone.utc) - timedelta(seconds=10)
    assert client.get("/v1/me", headers=bearer(mint(exp=just_expired))).status_code == 200


@pytest.mark.parametrize("claim", ["exp", "iss", "aud", "sub"])
def test_required_claim_missing(client, claim):
    assert_invalid(client.get("/v1/me", headers=bearer(mint(drop=(claim,)))))


@pytest.mark.parametrize("issuer", [
    "https://evil.example/auth/v1", SUPABASE_URL, f"{ISSUER}/", "https://other-project.supabase.co/auth/v1",
])
def test_wrong_iss(client, issuer):
    assert_invalid(client.get("/v1/me", headers=bearer(mint(iss=issuer))))


@pytest.mark.parametrize("audience", ["anon", "service_role", ["other"]])
def test_wrong_aud(client, audience):
    assert_invalid(client.get("/v1/me", headers=bearer(mint(aud=audience))))


@pytest.mark.parametrize("role", ["anon", "service_role", None])
def test_wrong_role(client, role):
    claims = {"drop": ("role",)} if role is None else {"role": role}
    assert_invalid(client.get("/v1/me", headers=bearer(mint(**claims))))


def _b64(data):
    return base64.urlsafe_b64encode(json.dumps(data).encode()).rstrip(b"=").decode()


def test_alg_none_rejected_without_fetch(client, jwks):
    now = int(datetime.now(timezone.utc).timestamp())
    claims = {"sub": USER_ID, "iss": ISSUER, "aud": "authenticated", "role": "authenticated",
              "is_anonymous": False, "exp": now + 3600}
    for alg in ("none", "None", "NONE"):
        token = f"{_b64({'alg': alg, 'typ': 'JWT', 'kid': 'kid-current'})}.{_b64(claims)}."
        assert_invalid(client.get("/v1/me", headers=bearer(token)))
    assert jwks.calls == 0


def test_hs256_with_guessable_secret_rejected_without_fetch(client, jwks):
    token = mint(key="secret", algorithm="HS256")
    assert_invalid(client.get("/v1/me", headers=bearer(token)))
    assert jwks.calls == 0


def test_missing_kid_rejected(client, jwks):
    token = jwt.encode({"sub": USER_ID}, SIGNING_KEY, algorithm="ES256")
    assert_invalid(client.get("/v1/me", headers=bearer(token)))
    assert jwks.calls == 0


def test_known_kid_wrong_key_rejected(client):
    assert_invalid(client.get("/v1/me", headers=bearer(mint(key=ROTATED_KEY, kid="kid-current"))))


def test_unknown_key_refetches_once(client, jwks):
    stranger, _ = new_key("kid-unknown")
    assert_invalid(client.get("/v1/me", headers=bearer(mint(key=stranger, kid="kid-unknown"))))
    assert jwks.calls == 2  # initial fetch + exactly one refetch
    assert_invalid(client.get("/v1/me", headers=bearer(mint(key=stranger, kid="kid-other"))))
    assert jwks.calls == 2  # cooldown: no second refetch


def test_refetch_allowed_again_after_cooldown(client, jwks, monkeypatch):
    stranger, _ = new_key("kid-unknown")
    token = mint(key=stranger, kid="kid-unknown")
    client.get("/v1/me", headers=bearer(token))
    assert jwks.calls == 2
    clock = auth.time.monotonic() + auth.REFETCH_COOLDOWN_SECONDS + 1
    monkeypatch.setattr(auth.time, "monotonic", lambda: clock)
    client.get("/v1/me", headers=bearer(token))
    assert jwks.calls == 3


def test_rotated_key_accepted_after_refetch(client, jwks):
    assert client.get("/v1/me", headers=bearer(mint())).status_code == 200
    jwks.keys = [SIGNING_JWK, ROTATED_JWK]
    response = client.get("/v1/me", headers=bearer(mint(key=ROTATED_KEY, kid="kid-rotated")))
    assert response.status_code == 200
    assert jwks.calls == 2


@pytest.mark.parametrize("claims", [{"is_anonymous": True}, {"drop": ("is_anonymous",)}, {"is_anonymous": "false"}],
                         ids=["true", "missing", "string"])
def test_anonymous_rejected(client, claims):
    assert_invalid(client.get("/v1/me", headers=bearer(mint(**claims))))


@pytest.mark.parametrize("sub", ["not-a-uuid", "", "12345", "service_role"])
def test_non_uuid_sub(client, sub):
    assert_invalid(client.get("/v1/me", headers=bearer(mint(sub=sub))))


def test_sub_is_canonicalised(client):
    response = client.get("/v1/me", headers=bearer(mint(sub=USER_ID.upper())))
    assert response.json()["user_id"] == USER_ID


def test_jwks_unreachable_is_503(client, jwks):
    jwks.unreachable = True
    response = client.get("/v1/me", headers=bearer(mint()))
    assert response.status_code == 503
    assert response.json() == {"detail": "Sign-in is temporarily unavailable."}
    assert response.headers["retry-after"] == "30"


def test_jwks_without_usable_keys_is_503(client, jwks):
    jwks.keys = []
    assert client.get("/v1/me", headers=bearer(mint())).status_code == 503


@pytest.mark.parametrize("overrides", [{"supabase_url": ""}, {"supabase_secret_key": ""}], ids=["no-url", "no-secret"])
def test_not_configured_is_503_without_fetch(client, jwks, overrides):
    use_settings(**overrides)
    for headers in (None, bearer(mint()), {"Authorization": "garbage"}):
        response = client.get("/v1/me", headers=headers)
        assert response.status_code == 503
        assert response.json() == {"detail": "Logbook not configured."}
    assert client.get("/v1/anything-else").status_code == 503
    assert jwks.calls == 0


def test_app_token_checked_first(client, jwks):
    use_settings(app_token=APP_TOKEN)
    response = client.get("/v1/me", headers=bearer(mint()))
    assert response.status_code == 401
    assert response.json() == {"detail": "Unauthorized client."}
    assert "www-authenticate" not in response.headers
    assert jwks.calls == 0
    ok = client.get("/v1/me", headers={**bearer(mint()), "X-ScopePilot-Token": APP_TOKEN})
    assert ok.status_code == 200


def test_unknown_v1_path_needs_session(client):
    assert_invalid(client.get("/v1/unknown"))
    assert client.get("/v1/unknown", headers=bearer(mint())).status_code == 404


def test_health_still_open(client):
    use_settings(app_token=APP_TOKEN)
    assert client.get("/health").status_code == 200


def test_legacy_routes_do_not_need_bearer(client):
    # Rejected for its body (422), not for a missing session: bearer auth is /v1 only.
    assert client.post("/ask", json={}).status_code == 422


def test_bearer_check_precedes_body_limit(client):
    use_settings(max_json_body_bytes=10)
    assert_invalid(client.post("/v1/me", content=b"x" * 100))


def test_current_user_override(client):
    app.dependency_overrides[current_user] = lambda: AuthenticatedUser(user_id=USER_ID, email=None)
    response = client.get("/v1/me", headers=bearer(mint(sub=str(uuid.uuid4()))))
    assert response.json() == {"user_id": USER_ID, "email": None}
    # The middleware still guards /v1: overriding the dependency does not bypass it.
    assert_invalid(client.get("/v1/me"))


def test_no_token_email_or_claims_in_logs(client, jwks, caplog):
    stranger, _ = new_key("kid-unknown")
    tokens = [
        mint(),
        mint(exp=datetime.now(timezone.utc) - timedelta(hours=1)),
        mint(iss="https://evil.example/auth/v1"),
        mint(key=stranger, kid="kid-unknown"),
        mint(is_anonymous=True),
        mint(key="secret", algorithm="HS256"),
    ]
    with caplog.at_level(logging.DEBUG):
        for token in tokens:
            client.get("/v1/me", headers=bearer(token))
        client.get("/v1/me", headers={"Authorization": f"Basic {tokens[0]}"})
        jwks.unreachable = True
        auth._jwks_client.cache_clear()
        client.get("/v1/me", headers=bearer(tokens[0]))
    text = caplog.text
    for reason in ("expired", "bad_iss", "unknown_kid", "anonymous", "bad_alg", "malformed", "jwks_unavailable"):
        assert f"rule=bearer path=/v1/me reason={reason}" in text
    for token in tokens:
        for part in token.split("."):
            if part:
                assert part not in text
    assert EMAIL not in text
    assert USER_ID not in text
    assert "kid-unknown" not in text
