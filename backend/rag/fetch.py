"""Fetch the pages listed in backend/rag/sources.json into backend/rag/sources/<key>.md.

Run from backend/:  python -m rag.fetch --contact <email or URL> [--only KEY ...] [--refresh]

Requests are sequential, DELAY_SECONDS apart, with a User-Agent that names the project and the
contact given on the command line (never stored). Wikipedia pages come as plain text from the
MediaWiki API; *.libretexts.org pages are parsed from their HTML, main article content only. No
other host is fetched, and openstax.org / cnx.org never are, redirects included. The licence
confirmed in sources.json must agree with every licence signal the page gives and be CC BY or
CC BY-SA; a page with no signal is accepted on the confirmation alone ("confirmed by hand").
The files are reviewed and committed by hand: ingestion reads only committed files, never the
network. Logs carry keys and reasons only, never page text.
"""

import argparse
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from html.parser import HTMLParser
import json
import logging
import os
from pathlib import Path
import re
import sys
import time
from typing import Literal
from urllib.parse import quote, unquote, urljoin, urlsplit
from urllib.robotparser import RobotFileParser

import httpx
from pydantic import BaseModel, ConfigDict, ValidationError, field_validator, model_validator

from rag.sourcefile import (
    CONTROL, EVIDENCE_HAND, EVIDENCE_PAGE, SourceError, SourceMeta, SourceRow, check_key, check_licence,
    check_text, check_topic, check_url, format_source, is_blocked_host, normalise, parse_sources_md,
    format_sources_md,
)

logger = logging.getLogger(__name__)

RAG_DIR = Path(__file__).resolve().parent
USER_AGENT_NAME = "ScopePilotSourceFetcher"
DELAY_SECONDS = 3.0
TIMEOUT_SECONDS = 20.0
MAX_RESPONSE_BYTES = 5 * 1024 * 1024
MAX_REDIRECTS = 3
DEFAULT_RETRY_SECONDS = 5.0
MAX_RETRY_SECONDS = 30.0
MAX_CONTACT_CHARS = 200
WIKIPEDIA_HOST = "en.wikipedia.org"
WIKIPEDIA_API = "https://en.wikipedia.org/w/api.php"
WIKIPEDIA_AUTHOR = "Wikipedia contributors"
LIBRETEXTS_SUFFIX = ".libretexts.org"
# Top-level Wikipedia sections where the article text ends.
STOP_SECTIONS = frozenset({
    "references", "see also", "notes", "external links", "further reading", "bibliography", "sources",
    "citations",
})
ALLOWED_KINDS = ("CC BY", "CC BY-SA")
# LibreTexts page tags (license:<code>) and the licences they name. Any other code is refused.
LIBRETEXTS_LICENCES = {
    "ccby": "CC BY", "ccbysa": "CC BY-SA", "ccbync": "CC BY-NC", "ccbyncsa": "CC BY-NC-SA",
    "ccbynd": "CC BY-ND", "ccbyncnd": "CC BY-NC-ND",
}
_TAG = re.compile(r"(?<![\w-])(license|licenseversion|authorname|program):([a-z0-9][a-z0-9-]*)", re.I)
# LibreTexts' attribution line: "This page titled ... is shared under a CC BY 4.0 license and was ..."
_ATTRIBUTION = re.compile(r"is shared under an? (CC BY(?:-[A-Z]{2})*) (\d\.\d) license[^.]*", re.I)
_WIKI_HEADING = re.compile(r"(={2,6})\s*(.*?)\s*\1")
_CHARSET = re.compile(r"charset=\"?([\w-]+)", re.I)


class FetchRefused(Exception):
    """A page that is not written. reason is a short slug; detail is a canonical URL to use instead."""

    def __init__(self, reason: str, detail: str | None = None) -> None:
        super().__init__(reason)
        self.reason = reason
        self.detail = detail


