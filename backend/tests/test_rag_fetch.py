"""The source fetch script (rag/fetch.py) against synthetic fixtures through httpx.MockTransport.

No network: an unexpected request fails the test, and any request to an OpenStax host fails it
at once. Every test works in its own tmp_path rag folder, never in the committed backend/rag
library. The fixtures in tests/fixtures/rag are invented text in each site's structure.
"""

from datetime import date
import json
import logging
from pathlib import Path

import httpx
import pytest

from rag import fetch
from rag.fetch import Signal, decide_licence, load_entries, render, signal_from_cc_url, wikipedia_blocks
from rag.sourcefile import (
    EVIDENCE_HAND, EVIDENCE_PAGE, SourceError, format_sources_md, is_blocked_host, parse_sources_md, read_source,
)

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "rag"
# An empty SOURCES.md for each test's own rag folder.
TEMPLATE = format_sources_md("# Test sources\n\nSynthetic table for the fetch tests.", {})
CONTACT = "student@example.org"
USER_AGENT = f"ScopePilotSourceFetcher/1.0 (educational microscopy project; {CONTACT})"
TODAY = date(2026, 10, 20)
WIKI_URL = "https://en.wikipedia.org/wiki/Plant_cell_wall"
LT_URL = "https://bio.libretexts.org/Bookshelves/Botany/Cell_Walls"
ROBOTS = "User-agent: *\nDisallow: /Special:\n"
WIKI_ENTRY = {"key": "plant-cell-wall", "url": WIKI_URL, "topic": "plant-cells", "licence": "CC BY-SA 4.0"}
LT_ENTRY = {"key": "libretexts-cell-walls", "url": LT_URL, "topic": "plant-cells", "licence": "CC BY 4.0",
            "author": "Jane Example"}
NO_SIGNAL_HTML = ('<html><head><title>Cell Walls - Biology LibreTexts</title></head><body>'
                  '<div class="mt-content-container"><p>Walls hold plant cells in this invented text.</p></div>'
                  '</body></html>')
WIKI_BODY = """A plant cell wall is a layer outside the cell membrane in this invented lead paragraph.

It gives the cell its shape.

## Structure

The wall is built from layers in this synthetic text.

### Layers

The middle lamella joins neighbouring cells.

## Function

The wall resists the pressure of water inside the cell.

### Deep

#### Deeper

A level four heading.

#### Deepest

A level five heading."""
LT_BODY = """Learning about walls in this invented introduction.

## Structure of the wall

The wall has three layers in this synthetic text.

An unclosed paragraph is closed by the next block.

- Middle lamella
- Primary wall

### Plasmodesmata

Channels link neighbouring cells. They pass through the wall & the membrane.

## Further structure

#### Detail

A fourth-level detail.

#### Fine detail

A fifth-level detail."""


def fixture(name):
    return (FIXTURES / name).read_text(encoding="utf-8")


def wiki_page(title="Plant cell wall", **changes):
    data = json.loads(fixture("wikipedia_page.json"))
    data["query"]["pages"][0].update({"title": title, **changes})
    return data


def html(text, status=200, content_type="text/html; charset=utf-8"):
    return lambda request: httpx.Response(status, text=text, headers={"content-type": content_type})


class Web:
    """The MockTransport target. Routes (host, path) to handlers taking the request; a route with
    several handlers serves them in turn and then repeats the last. Wikipedia's API answers from
    wiki_pages by title and siteinfo, after any handlers queued in api_queue."""

    def __init__(self):
        self.requests: list[httpx.Request] = []
        self.routes = {}
        self.wiki_pages = {"Plant cell wall": wiki_page()}
        self.siteinfo = json.loads(fixture("wikipedia_siteinfo.json"))
        self.api_queue = []
        self.route("https://bio.libretexts.org/robots.txt", html(ROBOTS, content_type="text/plain"))
        self.route(LT_URL, html(fixture("libretexts_page.html")))

    def route(self, url, *handlers):
        parsed = httpx.URL(url)
        self.routes[(parsed.host, parsed.path)] = list(handlers)

    def __call__(self, request):
        self.requests.append(request)
        assert not is_blocked_host(request.url.host), "OpenStax must never be requested"
        if (request.url.host, request.url.path) == ("en.wikipedia.org", "/w/api.php"):
            if self.api_queue:
                return self.api_queue.pop(0)(request)
            if request.url.params.get("meta") == "siteinfo":
                return httpx.Response(200, json=self.siteinfo)
            return httpx.Response(200, json=self.wiki_pages[request.url.params["titles"]])
        handlers = self.routes.get((request.url.host, request.url.path))
        assert handlers, f"unexpected request {request.url.host}{request.url.path}"
        return (handlers.pop(0) if len(handlers) > 1 else handlers[0])(request)

    def page_requests(self):
        return [r for r in self.requests if "titles" in r.url.params]

    def siteinfo_requests(self):
        return [r for r in self.requests if r.url.params.get("meta") == "siteinfo"]


