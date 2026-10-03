"""App token middleware. Hermetic: dummy token value, mocked SDK, no network."""

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
from app.middleware import AppTokenMiddleware
from app.services import gemini

KEY = "test-key-not-real"
TOKEN = "dummy-app-token-for-tests"
WRONG = "wrong-dummy-token"
HEADER = "X-ScopePilot-Token"
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
        payload["question"] = "Why are the cells rectangular?"
    return client.post(endpoint, json=payload, headers=headers)


@pytest.mark.parametrize("endpoint", REPLIES)
def test_disabled_when_empty(client, sdk, endpoint):
    sdk.return_value = SimpleNamespace(text=REPLIES[endpoint])
    assert call(client, endpoint).status_code == 200


@pytest.mark.parametrize("endpoint", REPLIES)
@pytest.mark.parametrize("headers", [None, {HEADER: WRONG}, {HEADER: ""}], ids=["missing", "wrong", "empty"])
def test_missing_or_wrong_token_rejected(client, sdk, endpoint, headers):
    use_settings(app_token=TOKEN)
    response = call(client, endpoint, headers)
    assert response.status_code == 401
    assert response.json() == {"detail": "Unauthorized client."}
    sdk.assert_not_called()


@pytest.mark.parametrize("endpoint", REPLIES)
def test_correct_token_accepted(client, sdk, endpoint):
    use_settings(app_token=TOKEN)
    sdk.return_value = SimpleNamespace(text=REPLIES[endpoint])
    assert call(client, endpoint, {HEADER: TOKEN}).status_code == 200


def test_header_name_case_insensitive(client, sdk):
    use_settings(app_token=TOKEN)
    sdk.return_value = SimpleNamespace(text=REPLIES["/ask"])
    assert call(client, "/ask", {HEADER.lower(): TOKEN}).status_code == 200


def test_health_without_token(client):
    use_settings(app_token=TOKEN)
    assert client.get("/health").status_code == 200


def test_token_never_exposed(client, sdk, caplog):
    use_settings(app_token=TOKEN)
    with caplog.at_level(logging.WARNING, logger="app.middleware"):
        responses = [call(client, "/ask"), call(client, "/ask", {HEADER: WRONG})]
    assert "Request rejected rule=app_token path=/ask reason=missing" in caplog.text
    assert "Request rejected rule=app_token path=/ask reason=mismatch" in caplog.text
    for response in responses:
        assert TOKEN not in response.text
        assert TOKEN not in str(response.headers)
    assert TOKEN not in caplog.text
    assert WRONG not in caplog.text
    assert TOKEN not in repr(Settings(_env_file=None, app_token=TOKEN))


def test_unauthorized_oversized_body_gets_401_not_413(client, sdk):
    use_settings(app_token=TOKEN, max_json_body_bytes=10)
    assert call(client, "/ask").status_code == 401
    assert call(client, "/ask", {HEADER: TOKEN}).status_code == 413
    sdk.assert_not_called()


def test_rejected_request_body_never_read():
    sent = []

    async def downstream(scope, receive, send):
        raise AssertionError("the app must not run for a rejected request")

    async def receive():
        raise AssertionError("the body must not be read")

    async def send(message):
        sent.append(message)

    settings = Settings(_env_file=None, app_token=TOKEN)
    middleware = AppTokenMiddleware(downstream, settings_for=lambda scope: settings)
    asyncio.run(middleware({"type": "http", "path": "/ask", "headers": []}, receive, send))
    assert sent[0]["status"] == 401
    assert json.loads(sent[1]["body"]) == {"detail": "Unauthorized client."}