class SourceEntry(BaseModel):
    """One curated page in sources.json. licence is the licence confirmed by hand on the page."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    key: str
    url: str
    topic: str
    licence: str
    author: str | None = None

    @field_validator("key")
    @classmethod
    def valid_key(cls, value: str) -> str:
        return check_key(value)

    @field_validator("url")
    @classmethod
    def valid_url(cls, value: str) -> str:
        return check_url(value)

    @field_validator("topic")
    @classmethod
    def valid_topic(cls, value: str) -> str:
        return check_topic(value)

    @field_validator("licence")
    @classmethod
    def valid_licence(cls, value: str) -> str:
        return check_licence(value)

    @field_validator("author")
    @classmethod
    def valid_author(cls, value: str | None) -> str | None:
        return None if value is None else check_text("author", value)


class SourceList(BaseModel):
    model_config = ConfigDict(extra="forbid")

    version: Literal[1]
    sources: list[SourceEntry]

    @model_validator(mode="after")
    def unique_entries(self) -> "SourceList":
        for name in ("key", "url"):
            values = [getattr(entry, name) for entry in self.sources]
            if len(values) != len(set(values)):
                raise ValueError(f"Two entries share a {name}.")
        return self


def load_entries(path: Path) -> list[SourceEntry]:
    try:
        return SourceList.model_validate_json(path.read_text(encoding="utf-8")).sources
    except OSError:
        raise SourceError("sources.json cannot be read.") from None
    except ValidationError as exc:
        raise SourceError(f"sources.json is invalid: {exc}") from None


@dataclass(frozen=True)
class Signal:
    """A licence a page states. kind None: a version alone, which says nothing about the licence type."""

    kind: str | None
    version: str | None


def signal_from_cc_url(href: str) -> Signal:
    """The licence a creativecommons.org licence URL names; any other URL is an unknown licence."""
    parts = urlsplit(href.strip())
    host = (parts.hostname or "").lower().removeprefix("www.")
    segments = [segment for segment in parts.path.lower().split("/") if segment]
    if host == "creativecommons.org" and len(segments) >= 3 and segments[0] == "licenses":
        version = segments[2] if re.fullmatch(r"\d\.\d", segments[2]) else None
        return Signal(f"CC {segments[1].upper()}", version)
    return Signal(f"other:{host}{parts.path}"[:80], None)


def decide_licence(signals: list[Signal], confirmed: str) -> tuple[str, str]:
    """(licence, evidence) for a page, or FetchRefused.

    Every signal must be CC BY or CC BY-SA and agree with the others and with the confirmed
    licence. A page with no licence type signal is accepted on the confirmation alone.
    """
    kinds = {signal.kind for signal in signals if signal.kind}
    if not kinds:
        return confirmed, EVIDENCE_HAND
    if any(kind not in ALLOWED_KINDS for kind in kinds):
        raise FetchRefused("licence_not_allowed")
    versions = {signal.version for signal in signals if signal.version}
    if len(kinds) > 1 or len(versions) > 1:
        raise FetchRefused("licence_conflict")
    kind, _, version = confirmed.rpartition(" ")
    if kinds != {kind} or (versions and versions != {version}):
        raise FetchRefused("licence_mismatch")
    return confirmed, EVIDENCE_PAGE


def user_agent(contact: str) -> str:
    if not isinstance(contact, str) or not contact.strip() or len(contact) > MAX_CONTACT_CHARS \
            or CONTROL.search(contact):
        raise SourceError(f"--contact must be 1-{MAX_CONTACT_CHARS} characters on one line.")
    return f"{USER_AGENT_NAME}/1.0 (educational microscopy project; {contact.strip()})"


def check_fetch_host(url: str) -> None:
    """Only Wikipedia (English) and LibreTexts are fetched, over https; OpenStax never is."""
    parts = urlsplit(url)
    host = (parts.hostname or "").lower()
    if is_blocked_host(host):
        raise FetchRefused("openstax_not_allowed")
    if parts.scheme != "https" or not (host == WIKIPEDIA_HOST or host.endswith(LIBRETEXTS_SUFFIX)):
        raise FetchRefused("host_not_supported")


def clean_line(text: str) -> str:
    return re.sub(r"\s+", " ", CONTROL.sub(" ", text)).strip()


@dataclass(frozen=True)
class Response:
    status: int
    headers: httpx.Headers
    content: bytes


def _charset(response: Response) -> str:
    match = _CHARSET.search(response.headers.get("content-type", ""))
    if match:
        try:
            "".encode(match.group(1))
            return match.group(1)
        except LookupError:
            pass
    return "utf-8"


def _json(response: Response) -> object:
    if not response.headers.get("content-type", "").lower().startswith("application/json"):
        return None
    try:
        return json.loads(response.content.decode(_charset(response), errors="replace"))
    except ValueError:
        return None


class Fetcher:
    """Sequential GET requests with the delay, the User-Agent, manual redirects and a size cap."""

    def __init__(self, client: httpx.Client, *, contact: str, sleep: Callable[[float], None] = time.sleep) -> None:
        self.client = client
        self.sleep = sleep
        self.user_agent = user_agent(contact)
        self._requested = False
        self._robots: dict[str, RobotFileParser | None] = {}
        self._wikipedia_licence: list[Signal] | None = None

    def get(self, url: str, params: dict[str, str] | None = None) -> Response:
        """One page, following up to MAX_REDIRECTS redirects; every hop's host is checked first."""
        for _ in range(MAX_REDIRECTS + 1):
            check_fetch_host(url)
            if self._requested:
                self.sleep(DELAY_SECONDS)
            self._requested = True
            try:
                with self.client.stream("GET", url, params=params,
                                        headers={"User-Agent": self.user_agent}) as response:
                    if response.status_code in (301, 302, 303, 307, 308):
                        location = response.headers.get("location")
                        if not location:
                            raise FetchRefused("bad_redirect")
                        url, params = urljoin(str(response.url), location), None
                        continue
                    declared = response.headers.get("content-length", "")
                    if declared.isdigit() and int(declared) > MAX_RESPONSE_BYTES:
                        raise FetchRefused("too_large")
                    content = bytearray()
                    for chunk in response.iter_bytes():
                        content.extend(chunk)
                        if len(content) > MAX_RESPONSE_BYTES:
                            raise FetchRefused("too_large")
                    return Response(response.status_code, response.headers, bytes(content))
            except httpx.HTTPError:
                raise FetchRefused("transport") from None
        raise FetchRefused("too_many_redirects")

    def _retry_delay(self, response: Response) -> float:
        value = response.headers.get("retry-after", "").strip()
        seconds = float(value) if re.fullmatch(r"\d+(\.\d+)?", value) else DEFAULT_RETRY_SECONDS
        return min(seconds, MAX_RETRY_SECONDS)

    def wikipedia_api(self, params: dict[str, str]) -> dict:
        """A MediaWiki API query with maxlag; a lag error or 429/503 is retried once after Retry-After."""
        query = {**params, "format": "json", "formatversion": "2", "maxlag": "5"}
        for attempt in (1, 2):
            response = self.get(WIKIPEDIA_API, query)
            data = _json(response) if response.status == 200 else None
            lagged = isinstance(data, dict) and isinstance(data.get("error"), dict) \
                and data["error"].get("code") == "maxlag"
            if response.status in (429, 503) or lagged:
                if attempt == 1:
                    self.sleep(self._retry_delay(response))
                    continue
                raise FetchRefused("rate_limited")
            if response.status != 200:
                raise FetchRefused(f"http_{response.status}")
            if not isinstance(data, dict) or "error" in data:
                raise FetchRefused("bad_api_response")
            return data
        raise AssertionError("unreachable")

    def wikipedia_licence(self) -> list[Signal]:
        """The wiki's content licence (siteinfo rightsinfo), asked once per run."""
        if self._wikipedia_licence is None:
            data = self.wikipedia_api({"action": "query", "meta": "siteinfo", "siprop": "rightsinfo"})
            query = data.get("query")
            info = query.get("rightsinfo") if isinstance(query, dict) else None
            url = info.get("url") if isinstance(info, dict) else None
            self._wikipedia_licence = [signal_from_cc_url(url)] if isinstance(url, str) and url else []
        return self._wikipedia_licence

    def check_robots(self, url: str) -> None:
        """robots.txt for url's origin, read once; 404/410 allows all, any other failure refuses."""
        parts = urlsplit(url)
        origin = f"{parts.scheme}://{parts.netloc}"
        if origin not in self._robots:
            response = self.get(f"{origin}/robots.txt")
            parser: RobotFileParser | None = RobotFileParser()
            if response.status == 200:
                parser.parse(response.content.decode(_charset(response), errors="replace").splitlines())
            elif response.status in (404, 410):
                parser.parse([])
            else:
                parser = None
            self._robots[origin] = parser
        parser = self._robots[origin]
        if parser is None:
            raise FetchRefused("robots_unavailable")
        if not parser.can_fetch(USER_AGENT_NAME, url):
            raise FetchRefused("robots_disallowed")


