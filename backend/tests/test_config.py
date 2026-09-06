from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app import config
from app.main import app


@pytest.fixture(autouse=True)
def isolated_settings():
    config.get_settings.cache_clear()
    yield
    config.get_settings.cache_clear()


@pytest.mark.parametrize("value", ["", "   "])
def test_missing_or_blank_key_stops_startup(value):
    settings = config.Settings(_env_file=None, gemini_api_key=value)
    with patch.object(config, "Settings", return_value=settings):
        with pytest.raises(RuntimeError, match="GEMINI_API_KEY is required"):
            with TestClient(app):
                pass


def test_environment_key_and_health(monkeypatch):
    # Synthetic test input, never a real credential; no network calls are made.
    monkeypatch.setenv("GEMINI_API_KEY", "configuration-test-only")
    settings = config.Settings(_env_file=None)
    assert settings.gemini_api_key
    assert "configuration-test-only" not in repr(settings)
    with patch.object(config, "Settings", return_value=settings):
        with TestClient(app) as client:
            response = client.get("/health")
            assert response.status_code == 200
            assert response.json() == {"status": "ok"}


def test_invalid_configuration_error_is_sanitized():
    with patch.object(config, "Settings", side_effect=ValueError("sensitive-input-marker")):
        with pytest.raises(RuntimeError) as error:
            config.get_settings()
    assert "sensitive-input-marker" not in str(error.value)
    assert error.value.__suppress_context__
