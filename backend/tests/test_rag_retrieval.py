"""Retrieval of RAG reference passages (app/services/rag.py retrieve_passages) and its settings.

Gemini and Supabase are mocked: an unexpected Gemini client or Supabase request fails the test.
Passages explain biology in general; nothing here treats them as evidence about an image.
"""

import json
import logging
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from google.genai import errors
import httpx
import pytest

from app import config
from app.config import Settings
from app.services import gemini, logbook, rag
from app.services.rag import Passage, retrieval_query, retrieve_passages

KEY = "test-key-not-real"
SUPABASE_URL = "https://example-project.supabase.co"
SECRET = "dummy-supabase-secret-for-tests"
MODEL = "gemini-embedding-2"
QUESTION = "What does the wall do in these cells?"
SPECIMEN = "Possible onion epidermis"
LOGGER = "app.services.rag"


def settings(**overrides):
    values = {"gemini_api_key": KEY, "supabase_url": SUPABASE_URL, "supabase_secret_key": SECRET, **overrides}
    return Settings(_env_file=None, **values)


def row(**changes):
    return {
        "id": "5b0c6a8e-2f43-4d7a-9a51-0f6f1c2d3e4a", "source_key": "plant-cell", "title": "Plant cell",
        "section": "Cell wall", "url": "https://en.wikipedia.org/wiki/Plant_cell", "licence": "CC BY-SA 4.0",
        "topic": "plant-cells", "content": "The wall gives the cell its shape in this invented passage.",
        "embedding_model": MODEL, "similarity": 0.91, **changes,
    }


class FakeMatch:
    """POST /rest/v1/rpc/match_rag_chunks. Answers rows, or body with status, or raises error."""

    def __init__(self):
        self.requests: list[httpx.Request] = []
        self.rows: list[dict] = [row(), row(title="Plant cell wall", section=None, similarity=0.85)]
        self.status = 200
        self.body: bytes | None = None
        self.error: type[httpx.HTTPError] | None = None

    def __call__(self, request):
        self.requests.append(request)
        assert request.headers["apikey"] == SECRET
        assert (request.method, request.url.path) == ("POST", "/rest/v1/rpc/match_rag_chunks")
        if self.error is not None:
            raise self.error("fake failure", request=request)
        # Encoded here, not with httpx's json=, which rejects NaN: json.dumps writes a literal NaN,
        # as a misbehaving server could, so the row check is what rejects it.
        body = self.body if self.body is not None else json.dumps(self.rows).encode()
        return httpx.Response(self.status, content=body, headers={"content-type": "application/json"})

    def body_sent(self):
        return json.loads(self.requests[0].content)


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    """Supabase and Gemini fail the test unless the match or embedder fixture replaces them."""
    def refuse(request):
        raise AssertionError(f"unexpected Supabase request {request.method} {request.url.path}")

    monkeypatch.setattr(logbook, "_transport", httpx.MockTransport(refuse))
    monkeypatch.setattr(rag.genai, "Client", MagicMock(side_effect=AssertionError("unexpected Gemini client")))


@pytest.fixture
def match(monkeypatch):
    fake = FakeMatch()
    monkeypatch.setattr(logbook, "_transport", httpx.MockTransport(fake))
    return fake


@pytest.fixture
def embedder(monkeypatch):
    factory = MagicMock()
    factory.return_value.__enter__.return_value.models.embed_content.return_value = SimpleNamespace(
        embeddings=[SimpleNamespace(values=[0.25] * 768)])
    monkeypatch.setattr(rag.genai, "Client", factory)
    return factory


def embed_content(embedder):
    return embedder.return_value.__enter__.return_value.models.embed_content


def rag_messages(caplog):
    return [(record.levelname, record.getMessage()) for record in caplog.records if record.name == LOGGER]


def retrieve(caplog, **overrides):
    with caplog.at_level(logging.INFO, logger=LOGGER):
        return retrieve_passages(QUESTION, SPECIMEN, settings(**overrides))


def assert_nothing_private_logged(caplog):
    for record in caplog.records:
        message = record.getMessage()
        assert QUESTION not in message and SPECIMEN not in message and "5b0c6a8e" not in message


# --- Success ---

def test_retrieval_query_is_the_question_then_the_tentative_specimen():
    assert retrieval_query("Why?", "Yeast") == "task: search result | query: Why?\nProbable specimen (tentative): Yeast"


def test_passages_come_back_closest_first_with_their_attribution(caplog, match, embedder):
    assert retrieve(caplog) == [
        Passage(title="Plant cell", section="Cell wall", url="https://en.wikipedia.org/wiki/Plant_cell",
                licence="CC BY-SA 4.0", content="The wall gives the cell its shape in this invented passage."),
        Passage(title="Plant cell wall", section=None, url="https://en.wikipedia.org/wiki/Plant_cell",
                licence="CC BY-SA 4.0", content="The wall gives the cell its shape in this invented passage."),
    ]
    assert rag_messages(caplog) == [("INFO", "RAG retrieval passages=2 top_similarity=0.91")]
    assert_nothing_private_logged(caplog)