@pytest.fixture
def web():
    return Web()


@pytest.fixture
def sleeps():
    return []


@pytest.fixture
def rag_dir(tmp_path):
    (tmp_path / "sources").mkdir()
    (tmp_path / "SOURCES.md").write_text(TEMPLATE, encoding="utf-8")
    return tmp_path


def write_entries(rag_dir, *entries, version=1):
    (rag_dir / "sources.json").write_text(json.dumps({"version": version, "sources": list(entries)}),
                                          encoding="utf-8")


def run(rag_dir, web, sleeps, *args, contact=CONTACT):
    return fetch.main(["--contact", contact, *args], rag_dir=rag_dir, transport=httpx.MockTransport(web),
                      sleep=sleeps.append, today=TODAY)


def source_text(rag_dir, key):
    return (rag_dir / "sources" / f"{key}.md").read_text(encoding="utf-8")


def rows(rag_dir):
    return parse_sources_md((rag_dir / "SOURCES.md").read_text(encoding="utf-8"))[1]


def assert_nothing_written(rag_dir):
    assert [path.name for path in (rag_dir / "sources").iterdir()] == []
    assert (rag_dir / "SOURCES.md").read_text(encoding="utf-8") == TEMPLATE


# --- Wikipedia ---

def test_wikipedia_article_is_written_as_markdown_from_the_api(rag_dir, web, sleeps):
    write_entries(rag_dir, WIKI_ENTRY)
    assert run(rag_dir, web, sleeps) == 0
    assert source_text(rag_dir, "plant-cell-wall") == (
        "---\ntitle: Plant cell wall\nurl: https://en.wikipedia.org/wiki/Plant_cell_wall\n"
        "author: Wikipedia contributors\nlicence: CC BY-SA 4.0\nretrieved: 2026-10-20\ntopic: plant-cells\n"
        f"---\n\n{WIKI_BODY}\n")
    # The written file passes the validation ingestion uses.
    meta, body = read_source(rag_dir / "sources" / "plant-cell-wall.md")
    assert (meta.key, body) == ("plant-cell-wall", WIKI_BODY)
    row = rows(rag_dir)["plant-cell-wall"]
    assert (row.evidence, row.retrieved, row.licence, row.url) == (EVIDENCE_PAGE, "2026-10-20", "CC BY-SA 4.0", WIKI_URL)
    assert not list((rag_dir / "sources").glob("*.tmp")) and not list(rag_dir.glob("*.tmp"))


def test_wikipedia_requests_use_the_api_with_the_user_agent(rag_dir, web, sleeps):
    write_entries(rag_dir, WIKI_ENTRY)
    run(rag_dir, web, sleeps)
    assert dict(web.page_requests()[0].url.params) == {
        "action": "query", "prop": "extracts|pageprops", "ppprop": "disambiguation", "explaintext": "1",
        "exsectionformat": "wiki", "redirects": "1", "titles": "Plant cell wall", "format": "json",
        "formatversion": "2", "maxlag": "5",
    }
    assert dict(web.siteinfo_requests()[0].url.params) == {
        "action": "query", "meta": "siteinfo", "siprop": "rightsinfo", "format": "json", "formatversion": "2",
        "maxlag": "5",
    }
    assert {(r.method, r.url.host, r.url.path) for r in web.requests} == {("GET", "en.wikipedia.org", "/w/api.php")}
    assert all(r.headers["user-agent"] == USER_AGENT for r in web.requests)


