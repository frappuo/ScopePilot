"""Chunk, embed and store the committed reference sources in public.rag_chunks (migration 0003).

Run from backend/:  python -m rag.ingest [--dry-run] [--prune]

Reads only committed files, never the source sites: backend/rag/sources/*.md, sources.json and
SOURCES.md. Every file is validated first, and any problem stops the run before anything is
embedded or sent. A file may be fetched or written by hand; only the file is validated.

Idempotent: each chunk is keyed by content_hash (its text, metadata and embedding model), only
chunks whose hash is not stored yet are embedded, and inserts ignore duplicates. Each batch is
inserted as soon as it is embedded, so a failed run keeps what it stored and a rerun goes on from
there. Only after every insert has succeeded are a source's outdated rows deleted, and with
--prune the rows of sources that no longer have a file. --dry-run validates and chunks only:
no Gemini or Supabase call.

Settings (Gemini key, Supabase URL and secret key, RAG_EMBEDDING_MODEL) are read like the backend
reads them. Output carries keys, counts and step names only: never keys, URLs or passage text.
"""

import argparse
from dataclasses import dataclass, field
import hashlib
import json
import logging
from pathlib import Path
import re
import sys

from pydantic import ValidationError

from app.config import Settings
from app.services import logbook
from app.services.errors import AnalysisError
from app.services.rag import (
    DOCUMENT_TEMPLATE, EMBED_BATCH, EMBEDDING_DIMENSIONS, document_text, embed_texts, vector_literal,
)
from rag.fetch import load_entries
from rag.sourcefile import SourceError, SourceMeta, normalise, parse_sources_md, read_source

RAG_DIR = Path(__file__).resolve().parent
# Chunk sizes in characters. A chunk is packed from whole blocks up to TARGET_CHARS; a block longer
# than _PIECE_MAX is split at line ends, then at sentence ends, then hard. Each chunk after the
# first in a section starts with up to OVERLAP_CHARS from the end of the previous one, so no chunk,
# overlap included, is longer than MAX_CHARS.
TARGET_CHARS = 1200
MAX_CHARS = 1800
OVERLAP_CHARS = 200
_PIECE_MAX = MAX_CHARS - OVERLAP_CHARS - 2
MIN_CHARS = 80  # A shorter piece joins a neighbour in its section, or is dropped if it is all the section has.
MAX_SECTION_CHARS = 300  # rag_chunks.section check.
MAX_CHUNKS_PER_SOURCE = 200
EMBED_TIMEOUT_SECONDS = 60
LIST_PAGE = 500  # Below Supabase's default PostgREST row cap (1000), so a short page means the end.
DELETE_BATCH = 50
TABLE = "/rest/v1/rag_chunks"
_EXTRA_FILES = frozenset({".gitkeep"})
_HEADING = re.compile(r"(#{1,6}) +(\S.*)")
_FENCE = re.compile(r"(```|~~~)")
_SENTENCE_END = re.compile(r"(?<=[.!?])\s+")
_SENTENCE_START = re.compile(r"(?<=[.!?])\s+|\n+")
_HASH = re.compile(r"[0-9a-f]{64}")


@dataclass(frozen=True)
class Chunk:
    source_key: str
    title: str
    section: str | None
    url: str
    licence: str
    topic: str
    content: str
    content_hash: str


class IngestError(Exception):
    """A Gemini or Supabase step failed. The message names the step only."""


def load_sources(rag_dir: Path) -> list[tuple[SourceMeta, str]]:
    """Every committed source file with its body, sorted by file name.

    Each <key>.md must pass sourcefile.read_source and match its sources.json entry (url, topic,
    licence) and its SOURCES.md row (url, licence; the row's licence evidence is checked when the
    table is read). Every entry and row needs a file. SourceError lists every problem found.
    """
    entries = {entry.key: entry for entry in load_entries(rag_dir / "sources.json")}
    try:
        _, rows = parse_sources_md((rag_dir / "SOURCES.md").read_text(encoding="utf-8"))
        paths = sorted((rag_dir / "sources").iterdir())
    except OSError:
        raise SourceError("SOURCES.md or the sources folder cannot be read.") from None
    problems: list[str] = []
    sources: list[tuple[SourceMeta, str]] = []
    stems: set[str] = set()
    for path in paths:
        if path.name in _EXTRA_FILES:
            continue
        if not path.is_file() or path.suffix != ".md":
            problems.append(f"{path.name}: only <key>.md files belong in sources/.")
            continue
        stems.add(path.stem)
        try:
            meta, body = read_source(path)
        except SourceError as exc:
            problems.append(str(exc))
            continue
        entry = entries.get(meta.key)
        if entry is None:
            problems.append(f"{path.name}: no sources.json entry with this key.")
        else:
            problems += [f"{path.name}: {name} differs from its sources.json entry."
                         for name in ("url", "topic", "licence") if getattr(entry, name) != getattr(meta, name)]
        row = rows.get(meta.key)
        if row is None:
            problems.append(f"{path.name}: no SOURCES.md row with this key.")
        else:
            problems += [f"{path.name}: {name} differs from its SOURCES.md row."
                         for name in ("url", "licence") if getattr(row, name) != getattr(meta, name)]
        sources.append((meta, body))
    problems += [f"sources.json entry '{key}' has no file in sources/." for key in sorted(set(entries) - stems)]
    problems += [f"SOURCES.md row '{key}' has no file in sources/." for key in sorted(set(rows) - stems)]
    if problems:
        raise SourceError("\n".join(problems))
    return sources