Block = tuple  # ("h", level, text), ("p", text) or ("li", text)


def drop_empty_sections(blocks: list[Block]) -> list[Block]:
    """Without headings that have no text before the next heading of the same or a higher level."""
    def has_content(index: int) -> bool:
        level = blocks[index][1]
        for block in blocks[index + 1:]:
            if block[0] != "h":
                return True
            if block[1] <= level:
                return False
        return False

    return [block for index, block in enumerate(blocks) if block[0] != "h" or has_content(index)]


def render(blocks: list[Block]) -> str:
    """Markdown: "## "-"#### " headings, paragraphs, and "- " list items on consecutive lines."""
    parts: list[str] = []
    previous = None
    for block in drop_empty_sections(blocks):
        if block[0] == "h":
            text = f"{'#' * block[1]} {block[2]}"
        elif block[0] == "li":
            text = f"- {block[1]}"
        else:
            text = block[1]
            if text.startswith("#") or text == "---":
                text = f"\\{text}"  # Not a heading, and not a front matter line.
        separator = "\n" if previous == "li" and block[0] == "li" else "\n\n"
        parts.append(f"{separator}{text}" if parts else text)
        previous = block[0]
    return "".join(parts)


def wikipedia_title(url: str) -> str:
    parts = urlsplit(url)
    if parts.hostname != WIKIPEDIA_HOST or not parts.path.startswith("/wiki/") or parts.query:
        raise FetchRefused("bad_wikipedia_url")
    title = unquote(parts.path.removeprefix("/wiki/")).replace("_", " ").strip()
    if not title:
        raise FetchRefused("bad_wikipedia_url")
    return title


