"""RAG reference passages: embeddings shared by ingestion (backend/rag/ingest.py) and retrieval.

The embedding model comes from settings (RAG_EMBEDDING_MODEL). Its input formats and vector size
are defined here only. Embedding calls do not go through gemini._generate: they never count
against GEMINI_DAILY_CALL_LIMIT or a user's quota, and never fall back to another model.
Passages explain biology in general; they are never evidence about what a student's image shows.
"""

import math

from google import genai
from google.genai import types

from app.config import Settings

EMBEDDING_DIMENSIONS = 768  # rag_chunks.embedding is vector(768) (supabase/migrations/0003_rag.sql).
QUERY_TEMPLATE = "task: search result | query: {content}"
DOCUMENT_TEMPLATE = "title: {title} | text: {content}"
EMBED_BATCH = 20


def document_text(title: str, section: str | None, content: str) -> str:
    """The text embedded for a stored passage: its section heading, then the passage."""
    return DOCUMENT_TEMPLATE.format(title=title, content=f"{section}\n\n{content}" if section else content)


def _is_number(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def embed_texts(texts: list[str], settings: Settings, *, timeout_seconds: float) -> list[list[float]]:
    """One EMBEDDING_DIMENSIONS-long vector per text, in order.

    Each text is its own Content: several parts in one Content would be combined into a single
    embedding. Raises ValueError unless exactly one vector of EMBEDDING_DIMENSIONS finite numbers
    comes back per text, so callers never store or use a partial result. Provider and transport
    errors propagate unchanged.
    """
    if not texts:
        return []
    key = settings.gemini_api_key.get_secret_value().strip()
    if not key:
        raise ValueError("Gemini API key is not configured.")
    with genai.Client(
        api_key=key,
        http_options=types.HttpOptions(
            timeout=max(1, int(timeout_seconds * 1000)),
            retry_options=types.HttpRetryOptions(attempts=1),
        ),
    ) as client:
        result = client.models.embed_content(
            model=settings.rag_embedding_model,
            contents=[types.Content(parts=[types.Part(text=text)]) for text in texts],
            config=types.EmbedContentConfig(output_dimensionality=EMBEDDING_DIMENSIONS),
        )
    embeddings = getattr(result, "embeddings", None)
    if not isinstance(embeddings, list) or len(embeddings) != len(texts):
        raise ValueError("The embedding response does not have one vector per text.")
    vectors = []
    for embedding in embeddings:
        values = getattr(embedding, "values", None)
        if not isinstance(values, list) or len(values) != EMBEDDING_DIMENSIONS or not all(map(_is_number, values)):
            raise ValueError("An embedding vector has the wrong size or a non-finite value.")
        vectors.append([float(value) for value in values])
    return vectors
