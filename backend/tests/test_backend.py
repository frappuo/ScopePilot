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

QUIZ = {
    "questions": [
        {
            "question": "Why might these cells appear rectangular?",
            "options": [
                "Rigid cell walls help maintain their shape",
                "Nuclei force every cell into a square",
                "Chloroplasts form the cell boundaries",
                "Cytoplasm becomes crystalline",
            ],
            "correct_answer": "Rigid cell walls help maintain their shape",
            "explanation": "Cell walls provide structural support and help maintain regular boundaries.",
        },
        {
            "question": "Which observation is directly supported by the analysis?",
            "options": [
                "Rectangular cell outlines are visible",
                "The tissue is diseased",
                "Every nucleus is dividing",
                "The sample came from a named organism",
            ],
            "correct_answer": "Rectangular cell outlines are visible",
            "explanation": "Visible outlines are observations, while the other claims are unsupported.",
        },
        {
            "question": "Why should this identification remain tentative?",
            "options": [
                "Image quality and view limits may hide useful details",
                "Microscopy images always show bacteria",
                "A model can verify every structure automatically",
                "Limitations do not affect specimen identification",
            ],
            "correct_answer": "Image quality and view limits may hide useful details",
            "explanation": "Limited visual evidence means the probable specimen needs verification.",
        },
    ]
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


def ask(client, question="Why do the cells appear rectangular?"):
    return client.post("/ask", json={"analysis": RESULT, "question": question})


def quiz_request(client, analysis=RESULT):
    return client.post("/quiz", json={"analysis": analysis})


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


def test_ask_success_uses_tentative_analysis_context(client, sdk):
    sdk.return_value = SimpleNamespace(text="Rigid plant cell walls can produce a rectangular appearance.")
    response = ask(client)
    assert response.status_code == 200
    assert response.json() == {
        "answer": "Rigid plant cell walls can produce a rectangular appearance."
    }
    args = sdk.call_args.kwargs
    assert args["model"] == "gemini-2.5-flash"
    assert RESULT["probable_specimen"] in args["contents"]
    assert "Why do the cells appear rectangular?" in args["contents"]
    assert args["config"].automatic_function_calling.disable is True
    assert "tentative" in args["config"].system_instruction.lower()
    assert "medical diagnosis" in args["config"].system_instruction.lower()
    assert "clean plain text, not markdown" in args["config"].system_instruction.lower()
    assert "markdown heading markers" in args["config"].system_instruction.lower()


def test_ask_returns_exact_out_of_scope_model_response(client, sdk):
    message = "This question is outside the scope of the current microscopy analysis."
    sdk.return_value = SimpleNamespace(text=message)
    response = ask(client, "Who won the football match?")
    assert response.status_code == 200
    assert response.json() == {"answer": message}
    prompt = sdk.call_args.kwargs["config"].system_instruction
    assert message in prompt
    assert "clearly unrelated to microscopy or biology" in prompt


@pytest.mark.parametrize("question", ["", "   "])
def test_ask_rejects_blank_question(client, sdk, question):
    assert ask(client, question).status_code == 422
    sdk.assert_not_called()


def test_ask_provider_failure_is_safe(client, sdk):
    sdk.side_effect = errors.ServerError(
        500, {"error": {"message": "private provider detail"}}
    )
    response = ask(client)
    assert response.status_code == 502
    assert "private provider detail" not in response.text


@pytest.mark.parametrize("text", [None, "", "   "])
def test_ask_rejects_empty_model_response(client, sdk, text):
    sdk.return_value = SimpleNamespace(text=text)
    assert ask(client).status_code == 502


def test_quiz_success_uses_current_analysis(client, sdk):
    sdk.return_value = SimpleNamespace(text=json.dumps(QUIZ))
    response = quiz_request(client)
    assert response.status_code == 200
    assert response.json() == QUIZ
    args = sdk.call_args.kwargs
    assert args["model"] == "gemini-2.5-flash"
    assert RESULT["probable_specimen"] in args["contents"]
    assert args["config"].automatic_function_calling.disable is True
    assert args["config"].response_mime_type == "application/json"
    assert args["config"].response_schema == gemini._quiz_response_schema()
    prompt = args["config"].system_instruction.lower()
    assert "exactly 3" in prompt
    assert "exactly 4" in prompt
    assert "tentative" in prompt
    assert "medical diagnosis" in prompt


@pytest.mark.parametrize("questions", [QUIZ["questions"][:2], QUIZ["questions"] + [QUIZ["questions"][0]]])
def test_quiz_requires_exactly_three_questions(client, sdk, questions):
    sdk.return_value = SimpleNamespace(text=json.dumps({"questions": questions}))
    assert quiz_request(client).status_code == 502


def test_quiz_rejects_invalid_question_shape(client, sdk):
    invalid = json.loads(json.dumps(QUIZ))
    invalid["questions"][0]["options"] = ["only one"]
    sdk.return_value = SimpleNamespace(text=json.dumps(invalid))
    assert quiz_request(client).status_code == 502


@pytest.mark.parametrize("change", [
    {"duplicate_options": True},
    {"blank_option": True},
    {"wrong_correct_answer": True},
])
def test_quiz_rejects_invalid_options_and_answer(client, sdk, change):
    invalid = json.loads(json.dumps(QUIZ))
    question = invalid["questions"][0]
    if change.get("duplicate_options"):
        question["options"][1] = question["options"][0]
    if change.get("blank_option"):
        question["options"][1] = "   "
    if change.get("wrong_correct_answer"):
        question["correct_answer"] = "Not an option"
    sdk.return_value = SimpleNamespace(text=json.dumps(invalid))
    assert quiz_request(client).status_code == 502


def test_quiz_provider_failure_is_safe(client, sdk):
    sdk.side_effect = errors.ServerError(500, {"error": {"message": "private provider detail"}})
    response = quiz_request(client)
    assert response.status_code == 502
    assert "private provider detail" not in response.text


@pytest.mark.parametrize("text", [None, "", "not json"])
def test_quiz_rejects_empty_or_malformed_model_response(client, sdk, text):
    sdk.return_value = SimpleNamespace(text=text)
    assert quiz_request(client).status_code == 502