def wikipedia_url(title: str) -> str:
    return f"https://{WIKIPEDIA_HOST}/wiki/" + quote(title.replace(" ", "_"), safe="()_,'!:-.~*/")


def wikipedia_blocks(extract: str) -> list[Block]:
    """Blocks from a plain-text extract (exsectionformat=wiki): "== H ==" is ##, "=== H ===" ###,
    deeper ####. Each non-empty line is a paragraph. The text ends at the first top-level
    reference section (STOP_SECTIONS)."""
    blocks: list[Block] = []
    for raw in normalise(extract).split("\n"):
        line = clean_line(raw)
        if not line:
            continue
        match = _WIKI_HEADING.fullmatch(line)
        if match:
            level, name = len(match.group(1)), clean_line(match.group(2))
            if level == 2 and name.lower() in STOP_SECTIONS:
                break
            if name:
                blocks.append(("h", min(level, 4), name))
            continue
        blocks.append(("p", line))
    return blocks


def fetch_wikipedia(fetcher: Fetcher, entry: SourceEntry) -> tuple[str, str, str, list[Signal]]:
    """(title, author, Markdown body, licence signals) of an English Wikipedia article.

    Refuses a missing page, a non-article, a disambiguation page, and a title the API normalised
    or redirected: its detail is the canonical URL to put in sources.json, because the file's URL
    must be the entry's.
    """
    title = wikipedia_title(entry.url)
    signals = fetcher.wikipedia_licence()
    data = fetcher.wikipedia_api({
        "action": "query", "prop": "extracts|pageprops", "ppprop": "disambiguation", "explaintext": "1",
        "exsectionformat": "wiki", "redirects": "1", "titles": title,
    })
    query = data.get("query")
    pages = query.get("pages") if isinstance(query, dict) else None
    if not isinstance(pages, list) or len(pages) != 1 or not isinstance(pages[0], dict):
        raise FetchRefused("bad_api_response")
    page = pages[0]
    if page.get("missing") or page.get("invalid"):
        raise FetchRefused("page_missing")
    found = page.get("title")
    if query.get("redirects") or query.get("normalized") or found != title:
        raise FetchRefused("redirected", wikipedia_url(found) if isinstance(found, str) and found else None)
    if page.get("ns") != 0:
        raise FetchRefused("not_an_article")
    if isinstance(page.get("pageprops"), dict) and "disambiguation" in page["pageprops"]:
        raise FetchRefused("disambiguation")
    extract = page.get("extract")
    if not isinstance(extract, str):
        raise FetchRefused("bad_api_response")
    return title, WIKIPEDIA_AUTHOR, render(wikipedia_blocks(extract)), signals