def test_requests_are_sequential_with_a_delay_and_siteinfo_is_asked_once(rag_dir, web, sleeps):
    web.wiki_pages["Cell membrane"] = wiki_page("Cell membrane")
    write_entries(rag_dir, WIKI_ENTRY, {**WIKI_ENTRY, "key": "cell-membrane",
                                        "url": "https://en.wikipedia.org/wiki/Cell_membrane"})
    assert run(rag_dir, web, sleeps) == 0
    assert len(web.requests) == 3 and len(web.siteinfo_requests()) == 1
    assert sleeps == [fetch.DELAY_SECONDS, fetch.DELAY_SECONDS]
    assert set(rows(rag_dir)) == {"plant-cell-wall", "cell-membrane"}


@pytest.mark.parametrize("page, reason", [
    ({"missing": True}, "page_missing"),
    ({"ns": 4}, "not_an_article"),
    ({"pageprops": {"disambiguation": ""}}, "disambiguation"),
    ({"extract": None}, "bad_api_response"),
], ids=["missing", "not-article", "disambiguation", "no-extract"])
def test_wikipedia_page_refusals(rag_dir, web, sleeps, caplog, page, reason):
    web.wiki_pages["Plant cell wall"] = wiki_page(**page)
    write_entries(rag_dir, WIKI_ENTRY)
    with caplog.at_level(logging.INFO, logger="rag.fetch"):
        assert run(rag_dir, web, sleeps) == 1
    assert f"Source refused key=plant-cell-wall reason={reason}" in caplog.messages
    assert_nothing_written(rag_dir)


@pytest.mark.parametrize("url, title, extra", [
    ("https://en.wikipedia.org/wiki/Cell_wall_(plant)", "Cell wall (plant)",
     {"redirects": [{"from": "Cell wall (plant)", "to": "Plant cell wall"}]}),
    ("https://en.wikipedia.org/wiki/plant_cell_wall", "plant cell wall",
     {"normalized": [{"from": "plant cell wall", "to": "Plant cell wall"}]}),
], ids=["redirected", "normalised"])
def test_wikipedia_redirect_or_normalised_title_is_refused_with_the_canonical_url(
        rag_dir, web, sleeps, capsys, url, title, extra):
    response = wiki_page()
    response["query"].update(extra)
    web.wiki_pages[title] = response
    write_entries(rag_dir, {**WIKI_ENTRY, "url": url})
    assert run(rag_dir, web, sleeps) == 1
    assert f"refused plant-cell-wall: redirected (use {WIKI_URL} in sources.json)" in capsys.readouterr().out
    assert_nothing_written(rag_dir)


@pytest.mark.parametrize("rights, licence, outcome", [
    ({"url": "https://creativecommons.org/licenses/by-sa/4.0/"}, "CC BY 4.0", "licence_mismatch"),
    ({"url": "https://creativecommons.org/licenses/by-sa/4.0/"}, "CC BY-SA 3.0", "licence_mismatch"),
    ({"url": "https://creativecommons.org/licenses/by-nc-sa/4.0/"}, "CC BY-SA 4.0", "licence_not_allowed"),
    ({"url": "https://www.gnu.org/copyleft/fdl.html"}, "CC BY-SA 4.0", "licence_not_allowed"),
    ({}, "CC BY-SA 4.0", EVIDENCE_HAND),
], ids=["type-mismatch", "version-mismatch", "nc", "not-cc", "no-signal"])
def test_wikipedia_licence_must_agree_with_the_confirmed_licence(rag_dir, web, sleeps, caplog, rights, licence, outcome):
    web.siteinfo = {"batchcomplete": True, "query": {"rightsinfo": rights}}
    write_entries(rag_dir, {**WIKI_ENTRY, "licence": licence})
    with caplog.at_level(logging.INFO, logger="rag.fetch"):
        code = run(rag_dir, web, sleeps)
    if outcome == EVIDENCE_HAND:
        assert code == 0 and rows(rag_dir)["plant-cell-wall"].evidence == EVIDENCE_HAND
    else:
        assert code == 1 and f"Source refused key=plant-cell-wall reason={outcome}" in caplog.messages
        assert_nothing_written(rag_dir)


