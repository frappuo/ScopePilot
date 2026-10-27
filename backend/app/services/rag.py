"""RAG reference passages: embeddings shared by ingestion (backend/rag/ingest.py) and retrieval.

The embedding model comes from settings (RAG_EMBEDDING_MODEL). Its input formats and vector size
are defined here only. Embedding calls do not go through gemini._generate: they never count
against GEMINI_DAILY_CALL_LIMIT or a user's quota, and never fall back to another model.
Passages explain biology in general; they are never evidence about what a student's image shows.
"""

from dataclasses import dataclass
import logging
import math
import re
from time import monotonic
from urllib.parse import urlsplit

from google import genai
from google.genai import types
import httpx

from app.config import Settings
from app.services import logbook

logger = logging.getLogger(__name__)

EMBEDDING_DIMENSIONS = 768  # rag_chunks.embedding is vector(768) (supabase/migrations/0003_rag.sql).
QUERY_TEMPLATE = "task: search result | query: {content}"
DOCUMENT_TEMPLATE = "title: {title} | text: {content}"
EMBED_BATCH = 20
# The rag_chunks.licence check in supabase/migrations/0003_rag.sql.
LICENCE_PATTERN = re.compile(r"CC BY(-SA)? (2\.0|2\.5|3\.0|4\.0)")
MATCH_PATH = "/rest/v1/rpc/match_rag_chunks"
SIMILARITY_TOLERANCE = 1e-6  # Float rounding at both ends of the similarity range.
_STRING_FIELDS = ("source_key", "title", "url", "licence", "topic", "content", "embedding_model")


@dataclass(frozen=True)
class Passage:
    """A reference passage for one ask: openly licensed biology text, never evidence about the image."""

    title: str
    section: str | None
    url: str
    licence: str
    content: str


def document_text(title: str, section: str | None, content: str) -> str:
    """The text embedded for a stored passage: its section heading, then the passage."""
    return DOCUMENT_TEMPLATE.format(title=title, content=f"{section}\n\n{content}" if section else content)


def retrieval_query(question: str, specimen: str) -> str:
    """The text embedded for a question: the question, then the analysis's tentative specimen."""
    return QUERY_TEMPLATE.format(content=f"{question}\nProbable specimen (tentative): {specimen}")


def vector_literal(vector: list[float]) -> str:
    """pgvector's text form; PostgREST casts it to vector(768)."""
    return "[" + ",".join(repr(value) for value in vector) + "]"


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


def _https_url(value: str) -> bool:
    parts = urlsplit(value)
    return parts.scheme == "https" and bool(parts.hostname) and len(value) <= 2000


def _text(value: object, limit: int) -> bool:
    return isinstance(value, str) and 1 <= len(value) <= limit


def _passages(rows: object, settings: Settings) -> tuple[list[Passage], float] | None:
    """(passages closest first, top similarity clamped to 1.0) from match_rag_chunks rows, or None.

    Rows embedded with another model are dropped: their vectors are not comparable. Any other
    malformed row discards the whole result.
    """
    if not isinstance(rows, list) or len(rows) > settings.rag_top_k:
        return None
    passages: list[Passage] = []
    top = 0.0
    low, high = settings.rag_min_similarity - SIMILARITY_TOLERANCE, 1 + SIMILARITY_TOLERANCE
    for row in rows:
        if not isinstance(row, dict) or not all(isinstance(row.get(name), str) for name in _STRING_FIELDS):
            return None
        if row["embedding_model"] != settings.rag_embedding_model:
            continue
        section, similarity = row.get("section"), row.get("similarity")
        if not (_text(row["title"], 200) and (section is None or _text(section, 300)) and _https_url(row["url"])
                and LICENCE_PATTERN.fullmatch(row["licence"]) and _text(row["content"], 4000)
                and _is_number(similarity) and low <= similarity <= high):
            return None
        passages.append(Passage(title=row["title"], section=section, url=row["url"], licence=row["licence"],
                                content=row["content"]))
        top = max(top, min(float(similarity), 1.0))
    return passages, top


def _skipped(reason: str) -> list[Passage]:
    # Never the question, the specimen or any ID.
    logger.warning("RAG retrieval skipped reason=%s", reason)
    return []


def retrieve_passages(question: str, specimen: str, settings: Settings) -> list[Passage]:
    """Up to RAG_TOP_K reference passages for a question, closest first. Never raises.

    The query embedding and the match_rag_chunks call share one wall-clock budget
    (RAG_RETRIEVAL_TIMEOUT_SECONDS). Any failure returns [] with one WARNING line naming the step,
    so the ask goes on without passages. The request body holds only the query vector and the
    match settings: no user or experiment ID.
    """
    deadline = monotonic() + settings.rag_retrieval_timeout_seconds
    try:
        (vector,) = embed_texts([retrieval_query(question, specimen)], settings,
                                timeout_seconds=settings.rag_retrieval_timeout_seconds)
    except (httpx.TimeoutException, TimeoutError):
        return _skipped("embed_timeout")
    except ValueError:
        return _skipped("embed_bad_response")
    except Exception:
        # Provider errors (a 429 included) and transport failures; their messages can quote the request.
        return _skipped("embed_error")
    remaining = deadline - monotonic()
    if remaining <= 0:
        return _skipped("budget")
    try:
        # The logbook client: the one place that reads the secret key.
        with logbook._client(settings) as client:
            response = client.post(MATCH_PATH, headers=logbook._auth_headers(settings), timeout=remaining, json={
                "query_embedding": vector_literal(vector),
                "match_count": settings.rag_top_k,
                "min_similarity": settings.rag_min_similarity,
            })
    except httpx.HTTPError:
        return _skipped("rpc_transport")
    if not response.is_success:
        return _skipped(f"rpc_status_{response.status_code}")
    try:
        result = _passages(response.json(), settings)
    except ValueError:
        result = None
    if result is None:
        return _skipped("rpc_bad_response")
    passages, top = result
    logger.info("RAG retrieval passages=%s top_similarity=%.2f", len(passages), top)
    return passages