def _section_name(path: list[tuple[int, str]]) -> str:
    return " > ".join(text for _, text in path)[:MAX_SECTION_CHARS].rstrip()


def split_sections(body: str) -> list[tuple[str | None, list[str]]]:
    """(section, blocks) in document order.

    "#" headings are ignored (the title comes from the front matter); "##" to "######" open a
    section named by its heading path, such as "Cell wall > Composition" (levels below "####" count
    as "####"). Text before the first heading has section None. Blocks are separated by blank
    lines; a fenced code block stays one block, blank lines included.
    """
    sections: list[tuple[str | None, list[str]]] = []
    path: list[tuple[int, str]] = []
    current: str | None = None
    blocks: list[str] = []
    lines: list[str] = []
    fence: str | None = None

    def end_block() -> None:
        text = "\n".join(lines).strip()
        lines.clear()
        if text:
            blocks.append(text)

    def end_section() -> None:
        end_block()
        if blocks:
            sections.append((current, list(blocks)))
            blocks.clear()

    for line in normalise(body).split("\n"):
        stripped = line.strip()
        if fence is not None:
            lines.append(line.rstrip())
            if stripped.startswith(fence):
                fence = None
            continue
        marker = _FENCE.match(stripped)
        if marker:
            end_block()
            lines.append(line.rstrip())
            fence = marker.group(1)
            continue
        heading = _HEADING.fullmatch(stripped)
        if heading:
            end_section()
            level = len(heading.group(1))
            if level > 1:
                level = min(level, 4)
                path = [(depth, text) for depth, text in path if depth < level] + [(level, heading.group(2).strip())]
                current = _section_name(path)
            continue
        if not stripped:
            end_block()
            continue
        lines.append(line.rstrip())
    end_section()
    return sections


def _pack(parts: list[str], separator: str, limit: int) -> list[str]:
    """Consecutive parts joined by separator while the result stays within limit."""
    packed: list[str] = []
    current = ""
    for part in parts:
        if not part:
            continue
        candidate = f"{current}{separator}{part}" if current else part
        if len(candidate) <= limit or not current:
            current = candidate
        else:
            packed.append(current)
            current = part
    if current:
        packed.append(current)
    return packed


def _pieces(block: str) -> list[str]:
    """block in parts of at most _PIECE_MAX: split at line ends, then sentence ends, then hard."""
    if len(block) <= _PIECE_MAX:
        return [block]
    if "\n" in block:
        return _pack([piece for line in block.split("\n") for piece in _pieces(line)], "\n", _PIECE_MAX)
    parts = []
    for sentence in _SENTENCE_END.split(block):
        parts += [sentence[start:start + _PIECE_MAX] for start in range(0, len(sentence), _PIECE_MAX)]
    return _pack(parts, " ", _PIECE_MAX)


def _merge_short(bodies: list[str]) -> list[str]:
    """Pieces under MIN_CHARS join the previous one, or the next if none comes before, when the
    result fits; a short piece that is all the section has is dropped."""
    merged: list[str] = []
    pending: str | None = None
    for body in bodies:
        if pending is not None:
            joined = f"{pending}\n\n{body}"
            if len(joined) <= _PIECE_MAX:
                body = joined
            else:
                merged.append(pending)
            pending = None
        if len(body) < MIN_CHARS:
            if merged and len(merged[-1]) + 2 + len(body) <= _PIECE_MAX:
                merged[-1] = f"{merged[-1]}\n\n{body}"
                continue
            if not merged:
                pending = body
                continue
        merged.append(body)
    return merged


