"""Embeddings for RAG passages (app/services/rag.py). The Gemini SDK is mocked."""

from types import SimpleNamespace
from unittest.mock import MagicMock

from google.genai import types
import pytest

from app.config import Settings
from app.services import gemini, rag

KEY = "test-key-not-real"


def settings(**overrides):
    return Settings(_env_file=None, gemini_api_key=KEY, **overrides)


@pytest.fixture(autouse=True)
def no_gemini(monkeypatch):
    """Gemini fails the test unless the client fixture replaces it."""
    monkeypatch.setattr(rag.genai, "Client", MagicMock(side_effect=AssertionError("unexpected Gemini client")))


@pytest.fixture
def client(monkeypatch):
    factory = MagicMock()
    monkeypatch.setattr(rag.genai, "Client", factory)
    return factory


def embed_content(client):
    return client.return_value.__enter__.return_value.models.embed_content


def answer(client, vectors):
    embed_content(client).return_value = SimpleNamespace(embeddings=[SimpleNamespace(values=v) for v in vectors])


def test_constants_are_the_documented_ones():
    assert rag.EMBEDDING_DIMENSIONS == 768
    assert rag.QUERY_TEMPLATE == "task: search result | query: {content}"
    assert rag.DOCUMENT_TEMPLATE == "title: {title} | text: {content}"
    assert Settings(_env_file=None).rag_embedding_model == "gemini-embedding-2"


def test_document_text_puts_the_section_before_the_passage():
    assert rag.document_text("Plant cell", "Cell wall", "The wall is rigid.") == \
        "title: Plant cell | text: Cell wall\n\nThe wall is rigid."
    assert rag.document_text("Plant cell", None, "The wall is rigid.") == "title: Plant cell | text: The wall is rigid."


def test_each_text_is_its_own_content_with_768_dimensions_and_no_task_type(client):
    answer(client, [[0.1] * 768, [0.2] * 768])
    vectors = rag.embed_texts(["first", "second"], settings(rag_embedding_model="embed-model"), timeout_seconds=2.5)
    assert vectors == [[0.1] * 768, [0.2] * 768]
    kwargs = embed_content(client).call_args.kwargs
    assert kwargs["model"] == "embed-model"
    contents = kwargs["contents"]
    assert len(contents) == 2
    assert all(isinstance(content, types.Content) and len(content.parts) == 1 for content in contents)
    assert [content.parts[0].text for content in contents] == ["first", "second"]
    assert kwargs["config"].output_dimensionality == 768
    assert kwargs["config"].task_type is None
    options = client.call_args.kwargs["http_options"]
    assert client.call_args.kwargs["api_key"] == KEY
    assert options.timeout == 2500 and options.retry_options.attempts == 1


@pytest.mark.parametrize("vectors", [
    [[0.1] * 768],
    [[0.1] * 768] * 3,
    [[0.1] * 767, [0.1] * 768],
    [[0.1] * 768, [float("nan")] + [0.1] * 767],
    [[0.1] * 768, [float("inf")] + [0.1] * 767],
    [[0.1] * 768, [True] * 768],
    [[0.1] * 768, None],
], ids=["one-for-two", "three-for-two", "wrong-size", "nan", "inf", "booleans", "missing"])
def test_anything_but_one_full_vector_per_text_is_refused(client, vectors):
    answer(client, vectors)
    with pytest.raises(ValueError):
        rag.embed_texts(["a", "b"], settings(), timeout_seconds=5)


def test_a_response_without_embeddings_is_refused(client):
    embed_content(client).return_value = SimpleNamespace(embeddings=None)
    with pytest.raises(ValueError):
        rag.embed_texts(["a"], settings(), timeout_seconds=5)


def test_no_texts_means_no_call(client):
    assert rag.embed_texts([], settings(), timeout_seconds=5) == []
    client.assert_not_called()


def test_a_missing_key_is_refused_before_any_call(client):
    with pytest.raises(ValueError):
        rag.embed_texts(["a"], Settings(_env_file=None, gemini_api_key=""), timeout_seconds=5)
    client.assert_not_called()


def test_provider_errors_propagate(client):
    embed_content(client).side_effect = RuntimeError("provider down")
    with pytest.raises(RuntimeError):
        rag.embed_texts(["a"], settings(), timeout_seconds=5)


def test_embedding_does_not_count_against_the_daily_gemini_cap(client):
    answer(client, [[0.1] * 768])
    rag.embed_texts(["a"], settings(), timeout_seconds=5)
    # The cap of one call is still unused.
    assert gemini._DAILY_CALLS.take(1, "test") is None