def maxlag(retry_after="7"):
    return lambda request: httpx.Response(200, json={"error": {"code": "maxlag", "info": "Waiting"}},
                                          headers={"retry-after": retry_after})


def test_maxlag_is_retried_once_after_retry_after(rag_dir, web, sleeps):
    web.api_queue = [maxlag("7")]
    write_entries(rag_dir, WIKI_ENTRY)
    assert run(rag_dir, web, sleeps) == 0
    assert sleeps == [7.0, fetch.DELAY_SECONDS, fetch.DELAY_SECONDS]


def test_retry_after_is_capped(rag_dir, web, sleeps):
    web.api_queue = [lambda request: httpx.Response(429, headers={"retry-after": "3600"})]
    write_entries(rag_dir, WIKI_ENTRY)
    assert run(rag_dir, web, sleeps) == 0
    assert sleeps[0] == fetch.MAX_RETRY_SECONDS


def test_a_second_maxlag_refuses_the_page(rag_dir, web, sleeps, caplog):
    web.api_queue = [maxlag(), maxlag()]
    write_entries(rag_dir, WIKI_ENTRY)
    with caplog.at_level(logging.INFO, logger="rag.fetch"):
        assert run(rag_dir, web, sleeps) == 1
    assert "Source refused key=plant-cell-wall reason=rate_limited" in caplog.messages
    assert_nothing_written(rag_dir)


def test_wikipedia_server_error_is_refused(rag_dir, web, sleeps, caplog):
    web.api_queue = [lambda request: httpx.Response(500)]
    write_entries(rag_dir, WIKI_ENTRY)
    with caplog.at_level(logging.INFO, logger="rag.fetch"):
        assert run(rag_dir, web, sleeps) == 1
    assert "Source refused key=plant-cell-wall reason=http_500" in caplog.messages


# --- LibreTexts ---

def test_libretexts_article_is_written_from_the_content_region(rag_dir, web, sleeps):
    write_entries(rag_dir, LT_ENTRY)
    assert run(rag_dir, web, sleeps) == 0
    text = source_text(rag_dir, "libretexts-cell-walls")
    assert text == (
        "---\ntitle: 4.2: Cell Walls\nurl: https://bio.libretexts.org/Bookshelves/Botany/Cell_Walls\n"
        "author: Jane Example\nlicence: CC BY 4.0\nretrieved: 2026-10-20\ntopic: plant-cells\n"
        f"---\n\n{LT_BODY}\n")
    assert "must not appear" not in text and "shared under" not in text and "Empty heading" not in text
    assert rows(rag_dir)["libretexts-cell-walls"].evidence == EVIDENCE_PAGE
    assert [r.url.path for r in web.requests] == ["/robots.txt", "/Bookshelves/Botany/Cell_Walls"]
    assert all(r.headers["user-agent"] == USER_AGENT for r in web.requests)


def test_robots_txt_is_read_once_per_host(rag_dir, web, sleeps):
    second = "https://bio.libretexts.org/Bookshelves/Botany/Cell_Walls_II"
    web.route(second, html(fixture("libretexts_page.html")))
    write_entries(rag_dir, LT_ENTRY, {**LT_ENTRY, "key": "cell-walls-ii", "url": second})
    assert run(rag_dir, web, sleeps) == 0
    assert [r.url.path for r in web.requests] == [
        "/robots.txt", "/Bookshelves/Botany/Cell_Walls", "/Bookshelves/Botany/Cell_Walls_II"]
    assert sleeps == [fetch.DELAY_SECONDS, fetch.DELAY_SECONDS]


def test_libretexts_author_falls_back_to_the_authorname_tag(rag_dir, web, sleeps):
    write_entries(rag_dir, {key: value for key, value in LT_ENTRY.items() if key != "author"})
    assert run(rag_dir, web, sleeps) == 0
    assert "\nauthor: jexample\n" in source_text(rag_dir, "libretexts-cell-walls")


def test_libretexts_page_without_licence_signals_is_confirmed_by_hand(rag_dir, web, sleeps):
    web.route(LT_URL, html(NO_SIGNAL_HTML))
    write_entries(rag_dir, LT_ENTRY)
    assert run(rag_dir, web, sleeps) == 0
    text = source_text(rag_dir, "libretexts-cell-walls")
    assert "\ntitle: Cell Walls\n" in text and text.endswith("Walls hold plant cells in this invented text.\n")
    assert rows(rag_dir)["libretexts-cell-walls"].evidence == EVIDENCE_HAND


