"""Ingestion (rag/ingest.py): validation of the committed sources, chunking, and the idempotent
upsert into rag_chunks. Gemini and Supabase are mocked; nothing leaves the machine. Synthetic
sources are invented text."""

from dataclasses import replace
from datetime import date
import json
from pathlib import Path
import re
from types import SimpleNamespace
from unittest.mock import MagicMock

import httpx
import pytest

from app.config import Settings
from app.services import gemini, logbook, rag
from rag import ingest
from rag.fetch import load_entries
from rag.ingest import chunk_all, chunk_source, content_hash, load_sources, section_chunks, split_sections
from rag.sourcefile import EVIDENCE_HAND, EVIDENCE_PAGE, SourceError, SourceMeta, SourceRow, format_source, format_sources_md

RAG = Path(__file__).resolve().parents[1] / "rag"
KEY = "test-key-not-real"
SUPABASE_URL = "https://example-project.supabase.co"
SECRET = "dummy-supabase-secret-for-tests"
MODEL = "gemini-embedding-2"
META = SourceMeta(key="onion-cells", title="Onion cells", url="https://en.wikipedia.org/wiki/Onion_cells",
                  author="Wikipedia contributors", licence="CC BY-SA 4.0", retrieved=date(2026, 10, 20),
                  topic="plant-cells")
OTHER = SourceMeta(key="cheek-cells", title="Cheek cells", url="https://en.wikipedia.org/wiki/Cheek_cells",
                   author="Wikipedia contributors", licence="CC BY-SA 4.0", retrieved=date(2026, 10, 20),
                   topic="epithelium")


def sentences(word, count):
    return " ".join(f"{word} sentence {index} adds invented detail about cells." for index in range(count))


BODY = f"{sentences('Lead', 3)}\n\n## Cell wall\n\n{sentences('Wall', 3)}"
MANY_BODY = "\n\n".join(f"## Part {index}\n\n{sentences(f'Part{index}', 3)}" for index in range(25))


def settings(**overrides):
    values = {"gemini_api_key": KEY, "supabase_url": SUPABASE_URL, "supabase_secret_key": SECRET, **overrides}
    return Settings(_env_file=None, **values)


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    """Supabase and Gemini fail the test unless the table or embedder fixture replaces them."""
    def refuse(request):
        raise AssertionError(f"unexpected Supabase request {request.method} {request.url.path}")

    monkeypatch.setattr(logbook, "_transport", httpx.MockTransport(refuse))
    monkeypatch.setattr(rag.genai, "Client", MagicMock(side_effect=AssertionError("unexpected Gemini client")))


def make_rag(root, sources, *, entries=None, rows=None):
    """A rag folder with these (meta, body) files and, unless given, matching entries and rows."""
    folder = root / "sources"
    folder.mkdir(exist_ok=True)
    for path in folder.glob("*.md"):
        path.unlink()
    for meta, body in sources:
        (folder / f"{meta.key}.md").write_text(format_source(meta, body), encoding="utf-8")
    if entries is None:
        entries = [{"key": m.key, "url": m.url, "topic": m.topic, "licence": m.licence} for m, _ in sources]
    if rows is None:
        rows = {m.key: SourceRow.from_meta(m, EVIDENCE_PAGE) for m, _ in sources}
    (root / "sources.json").write_text(json.dumps({"version": 1, "sources": entries}), encoding="utf-8")
    (root / "SOURCES.md").write_text(format_sources_md("# Sources", rows), encoding="utf-8")
    return root


