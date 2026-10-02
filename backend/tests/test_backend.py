from io import BytesIO
import json
import logging
import struct
from types import SimpleNamespace
import zlib
from unittest.mock import MagicMock

import httpx
import pytest
from fastapi.testclient import TestClient
from google.genai import errors
from PIL import Image

from app.config import Settings, get_settings
from app.main import app
from app.services import gemini, images

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


def mpo_bytes():
    """Synthetic two-frame MPO, the format Pillow reports for iPhone camera JPEGs."""
    stream = BytesIO()
    Image.new("RGB", (8, 8), "red").save(
        stream, format="MPO", save_all=True, append_images=[Image.new("RGB", (8, 8), "blue")]
    )
    return stream.getvalue()


def animated_bytes(fmt):
    stream = BytesIO()
    Image.new("RGB", (8, 8), "white").save(
        stream, format=fmt, save_all=True,
        append_images=[Image.new("RGB", (8, 8), "black")], duration=100, loop=0,
    )
    return stream.getvalue()


def rgb16_png():
    """4x2 PNG with 16 bits per RGB channel; Pillow cannot write this mode itself."""
    def chunk(kind, payload):
        return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", zlib.crc32(kind + payload))
    rows = b"".join(
        b"\x00" + b"".join(struct.pack(">HHH", 1000 * (x + 1), 300 * (y + 1), 65535 - x) for x in range(4))
        for y in range(2)
    )
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 4, 2, 16, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b""))


def sent(sdk):
    part = sdk.call_args.kwargs["contents"][0].inline_data
    return part.data, part.mime_type


def sent_image(sdk):
    data, _ = sent(sdk)
    image = Image.open(BytesIO(data))
    image.load()
    return image


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
    exif = Image.Exif()
    exif[0x010F] = "SyntheticCam"
    stream = BytesIO()
    Image.new("RGB", (8, 8), "white").save(stream, format=fmt, exif=exif)
    data = stream.getvalue()
    response = upload(client, data, mime)
    assert response.status_code == 200
    assert response.json() == RESULT
    args = sdk.call_args.kwargs
    sent_data, sent_mime = sent(sdk)
    assert sent_data != data
    assert sent_mime == mime
    with Image.open(BytesIO(sent_data)) as output:
        assert (output.format, output.size) == (fmt, (8, 8))
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
    (mpo_bytes(), "image/png", 415),
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


def test_mpo_declared_jpeg_sends_first_frame_as_jpeg(client, sdk):
    data = mpo_bytes()
    with Image.open(BytesIO(data)) as source:
        assert (source.format, source.n_frames) == ("MPO", 2)
    assert upload(client, data, "image/jpeg").status_code == 200
    assert sent(sdk)[1] == "image/jpeg"
    output = sent_image(sdk)
    assert output.format == "JPEG"
    assert getattr(output, "n_frames", 1) == 1
    red, _, blue = output.convert("RGB").getpixel((4, 4))
    assert red > 200 and blue < 60


def test_exif_orientation_applied(client, sdk):
    exif = Image.Exif()
    exif[0x0112] = 6  # Rotate 90 degrees clockwise for display.
    stream = BytesIO()
    Image.new("RGB", (8, 4), "white").save(stream, format="JPEG", exif=exif)
    assert upload(client, stream.getvalue(), "image/jpeg").status_code == 200
    output = sent_image(sdk)
    assert output.size == (4, 8)
    assert 0x0112 not in output.getexif()


@pytest.mark.parametrize("fmt,mime", [("JPEG", "image/jpeg"), ("PNG", "image/png"), ("WEBP", "image/webp")])
def test_metadata_stripped(client, sdk, fmt, mime):
    exif = Image.Exif()
    exif[0x010F] = "SyntheticCam"
    exif.get_ifd(0x8825).update({1: "N", 2: (51.0, 30.0, 0.0), 3: "W", 4: (0.0, 7.0, 0.0)})
    options = {"exif": exif}
    if fmt == "JPEG":
        options["xmp"] = b"<x:xmpmeta>synthetic-xmp</x:xmpmeta>"
    if fmt == "PNG":
        from PIL.PngImagePlugin import PngInfo
        options["pnginfo"] = PngInfo()
        options["pnginfo"].add_text("Comment", "synthetic-text")
    stream = BytesIO()
    Image.new("RGB", (8, 8), "white").save(stream, format=fmt, **options)
    data = stream.getvalue()
    with Image.open(BytesIO(data)) as source:
        assert source.getexif().get_ifd(0x8825)
    assert upload(client, data, mime).status_code == 200
    sent_data, sent_mime = sent(sdk)
    assert sent_mime == mime
    for marker in (b"SyntheticCam", b"synthetic-xmp", b"synthetic-text", b"Exif\x00\x00", b"eXIf"):
        assert marker not in sent_data
    output = sent_image(sdk)
    assert not output.getexif()
    assert not output.getexif().get_ifd(0x8825)
    assert "xmp" not in output.info


def png_round_trip(client, sdk, image, **options):
    stream = BytesIO()
    image.save(stream, format="PNG", **options)
    assert upload(client, stream.getvalue(), "image/png").status_code == 200
    assert sent(sdk)[1] == "image/png"
    return sent_image(sdk)


def test_rgba_png_keeps_alpha(client, sdk):
    image = Image.new("RGBA", (4, 4), (10, 20, 30, 0))
    image.putpixel((1, 1), (200, 100, 50, 128))
    output = png_round_trip(client, sdk, image)
    assert output.mode == "RGBA"
    assert output.tobytes() == image.tobytes()


