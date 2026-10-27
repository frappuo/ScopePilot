import pytest

from app.config import Settings
from app.services import gemini

# Every setting, by its environment variable name, so a new setting is covered without a list to update.
SHELL_SETTINGS = tuple(name.upper() for name in Settings.model_fields)


@pytest.fixture(autouse=True)
def clean_shell_settings(monkeypatch):
    """Settings(_env_file=None) still reads the OS environment; keep the developer's shell out.

    backend/.env is switched off too, for any Settings() built without _env_file, so no test can
    read the developer's real keys. A test that needs an env file passes its own _env_file.
    """
    for name in SHELL_SETTINGS:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setitem(Settings.model_config, "env_file", None)


@pytest.fixture(autouse=True)
def fresh_daily_gemini_budget():
    """The daily Gemini cap is process-wide; give every test a fresh budget."""
    gemini._DAILY_CALLS.reset()
    yield
    gemini._DAILY_CALLS.reset()
