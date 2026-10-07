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


def test_logbook_is_off_by_default():
    settings = config.Settings(_env_file=None, gemini_api_key="configuration-test-only")
    assert settings.supabase_url == ""
    assert not settings.logbook_configured
    assert settings.logbook_bucket == "experiment-images"


def test_logbook_configured_needs_url_and_secret_key():
    # Synthetic values only; no network calls are made.
    url_only = config.Settings(_env_file=None, supabase_url="https://example-ref.supabase.co")
    assert not url_only.logbook_configured
    both = config.Settings(_env_file=None, supabase_url="https://example-ref.supabase.co/",
                           supabase_secret_key="configuration-test-only")
    assert both.logbook_configured
    assert both.supabase_url == "https://example-ref.supabase.co"
    assert "configuration-test-only" not in repr(both)


@pytest.mark.parametrize("url", [
    "http://example-ref.supabase.co",
    "https://example-ref.supabase.co/rest/v1",
    "https://example-ref.supabase.co?x=1",
    "https://user:pass@example-ref.supabase.co",
    "example-ref.supabase.co",
])
def test_invalid_supabase_url_is_rejected(url):
    with pytest.raises(ValueError, match="SUPABASE_URL"):
        config.Settings(_env_file=None, supabase_url=url)


@pytest.mark.parametrize("field, value", [
    ("user_daily_gemini_limit", 0),
    ("max_saved_experiments_per_user", 0),
    ("max_drafts_per_user", 0),
    ("draft_ttl_hours", 0),
    ("draft_ttl_hours", 169),
    ("logbook_bucket", "Bad_Bucket"),
])
def test_invalid_logbook_limits_are_rejected(field, value):
    with pytest.raises(ValueError):
        config.Settings(_env_file=None, **{field: value})