class FakeTable:
    """public.rag_chunks behind PostgREST: list, insert with on_conflict=content_hash and
    ignore-duplicates, and deletes filtered by source_key (and content_hash). Records every request.
    fail maps a method to a status."""

    def __init__(self):
        self.rows: dict[str, dict] = {}
        self.requests: list[httpx.Request] = []
        self.fail: dict[str, int] = {}
        self.list_body: object = None

    def by(self, method):
        return [request for request in self.requests if request.method == method]

    def __call__(self, request):
        self.requests.append(request)
        assert request.headers["apikey"] == SECRET
        assert request.url.path == "/rest/v1/rag_chunks"
        if request.method in self.fail:
            return httpx.Response(self.fail[request.method], json={"message": "fake failure"})
        params = request.url.params
        if request.method == "GET":
            assert params["select"] == "source_key,content_hash" and params["order"] == "content_hash.asc"
            if self.list_body is not None:
                return httpx.Response(200, json=self.list_body)
            ordered = sorted(self.rows.values(), key=lambda row: row["content_hash"])
            offset, limit = int(params["offset"]), int(params["limit"])
            return httpx.Response(200, json=[{"source_key": row["source_key"], "content_hash": row["content_hash"]}
                                             for row in ordered[offset:offset + limit]])
        if request.method == "POST":
            assert params["on_conflict"] == "content_hash"
            assert request.headers["prefer"] == "resolution=ignore-duplicates,return=minimal"
            for row in json.loads(request.content):
                self.rows.setdefault(row["content_hash"], row)
            return httpx.Response(201)
        if request.method == "DELETE":
            # Never an unfiltered delete.
            assert params["source_key"].startswith("eq.")
            source_key = params["source_key"].removeprefix("eq.")
            hashes = set(params["content_hash"].removeprefix("in.(").removesuffix(")").split(",")) \
                if "content_hash" in params else None
            for stored_hash, row in list(self.rows.items()):
                if row["source_key"] == source_key and (hashes is None or stored_hash in hashes):
                    del self.rows[stored_hash]
            return httpx.Response(204)
        raise AssertionError(f"unexpected {request.method}")


class FakeEmbedder:
    """models.embed_content: one 768-value vector per Content. short_on answers that call (1-based)
    with one vector too few; fail_on raises on it."""

    def __init__(self):
        self.calls: list[dict] = []
        self.short_on: int | None = None
        self.fail_on: int | None = None

    def embed_content(self, *, model, contents, config):
        self.calls.append({"model": model, "texts": [content.parts[0].text for content in contents],
                           "config": config})
        if len(self.calls) == self.fail_on:
            raise RuntimeError("provider failure quoting the request")
        count = len(contents) - (1 if len(self.calls) == self.short_on else 0)
        return SimpleNamespace(embeddings=[SimpleNamespace(values=[0.25] * 768) for _ in range(count)])

    def embedded(self):
        return sum(len(call["texts"]) for call in self.calls)


@pytest.fixture
def table(monkeypatch):
    fake = FakeTable()
    monkeypatch.setattr(logbook, "_transport", httpx.MockTransport(fake))
    return fake


@pytest.fixture
def embedder(monkeypatch):
    fake = FakeEmbedder()
    factory = MagicMock()
    factory.return_value.__enter__.return_value.models = fake
    monkeypatch.setattr(rag.genai, "Client", factory)
    return fake


def run(root, *args, **overrides):
    return ingest.main(list(args), rag_dir=root, settings=settings(**overrides))


# --- The committed sources ---

def test_the_committed_sources_validate_and_chunk():
    sources = load_sources(RAG)
    entries = load_entries(RAG / "sources.json")
    assert len(sources) == len(entries) > 0
    chunks = chunk_all(sources, MODEL)
    assert {chunk.source_key for chunk in chunks} == {entry.key for entry in entries}
    assert len({chunk.content_hash for chunk in chunks}) == len(chunks)
    for chunk in chunks:
        assert 1 <= len(chunk.content) <= ingest.MAX_CHARS
        assert chunk.section is None or 1 <= len(chunk.section) <= ingest.MAX_SECTION_CHARS
        assert not re.match(r"#{1,6} ", chunk.content)


def test_dry_run_on_the_committed_sources_calls_nothing(monkeypatch, capsys):
    def no_network(request):
        raise AssertionError("a dry run must not call Supabase")

    monkeypatch.setattr(logbook, "_transport", httpx.MockTransport(no_network))
    monkeypatch.setattr(rag.genai, "Client", MagicMock(side_effect=AssertionError("a dry run must not embed")))
    # No keys needed: a dry run only validates and chunks.
    assert ingest.main(["--dry-run"], rag_dir=RAG, settings=Settings(_env_file=None, gemini_api_key="")) == 0
    out = capsys.readouterr().out
    assert f"sources={len(load_entries(RAG / 'sources.json'))} " in out
    assert "Dry run: nothing embedded or stored." in out