_VOID = frozenset("area base br col embed hr img input link meta param source track wbr".split())
# Never article text: dropped with everything inside them.
_SKIP_TAGS = frozenset(
    "h1 script style noscript template table figure figcaption img svg math nav aside footer header form "
    "button iframe video audio object select textarea".split())
_SKIP_CLASSES = frozenset({"noprint", "mt-guide-content", "mw-editsection", "navbox", "infobox", "hatnote", "toc"})
_TEXT_SKIP_TAGS = frozenset({"script", "style", "noscript", "template"})
_BLOCK_KIND = {
    "p": ("p",), "li": ("li",), "dt": ("p",), "dd": ("p",), "blockquote": ("p",), "pre": ("p",),
    "h2": ("h", 2), "h3": ("h", 3), "h4": ("h", 4), "h5": ("h", 4), "h6": ("h", 4),
}
# Tags whose start ends an open <p>, as HTML parsing does.
_CLOSES_P = frozenset(
    "p div ul ol li dl dt dd h1 h2 h3 h4 h5 h6 table figure section article blockquote pre header footer "
    "nav aside form".split())


class _LibreTextsParser(HTMLParser):
    """Blocks from the first element with class "mt-content-container", plus the page title,
    rel="license" links and the page's text (for the attribution line)."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.stack: list[str] = []
        self.region_depth: int | None = None
        self.region_seen = False
        self.skip_depth: int | None = None
        self.text_skip_depth: int | None = None
        self.h1_depth: int | None = None
        self.title_depth: int | None = None
        self.kind: tuple | None = None
        self.buffer: list[str] = []
        self.blocks: list[Block] = []
        self.h1: list[str] = []
        self.title: list[str] = []
        self.text: list[str] = []
        self.licence_links: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = {name: value or "" for name, value in attrs}
        if tag in ("a", "link") and "license" in attributes.get("rel", "").lower().split() \
                and attributes.get("href"):
            self.licence_links.append(attributes["href"])
        if self.stack and self.stack[-1] == "p" and tag in _CLOSES_P:
            self._pop()
        if tag == "li" and self.stack and self.stack[-1] == "li":
            self._pop()
        if tag in _VOID:
            if tag == "br":
                self.handle_data(" ")
            return
        self.stack.append(tag)
        depth = len(self.stack)
        classes = set(attributes.get("class", "").split())
        if tag in _TEXT_SKIP_TAGS and self.text_skip_depth is None:
            self.text_skip_depth = depth
        if tag == "h1" and not self.h1 and self.h1_depth is None:
            self.h1_depth = depth
        if tag == "title" and self.title_depth is None:
            self.title_depth = depth
        if self.region_depth is None:
            if not self.region_seen and "mt-content-container" in classes:
                self.region_depth, self.region_seen = depth, True
            return
        if self.skip_depth is not None:
            return
        if tag in _SKIP_TAGS or classes & _SKIP_CLASSES:
            if tag == "math" and attributes.get("alttext"):
                self.buffer.append(f" {attributes['alttext']} ")
            self.skip_depth = depth
            return
        kind = _BLOCK_KIND.get(tag)
        if kind:
            self._flush()
            self.kind = kind

    def handle_endtag(self, tag: str) -> None:
        if tag in _VOID or tag not in self.stack:
            return
        while self.stack:
            if self._pop() == tag:
                break

    def handle_data(self, data: str) -> None:
        if self.text_skip_depth is None:
            self.text.append(data)
        if self.h1_depth is not None:
            self.h1.append(data)
        if self.title_depth is not None:
            self.title.append(data)
        if self.region_depth is not None and self.skip_depth is None:
            self.buffer.append(data)

    def close(self) -> None:
        super().close()
        while self.stack:
            self._pop()
        self._flush()

    def _pop(self) -> str:
        depth = len(self.stack)
        tag = self.stack.pop()
        if self.text_skip_depth == depth:
            self.text_skip_depth = None
        if self.h1_depth == depth:
            self.h1_depth = None
        if self.title_depth == depth:
            self.title_depth = None
        if self.skip_depth == depth:
            self.skip_depth = None
        elif self.region_depth == depth:
            self._flush()
            self.region_depth = None
        elif self.region_depth is not None and self.skip_depth is None and tag in _BLOCK_KIND:
            self._flush()
        return tag

    def _flush(self) -> None:
        text = clean_line("".join(self.buffer))
        kind = self.kind or ("p",)
        self.buffer, self.kind = [], None
        if text:
            self.blocks.append((*kind, text))


@dataclass(frozen=True)
class LibreTextsPage:
    title: str
    author: str | None
    body: str
    signals: list[Signal]


def parse_libretexts(html: str) -> LibreTextsPage:
    """The article in a LibreTexts page and its licence signals: rel="license" links, license: and
    licenseversion: page tags, and the attribution line. Refuses OpenStax material: any page tag,
    attribution line or article text that names OpenStax."""
    parser = _LibreTextsParser()
    parser.feed(html)
    parser.close()
    if not parser.region_seen:
        raise FetchRefused("no_content_region")
    tags = [(match.group(1).lower(), match.group(2).lower()) for match in _TAG.finditer(html)]
    attributions = list(_ATTRIBUTION.finditer(clean_line("".join(parser.text))))
    article = " ".join(block[-1] for block in parser.blocks)
    if any("openstax" in value for _, value in tags) or "openstax" in article.lower() \
            or any("openstax" in match.group(0).lower() for match in attributions):
        raise FetchRefused("openstax_not_allowed")
    signals = [signal_from_cc_url(href) for href in parser.licence_links]
    signals += [Signal(LIBRETEXTS_LICENCES.get(value, f"other:{value}"), None) for name, value in tags
                if name == "license"]
    signals += [Signal(None, f"{value[0]}.{value[1:]}") for name, value in tags
                if name == "licenseversion" and re.fullmatch(r"\d{2}", value)]
    signals += [Signal(match.group(1).upper(), match.group(2)) for match in attributions]
    title = clean_line("".join(parser.h1)) or clean_line("".join(parser.title)).split(" - ")[0].strip()
    if not title:
        raise FetchRefused("no_title")
    authors = [value for name, value in tags if name == "authorname"]
    # The attribution line is metadata, not article text.
    blocks = [block for block in parser.blocks if not _ATTRIBUTION.search(block[-1])]
    return LibreTextsPage(title, authors[0] if authors else None, render(blocks), signals)


def fetch_libretexts(fetcher: Fetcher, entry: SourceEntry) -> tuple[str, str, str, list[Signal]]:
    fetcher.check_robots(entry.url)
    response = fetcher.get(entry.url)
    if response.status != 200:
        raise FetchRefused(f"http_{response.status}")
    if not response.headers.get("content-type", "").lower().startswith("text/html"):
        raise FetchRefused("not_html")
    page = parse_libretexts(response.content.decode(_charset(response), errors="replace"))
    author = entry.author or page.author
    if not author:
        raise FetchRefused("author_missing")
    return page.title, author, page.body, page.signals


def fetch_one(fetcher: Fetcher, entry: SourceEntry, today: date) -> tuple[SourceMeta, str, str]:
    """(metadata, file text, licence evidence) for one entry, or FetchRefused."""
    check_fetch_host(entry.url)
    host = (urlsplit(entry.url).hostname or "").lower()
    fetch = fetch_wikipedia if host == WIKIPEDIA_HOST else fetch_libretexts
    title, author, body, signals = fetch(fetcher, entry)
    licence, evidence = decide_licence(signals, entry.licence)
    title, author = clean_line(title), clean_line(entry.author or author)
    if "openstax" in f"{title} {author}".lower():
        raise FetchRefused("openstax_not_allowed")
    if not body.strip():
        raise FetchRefused("no_content")
    meta = SourceMeta(key=entry.key, title=title, url=entry.url, author=author, licence=licence,
                      retrieved=today, topic=entry.topic)
    try:
        return meta, format_source(meta, body), evidence
    except SourceError:
        raise FetchRefused("invalid_output") from None


def _write_atomic(path: Path, text: str) -> None:
    temporary = path.with_name(f"{path.name}.tmp")
    try:
        with open(temporary, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(text)
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


@dataclass
class FetchReport:
    written: list[str] = field(default_factory=list)
    skipped: list[tuple[str, str]] = field(default_factory=list)
    refused: list[tuple[str, str, str | None]] = field(default_factory=list)


def fetch_all(entries: list[SourceEntry], *, sources_dir: Path, sources_md: Path, fetcher: Fetcher,
              refresh: bool = False, only: list[str] | None = None, today: date | None = None) -> FetchReport:
    """Fetch each entry into sources_dir/<key>.md and update its SOURCES.md row.

    An existing file is skipped unless refresh is set; a file whose row says "confirmed by hand"
    is never overwritten. A refused page writes nothing and the run goes on with the next entry.
    SOURCES.md is rewritten after each written file, keeping every other row as it is.
    """
    today = today or datetime.now(timezone.utc).date()
    preamble, rows = parse_sources_md(sources_md.read_text(encoding="utf-8"))
    selected = entries
    if only:
        unknown = sorted(set(only) - {entry.key for entry in entries})
        if unknown:
            raise SourceError(f"Unknown key in --only: {', '.join(unknown)}.")
        selected = [entry for entry in entries if entry.key in only]
    sources_dir.mkdir(parents=True, exist_ok=True)
    report = FetchReport()
    for entry in selected:
        path = sources_dir / f"{entry.key}.md"
        row = rows.get(entry.key)
        if path.exists() and row is not None and row.evidence == EVIDENCE_HAND:
            reason = "confirmed_by_hand"
        elif path.exists() and not refresh:
            reason = "exists"
        else:
            reason = None
        if reason:
            logger.info("Source skipped key=%s reason=%s", entry.key, reason)
            report.skipped.append((entry.key, reason))
            continue
        try:
            meta, text, evidence = fetch_one(fetcher, entry, today)
        except FetchRefused as exc:
            logger.warning("Source refused key=%s reason=%s", entry.key, exc.reason)
            report.refused.append((entry.key, exc.reason, exc.detail))
            continue
        _write_atomic(path, text)
        rows[entry.key] = SourceRow.from_meta(meta, evidence)
        _write_atomic(sources_md, format_sources_md(preamble, rows))
        logger.info("Source written key=%s evidence=%s", entry.key, evidence.replace(" ", "_"))
        report.written.append(entry.key)
    return report


def main(argv: list[str] | None = None, *, rag_dir: Path = RAG_DIR, transport: httpx.BaseTransport | None = None,
         sleep: Callable[[float], None] = time.sleep, today: date | None = None) -> int:
    """0 if every selected page was written or skipped, 1 if any was refused, 2 on a setup error."""
    parser = argparse.ArgumentParser(prog="python -m rag.fetch", description="Fetch the pages in rag/sources.json.")
    parser.add_argument("--contact", required=True,
                        help="Email or URL for the User-Agent, so site operators can reach you. Never stored.")
    parser.add_argument("--only", action="append", metavar="KEY", help="Fetch only this key (repeatable).")
    parser.add_argument("--refresh", action="store_true",
                        help="Fetch again when the file exists (never a 'confirmed by hand' file).")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    try:
        entries = load_entries(rag_dir / "sources.json")
        with httpx.Client(timeout=TIMEOUT_SECONDS, follow_redirects=False, transport=transport) as client:
            fetcher = Fetcher(client, contact=args.contact, sleep=sleep)
            report = fetch_all(entries, sources_dir=rag_dir / "sources", sources_md=rag_dir / "SOURCES.md",
                               fetcher=fetcher, refresh=args.refresh, only=args.only, today=today)
    except SourceError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 2
    print(f"written={len(report.written)} skipped={len(report.skipped)} refused={len(report.refused)}")
    for key, reason, detail in report.refused:
        print(f"refused {key}: {reason}" + (f" (use {detail} in sources.json)" if detail else ""))
    return 1 if report.refused else 0


if __name__ == "__main__":
    sys.exit(main())
