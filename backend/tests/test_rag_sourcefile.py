"""The reference source file format and SOURCES.md rows (rag/sourcefile.py), and the committed templates."""

from dataclasses import replace
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import pytest

from rag.sourcefile import (
    EVIDENCE_HAND, EVIDENCE_PAGE, SourceError, SourceMeta, SourceRow, format_source, format_sources_md,
    is_blocked_host, parse_source, parse_sources_md, read_source,
)

RAG = Path(__file__).resolve().parents[1] / "rag"
META = SourceMeta(key="plant-cell", title="Plant cell", url="https://en.wikipedia.org/wiki/Plant_cell",
                  author="Wikipedia contributors", licence="CC BY-SA 4.0", retrieved=date(2026, 10, 20),
                  topic="plant-cells")
BODY = "Plant cells have walls in this invented text.\n\n## Cell wall\n\nThe wall lies outside the membrane."
TEXT = (
    "---\ntitle: Plant cell\nurl: https://en.wikipedia.org/wiki/Plant_cell\nauthor: Wikipedia contributors\n"
    "licence: CC BY-SA 4.0\nretrieved: 2026-10-20\ntopic: plant-cells\n---\n\n" + BODY + "\n"
)


def test_format_source_writes_the_front_matter_in_order():
    assert format_source(META, BODY) == TEXT


def test_parse_source_reads_back_what_format_source_wrote():
    assert parse_source(format_source(META, BODY), "plant-cell") == (META, BODY)


def test_hand_written_variants_parse_the_same():
    # A byte order mark, CRLF line ends and a quoted value, as an editor might save them.
    text = "﻿" + TEXT.replace("title: Plant cell", 'title: "Plant cell"').replace("\n", "\r\n")
    assert parse_source(text, "plant-cell") == (META, BODY)


def test_a_body_with_a_dash_line_keeps_it():
    body = "Intro text.\n\n---\n\nMore text."
    assert parse_source(format_source(META, body), "plant-cell")[1] == body


@pytest.mark.parametrize("old, new", [
    ("topic: plant-cells\n", ""),
    ("topic: plant-cells\n", "topic: plant-cells\nextra: value\n"),
    ("topic: plant-cells\n", "topic: plant-cells\ntopic: other\n"),
    ("title: Plant cell\n", "title: Plant cell\n\n"),
    ("title: Plant cell\n", "title:Plant cell\n"),
    ("title: Plant cell\n", "title: \n"),
    ("title: Plant cell\n", f"title: {'x' * 201}\n"),
    ("https://en.wikipedia.org/wiki/Plant_cell", "http://en.wikipedia.org/wiki/Plant_cell"),
    ("https://en.wikipedia.org/wiki/Plant_cell", "https://openstax.org/books/biology-2e/pages/4-1"),
    ("https://en.wikipedia.org/wiki/Plant_cell", "https://legacy.cnx.org/content/m1"),
    ("https://en.wikipedia.org/wiki/Plant_cell", "https://en.wikipedia.org/wiki/Plant_cell#Wall"),
    ("https://en.wikipedia.org/wiki/Plant_cell", "https://user@en.wikipedia.org/wiki/Plant_cell"),
    ("author: Wikipedia contributors", "author: OpenStax"),
    ("licence: CC BY-SA 4.0", "licence: CC BY-NC-SA 4.0"),
    ("licence: CC BY-SA 4.0", "licence: CC BY-ND 4.0"),
    ("licence: CC BY-SA 4.0", "licence: CC0 1.0"),
    ("licence: CC BY-SA 4.0", "licence: CC BY-SA 1.0"),
    ("licence: CC BY-SA 4.0", "licence: cc by-sa 4.0"),
    ("retrieved: 2026-10-20", "retrieved: 20 October 2026"),
    ("retrieved: 2026-10-20", "retrieved: 2026-02-30"),
    ("topic: plant-cells", "topic: Plant cells"),
    (BODY, "   "),
])
def test_parse_source_refuses_a_broken_rule(old, new):
    assert old in TEXT
    with pytest.raises(SourceError):
        parse_source(TEXT.replace(old, new), "plant-cell")


def test_parse_source_refuses_a_retrieved_date_in_the_future():
    tomorrow = (datetime.now(timezone.utc).date() + timedelta(days=1)).isoformat()
    with pytest.raises(SourceError):
        parse_source(TEXT.replace("2026-10-20", tomorrow), "plant-cell")