@pytest.mark.parametrize("old, new, reason", [
    ("license:ccby", "license:ccbyncsa", "licence_not_allowed"),
    ("license:ccby", "license:gnufdl", "licence_not_allowed"),
    ("a CC BY 4.0 license", "a CC BY-NC 4.0 license", "licence_not_allowed"),
    ("licenses/by/4.0", "licenses/by-sa/4.0", "licence_conflict"),
    ("licenseversion:40", "licenseversion:30", "licence_conflict"),
    ("authorname:jexample", "authorname:openstax", "openstax_not_allowed"),
    ("curated by Jane Example", "curated by OpenStax", "openstax_not_allowed"),
    ("Middle lamella", "Adapted from OpenStax Biology", "openstax_not_allowed"),
    ('class="mt-content-container"', 'class="other"', "no_content_region"),
], ids=["nc-tag", "unknown-tag", "nc-attribution", "type-conflict", "version-conflict", "openstax-tag",
        "openstax-attribution", "openstax-text", "no-content-region"])
def test_libretexts_page_refusals(rag_dir, web, sleeps, caplog, old, new, reason):
    page = fixture("libretexts_page.html")
    assert old in page
    web.route(LT_URL, html(page.replace(old, new)))
    write_entries(rag_dir, LT_ENTRY)
    with caplog.at_level(logging.INFO, logger="rag.fetch"):
        assert run(rag_dir, web, sleeps) == 1
    assert f"Source refused key=libretexts-cell-walls reason={reason}" in caplog.messages
    assert_nothing_written(rag_dir)


@pytest.mark.parametrize("licence", ["CC BY-SA 4.0", "CC BY 3.0"], ids=["type", "version"])
def test_libretexts_confirmed_licence_must_match_the_page(rag_dir, web, sleeps, caplog, licence):
    write_entries(rag_dir, {**LT_ENTRY, "licence": licence})
    with caplog.at_level(logging.INFO, logger="rag.fetch"):
        assert run(rag_dir, web, sleeps) == 1
    assert "Source refused key=libretexts-cell-walls reason=licence_mismatch" in caplog.messages


def test_libretexts_page_without_any_author_is_refused(rag_dir, web, sleeps, caplog):
    web.route(LT_URL, html(NO_SIGNAL_HTML))
    write_entries(rag_dir, {key: value for key, value in LT_ENTRY.items() if key != "author"})
    with caplog.at_level(logging.INFO, logger="rag.fetch"):
        assert run(rag_dir, web, sleeps) == 1
    assert "Source refused key=libretexts-cell-walls reason=author_missing" in caplog.messages


@pytest.mark.parametrize("robots, reason", [
    (html("User-agent: ScopePilotSourceFetcher\nDisallow: /Bookshelves/\n", content_type="text/plain"),
     "robots_disallowed"),
    (html("", status=500), "robots_unavailable"),
], ids=["disallowed", "server-error"])
def test_robots_txt_can_refuse(rag_dir, web, sleeps, caplog, robots, reason):
    web.route("https://bio.libretexts.org/robots.txt", robots)
    write_entries(rag_dir, LT_ENTRY)
    with caplog.at_level(logging.INFO, logger="rag.fetch"):
        assert run(rag_dir, web, sleeps) == 1
    assert f"Source refused key=libretexts-cell-walls reason={reason}" in caplog.messages
    assert [r.url.path for r in web.requests] == ["/robots.txt"]


def test_missing_robots_txt_allows_the_page(rag_dir, web, sleeps):
    web.route("https://bio.libretexts.org/robots.txt", html("", status=404))
    write_entries(rag_dir, LT_ENTRY)
    assert run(rag_dir, web, sleeps) == 0


def test_redirect_on_the_same_host_is_followed(rag_dir, web, sleeps):
    web.route(LT_URL, lambda request: httpx.Response(302, headers={"location": "/Bookshelves/Botany/Cell_Walls_v2"}))
    web.route("https://bio.libretexts.org/Bookshelves/Botany/Cell_Walls_v2", html(fixture("libretexts_page.html")))
    write_entries(rag_dir, LT_ENTRY)
    assert run(rag_dir, web, sleeps) == 0
    # The file keeps the entry's URL, which ingestion compares with sources.json.
    assert f"\nurl: {LT_URL}\n" in source_text(rag_dir, "libretexts-cell-walls")