def _overlap(previous: str) -> str:
    """Up to the last OVERLAP_CHARS of previous, starting at a sentence or line start; "" if none."""
    tail = previous[-OVERLAP_CHARS:]
    match = _SENTENCE_START.search(tail)
    return tail[match.end():].strip() if match else ""


def section_chunks(blocks: list[str]) -> list[str]:
    """The chunk texts of one section, in order."""
    bodies = _merge_short(_pack([piece for block in blocks for piece in _pieces(block)], "\n\n", TARGET_CHARS))
    chunks = bodies[:1]
    for previous, body in zip(bodies, bodies[1:]):
        overlap = _overlap(previous)
        chunks.append(f"{overlap}\n\n{body}" if overlap else body)
    return chunks


def content_hash(*, source_key: str, title: str, section: str | None, url: str, licence: str, topic: str,
                 content: str, embedding_model: str) -> str:
    """sha256 over everything that ends up in the row or in the embedded text, the model included."""
    payload = {
        "source_key": source_key, "title": title, "section": section, "url": url, "licence": licence,
        "topic": topic, "content": content, "embedding_model": embedding_model,
        "dimensions": EMBEDDING_DIMENSIONS, "document_template": DOCUMENT_TEMPLATE,
    }
    canonical = json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def chunk_source(meta: SourceMeta, body: str, embedding_model: str) -> list[Chunk]:
    """The chunks of one source. SourceError if it gives none or more than MAX_CHUNKS_PER_SOURCE."""
    chunks = []
    for section, blocks in split_sections(body):
        for text in section_chunks(blocks):
            chunks.append(Chunk(
                source_key=meta.key, title=meta.title, section=section, url=meta.url, licence=meta.licence,
                topic=meta.topic, content=text,
                content_hash=content_hash(source_key=meta.key, title=meta.title, section=section, url=meta.url,
                                          licence=meta.licence, topic=meta.topic, content=text,
                                          embedding_model=embedding_model),
            ))
    if not chunks:
        raise SourceError(f"{meta.key}.md gives no passages.")
    if len(chunks) > MAX_CHUNKS_PER_SOURCE:
        raise SourceError(f"{meta.key}.md gives more than {MAX_CHUNKS_PER_SOURCE} passages.")
    return chunks


def chunk_all(sources: list[tuple[SourceMeta, str]], embedding_model: str) -> list[Chunk]:
    """Every source's chunks; a chunk identical to an earlier one is kept once."""
    unique: dict[str, Chunk] = {}
    for meta, body in sources:
        for chunk in chunk_source(meta, body, embedding_model):
            unique.setdefault(chunk.content_hash, chunk)
    return list(unique.values())


def _call(op: str, settings: Settings, method: str, **kwargs) -> object:
    """One PostgREST request on rag_chunks through the logbook client (the one place that reads
    the secret key); its failure log line names rag_<op> and the status only."""
    try:
        response = logbook._request(f"rag_{op}", settings, method, TABLE, **kwargs)
    except AnalysisError:
        raise IngestError(f"Supabase step '{op}' failed.") from None
    return logbook._json(response)


def _existing(settings: Settings) -> list[tuple[str, str]]:
    """(source_key, content_hash) of every stored row, page by page."""
    found: list[tuple[str, str]] = []
    offset = 0
    while True:
        rows = _call("list", settings, "GET", params={
            "select": "source_key,content_hash", "order": "content_hash.asc",
            "limit": str(LIST_PAGE), "offset": str(offset),
        })
        if not isinstance(rows, list) or len(rows) > LIST_PAGE or not all(
                isinstance(row, dict) and isinstance(row.get("source_key"), str)
                and isinstance(row.get("content_hash"), str) and _HASH.fullmatch(row["content_hash"])
                for row in rows):
            raise IngestError("Supabase step 'list' returned an unexpected response.")
        found += [(row["source_key"], row["content_hash"]) for row in rows]
        if len(rows) < LIST_PAGE:
            return found
        offset += LIST_PAGE


@dataclass
class IngestReport:
    embedded: int = 0
    inserted: int = 0
    deleted: int = 0
    orphan_sources: list[str] = field(default_factory=list)