def test_parse_source_refuses_missing_or_unclosed_front_matter():
    with pytest.raises(SourceError):
        parse_source(TEXT.removeprefix("---\n"), "plant-cell")
    with pytest.raises(SourceError):
        parse_source(TEXT.replace("\n---\n", "\n", 1), "plant-cell")


@pytest.mark.parametrize("key", ["", "Plant-cell", "plant_cell", "-plant", "a" * 81, "plant cell"])
def test_parse_source_refuses_a_bad_key(key):
    with pytest.raises(SourceError):
        parse_source(TEXT, key)


def test_format_source_refuses_what_parse_source_would_refuse():
    for meta in (replace(META, licence="CC BY-NC 4.0"), replace(META, title='"Quoted"'),
                 replace(META, url="https://openstax.org/x")):
        with pytest.raises(SourceError):
            format_source(meta, BODY)
    with pytest.raises(SourceError):
        format_source(META, "  \n ")


def test_read_source_uses_the_file_name_as_key(tmp_path):
    path = tmp_path / "plant-cell.md"
    path.write_text(TEXT, encoding="utf-8")
    assert read_source(path) == (META, BODY)


@pytest.mark.parametrize("name, data", [
    ("Plant Cell.md", TEXT.encode()),
    ("plant-cell.txt", TEXT.encode()),
    ("plant-cell.md", TEXT.encode() + b"x" * (256 * 1024)),
    ("plant-cell.md", TEXT.encode().replace(b"invented", b"\xff\xfe")),
])
def test_read_source_refuses_and_names_the_file(tmp_path, name, data):
    path = tmp_path / name
    path.write_bytes(data)
    with pytest.raises(SourceError) as error:
        read_source(path)
    assert str(error.value).startswith(f"{name}: ")


@pytest.mark.parametrize("host, blocked", [
    ("openstax.org", True), ("www.openstax.org", True), ("OpenStax.org.", True), ("legacy.cnx.org", True),
    ("notopenstax.org", False), ("openstax.org.example.com", False), ("bio.libretexts.org", False),
])
def test_is_blocked_host(host, blocked):
    assert is_blocked_host(host) is blocked


def test_committed_sources_md_template_parses_and_is_canonical():
    text = (RAG / "SOURCES.md").read_text(encoding="utf-8")
    preamble, rows = parse_sources_md(text)
    assert preamble.startswith("# RAG reference sources")
    assert format_sources_md(preamble, rows) == text.replace("\r\n", "\n")


def test_sources_md_rows_round_trip_sorted_with_escaped_pipes():
    preamble = "# Sources"
    rows = {
        "zeta": SourceRow.from_meta(replace(META, key="zeta", title="A | B"), EVIDENCE_PAGE),
        "alpha": SourceRow.from_meta(replace(META, key="alpha"), EVIDENCE_HAND),
    }
    text = format_sources_md(preamble, rows)
    assert text.index("| alpha |") < text.index("| zeta |")
    assert "A \\| B" in text
    assert parse_sources_md(text) == (preamble, rows)


ROW = "| plant-cell | Plant cell | Wikipedia contributors | https://en.wikipedia.org/wiki/Plant_cell | CC BY-SA 4.0 | page and confirmed | 2026-10-20 | Converted. |"
TABLE = "# Sources\n\n| key | title | author | url | licence | licence evidence | retrieved | changes |\n|---|---|---|---|---|---|---|---|\n"


@pytest.mark.parametrize("text", [
    "# Sources\n\nNo table here.\n",
    TABLE.replace("|---|---|---|---|---|---|---|---|\n", ""),
    TABLE + ROW.replace("page and confirmed", "looked at it") + "\n",
    TABLE + ROW.replace("CC BY-SA 4.0", "CC BY-NC 4.0") + "\n",
    TABLE + ROW.replace(" Converted. |", "") + "\n",
    TABLE + ROW + "\n" + ROW + "\n",
    TABLE + ROW + "\n\nText after the table.\n",
])
def test_parse_sources_md_refuses_a_broken_table(text):
    with pytest.raises(SourceError):
        parse_sources_md(text)


def test_parse_sources_md_reads_a_row():
    _, rows = parse_sources_md(TABLE + ROW + "\n")
    assert rows == {"plant-cell": SourceRow("plant-cell", "Plant cell", "Wikipedia contributors",
                                            "https://en.wikipedia.org/wiki/Plant_cell", "CC BY-SA 4.0",
                                            EVIDENCE_PAGE, "2026-10-20", "Converted.")}
