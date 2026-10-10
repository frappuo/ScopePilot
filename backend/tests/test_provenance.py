"""Prompt version and served-model reporting. Hermetic: dummy key, mocked SDK, no network."""

import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from google.genai import errors

from app.config import Settings
from app.schemas.analysis import Analysis
from app.services import gemini

BACKEND_DIR = Path(__file__).resolve().parents[1]
IMAGE = b"synthetic-image-bytes-marker"
ANALYSIS = {
    "probable_specimen": "Possible onion epidermis",
    "visible_structures": ["Cell walls"],
    "observations": ["Rectangular cells"],
    "explanation": "Plant cell walls define cell boundaries.",
    "limitations": ["Tentative AI output; verify with an instructor."],
}


def settings():
    return Settings(
        _env_file=None, gemini_api_key="test-key-not-real", gemini_model="primary", gemini_fallback_models="fb-1"
    )


@pytest.fixture
def sdk(monkeypatch):
    factory = MagicMock()
    generate = factory.return_value.__enter__.return_value.models.generate_content
    monkeypatch.setattr(gemini.genai, "Client", factory)
    return generate


def test_prompt_version_is_hash_of_production_prompt():
    assert re.fullmatch(r"[0-9a-f]{12}", gemini.PROMPT_VERSION)
    assert gemini.PROMPT_VERSION == hashlib.sha256(gemini.PROMPT.encode("utf-8")).hexdigest()[:12]


def test_prompt_version_stable_across_imports():
    code = "from app.services.gemini import PROMPT_VERSION; print(PROMPT_VERSION)"
    runs = [
        subprocess.run([sys.executable, "-c", code], cwd=BACKEND_DIR, capture_output=True, text=True,
                       check=True, timeout=120).stdout.strip()
        for _ in range(2)
    ]
    assert runs == [gemini.PROMPT_VERSION, gemini.PROMPT_VERSION]


def test_primary_served_model_reported(sdk):
    sdk.return_value = SimpleNamespace(text=json.dumps(ANALYSIS))
    analysis, model = gemini.analyze_image_with_model(IMAGE, "image/jpeg", settings())
    assert (analysis, model) == (Analysis(**ANALYSIS), "primary")


def test_fallback_served_model_reported(sdk):
    sdk.side_effect = [
        errors.ClientError(429, {"error": {"message": "provider detail", "status": "RESOURCE_EXHAUSTED"}}),
        SimpleNamespace(text=json.dumps(ANALYSIS)),
    ]
    analysis, model = gemini.analyze_image_with_model(IMAGE, "image/jpeg", settings())
    assert (analysis, model) == (Analysis(**ANALYSIS), "fb-1")


def test_analyze_image_still_returns_only_analysis(sdk):
    sdk.return_value = SimpleNamespace(text=json.dumps(ANALYSIS))
    assert gemini.analyze_image(IMAGE, "image/jpeg", settings()) == Analysis(**ANALYSIS)
