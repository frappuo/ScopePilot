from io import BytesIO
import json
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
    expected_schema = gemini.Analysis.model_json_schema()
    expected_schema.pop("additionalProperties", None)
    assert args["config"].response_schema == expected_schema
    assert args["config"].automatic_function_calling.disable is True


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
    (errors.ClientError(404, {"error": {"message": "private provider detail"}}), 502),
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


@pytest.mark.parametrize("field,value", [
    ("probable_specimen", "   "),
    ("explanation", ""),
    ("visible_structures", [1]),
    ("visible_structures", [" "]),
    ("observations", "not a list"),
    ("limitations", []),
    ("limitations", [" "]),
    ("confidence", 99),
])
def test_schema_rejects_invalid_fields(client, sdk, field, value):
    sdk.return_value = SimpleNamespace(text=json.dumps({**RESULT, field: value}))
    assert upload(client).status_code == 502


@pytest.mark.parametrize("field", list(RESULT))
def test_schema_requires_every_field(client, sdk, field):
    result = dict(RESULT)
    del result[field]
    sdk.return_value = SimpleNamespace(text=json.dumps(result))
    assert upload(client).status_code == 502


def test_no_discernible_structures_is_valid(client, sdk):
    result = {**RESULT, "visible_structures": [], "observations": []}
    sdk.return_value = SimpleNamespace(text=json.dumps(result))
    response = upload(client)
    assert response.status_code == 200
    assert response.json() == result


@pytest.mark.parametrize("extra_byte,status", [(0, 200), (1, 413)])
def test_exact_upload_limit(client, sdk, extra_byte, status):
    data = image_bytes()
    app.dependency_overrides[get_settings] = lambda: Settings(
        _env_file=None, gemini_api_key="test-key", max_image_bytes=len(data)
    )
    assert upload(client, data + b"x" * extra_byte).status_code == status
    if extra_byte:
        sdk.assert_not_called()


def test_configured_model_is_used(client, sdk):
    app.dependency_overrides[get_settings] = lambda: Settings(
        _env_file=None, gemini_api_key="test-key", gemini_model="configured-test-model"
    )
    assert upload(client).status_code == 200
    assert sdk.call_args.kwargs["model"] == "configured-test-model"


def test_animated_image_rejected(client, sdk):
    stream = BytesIO()
    Image.new("RGB", (8, 8), "white").save(
        stream, format="PNG", save_all=True,
        append_images=[Image.new("RGB", (8, 8), "black")], duration=100, loop=0,
    )
    assert upload(client, stream.getvalue()).status_code == 415
    sdk.assert_not_called()