# --- Validation ---

def test_matching_sources_load(tmp_path):
    assert load_sources(make_rag(tmp_path, [(META, BODY)])) == [(META, BODY)]


def test_a_hand_written_file_validates_and_ingests_like_a_fetched_one(tmp_path, table, embedder):
    root = make_rag(tmp_path, [], entries=[{"key": META.key, "url": META.url, "topic": META.topic,
                                           "licence": META.licence}],
                    rows={META.key: SourceRow.from_meta(META, EVIDENCE_HAND, "Saved by hand.")})
    hand = format_source(META, BODY).replace("title: Onion cells", 'title: "Onion cells"').replace("\n", "\r\n")
    (root / "sources" / "onion-cells.md").write_bytes(("﻿" + hand).encode("utf-8"))
    assert load_sources(root) == [(META, BODY)]
    assert run(root) == 0
    assert {row["source_key"] for row in table.rows.values()} == {META.key}


def entry(meta, **changes):
    return {"key": meta.key, "url": meta.url, "topic": meta.topic, "licence": meta.licence, **changes}


@pytest.mark.parametrize("entries, rows, message", [
    ([], None, "onion-cells.md: no sources.json entry with this key."),
    ([entry(META, topic="other-topic")], None, "onion-cells.md: topic differs from its sources.json entry."),
    ([entry(META, url="https://en.wikipedia.org/wiki/Other")], None, "onion-cells.md: url differs from its sources.json entry."),
    ([entry(META, licence="CC BY 4.0")], None, "onion-cells.md: licence differs from its sources.json entry."),
    (None, {}, "onion-cells.md: no SOURCES.md row with this key."),
    (None, {META.key: SourceRow.from_meta(replace(META, url="https://en.wikipedia.org/wiki/Other"), EVIDENCE_PAGE)},
     "onion-cells.md: url differs from its SOURCES.md row."),
    (None, {META.key: SourceRow.from_meta(replace(META, licence="CC BY 4.0"), EVIDENCE_PAGE)},
     "onion-cells.md: licence differs from its SOURCES.md row."),
    ([entry(META), entry(OTHER)], None, "sources.json entry 'cheek-cells' has no file in sources/."),
    (None, {META.key: SourceRow.from_meta(META, EVIDENCE_PAGE), OTHER.key: SourceRow.from_meta(OTHER, EVIDENCE_PAGE)},
     "SOURCES.md row 'cheek-cells' has no file in sources/."),
], ids=["no-entry", "entry-topic", "entry-url", "entry-licence", "no-row", "row-url", "row-licence", "extra-entry",
        "extra-row"])
def test_files_must_match_sources_json_and_sources_md(tmp_path, entries, rows, message):
    root = make_rag(tmp_path, [(META, BODY)], entries=entries, rows=rows)
    with pytest.raises(SourceError) as error:
        load_sources(root)
    assert message in str(error.value).split("\n")


def test_every_problem_is_listed_and_stray_files_are_refused(tmp_path):
    root = make_rag(tmp_path, [(META, BODY)], entries=[])
    (root / "sources" / "notes.txt").write_text("stray", encoding="utf-8")
    (root / "sources" / "broken.md").write_text("no front matter", encoding="utf-8")
    (root / "sources" / ".gitkeep").write_text("", encoding="utf-8")
    with pytest.raises(SourceError) as error:
        load_sources(root)
    problems = str(error.value).split("\n")
    assert "notes.txt: only <key>.md files belong in sources/." in problems
    assert any(problem.startswith("broken.md: ") for problem in problems)
    assert "onion-cells.md: no sources.json entry with this key." in problems
    assert not any(".gitkeep" in problem for problem in problems)


