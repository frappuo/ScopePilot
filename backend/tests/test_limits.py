"""Request limits: body size, analysis input caps, daily Gemini cap. Hermetic: dummy key, mocked SDK."""

import asyncio
from datetime import datetime, timedelta, timezone
from io import BytesIO
import json
import logging
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient
from google.genai import errors
from PIL import Image
from pydantic import ValidationError

from app.config import Settings, get_settings
from app.main import app
from app.middleware import MULTIPART_OVERHEAD_BYTES, BodySizeLimitMiddleware
from app.services import gemini, images

KEY = "test-key-not-real"
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
LIST_FIELDS = ("visible_structures", "observations", "limitations")


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
    generate.return_value = SimpleNamespace(text="An answer.")
    monkeypatch.setattr(gemini.genai, "Client", factory)
    return generate


@pytest.fixture
def clock(monkeypatch):
    now = [datetime(2026, 10, 4, 23, 59, 30, tzinfo=timezone.utc)]
    monkeypatch.setattr(gemini._DAILY_CALLS, "clock", lambda: now[0])
    return now


def reply(text):
    return SimpleNamespace(text=text)


def quota():
    return errors.ClientError(429, {"error": {"message": "provider detail", "status": "RESOURCE_EXHAUSTED"}})


def ask_body(analysis=ANALYSIS):
    return json.dumps({"analysis": analysis, "question": "Why are the cells rectangular?"}).encode()


def post_ask(client, content):
    return client.post("/ask", content=content, headers={"content-type": "application/json"})


def chunks(body, size=50):
    for start in range(0, len(body), size):
        yield body[start:start + size]


def png_bytes():
    stream = BytesIO()
    Image.new("RGB", (8, 8), "white").save(stream, format="PNG")
    return stream.getvalue()


# Body size


def test_content_length_over_limit_rejected(client, sdk):
    body = ask_body()
    use_settings(max_json_body_bytes=len(body) - 1)
    response = post_ask(client, body)
    assert response.status_code == 413
    assert response.json() == {"detail": f"Request body exceeds the {len(body) - 1:,}-byte limit."}
    sdk.assert_not_called()


def test_body_exactly_at_limit_accepted(client, sdk):
    body = ask_body()
    use_settings(max_json_body_bytes=len(body))
    assert post_ask(client, body).status_code == 200


def test_chunked_over_limit_rejected(client, sdk):
    body = ask_body()
    use_settings(max_json_body_bytes=len(body) - 1)
    response = post_ask(client, chunks(body))
    assert response.status_code == 413
    sdk.assert_not_called()


def test_chunked_at_limit_accepted(client, sdk):
    body = ask_body()
    use_settings(max_json_body_bytes=len(body))
    assert post_ask(client, chunks(body)).status_code == 200


def test_oversized_upload_rejected_before_decode_and_gemini(client, sdk, monkeypatch):
    use_settings(max_image_bytes=1000)
    prepare = MagicMock(side_effect=AssertionError("prepare_image must not run"))
    monkeypatch.setattr("app.routes.analyze.prepare_image", prepare)
    data = b"x" * (1000 + MULTIPART_OVERHEAD_BYTES + 1)
    response = client.post("/analyze", files={"image": ("big.png", data, "image/png")})
    assert response.status_code == 413
    assert response.json()["detail"].startswith("Request body exceeds")
    prepare.assert_not_called()
    sdk.assert_not_called()
    assert images._DECODE_SLOTS.acquire(blocking=False)
    images._DECODE_SLOTS.release()


def test_health_is_exempt(client):
    use_settings(max_json_body_bytes=1)
    assert client.request("GET", "/health", content=b"x" * 100).status_code == 200


def run_middleware(body_chunks, limit):
    """Drive the middleware directly so the body really arrives in several messages."""
    sent, read = [], []

    async def downstream(scope, receive, send):
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                break
            read.append(message.get("body", b""))
            if not message.get("more_body"):
                break
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"ok"})

    messages = [
        {"type": "http.request", "body": chunk, "more_body": index < len(body_chunks) - 1}
        for index, chunk in enumerate(body_chunks)
    ]

    async def receive():
        return messages.pop(0)

    async def send(message):
        sent.append(message)

    settings = Settings(_env_file=None, max_json_body_bytes=limit)
    middleware = BodySizeLimitMiddleware(downstream, settings_for=lambda scope: settings)
    asyncio.run(middleware({"type": "http", "path": "/ask", "headers": []}, receive, send))
    return sent, read


def test_streamed_body_rejected_mid_stream():
    sent, read = run_middleware([b"x" * 40] * 5, limit=100)
    starts = [message for message in sent if message["type"] == "http.response.start"]
    assert [start["status"] for start in starts] == [413]
    assert sum(map(len, read)) == 80
    assert json.loads(sent[1]["body"]) == {"detail": "Request body exceeds the 100-byte limit."}


def test_streamed_body_at_limit_passes():
    sent, read = run_middleware([b"x" * 50] * 2, limit=100)
    assert sent[0]["status"] == 200
    assert sum(map(len, read)) == 100


def test_body_rejection_logged(client, sdk, caplog):
    body = ask_body()
    use_settings(max_json_body_bytes=10)
    with caplog.at_level(logging.WARNING, logger="app.middleware"):
        assert post_ask(client, body).status_code == 413
    assert "Request body rejected path=/ask limit=10 reason=content_length" in caplog.text
    assert "rectangular" not in caplog.text