def test_palette_png_keeps_palette_and_transparency(client, sdk):
    palette = [0, 0, 0, 255, 0, 0, 0, 255, 0]
    image = Image.new("P", (4, 4), 0)
    image.putpalette(palette + [0] * (768 - len(palette)))
    image.putpixel((1, 1), 2)
    output = png_round_trip(client, sdk, image, transparency=0)
    assert output.mode == "P"
    assert output.info.get("transparency") == 0
    assert output.getpalette()[:9] == palette
    assert output.tobytes() == image.tobytes()


def test_16bit_grayscale_png_round_trips(client, sdk):
    image = Image.new("I;16", (4, 2))
    image.putpixel((0, 0), 60000)
    image.putpixel((3, 1), 300)
    output = png_round_trip(client, sdk, image)
    assert output.mode == "I;16"
    assert output.tobytes() == image.tobytes()


def test_16bit_rgb_png_is_reduced_to_8bit_by_pillow(client, sdk):
    # Documents Pillow behaviour, not a round trip: 48-bit RGB decodes as 8-bit RGB
    # keeping the high byte of each channel, so the re-encoded PNG is 8-bit.
    assert upload(client, rgb16_png(), "image/png").status_code == 200
    sent_data, _ = sent(sdk)
    assert sent_data[24] == 8  # IHDR bit depth
    output = sent_image(sdk)
    assert output.mode == "RGB"
    assert output.getpixel((0, 0)) == (1000 >> 8, 300 >> 8, 65535 >> 8)


def test_rgba_webp_reencoded_as_webp(client, sdk):
    stream = BytesIO()
    Image.new("RGBA", (8, 8), (10, 200, 30, 128)).save(stream, format="WEBP")
    assert upload(client, stream.getvalue(), "image/webp").status_code == 200
    assert sent(sdk)[1] == "image/webp"
    output = sent_image(sdk)
    assert (output.format, output.mode, output.size) == ("WEBP", "RGBA", (8, 8))


def test_cmyk_jpeg_converted_to_rgb(client, sdk):
    stream = BytesIO()
    Image.new("CMYK", (8, 8), (0, 255, 255, 0)).save(stream, format="JPEG")
    assert upload(client, stream.getvalue(), "image/jpeg").status_code == 200
    output = sent_image(sdk)
    assert (output.format, output.mode) == ("JPEG", "RGB")


@pytest.mark.parametrize("fmt,mime", [("GIF", "image/gif"), ("GIF", "image/png"), ("WEBP", "image/webp")])
def test_animated_images_rejected(client, sdk, fmt, mime):
    assert upload(client, animated_bytes(fmt), mime).status_code == 415
    sdk.assert_not_called()


def test_output_cap_rejects_large_output(client, sdk, caplog):
    app.dependency_overrides[get_settings] = lambda: Settings(
        _env_file=None, gemini_api_key="test-key", max_encoded_image_bytes=10
    )
    with caplog.at_level(logging.WARNING, logger="app.services.images"):
        assert upload(client).status_code == 413
    assert "rule=output_too_large" in caplog.text
    sdk.assert_not_called()


def test_pixel_limit_message_is_clear(client, sdk):
    app.dependency_overrides[get_settings] = lambda: Settings(
        _env_file=None, gemini_api_key="test-key", max_image_pixels=10
    )
    response = upload(client)
    assert response.status_code == 413
    assert response.json()["detail"] == (
        "Image resolution exceeds the limit of 10 pixels. Choose a smaller image or lower the camera resolution."
    )
    sdk.assert_not_called()


def test_rejection_logs_safe_reason(client, sdk, caplog):
    data = mpo_bytes()
    with caplog.at_level(logging.WARNING, logger="app.services.images"):
        assert upload(client, data, "image/png").status_code == 415
        assert upload(client, b"<script>alert(1)</script>", "text/evil").status_code == 415
    assert "rule=type_mismatch status=415 declared_type=image/png detected_format=MPO" in caplog.text
    assert "rule=declared_type status=415 declared_type=other detected_format=none" in caplog.text
    assert "text/evil" not in caplog.text
    assert "<script>" not in caplog.text
    assert repr(data[:16]) not in caplog.text


def test_busy_returns_503_without_calling_gemini(client, sdk, monkeypatch, caplog):
    monkeypatch.setattr(images, "_DECODE_WAIT_SECONDS", 0.01)
    assert images._DECODE_SLOTS.acquire(blocking=False)
    try:
        with caplog.at_level(logging.WARNING, logger="app.services.images"):
            response = upload(client)
    finally:
        images._DECODE_SLOTS.release()
    assert response.status_code == 503
    assert "busy" in response.json()["detail"]
    assert "rule=busy" in caplog.text
    sdk.assert_not_called()


@pytest.mark.parametrize("error", [OSError("synthetic"), RuntimeError("synthetic")])
def test_decode_slot_released_after_exception(client, sdk, monkeypatch, error):
    def fail(*args):
        raise error
    monkeypatch.setattr(images, "_reencode", fail)
    if isinstance(error, OSError):
        assert upload(client).status_code == 400
    else:
        with pytest.raises(RuntimeError):
            upload(client)
    assert images._DECODE_SLOTS.acquire(blocking=False)
    images._DECODE_SLOTS.release()
    sdk.assert_not_called()


def test_decode_slot_not_held_during_gemini_call(client, sdk):
    def check_slot(**kwargs):
        assert images._DECODE_SLOTS.acquire(blocking=False)
        images._DECODE_SLOTS.release()
        return SimpleNamespace(text=json.dumps(RESULT))
    sdk.side_effect = check_slot
    assert upload(client).status_code == 200


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