def test_the_query_embedding_uses_the_query_format_and_the_budget(caplog, match, embedder):
    retrieve(caplog, rag_embedding_model="embed-model", rag_retrieval_timeout_seconds=2.5)
    kwargs = embed_content(embedder).call_args.kwargs
    assert kwargs["model"] == "embed-model"
    assert [content.parts[0].text for content in kwargs["contents"]] == [retrieval_query(QUESTION, SPECIMEN)]
    assert kwargs["config"].output_dimensionality == 768 and kwargs["config"].task_type is None
    assert embedder.call_args.kwargs["http_options"].timeout == 2500


def test_the_rpc_body_holds_only_the_vector_and_the_match_settings(caplog, match, embedder):
    retrieve(caplog, rag_top_k=3, rag_min_similarity=0.7, rag_retrieval_timeout_seconds=2.5)
    body = match.body_sent()
    assert set(body) == {"query_embedding", "match_count", "min_similarity"}
    assert (body["match_count"], body["min_similarity"]) == (3, 0.7)
    values = body["query_embedding"].removeprefix("[").removesuffix("]").split(",")
    assert len(values) == 768 and {float(value) for value in values} == {0.25}
    content = match.requests[0].content.decode()
    assert QUESTION not in content and SPECIMEN not in content
    # The RPC gets what is left of the shared budget.
    assert 0 < match.requests[0].extensions["timeout"]["read"] <= 2.5


def test_retrieval_does_not_count_against_the_daily_gemini_cap(caplog, match, embedder):
    retrieve(caplog)
    assert gemini._DAILY_CALLS.take(1, "test") is None


@pytest.mark.parametrize("similarity, logged", [
    (1 + 5e-7, "1.00"),
    (0.6 - 5e-7, "0.60"),
], ids=["just-above-one", "just-below-min"])
def test_similarity_rounding_at_either_end_is_tolerated(caplog, match, embedder, similarity, logged):
    match.rows = [row(similarity=similarity)]
    assert len(retrieve(caplog)) == 1
    assert rag_messages(caplog) == [("INFO", f"RAG retrieval passages=1 top_similarity={logged}")]


def test_rows_from_another_embedding_model_are_dropped(caplog, match, embedder):
    match.rows = [row(embedding_model="old-model", similarity=0.95), row(title="Kept", similarity=0.8)]
    assert [passage.title for passage in retrieve(caplog)] == ["Kept"]
    assert rag_messages(caplog) == [("INFO", "RAG retrieval passages=1 top_similarity=0.80")]


@pytest.mark.parametrize("rows", [[], [row(embedding_model="old-model")]], ids=["none", "only-other-model"])
def test_no_usable_passages_is_a_success_not_a_failure(caplog, match, embedder, rows):
    match.rows = rows
    assert retrieve(caplog) == []
    assert rag_messages(caplog) == [("INFO", "RAG retrieval passages=0 top_similarity=0.00")]


# --- Failures: [] and one WARNING line ---

def provider_429():
    return errors.ClientError(429, {"error": {"message": f"quota detail quoting {QUESTION}",
                                              "status": "RESOURCE_EXHAUSTED"}})


@pytest.mark.parametrize("failure, reason", [
    (httpx.ReadTimeout("slow"), "embed_timeout"),
    (TimeoutError(), "embed_timeout"),
    (provider_429(), "embed_error"),
    (RuntimeError(f"provider detail quoting {QUESTION}"), "embed_error"),
    (httpx.ConnectError("down"), "embed_error"),
], ids=["httpx-timeout", "timeout", "quota-429", "provider-error", "transport"])
def test_an_embedding_failure_skips_retrieval(caplog, match, embedder, failure, reason):
    embed_content(embedder).side_effect = failure
    assert retrieve(caplog) == []
    assert rag_messages(caplog) == [("WARNING", f"RAG retrieval skipped reason={reason}")]
    assert match.requests == []
    assert_nothing_private_logged(caplog)


@pytest.mark.parametrize("embeddings", [[], [SimpleNamespace(values=[0.25] * 767)], None],
                         ids=["no-vector", "wrong-size", "no-embeddings"])
def test_a_bad_embedding_response_skips_retrieval(caplog, match, embedder, embeddings):
    embed_content(embedder).return_value = SimpleNamespace(embeddings=embeddings)
    assert retrieve(caplog) == []
    assert rag_messages(caplog) == [("WARNING", "RAG retrieval skipped reason=embed_bad_response")]
    assert match.requests == []


