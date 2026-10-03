import pytest

from app.services import gemini


@pytest.fixture(autouse=True)
def fresh_daily_gemini_budget():
    """The daily Gemini cap is process-wide; give every test a fresh budget."""
    gemini._DAILY_CALLS.reset()
    yield
    gemini._DAILY_CALLS.reset()
