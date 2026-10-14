"""Legacy switch (LEGACY_API_ENABLED). Hermetic: dummy values, mocked SDK, no network."""

import asyncio
from io import BytesIO
import json
import logging
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.config import Settings, get_settings
from app.main import app
from app.middleware import LegacyApiMiddleware
from app.services import gemini

KEY = "test-key-not-real"
TOKEN = "dummy-app-token-for-tests"
GONE = {"detail": "This version of ScopePilot is no longer supported. Please update the app."}
LOGBOOK = {"supabase_url": "https://example-project.supabase.co",
           "supabase_secret_key": "dummy-supabase-secret-for-tests"}
ANALYSIS = {
    "probable_specimen": "Possible onion epidermis",
    "visible_structures": ["Cell walls"],
    "observations": ["Rectangular cells"],
    "explanation": "Plant cell walls define cell boundaries.",
    "limitations": ["Tentative AI output; verify with an instructor."],
}
QUIZ = {"questions": [
    {
        "question": f"Question {number}?",
        "options": [f"{number}A", f"{number}B", f"{number}C", f"{number}D"],
        "correct_answer": f"{number}A",
        "explanation": "Because of the visible evidence.",
    }
    for number in range(1, 4)
]}
REPLIES = {"/analyze": json.dumps(ANALYSIS), "/ask": "An answer.", "/quiz": json.dumps(QUIZ)}
QUESTION = "Why are the cells rectangular?"


def use_settings(**overrides):
    app.dependency_overrides[get_settings] = lambda: Settings(_env_file=None, gemini_api_key=KEY, **overrides)


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr("app.main.get_settings", lambda: Settings(_env_file=None, gemini_api_key=KEY))
    use_settings()
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()


@pytest.fixture
def sdk(monkeypatch):
    factory = MagicMock()
    generate = factory.return_value.__enter__.return_value.models.generate_content
    monkeypatch.setattr(gemini.genai, "Client", factory)
    return generate


def png_bytes():
    stream = BytesIO()
    Image.new("RGB", (8, 8), "white").save(stream, format="PNG")
    return stream.getvalue()


def call(client, endpoint, headers=None):
    if endpoint == "/analyze":
        return client.post("/analyze", files={"image": ("sample.png", png_bytes(), "image/png")}, headers=headers)
    payload = {"analysis": ANALYSIS}
    if endpoint == "/ask":
        payload["question"] = QUESTION
    return client.post(endpoint, json=payload, headers=headers)


def run_middleware(path, enabled, headers=()):
    """Runs the middleware alone; reports whether the app ran and what was sent."""
    sent, downstream_calls = [], []

    async def downstream(scope, receive, send):
        downstream_calls.append(scope["path"])

    async def receive():
        raise AssertionError("the body must not be read")

    async def send(message):
        sent.append(message)

    settings = Settings(_env_file=None, legacy_api_enabled=enabled)
    middleware = LegacyApiMiddleware(downstream, settings_for=lambda scope: settings)
    asyncio.run(middleware({"type": "http", "method": "POST", "path": path, "headers": list(headers)},
                           receive, send))
    return downstream_calls, sent


def test_enabled_by_default():
    assert Settings(_env_file=None).legacy_api_enabled is True


@pytest.mark.parametrize("endpoint", REPLIES)
def test_default_legacy_routes_work(client, sdk, endpoint):
    sdk.return_value = SimpleNamespace(text=REPLIES[endpoint])
    assert call(client, endpoint).status_code == 200
    sdk.assert_called_once()


@pytest.mark.parametrize("endpoint", REPLIES)
def test_disabled_route_gets_410_without_gemini(client, sdk, endpoint):
    use_settings(legacy_api_enabled=False)
    response = call(client, endpoint)
    assert response.status_code == 410
    assert response.json() == GONE
    assert response.headers["connection"] == "close"
    sdk.assert_not_called()


@pytest.mark.parametrize("endpoint", REPLIES)
def test_disabled_route_gets_410_for_any_method(client, endpoint):
    use_settings(legacy_api_enabled=False)
    response = client.get(endpoint)
    assert response.status_code == 410
    assert response.json() == GONE


@pytest.mark.parametrize("endpoint", REPLIES)
def test_disabled_route_body_never_read(endpoint):
    downstream_calls, sent = run_middleware(endpoint, enabled=False)
    assert downstream_calls == []
    assert sent[0]["status"] == 410
    assert (b"connection", b"close") in sent[0]["headers"]
    assert json.loads(sent[1]["body"]) == GONE


@pytest.mark.parametrize("endpoint", REPLIES)
def test_disabled_route_gets_410_before_app_token(client, sdk, endpoint):
    use_settings(legacy_api_enabled=False, app_token=TOKEN)
    response = call(client, endpoint)
    assert response.status_code == 410
    assert response.json() == GONE
    sdk.assert_not_called()


@pytest.mark.parametrize("endpoint", ["/ask", "/quiz"])
def test_disabled_route_gets_410_before_body_limit(client, sdk, endpoint):
    use_settings(max_json_body_bytes=10)
    assert call(client, endpoint).status_code == 413
    use_settings(legacy_api_enabled=False, max_json_body_bytes=10)
    assert call(client, endpoint).status_code == 410
    sdk.assert_not_called()


def test_health_unaffected_when_disabled(client):
    use_settings(legacy_api_enabled=False)
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


@pytest.mark.parametrize("path", ["/v1/me", "/v1/experiments"])
def test_v1_unaffected_when_disabled(client, path):
    use_settings(legacy_api_enabled=False, **LOGBOOK)
    # No bearer token: 401 from BearerAuthMiddleware, before any JWKS or Supabase call.
    assert client.get(path).status_code == 401
    use_settings(legacy_api_enabled=False)
    response = client.get(path)
    assert response.status_code == 503
    assert response.json() == {"detail": "Logbook not configured."}


def test_v1_still_needs_app_token_when_disabled(client):
    use_settings(legacy_api_enabled=False, app_token=TOKEN, **LOGBOOK)
    response = client.get("/v1/me")
    assert response.status_code == 401
    assert response.json() == {"detail": "Unauthorized client."}


@pytest.mark.parametrize("path", [
    "/health",
    "/v1/me",
    "/v1/experiments",
    "/v1/experiments/00000000-0000-0000-0000-000000000000",
    "/v1/experiments/00000000-0000-0000-0000-000000000000/ask",
    "/v1/experiments/00000000-0000-0000-0000-000000000000/quiz",
    "/v1/analyze",
    "/analyzer",
    "/ask/extra",
])
def test_other_paths_pass_through_when_disabled(path):
    downstream_calls, sent = run_middleware(path, enabled=False)
    assert downstream_calls == [path]
    assert sent == []


@pytest.mark.parametrize("endpoint", REPLIES)
def test_enabled_passes_through(endpoint):
    downstream_calls, sent = run_middleware(endpoint, enabled=True)
    assert downstream_calls == [endpoint]
    assert sent == []


def test_rejection_logged_without_body(client, caplog):
    use_settings(legacy_api_enabled=False)
    with caplog.at_level(logging.INFO, logger="app.middleware"):
        assert call(client, "/ask").status_code == 410
    assert "Request rejected rule=legacy_disabled path=/ask" in caplog.text
    assert QUESTION not in caplog.text
    assert ANALYSIS["probable_specimen"] not in caplog.text