@pytest.mark.parametrize("location, reason", [
    ("https://openstax.org/books/biology-2e/pages/4-1", "openstax_not_allowed"),
    ("https://www.cnx.org/content/m1", "openstax_not_allowed"),
    ("https://example.org/copy", "host_not_supported"),
    ("http://bio.libretexts.org/Bookshelves/Botany/Cell_Walls", "host_not_supported"),
    (LT_URL, "too_many_redirects"),
], ids=["openstax", "cnx", "other-host", "plain-http", "loop"])
def test_redirects_are_checked_before_they_are_followed(rag_dir, web, sleeps, caplog, location, reason):
    # The Web transport fails the test if an OpenStax host is ever requested.
    web.route(LT_URL, lambda request: httpx.Response(301, headers={"location": location}))
    write_entries(rag_dir, LT_ENTRY)
    with caplog.at_level(logging.INFO, logger="rag.fetch"):
        assert run(rag_dir, web, sleeps) == 1
    assert f"Source refused key=libretexts-cell-walls reason={reason}" in caplog.messages
    assert {r.url.host for r in web.requests} == {"bio.libretexts.org"}


def test_non_html_and_oversized_pages_are_refused(rag_dir, web, sleeps, caplog, monkeypatch):
    web.route(LT_URL, html("%PDF-1.4", content_type="application/pdf"))
    write_entries(rag_dir, LT_ENTRY)
    with caplog.at_level(logging.INFO, logger="rag.fetch"):
        assert run(rag_dir, web, sleeps) == 1
    assert "Source refused key=libretexts-cell-walls reason=not_html" in caplog.messages
    monkeypatch.setattr(fetch, "MAX_RESPONSE_BYTES", 100)
    web.route(LT_URL, html(fixture("libretexts_page.html")))
    with caplog.at_level(logging.INFO, logger="rag.fetch"):
        assert run(rag_dir, web, sleeps) == 1
    assert "Source refused key=libretexts-cell-walls reason=too_large" in caplog.messages


def test_transport_failure_is_refused(rag_dir, web, sleeps, caplog):
    def down(request):
        raise httpx.ConnectError("down", request=request)

    web.route(LT_URL, down)
    write_entries(rag_dir, LT_ENTRY)
    with caplog.at_level(logging.INFO, logger="rag.fetch"):
        assert run(rag_dir, web, sleeps) == 1
    assert "Source refused key=libretexts-cell-walls reason=transport" in caplog.messages


def test_logs_carry_keys_and_reasons_but_no_page_text(rag_dir, web, sleeps, caplog):
    write_entries(rag_dir, LT_ENTRY, WIKI_ENTRY)
    with caplog.at_level(logging.DEBUG):
        assert run(rag_dir, web, sleeps) == 0
    logged = " ".join(caplog.messages)
    assert "invented" not in logged and "Cell Walls" not in logged and CONTACT not in logged


# --- The run ---

def test_unsupported_host_is_refused_without_a_request_and_the_run_goes_on(rag_dir, web, sleeps, caplog):
    write_entries(rag_dir, {**WIKI_ENTRY, "key": "elsewhere", "url": "https://example.org/biology/cells"}, WIKI_ENTRY)
    with caplog.at_level(logging.INFO, logger="rag.fetch"):
        assert run(rag_dir, web, sleeps) == 1
    assert "Source refused key=elsewhere reason=host_not_supported" in caplog.messages
    assert not (rag_dir / "sources" / "elsewhere.md").exists()
    assert set(rows(rag_dir)) == {"plant-cell-wall"}
    assert all(r.url.host == "en.wikipedia.org" for r in web.requests)