def test_a_slow_embedding_leaves_no_budget_for_the_rpc(caplog, match, embedder, monkeypatch):
    clock = iter([100.0, 103.5])
    monkeypatch.setattr(rag, "monotonic", lambda: next(clock))
    assert retrieve(caplog, rag_retrieval_timeout_seconds=3.0) == []
    assert rag_messages(caplog) == [("WARNING", "RAG retrieval skipped reason=budget")]
    assert match.requests == []


@pytest.mark.parametrize("error", [httpx.ConnectError, httpx.ReadTimeout], ids=["connect", "timeout"])
def test_an_rpc_transport_failure_skips_retrieval(caplog, match, embedder, error):
    match.error = error
    assert retrieve(caplog) == []
    assert rag_messages(caplog) == [("WARNING", "RAG retrieval skipped reason=rpc_transport")]


@pytest.mark.parametrize("status", [404, 500, 503], ids=["404", "500", "503"])
def test_an_rpc_error_status_skips_retrieval(caplog, match, embedder, status):
    match.status, match.body = status, b'{"message": "fake failure"}'
    assert retrieve(caplog) == []
    assert rag_messages(caplog) == [("WARNING", f"RAG retrieval skipped reason=rpc_status_{status}")]


def without(name):
    return {key: value for key, value in row().items() if key != name}


@pytest.mark.parametrize("rows", [
    {"rows": []},
    [row()] * 5,
    ["row"],
    [without("content")],
    [without("topic")],
    [row(title=1)],
    [row(title="")],
    [row(title="t" * 201)],
    [row(section="")],
    [row(url="http://en.wikipedia.org/wiki/Plant_cell")],
    [row(url="not a url")],
    [row(licence="CC BY-NC 4.0")],
    [row(content="")],
    [row(content="x" * 4001)],
    [row(similarity=0.5)],
    [row(similarity=1.00001)],
    [row(similarity=float("nan"))],
    [row(similarity=True)],
    [row(similarity="0.9")],
    [row(), row(licence="CC0 1.0")],
], ids=["not-a-list", "too-many", "not-a-dict", "no-content", "no-topic", "int-title", "empty-title", "long-title",
        "empty-section", "http-url", "bad-url", "nc-licence", "empty-content", "long-content", "below-min",
        "above-one", "nan", "bool", "string", "one-bad-of-two"])
def test_any_malformed_row_discards_the_whole_result(caplog, match, embedder, rows):
    match.rows = rows
    assert retrieve(caplog) == []
    assert rag_messages(caplog) == [("WARNING", "RAG retrieval skipped reason=rpc_bad_response")]


def test_an_rpc_body_that_is_not_json_is_a_bad_response(caplog, match, embedder):
    match.body = b"not json"
    assert retrieve(caplog) == []
    assert rag_messages(caplog) == [("WARNING", "RAG retrieval skipped reason=rpc_bad_response")]


# --- Settings ---

def test_rag_settings_defaults():
    defaults = Settings(_env_file=None)
    assert defaults.rag_enabled is False
    assert (defaults.rag_top_k, defaults.rag_min_similarity, defaults.rag_retrieval_timeout_seconds) == (4, 0.6, 3.0)


@pytest.mark.parametrize("field, value", [
    ("rag_top_k", 0), ("rag_top_k", 9),
    ("rag_min_similarity", -0.1), ("rag_min_similarity", 1.1),
    ("rag_retrieval_timeout_seconds", 0), ("rag_retrieval_timeout_seconds", 10.5),
    ("rag_embedding_model", ""),
], ids=["top-k-0", "top-k-9", "similarity-negative", "similarity-above-1", "timeout-0", "timeout-over-10",
        "empty-model"])
def test_rag_settings_out_of_bounds_are_rejected(field, value):
    with pytest.raises(ValueError):
        Settings(_env_file=None, **{field: value})


@pytest.mark.parametrize("value, expected", [
    ("false", False), ("0", False), ("no", False), ("off", False), ("true", True), ("1", True), ("yes", True),
    ("on", True),
], ids=["false", "0", "no", "off", "true", "1", "yes", "on"])
def test_rag_enabled_parsed_from_environment(monkeypatch, value, expected):
    monkeypatch.setenv("RAG_ENABLED", value)
    assert Settings(_env_file=None).rag_enabled is expected


def test_invalid_rag_enabled_stops_startup_with_sanitized_error(monkeypatch):
    # Synthetic test input, never a real credential; no .env file is read.
    monkeypatch.setenv("GEMINI_API_KEY", "configuration-test-only")
    monkeypatch.setenv("RAG_ENABLED", "maybe")
    settings_class = config.Settings
    config.get_settings.cache_clear()
    try:
        with patch.object(config, "Settings", lambda: settings_class(_env_file=None)):
            with pytest.raises(RuntimeError, match="Invalid backend environment configuration") as error:
                config.get_settings()
    finally:
        config.get_settings.cache_clear()
    assert "maybe" not in str(error.value)