def ingest(chunks: list[Chunk], settings: Settings, *, prune: bool) -> IngestReport:
    """Store the chunks not stored yet, then delete outdated rows. IngestError if a step fails.

    Rows of a source that still has a file but whose hash is no longer produced are deleted.
    Rows of a source with no file are deleted only with prune; otherwise they are reported.
    """
    existing = _existing(settings)
    stored = {content_hash for _, content_hash in existing}
    missing = [chunk for chunk in chunks if chunk.content_hash not in stored]
    report = IngestReport()
    for start in range(0, len(missing), EMBED_BATCH):
        batch = missing[start:start + EMBED_BATCH]
        try:
            vectors = embed_texts([document_text(chunk.title, chunk.section, chunk.content) for chunk in batch],
                                  settings, timeout_seconds=EMBED_TIMEOUT_SECONDS)
        except Exception as exc:
            # The class name only: provider messages can quote the request.
            raise IngestError(f"Embedding failed ({type(exc).__name__}).") from None
        report.embedded += len(batch)
        _call("insert", settings, "POST", params={"on_conflict": "content_hash"},
              headers={"Prefer": "resolution=ignore-duplicates,return=minimal"},
              json=[{
                  "source_key": chunk.source_key, "title": chunk.title, "section": chunk.section, "url": chunk.url,
                  "licence": chunk.licence, "topic": chunk.topic, "content": chunk.content,
                  "content_hash": chunk.content_hash, "embedding_model": settings.rag_embedding_model,
                  "embedding": vector_literal(vector),
              } for chunk, vector in zip(batch, vectors, strict=True)])
        report.inserted += len(batch)

    current: dict[str, set[str]] = {}
    for chunk in chunks:
        current.setdefault(chunk.source_key, set()).add(chunk.content_hash)
    stale: dict[str, list[str]] = {}
    for source_key, stored_hash in existing:
        if source_key in current and stored_hash not in current[source_key]:
            stale.setdefault(source_key, []).append(stored_hash)
    for source_key in sorted(stale):
        hashes = sorted(stale[source_key])
        for start in range(0, len(hashes), DELETE_BATCH):
            batch = hashes[start:start + DELETE_BATCH]
            _call("delete", settings, "DELETE",
                  params={"source_key": f"eq.{source_key}", "content_hash": f"in.({','.join(batch)})"})
            report.deleted += len(batch)
    orphans = sorted({source_key for source_key, _ in existing} - set(current))
    if prune:
        for source_key in orphans:
            _call("prune", settings, "DELETE", params={"source_key": f"eq.{source_key}"})
            report.deleted += sum(1 for key, _ in existing if key == source_key)
    else:
        report.orphan_sources = orphans
    return report


def main(argv: list[str] | None = None, *, rag_dir: Path = RAG_DIR, settings: Settings | None = None) -> int:
    """0 on success, 1 if a Gemini or Supabase step failed, 2 on invalid sources or settings."""
    parser = argparse.ArgumentParser(prog="python -m rag.ingest",
                                     description="Chunk, embed and store the committed RAG sources.")
    parser.add_argument("--dry-run", action="store_true", help="Validate and chunk only; call nothing.")
    parser.add_argument("--prune", action="store_true", help="Also delete the rows of sources that have no file.")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)  # Its INFO lines print request URLs.
    try:
        sources = load_sources(rag_dir)
    except SourceError as exc:
        print(f"Source validation failed:\n{exc}", file=sys.stderr)
        return 2
    if settings is None:
        try:
            settings = Settings()
        except (ValidationError, ValueError, OSError):
            print("Error: invalid backend configuration. Check your local settings.", file=sys.stderr)
            return 2
    try:
        chunks = chunk_all(sources, settings.rag_embedding_model)
    except SourceError as exc:
        print(f"Chunking failed:\n{exc}", file=sys.stderr)
        return 2
    for meta, _ in sources:
        sizes = [len(chunk.content) for chunk in chunks if chunk.source_key == meta.key]
        print(f"{meta.key}: chunks={len(sizes)} chars={min(sizes, default=0)}-{max(sizes, default=0)}")
    print(f"sources={len(sources)} chunks={len(chunks)} model={settings.rag_embedding_model}")
    if args.dry_run:
        print("Dry run: nothing embedded or stored.")
        return 0
    if not settings.logbook_configured or not settings.gemini_api_key.get_secret_value().strip():
        print("Error: GEMINI_API_KEY, SUPABASE_URL and SUPABASE_SECRET_KEY must be set for a real run.",
              file=sys.stderr)
        return 2
    try:
        report = ingest(chunks, settings, prune=args.prune)
    except IngestError as exc:
        print(f"Error: {exc} Rows already inserted stay; run again to continue.", file=sys.stderr)
        return 1
    print(f"embedded={report.embedded} inserted={report.inserted} deleted={report.deleted}")
    if report.orphan_sources:
        print(f"Kept the rows of sources with no file (--prune deletes them): {', '.join(report.orphan_sources)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