# Analysis input caps

OVER_CAP = [
    ("probable_specimen", "x" * 301),
    ("explanation", "x" * 6001),
    *[(field, ["x"] * 41) for field in LIST_FIELDS],
    *[(field, ["x" * 1001]) for field in LIST_FIELDS],
]


def json_request(client, endpoint, analysis):
    payload = {"analysis": analysis}
    if endpoint == "/ask":
        payload["question"] = "Why are the cells rectangular?"
    return client.post(endpoint, json=payload)


@pytest.mark.parametrize("endpoint", ["/ask", "/quiz"])
@pytest.mark.parametrize("field,value", OVER_CAP, ids=lambda value: str(value)[:20])
def test_analysis_over_cap_rejected(client, sdk, endpoint, field, value):
    assert json_request(client, endpoint, {**ANALYSIS, field: value}).status_code == 422
    sdk.assert_not_called()


@pytest.mark.parametrize("endpoint,text", [("/ask", "An answer."), ("/quiz", json.dumps(QUIZ))])
def test_large_realistic_analysis_accepted(client, sdk, endpoint, text):
    sdk.return_value = reply(text)
    large = {
        "probable_specimen": "Possible onion (Allium cepa) epidermis, stained with iodine " * 4,
        "visible_structures": [f"Structure {index}: " + "rectangular cell wall outline " * 5 for index in range(30)],
        "observations": [f"Observation {index}: " + "cells arranged in regular rows " * 5 for index in range(30)],
        "explanation": "Plant cell walls give epidermal cells a regular, brick-like shape. " * 70,
        "limitations": [f"Limitation {index}: focus and staining vary across the field." for index in range(10)],
    }
    assert len(large["probable_specimen"]) <= 300 and len(large["explanation"]) <= 6000
    assert json_request(client, endpoint, large).status_code == 200


def test_analyze_response_not_capped(client, sdk):
    long_analysis = {**ANALYSIS, "explanation": "x" * 7000, "visible_structures": ["Cell wall"] * 50}
    sdk.return_value = reply(json.dumps(long_analysis))
    response = client.post("/analyze", files={"image": ("sample.png", png_bytes(), "image/png")})
    assert response.status_code == 200
    assert response.json() == long_analysis


# Daily Gemini cap


def test_daily_cap_returns_503_with_retry_after(client, sdk, clock):
    use_settings(gemini_daily_call_limit=2)
    assert post_ask(client, ask_body()).status_code == 200
    assert post_ask(client, ask_body()).status_code == 200
    response = post_ask(client, ask_body())
    assert response.status_code == 503
    assert response.headers["retry-after"] == "30"
    assert response.json()["detail"].startswith("Daily Gemini request limit")
    assert sdk.call_count == 2
    clock[0] += timedelta(minutes=1)  # Next UTC day.
    assert post_ask(client, ask_body()).status_code == 200
    assert sdk.call_count == 3


def test_fallback_attempts_count(client, sdk, clock):
    use_settings(gemini_daily_call_limit=2, gemini_model="primary", gemini_fallback_models="fb-1")
    sdk.side_effect = [quota(), reply("An answer."), reply("unused")]
    assert post_ask(client, ask_body()).status_code == 200
    assert post_ask(client, ask_body()).status_code == 503
    assert sdk.call_count == 2


def test_cap_reached_during_fallback(client, sdk, clock):
    use_settings(gemini_daily_call_limit=1, gemini_model="primary", gemini_fallback_models="fb-1")
    sdk.side_effect = [quota(), reply("unused")]
    response = post_ask(client, ask_body())
    assert response.status_code == 503
    assert response.json()["detail"].startswith("Daily Gemini request limit")
    assert sdk.call_count == 1


def test_rejected_requests_do_not_consume(client, sdk, clock):
    use_settings(gemini_daily_call_limit=1)
    sdk.return_value = reply(json.dumps(ANALYSIS))
    for data, mime in [(b"not an image", "image/png"), (png_bytes(), "image/jpeg"), (b"", "image/png")]:
        assert client.post("/analyze", files={"image": ("bad", data, mime)}).status_code in (400, 415)
    assert json_request(client, "/ask", {**ANALYSIS, "explanation": "x" * 6001}).status_code == 422
    use_settings(gemini_daily_call_limit=1, max_json_body_bytes=10)
    assert post_ask(client, ask_body()).status_code == 413
    use_settings(gemini_daily_call_limit=1)
    assert client.post("/analyze", files={"image": ("ok.png", png_bytes(), "image/png")}).status_code == 200
    assert sdk.call_count == 1


def test_daily_cap_logged_once(client, sdk, clock, caplog):
    use_settings(gemini_daily_call_limit=1)
    with caplog.at_level(logging.WARNING, logger="app.services.gemini"):
        for _ in range(4):
            post_ask(client, ask_body())
    assert caplog.text.count("Gemini daily call limit reached operation=ask limit=1") == 1


@pytest.mark.parametrize("field", ["max_json_body_bytes", "gemini_daily_call_limit"])
@pytest.mark.parametrize("value", [0, -1])
def test_limits_must_be_positive(field, value):
    with pytest.raises(ValidationError):
        Settings(_env_file=None, **{field: value})