def test_existing_file_is_kept_unless_refresh(rag_dir, web, sleeps):
    write_entries(rag_dir, WIKI_ENTRY)
    assert run(rag_dir, web, sleeps) == 0
    path = rag_dir / "sources" / "plant-cell-wall.md"
    path.write_text(path.read_text(encoding="utf-8").replace("It gives", "It still gives"), encoding="utf-8")
    edited, count = path.read_text(encoding="utf-8"), len(web.requests)
    assert run(rag_dir, web, sleeps) == 0
    assert path.read_text(encoding="utf-8") == edited and len(web.requests) == count
    assert run(rag_dir, web, sleeps, "--refresh") == 0
    assert "It gives" in path.read_text(encoding="utf-8") and len(web.requests) > count


def test_a_confirmed_by_hand_file_is_never_overwritten(rag_dir, web, sleeps):
    hand = ("---\ntitle: Plant cell wall\nurl: https://en.wikipedia.org/wiki/Plant_cell_wall\n"
            "author: Wikipedia contributors\nlicence: CC BY-SA 4.0\nretrieved: 2026-10-19\ntopic: plant-cells\n"
            "---\n\nWritten by hand in this invented test.\n")
    (rag_dir / "sources" / "plant-cell-wall.md").write_text(hand, encoding="utf-8")
    sources_md = (rag_dir / "SOURCES.md").read_text(encoding="utf-8") + (
        "| plant-cell-wall | Plant cell wall | Wikipedia contributors | https://en.wikipedia.org/wiki/Plant_cell_wall "
        "| CC BY-SA 4.0 | confirmed by hand | 2026-10-19 | Saved by hand. |\n")
    (rag_dir / "SOURCES.md").write_text(sources_md, encoding="utf-8")
    write_entries(rag_dir, WIKI_ENTRY)
    assert run(rag_dir, web, sleeps, "--refresh") == 0
    assert source_text(rag_dir, "plant-cell-wall") == hand
    assert (rag_dir / "SOURCES.md").read_text(encoding="utf-8") == sources_md
    assert web.requests == []


def test_rows_of_other_sources_are_kept(rag_dir, web, sleeps):
    other = ("| other-page | Other page | A. Author | https://example.org/other | CC BY 4.0 | confirmed by hand "
             "| 2026-10-01 | Saved by hand. |\n")
    (rag_dir / "SOURCES.md").write_text((rag_dir / "SOURCES.md").read_text(encoding="utf-8") + other, encoding="utf-8")
    write_entries(rag_dir, WIKI_ENTRY)
    assert run(rag_dir, web, sleeps) == 0
    assert set(rows(rag_dir)) == {"other-page", "plant-cell-wall"}
    assert other in (rag_dir / "SOURCES.md").read_text(encoding="utf-8")


def test_only_fetches_the_named_keys(rag_dir, web, sleeps):
    write_entries(rag_dir, WIKI_ENTRY, LT_ENTRY)
    assert run(rag_dir, web, sleeps, "--only", "libretexts-cell-walls") == 0
    assert set(rows(rag_dir)) == {"libretexts-cell-walls"}
    assert run(rag_dir, web, sleeps, "--only", "no-such-key") == 2


@pytest.mark.parametrize("contact", ["", "  ", "me@example.org\r\nX-Injected: 1", "x" * 201],
                         ids=["empty", "blank", "crlf", "too-long"])
def test_a_bad_contact_stops_before_any_request(rag_dir, web, sleeps, contact):
    write_entries(rag_dir, WIKI_ENTRY)
    assert run(rag_dir, web, sleeps, contact=contact) == 2
    assert web.requests == []


def test_main_quiets_the_httpx_request_lines(rag_dir, web, sleeps):
    httpx_logger = logging.getLogger("httpx")
    level = httpx_logger.level
    httpx_logger.setLevel(logging.NOTSET)
    try:
        write_entries(rag_dir, WIKI_ENTRY)
        run(rag_dir, web, sleeps)
        assert httpx_logger.level == logging.WARNING
    finally:
        httpx_logger.setLevel(level)


def test_contact_is_required():
    with pytest.raises(SystemExit):
        fetch.main([])


