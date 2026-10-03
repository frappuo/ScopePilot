"""Model fallback and eval pinning. Hermetic: dummy key, mocked SDK, no network."""

import importlib.util
import json
import logging
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import httpx
import pytest
from google.genai import errors
from PIL import Image
from pydantic import ValidationError

from app.config import Settings
from app.main import _configure_logging
from app.schemas.analysis import Analysis
from app.services import gemini
from app.services.errors import AnalysisError

KEY = "test-key-not-real"
IMAGE = b"synthetic-image-bytes-marker"
QUESTION = "synthetic-question-marker: why are the cells rectangular?"
ANALYSIS = {
    "probable_specimen": "Possible onion epidermis",
    "visible_structures": ["Cell walls"],
    "observations": ["Rectangular cells"],
    "explanation": "synthetic-explanation-marker about plant cell walls.",
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
EVAL_PATH = Path(__file__).resolve().parents[1] / "evals" / "microscopy_eval.py"


def settings(fallbacks="fb-1,fb-2"):
    return Settings(
        _env_file=None, gemini_api_key=KEY, gemini_model="primary", gemini_fallback_models=fallbacks
    )


def quota():
    return errors.ClientError(429, {"error": {"message": "provider detail", "status": "RESOURCE_EXHAUSTED"}})


def quota_status_only():
    return errors.ClientError(400, {"error": {"message": "provider detail", "status": "RESOURCE_EXHAUSTED"}})


def missing():
    return errors.ClientError(404, {"error": {"message": "provider detail", "status": "NOT_FOUND"}})


def missing_status_only():
    return errors.ClientError(400, {"error": {"message": "provider detail", "status": "NOT_FOUND"}})


def reply(text):
    return SimpleNamespace(text=text)


OPERATIONS = {
    "analyze": (lambda s: gemini.analyze_image(IMAGE, "image/jpeg", s), json.dumps(ANALYSIS)),
    "ask": (lambda s: gemini.answer_question(Analysis(**ANALYSIS), QUESTION, s), "A plain answer."),
    "quiz": (lambda s: gemini.generate_quiz(Analysis(**ANALYSIS), s), json.dumps(QUIZ)),
}


@pytest.fixture
def sdk(monkeypatch):
    factory = MagicMock()
    generate = factory.return_value.__enter__.return_value.models.generate_content
    monkeypatch.setattr(gemini.genai, "Client", factory)
    return generate


def models_called(sdk):
    return [call.kwargs["model"] for call in sdk.call_args_list]


def test_fallback_models_are_cleaned(monkeypatch):
    monkeypatch.delenv("GEMINI_FALLBACK_MODELS", raising=False)
    assert settings(" fb-1, ,fb-2, fb-1, primary ").fallback_models == ("fb-1", "fb-2")
    assert Settings(_env_file=None).fallback_models == ()


def test_fallback_models_read_from_env(monkeypatch):
    monkeypatch.setenv("GEMINI_FALLBACK_MODELS", "a, b")
    assert Settings(_env_file=None, gemini_model="primary").fallback_models == ("a", "b")


def test_fallback_model_cap():
    assert settings("a,b,c").fallback_models == ("a", "b", "c")
    assert settings("a, b, c, a, primary").fallback_models == ("a", "b", "c")
    with pytest.raises(ValidationError):
        settings("a,b,c,d")


@pytest.mark.parametrize("operation", OPERATIONS)
@pytest.mark.parametrize("error", [quota, quota_status_only, missing, missing_status_only])
def test_fallback_triggers(sdk, operation, error):
    call, ok_text = OPERATIONS[operation]
    sdk.side_effect = [error(), reply(ok_text)]
    assert call(settings()) is not None
    assert models_called(sdk) == ["primary", "fb-1"]


NO_FALLBACK = [
    (lambda: errors.ServerError(500, {"error": {"message": "provider detail"}}), 502),
    (lambda: errors.ClientError(400, {"error": {"message": "provider detail", "status": "INVALID_ARGUMENT"}}), 502),
    (lambda: httpx.ReadTimeout("provider detail"), 504),
    (lambda: httpx.ConnectError("provider detail"), 502),
    (lambda: reply(None), 502),
]


@pytest.mark.parametrize("operation", OPERATIONS)
@pytest.mark.parametrize("outcome,status", NO_FALLBACK)
def test_no_fallback_on_other_failures(sdk, operation, outcome, status):
    sdk.side_effect = [outcome(), reply(OPERATIONS[operation][1])]
    with pytest.raises(AnalysisError) as error:
        OPERATIONS[operation][0](settings())
    assert error.value.status_code == status
    assert models_called(sdk) == ["primary"]


@pytest.mark.parametrize("operation,text", [
    ("analyze", "not json"),
    ("quiz", "not json"),
    ("quiz", json.dumps({"questions": QUIZ["questions"][:2]})),
    ("ask", "   "),
])
def test_no_fallback_on_invalid_output(sdk, operation, text):
    sdk.side_effect = [reply(text), reply(OPERATIONS[operation][1])]
    with pytest.raises(AnalysisError) as error:
        OPERATIONS[operation][0](settings())
    assert error.value.status_code == 502
    assert models_called(sdk) == ["primary"]


def test_fallback_order_and_stop_at_first_success(sdk):
    sdk.side_effect = [quota(), missing(), reply(json.dumps(ANALYSIS))]
    assert gemini.analyze_image(IMAGE, "image/jpeg", settings()) == Analysis(**ANALYSIS)
    assert models_called(sdk) == ["primary", "fb-1", "fb-2"]

    sdk.reset_mock()
    sdk.side_effect = [quota(), reply(json.dumps(ANALYSIS)), quota(), quota()]
    gemini.analyze_image(IMAGE, "image/jpeg", settings("fb-1,fb-2,fb-3"))
    assert models_called(sdk) == ["primary", "fb-1"]


@pytest.mark.parametrize("errors_in_order,status", [
    ([quota, quota], 503),
    ([missing, missing], 502),
    ([quota, missing], 503),
    ([missing, quota], 503),
])
def test_exhaustion_status(sdk, errors_in_order, status):
    sdk.side_effect = [error() for error in errors_in_order]
    with pytest.raises(AnalysisError) as error:
        gemini.analyze_image(IMAGE, "image/jpeg", settings("fb-1"))
    assert error.value.status_code == status
    assert models_called(sdk) == ["primary", "fb-1"]


@pytest.mark.parametrize("error,status", [(quota, 503), (missing, 502)])
def test_without_fallbacks_behaviour_is_unchanged(sdk, error, status):
    sdk.side_effect = [error()]
    with pytest.raises(AnalysisError) as raised:
        gemini.analyze_image(IMAGE, "image/jpeg", settings(""))
    assert raised.value.status_code == status
    assert models_called(sdk) == ["primary"]


def test_allow_fallback_false(sdk):
    sdk.side_effect = [quota(), reply(json.dumps(ANALYSIS))]
    with pytest.raises(AnalysisError) as error:
        gemini.analyze_image(IMAGE, "image/jpeg", settings("fb-1"), allow_fallback=False)
    assert error.value.status_code == 503
    assert models_called(sdk) == ["primary"]


def test_fallback_logging_is_safe(sdk, caplog):
    sdk.side_effect = [quota(), reply("A plain answer."), reply(json.dumps(ANALYSIS))]
    with caplog.at_level(logging.INFO, logger="app.services.gemini"):
        gemini.answer_question(Analysis(**ANALYSIS), QUESTION, settings("fb-1"))
        gemini.analyze_image(IMAGE, "image/jpeg", settings(""))
    assert "Gemini fallback operation=ask from_model=primary to_model=fb-1 reason=quota" in caplog.text
    assert "Gemini served operation=ask model=fb-1 fallback_used=True" in caplog.text
    assert "Gemini served operation=analyze model=primary fallback_used=False" in caplog.text
    for private in (KEY, QUESTION, ANALYSIS["explanation"], gemini.ASK_PROMPT[:60], IMAGE.decode()):
        assert private not in caplog.text


def test_logging_configured_once():
    _configure_logging()
    _configure_logging()
    logger = logging.getLogger("app")
    assert logger.level == logging.INFO
    assert sum(getattr(handler, "_scopepilot", False) for handler in logger.handlers) == 1


@pytest.fixture
def eval_module(monkeypatch):
    # Not loaded as "eval", so importing does not start a Braintrust run.
    spec = importlib.util.spec_from_file_location("microscopy_eval_under_test", EVAL_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setattr(module, "get_settings", lambda: settings("fb-1"))
    return module


def test_eval_never_falls_back(eval_module, sdk, tmp_path, monkeypatch):
    image = tmp_path / "synthetic.jpg"
    Image.new("RGB", (8, 8), "white").save(image, format="JPEG")
    monkeypatch.setattr(eval_module, "_safe_image_path", lambda _: image)
    sdk.side_effect = [quota(), reply(json.dumps(ANALYSIS))]
    with pytest.raises(AnalysisError) as error:
        eval_module.analyze_case({"image_path": "synthetic"}, prompt_variant="prompt-a-naive-baseline")
    assert error.value.status_code == 503
    assert models_called(sdk) == ["primary"]


def test_run_eval_records_model(eval_module, monkeypatch, capsys):
    captured = {}
    monkeypatch.setattr(eval_module, "Eval", lambda name, **kwargs: captured.update(name=name, **kwargs))
    monkeypatch.setenv("SCOPEPILOT_EVAL_PROMPT_VARIANT", "prompt-a-naive-baseline")
    eval_module.run_eval()
    assert captured["experiment_name"] == "prompt-a-naive-baseline | primary"
    assert captured["metadata"] == {
        "gemini_model": "primary", "prompt_variant": "prompt-a-naive-baseline", "fallback": "disabled",
    }
    assert "model=primary" in capsys.readouterr().out
