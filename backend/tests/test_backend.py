from io import BytesIO
from types import SimpleNamespace
from unittest.mock import MagicMock

import httpx
import pytest
from fastapi.testclient import TestClient
from google.genai import errors
from PIL import Image

from app.config import Settings, get_settings
from app.main import app
from app.services import gemini

RESULT = {
    "probable_specimen": "Possible onion epidermis",
    "visible_structures": ["Cell walls"],
    "observations": ["Rectangular cells"],
    "explanation": "Plant cell walls define cell boundaries.",
    "limitations": ["Tentative AI output; verify with an instructor."],
}


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr("app.main.get_settings", lambda: Settings(
        _env_file=None, gemini_api_key="test-key"
    ))
    app.dependency_overrides[get_settings] = lambda: Settings(
        _env_file=None, gemini_api_key="test-key"
    )
    with TestClient(app) as client:
        yield client
    app.dependency_overrides.clear()


@pytest.fixture
def sdk(monkeypatch):
    factory = MagicMock()
    generate = factory.return_value.__enter__.return_value.models.generate_content
    import json
    generate.return_value = SimpleNamespace(text=json.dumps(RESULT))
    monkeypatch.setattr(gemini.genai, "Client", factory)
    return generate


def image_bytes(fmt="PNG"):
    stream = BytesIO()
    Image.new("RGB", (8, 8), "white").save(stream, format=fmt)
    return stream.getvalue()


def upload(client, data=None, mime="image/png"):
    return client.post("/analyze", files={"image": ("sample", image_bytes() if data is None else data, mime)})


def test_health(client):
    assert client.get("/health").json() == {"status": "ok"}


@pytest.mark.parametrize("fmt,mime", [("PNG", "image/png"), ("JPEG", "image/jpeg"), ("WEBP", "image/webp")])
def test_analyze_success(client, sdk, fmt, mime):
    data = image_bytes(fmt)
    response = upload(client, data, mime)
    assert response.status_code == 200
    assert response.json() == RESULT
    args = sdk.call_args.kwargs
    assert args["contents"][0].inline_data.data == data
    assert args["contents"][0].inline_data.mime_type == mime
    assert args["config"].response_schema is gemini.Analysis


@pytest.mark.parametrize("data,mime,status", [
    (b"", "image/png", 400),
    (b"not an image", "image/png", 400),
    (b"text", "text/plain", 415),
    (image_bytes(), "image/jpeg", 415),
    (image_bytes()[:30], "image/png", 400),
])
def test_invalid_images_never_call_gemini(client, sdk, data, mime, status):
    assert upload(client, data, mime).status_code == status
    sdk.assert_not_called()


@pytest.mark.parametrize("limits", [{"max_image_bytes": 10}, {"max_image_pixels": 10}])
def test_image_limits(client, sdk, limits):
    app.dependency_overrides[get_settings] = lambda: Settings(_env_file=None, **limits)
    assert upload(client).status_code == 413
    sdk.assert_not_called()


def test_missing_image(client, sdk):
    assert client.post("/analyze").status_code == 422
    sdk.assert_not_called()


def test_missing_key(client, sdk):
    app.dependency_overrides[get_settings] = lambda: Settings(_env_file=None, gemini_api_key="")
    assert upload(client).status_code == 503
    sdk.assert_not_called()


@pytest.mark.parametrize("text", [None, "not json", "{}", '{"probable_specimen": 4}'])
def test_invalid_gemini_response(client, sdk, text):
    sdk.return_value = SimpleNamespace(text=text)
    assert upload(client).status_code == 502


@pytest.mark.parametrize("error,status", [
    (httpx.ReadTimeout("private provider detail"), 504),
    (httpx.ConnectError("private provider detail"), 502),
    (errors.ClientError(429, {"error": {"message": "private provider detail"}}), 503),
    (errors.ClientError(403, {"error": {"message": "private provider detail"}}), 502),
    (errors.ServerError(500, {"error": {"message": "private provider detail"}}), 502),
])
def test_provider_errors(client, sdk, error, status):
    sdk.side_effect = error
    response = upload(client)
    assert response.status_code == status
    assert "private provider detail" not in response.text


def test_environment_loading(tmp_path, monkeypatch):
    env = tmp_path / ".env"
    env.write_text("GEMINI_API_KEY=file-secret\nGEMINI_MODEL=file-model\n")
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("GEMINI_MODEL", raising=False)
    settings = Settings(_env_file=env)
    assert settings.gemini_api_key.get_secret_value() == "file-secret"
    assert "file-secret" not in repr(settings)
    monkeypatch.setenv("GEMINI_MODEL", "environment-model")
    assert Settings(_env_file=env).gemini_model == "environment-model"