@pytest.mark.parametrize("entries, version", [
    ([{key: value for key, value in WIKI_ENTRY.items() if key != "licence"}], 1),
    ([{key: value for key, value in WIKI_ENTRY.items() if key != "key"}], 1),
    ([{**WIKI_ENTRY, "note": "extra"}], 1),
    ([WIKI_ENTRY, {**WIKI_ENTRY, "url": "https://en.wikipedia.org/wiki/Cell_membrane"}], 1),
    ([WIKI_ENTRY, {**WIKI_ENTRY, "key": "again"}], 1),
    ([{**WIKI_ENTRY, "licence": "CC BY-NC 4.0"}], 1),
    ([{**WIKI_ENTRY, "url": "https://openstax.org/books/biology-2e/pages/4-1"}], 1),
    ([{**WIKI_ENTRY, "topic": "Plant cells"}], 1),
    ([WIKI_ENTRY], 2),
], ids=["no-licence", "no-key", "extra-field", "duplicate-key", "duplicate-url", "nc-licence", "openstax-url",
        "bad-topic", "version-2"])
def test_an_invalid_sources_json_stops_before_any_request(rag_dir, web, sleeps, entries, version):
    write_entries(rag_dir, *entries, version=version)
    assert run(rag_dir, web, sleeps) == 2
    assert web.requests == []


# --- Units ---

@pytest.mark.parametrize("href, signal", [
    ("https://creativecommons.org/licenses/by/4.0/", Signal("CC BY", "4.0")),
    ("//creativecommons.org/licenses/by-sa/3.0/deed.en", Signal("CC BY-SA", "3.0")),
    ("https://www.creativecommons.org/licenses/by-nc-sa/4.0", Signal("CC BY-NC-SA", "4.0")),
    ("https://creativecommons.org/publicdomain/zero/1.0/", Signal("other:creativecommons.org/publicdomain/zero/1.0/", None)),
], ids=["cc-by", "protocol-relative", "www-nc-sa", "cc0"])
def test_signal_from_cc_url(href, signal):
    assert signal_from_cc_url(href) == signal


@pytest.mark.parametrize("signals, confirmed, result", [
    ([], "CC BY 4.0", ("CC BY 4.0", EVIDENCE_HAND)),
    ([Signal(None, "4.0")], "CC BY 4.0", ("CC BY 4.0", EVIDENCE_HAND)),
    ([Signal("CC BY", None), Signal(None, "4.0")], "CC BY 4.0", ("CC BY 4.0", EVIDENCE_PAGE)),
    ([Signal("CC BY-SA", "2.5")], "CC BY-SA 2.5", ("CC BY-SA 2.5", EVIDENCE_PAGE)),
    ([Signal("CC BY", None), Signal(None, "4.0")], "CC BY 3.0", "licence_mismatch"),
    ([Signal("CC BY", "4.0")], "CC BY-SA 4.0", "licence_mismatch"),
    ([Signal("CC BY", "4.0"), Signal("CC BY-SA", "4.0")], "CC BY 4.0", "licence_conflict"),
    ([Signal("CC BY", "4.0"), Signal("CC BY", "3.0")], "CC BY 4.0", "licence_conflict"),
    ([Signal("CC BY", "4.0"), Signal("CC BY-NC", "4.0")], "CC BY 4.0", "licence_not_allowed"),
], ids=["none", "version-only", "type-and-version", "by-sa-2.5", "version-mismatch", "type-mismatch",
        "type-conflict", "version-conflict", "nc"])
def test_decide_licence(signals, confirmed, result):
    if isinstance(result, tuple):
        assert decide_licence(signals, confirmed) == result
    else:
        with pytest.raises(fetch.FetchRefused) as refused:
            decide_licence(signals, confirmed)
        assert refused.value.reason == result


def test_render_keeps_paragraph_text_from_becoming_markdown_structure():
    assert render([("p", "#hashtag text"), ("p", "---"), ("li", "a"), ("li", "b"), ("p", "after")]) == (
        "\\#hashtag text\n\n\\---\n\n- a\n- b\n\nafter")


def test_wikipedia_blocks_stop_only_at_a_top_level_reference_section():
    blocks = wikipedia_blocks("Lead.\n== Uses ==\nText.\n=== Notes ===\nKept.\n== Notes ==\nDropped.")
    assert blocks == [("p", "Lead."), ("h", 2, "Uses"), ("p", "Text."), ("h", 3, "Notes"), ("p", "Kept.")]


def test_source_error_from_load_entries_names_the_file(tmp_path):
    with pytest.raises(SourceError):
        load_entries(tmp_path / "missing.json")