def test_invalid_sources_stop_the_run_before_any_call(tmp_path, table, embedder, capsys):
    root = make_rag(tmp_path, [(META, BODY)], entries=[])
    assert run(root) == 2
    assert table.requests == [] and embedder.calls == []
    assert "Source validation failed:" in capsys.readouterr().err


# --- Chunking ---

def test_sections_follow_the_heading_path():
    body = ("Lead paragraph.\n\n# Ignored title\n\n## Cell wall\n\nWall text.\n\n### Composition\n\nComposition text."
            "\n\n#### Detail\n\nDetail text.\n\n###### Deep\n\nDeep text.\n\n## Membrane\n\n- One\n- Two\n\n"
            "\\# Not a heading.")
    assert split_sections(body) == [
        (None, ["Lead paragraph."]),
        ("Cell wall", ["Wall text."]),
        ("Cell wall > Composition", ["Composition text."]),
        ("Cell wall > Composition > Detail", ["Detail text."]),
        ("Cell wall > Composition > Deep", ["Deep text."]),
        ("Membrane", ["- One\n- Two", "\\# Not a heading."]),
    ]


def test_a_fenced_block_stays_whole():
    body = "## Code\n\n```\nline one\n\nline two\n```\n\nAfter."
    assert split_sections(body) == [("Code", ["```\nline one\n\nline two\n```", "After."])]


def test_long_section_chunks_stay_within_size_with_sentence_overlap():
    paragraph = sentences("Wall", 100)
    chunks = section_chunks([paragraph])
    assert len(chunks) > 2
    assert all(len(chunk) <= ingest.MAX_CHARS for chunk in chunks)
    for previous, chunk in zip(chunks, chunks[1:]):
        overlap, _ = chunk.split("\n\n", 1)
        assert previous.endswith(overlap) and len(overlap) <= ingest.OVERLAP_CHARS
        assert overlap.startswith("Wall sentence ")
    for index in range(100):
        assert f"Wall sentence {index} adds" in " ".join(chunks)


def test_a_sentence_longer_than_a_chunk_is_split_hard():
    chunks = section_chunks(["x" * 4000])
    assert all(len(chunk) <= ingest.MAX_CHARS for chunk in chunks)
    assert "".join(chunks) == "x" * 4000


def test_a_long_list_is_split_between_items():
    items = "\n".join(f"- Item {index} describes an invented structure in some detail." for index in range(60))
    chunks = section_chunks([items])
    assert len(chunks) > 1 and all(len(chunk) <= ingest.MAX_CHARS for chunk in chunks)
    for chunk in chunks:
        assert all(line.startswith("- Item ") for line in chunk.split("\n") if line)


def test_short_pieces_join_a_neighbour_or_are_dropped():
    long = sentences("Wall", 25)
    assert section_chunks([long, "Tiny end."]) == [f"{long}\n\nTiny end."]
    assert section_chunks(["Intro line:", long]) == [f"Intro line:\n\n{long}"]
    assert section_chunks(["Short."]) == []


def test_chunks_never_cross_sections_and_carry_their_metadata():
    body = f"## Alpha\n\n{sentences('Alpha', 60)}\n\n## Beta\n\n{sentences('Beta', 3)}"
    chunks = chunk_source(META, body, MODEL)
    beta = [chunk for chunk in chunks if chunk.section == "Beta"]
    assert len(beta) == 1 and beta[0].content == sentences("Beta", 3)
    assert all("Beta" not in chunk.content for chunk in chunks if chunk.section == "Alpha")
    assert {(c.source_key, c.title, c.url, c.licence, c.topic) for c in chunks} == {
        (META.key, META.title, META.url, META.licence, META.topic)}
    assert chunk_source(META, body, MODEL) == chunks  # Deterministic.


def test_a_source_with_no_passages_or_too_many_is_refused(monkeypatch):
    with pytest.raises(SourceError):
        chunk_source(META, "## Only\n\nShort.", MODEL)
    monkeypatch.setattr(ingest, "MAX_CHUNKS_PER_SOURCE", 2)
    with pytest.raises(SourceError):
        chunk_source(META, MANY_BODY, MODEL)


