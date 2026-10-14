import pytest

from app.services import gemini

SHELL_SETTINGS = ("LEGACY_API_ENABLED", "APP_TOKEN", "SUPABASE_URL", "SUPABASE_SECRET_KEY",
                  "GEMINI_FALLBACK_MODELS")


@pytest.fixture(autouse=True)
def clean_shell_settings(monkeypatch):
    """Settings(_env_file=None) still reads the OS environment; keep the developer's shell out."""
    for name in SHELL_SETTINGS:
        monkeypatch.delenv(name, raising=False)


@pytest.fixture(autouse=True)
def fresh_daily_gemini_budget():
    """The daily Gemini cap is process-wide; give every test a fresh budget."""
    gemini._DAILY_CALLS.reset()
    yield
    gemini._DAILY_CALLS.reset()