def test_section_names_are_capped():
    (section, _), = split_sections(f"## {'h' * 400}\n\nText.")
    assert len(section) == ingest.MAX_SECTION_CHARS


def test_content_hash_covers_text_metadata_and_model():
    base = dict(source_key="a", title="T", section=None, url="https://example.org/a", licence="CC BY 4.0",
                topic="t", content="Text.", embedding_model=MODEL)
    value = content_hash(**base)
    assert re.fullmatch(r"[0-9a-f]{64}", value) and content_hash(**base) == value
    for name, changed in [("source_key", "b"), ("title", "U"), ("section", "S"), ("url", "https://example.org/b"),
                          ("licence", "CC BY-SA 4.0"), ("topic", "u"), ("content", "Other."),
                          ("embedding_model", "other-model")]:
        assert content_hash(**{**base, name: changed}) != value, name


# --- Ingest ---

def test_first_run_embeds_in_batches_and_inserts_every_chunk(tmp_path, table, embedder):
    root = make_rag(tmp_path, [(META, MANY_BODY)])
    assert run(root) == 0
    chunks = chunk_all(load_sources(root), MODEL)
    assert len(chunks) == 25
    assert [len(call["texts"]) for call in embedder.calls] == [20, 5]
    assert all(call["model"] == MODEL for call in embedder.calls)
    assert embedder.calls[0]["texts"][0] == rag.document_text(chunks[0].title, chunks[0].section, chunks[0].content)
    assert set(table.rows) == {chunk.content_hash for chunk in chunks}
    row = table.rows[chunks[0].content_hash]
    assert set(row) == {"source_key", "title", "section", "url", "licence", "topic", "content", "content_hash",
                        "embedding_model", "embedding"}
    assert (row["section"], row["content"], row["embedding_model"]) == ("Part 0", chunks[0].content, MODEL)
    values = row["embedding"].removeprefix("[").removesuffix("]").split(",")
    assert len(values) == 768 and {float(value) for value in values} == {0.25}
    assert len(table.by("POST")) == 2 and table.by("DELETE") == []
    assert gemini._DAILY_CALLS.take(1, "test") is None  # Embeddings never count against the daily cap.


def test_a_second_run_embeds_and_inserts_nothing(tmp_path, table, embedder, capsys):
    root = make_rag(tmp_path, [(META, MANY_BODY)])
    assert run(root) == 0
    calls, posts = len(embedder.calls), len(table.by("POST"))
    assert run(root) == 0
    assert len(embedder.calls) == calls and len(table.by("POST")) == posts and table.by("DELETE") == []
    assert "embedded=0 inserted=0 deleted=0" in capsys.readouterr().out


def test_a_changed_passage_replaces_only_its_row(tmp_path, table, embedder):
    root = make_rag(tmp_path, [(META, MANY_BODY), (OTHER, BODY)])
    assert run(root) == 0
    before = dict(table.rows)
    make_rag(tmp_path, [(META, MANY_BODY.replace("Part3 sentence 1", "Part3 sentence one")), (OTHER, BODY)])
    embedded = embedder.embedded()
    assert run(root) == 0
    assert embedder.embedded() == embedded + 1
    removed, added = set(before) - set(table.rows), set(table.rows) - set(before)
    assert len(removed) == len(added) == 1 and len(table.rows) == len(before)
    assert table.rows[added.pop()]["section"] == "Part 3"
    (delete,) = table.by("DELETE")
    assert delete.url.params["source_key"] == f"eq.{META.key}"
    assert delete.url.params["content_hash"] == f"in.({removed.pop()})"


def test_rows_of_a_removed_source_are_kept_unless_prune(tmp_path, table, embedder, capsys):
    root = make_rag(tmp_path, [(META, BODY), (OTHER, BODY)])
    assert run(root) == 0
    make_rag(tmp_path, [(META, BODY)])
    assert run(root) == 0
    assert OTHER.key in {row["source_key"] for row in table.rows.values()}
    assert f"(--prune deletes them): {OTHER.key}" in capsys.readouterr().out
    assert run(root, "--prune") == 0
    assert {row["source_key"] for row in table.rows.values()} == {META.key}
    (prune,) = [r for r in table.by("DELETE") if "content_hash" not in r.url.params]
    assert dict(prune.url.params) == {"source_key": f"eq.{OTHER.key}"}


def test_a_new_embedding_model_re_embeds_everything_and_drops_the_old_rows(tmp_path, table, embedder):
    root = make_rag(tmp_path, [(META, MANY_BODY)])
    assert run(root) == 0
    assert run(root, rag_embedding_model="other-model") == 0
    assert embedder.embedded() == 50
    assert len(table.rows) == 25 and {row["embedding_model"] for row in table.rows.values()} == {"other-model"}


@pytest.mark.parametrize("failure", ["short", "raise"], ids=["short-response", "exception"])
def test_an_embedding_failure_keeps_earlier_batches_and_deletes_nothing(tmp_path, table, embedder, capsys, failure):
    root = make_rag(tmp_path, [(META, MANY_BODY)])
    setattr(embedder, "short_on" if failure == "short" else "fail_on", 2)
    assert run(root) == 1
    assert len(table.rows) == 20 and len(table.by("POST")) == 1 and table.by("DELETE") == []
    err = capsys.readouterr().err
    assert "Embedding failed (" in err and "quoting the request" not in err
    embedder.short_on = embedder.fail_on = None
    assert run(root) == 0
    assert len(table.rows) == 25 and len(embedder.calls[-1]["texts"]) == 5


def test_an_insert_failure_stops_before_any_delete(tmp_path, table, embedder, capsys):
    root = make_rag(tmp_path, [(META, MANY_BODY)])
    table.fail["POST"] = 500
    assert run(root) == 1
    assert len(embedder.calls) == 1 and table.by("DELETE") == [] and table.rows == {}
    assert "Supabase step 'insert' failed." in capsys.readouterr().err


@pytest.mark.parametrize("body", [{"rows": []}, [{"source_key": "a", "content_hash": "not-a-hash"}], [{"source_key": 1}]],
                         ids=["not-a-list", "bad-hash", "bad-key"])
def test_an_unexpected_list_response_stops_before_embedding(tmp_path, table, embedder, body):
    table.list_body = body
    assert run(make_rag(tmp_path, [(META, BODY)])) == 1
    assert embedder.calls == []


def test_stored_rows_are_read_page_by_page(tmp_path, table, embedder, monkeypatch):
    root = make_rag(tmp_path, [(META, MANY_BODY)])
    assert run(root) == 0
    monkeypatch.setattr(ingest, "LIST_PAGE", 10)
    calls, gets = len(embedder.calls), len(table.by("GET"))
    assert run(root) == 0
    assert [r.url.params["offset"] for r in table.by("GET")[gets:]] == ["0", "10", "20"]
    assert len(embedder.calls) == calls


@pytest.mark.parametrize("overrides", [{"supabase_url": ""}, {"supabase_secret_key": ""}, {"gemini_api_key": ""}],
                         ids=["no-supabase-url", "no-supabase-key", "no-gemini-key"])
def test_a_real_run_needs_gemini_and_supabase(tmp_path, table, embedder, overrides):
    assert run(make_rag(tmp_path, [(META, BODY)]), **overrides) == 2
    assert table.requests == [] and embedder.calls == []


def test_output_carries_no_passage_text_or_secrets(tmp_path, table, embedder, capsys, caplog):
    root = make_rag(tmp_path, [(META, MANY_BODY)])
    table.fail["DELETE"] = 500
    assert run(root) == 0
    make_rag(tmp_path, [(META, BODY)])
    assert run(root) == 1  # The stale-row delete fails.
    captured = capsys.readouterr()
    ours = [record.getMessage() for record in caplog.records if record.name.startswith(("app.", "rag."))]
    assert "Logbook request failed op=rag_delete status=500" in ours
    text = captured.out + captured.err + " ".join(ours)
    for secret in ("invented", SECRET, KEY, SUPABASE_URL):
        assert secret not in text
    assert "Supabase step 'delete' failed." in captured.err
