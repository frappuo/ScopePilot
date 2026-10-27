"""Reference source files (backend/rag/sources/<key>.md) and their rows in backend/rag/SOURCES.md.

Shared by the fetch script (rag/fetch.py) and ingestion, so the format is defined once. A file
starts with front matter between "---" lines holding exactly title, url, author, licence,
retrieved and topic, one "name: value" line each, then the Markdown body. A file may be fetched
or written by hand: only the file is validated, never how it was made. Error messages name the
rule that failed, never page text. Passages explain biology in general; they are never evidence
about what a student's image shows.
"""

from dataclasses import astuple, dataclass
from datetime import date, datetime, timezone
from pathlib import Path
import re
from urllib.parse import urlsplit

FIELDS = ("title", "url", "author", "licence", "retrieved", "topic")
KEY_PATTERN = re.compile(r"[a-z0-9][a-z0-9-]{0,79}")
TOPIC_PATTERN = re.compile(r"[a-z0-9][a-z0-9-]{0,39}")
# The rag_chunks.licence check in supabase/migrations/0003_rag.sql.
LICENCE_PATTERN = re.compile(r"CC BY(-SA)? (2\.0|2\.5|3\.0|4\.0)")
BLOCKED_HOSTS = ("openstax.org", "cnx.org")
MAX_TEXT_CHARS = 200  # title, author
MAX_URL_CHARS = 2000
MAX_CHANGES_CHARS = 300
MAX_FILE_BYTES = 256 * 1024
CONTROL = re.compile(r"[\x00-\x1f\x7f]")
EVIDENCE_PAGE = "page and confirmed"
EVIDENCE_HAND = "confirmed by hand"
EVIDENCE = (EVIDENCE_PAGE, EVIDENCE_HAND)
DEFAULT_CHANGES = "Converted to Markdown; reference and navigation sections removed; split into passages for retrieval."
TABLE_HEADER = "| key | title | author | url | licence | licence evidence | retrieved | changes |"
TABLE_RULE = "|---|---|---|---|---|---|---|---|"
_FIELD_LINE = re.compile(r"([a-z]+): (.*)")
_DATE = re.compile(r"\d{4}-\d{2}-\d{2}")
_UNESCAPED_PIPE = re.compile(r"(?<!\\)\|")


class SourceError(ValueError):
    """A source file, sources.json entry or SOURCES.md row breaks a format rule."""


@dataclass(frozen=True)
class SourceMeta:
    key: str
    title: str
    url: str
    author: str
    licence: str
    retrieved: date
    topic: str


@dataclass(frozen=True)
class SourceRow:
    """One SOURCES.md row; the cells in table order."""

    key: str
    title: str
    author: str
    url: str
    licence: str
    evidence: str
    retrieved: str
    changes: str

    @classmethod
    def from_meta(cls, meta: SourceMeta, evidence: str, changes: str = DEFAULT_CHANGES) -> "SourceRow":
        return cls(meta.key, meta.title, meta.author, meta.url, meta.licence, evidence,
                   meta.retrieved.isoformat(), changes)

    def check(self) -> None:
        check_key(self.key)
        check_text("title", self.title)
        check_text("author", self.author)
        check_url(self.url)
        check_licence(self.licence)
        if self.evidence not in EVIDENCE:
            raise SourceError(f"Licence evidence must be one of: {', '.join(EVIDENCE)}.")
        check_retrieved(self.retrieved)
        check_text("changes", self.changes, MAX_CHANGES_CHARS)


def normalise(text: str) -> str:
    """Without a byte order mark, with LF line ends."""
    return text.removeprefix("﻿").replace("\r\n", "\n").replace("\r", "\n")


def is_blocked_host(host: str) -> bool:
    host = host.lower().rstrip(".")
    return any(host == blocked or host.endswith(f".{blocked}") for blocked in BLOCKED_HOSTS)


def check_key(key: object) -> str:
    if not isinstance(key, str) or not KEY_PATTERN.fullmatch(key):
        raise SourceError("key must be 1-80 characters of a-z, 0-9 and '-', starting with a letter or digit.")
    return key


def check_topic(topic: object) -> str:
    if not isinstance(topic, str) or not TOPIC_PATTERN.fullmatch(topic):
        raise SourceError("topic must be 1-40 characters of a-z, 0-9 and '-', starting with a letter or digit.")
    return topic


def check_licence(licence: object) -> str:
    if not isinstance(licence, str) or not LICENCE_PATTERN.fullmatch(licence):
        raise SourceError("licence must be CC BY or CC BY-SA, version 2.0, 2.5, 3.0 or 4.0 (e.g. 'CC BY-SA 4.0').")
    return licence


def check_text(name: str, value: object, limit: int = MAX_TEXT_CHARS) -> str:
    if not isinstance(value, str) or not value or value != value.strip() or len(value) > limit \
            or CONTROL.search(value):
        raise SourceError(f"{name} must be 1-{limit} characters on one line, without surrounding spaces.")
    return value


def check_url(url: object) -> str:
    if not isinstance(url, str) or not url or len(url) > MAX_URL_CHARS or CONTROL.search(url) or " " in url:
        raise SourceError(f"url must be one line of at most {MAX_URL_CHARS} characters without spaces.")
    parts = urlsplit(url)
    if parts.scheme != "https" or not parts.hostname or parts.username is not None \
            or parts.password is not None or parts.fragment:
        raise SourceError("url must be https with a host and no user, password or fragment.")
    if is_blocked_host(parts.hostname):
        raise SourceError("OpenStax material is not allowed.")
    return url


def check_retrieved(value: object) -> date:
    if isinstance(value, date):
        retrieved = value
    elif isinstance(value, str) and _DATE.fullmatch(value):
        try:
            retrieved = date.fromisoformat(value)
        except ValueError:
            raise SourceError("retrieved must be a date (YYYY-MM-DD).") from None
    else:
        raise SourceError("retrieved must be a date (YYYY-MM-DD).")
    if retrieved > datetime.now(timezone.utc).date():
        raise SourceError("retrieved must not be in the future.")
    return retrieved


def check_meta(meta: SourceMeta) -> None:
    check_key(meta.key)
    check_text("title", meta.title)
    check_url(meta.url)
    check_text("author", meta.author)
    check_licence(meta.licence)
    check_retrieved(meta.retrieved)
    check_topic(meta.topic)
    if "openstax" in f"{meta.title} {meta.author}".lower():
        raise SourceError("OpenStax material is not allowed.")


def format_source(meta: SourceMeta, body: str) -> str:
    """The file text for meta and body. SourceError if either breaks a rule."""
    check_meta(meta)
    values = {"title": meta.title, "url": meta.url, "author": meta.author, "licence": meta.licence,
              "retrieved": meta.retrieved.isoformat(), "topic": meta.topic}
    if any(len(value) >= 2 and value[0] == value[-1] == '"' for value in values.values()):
        # parse_source would strip the quotes, so the file would not read back the same.
        raise SourceError("Front matter values must not be wrapped in double quotes.")
    body = normalise(body).strip()
    if not body:
        raise SourceError("The body is empty.")
    front = "\n".join(f"{name}: {values[name]}" for name in FIELDS)
    return f"---\n{front}\n---\n\n{body}\n"


def parse_source(text: str, key: str) -> tuple[SourceMeta, str]:
    """(metadata, Markdown body) of a source file's text. SourceError if it breaks a rule.

    A value may be wrapped in one pair of double quotes, which are removed (hand-written files).
    """
    check_key(key)
    lines = normalise(text).split("\n")
    if lines[0] != "---":
        raise SourceError("The file must start with a '---' line.")
    try:
        end = lines.index("---", 1)
    except ValueError:
        raise SourceError("The front matter has no closing '---' line.") from None
    values: dict[str, str] = {}
    for line in lines[1:end]:
        match = _FIELD_LINE.fullmatch(line)
        if not match:
            raise SourceError("Each front matter line must be 'name: value'.")
        name, value = match.group(1), match.group(2).strip()
        if name not in FIELDS:
            raise SourceError(f"Unknown front matter field '{name}'.")
        if name in values:
            raise SourceError(f"Duplicate front matter field '{name}'.")
        if len(value) >= 2 and value[0] == value[-1] == '"':
            value = value[1:-1]
        values[name] = value
    missing = [name for name in FIELDS if name not in values]
    if missing:
        raise SourceError(f"Missing front matter fields: {', '.join(missing)}.")
    body = "\n".join(lines[end + 1:]).strip()
    if not body:
        raise SourceError("The body is empty.")
    meta = SourceMeta(key=key, title=values["title"], url=values["url"], author=values["author"],
                      licence=values["licence"], retrieved=check_retrieved(values["retrieved"]),
                      topic=values["topic"])
    check_meta(meta)
    return meta, body


def read_source(path: Path) -> tuple[SourceMeta, str]:
    """parse_source on a file; the key is the file name without ".md". Errors name the file."""
    try:
        if path.suffix != ".md":
            raise SourceError("Source files must end in .md.")
        data = path.read_bytes()
        if len(data) > MAX_FILE_BYTES:
            raise SourceError(f"The file is larger than {MAX_FILE_BYTES // 1024} KB.")
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError:
            raise SourceError("The file is not UTF-8.") from None
        return parse_source(text, path.stem)
    except SourceError as exc:
        raise SourceError(f"{path.name}: {exc}") from None


def _cells(line: str) -> list[str]:
    stripped = line.strip()
    if len(stripped) < 2 or not (stripped.startswith("|") and stripped.endswith("|")):
        raise SourceError("SOURCES.md table rows must start and end with '|'.")
    return [cell.strip().replace("\\|", "|") for cell in _UNESCAPED_PIPE.split(stripped[1:-1])]


def parse_sources_md(text: str) -> tuple[str, dict[str, SourceRow]]:
    """(text before the table, rows by key). The file must end with the sources table."""
    lines = normalise(text).split("\n")
    try:
        start = lines.index(TABLE_HEADER)
    except ValueError:
        raise SourceError("SOURCES.md has no sources table header.") from None
    if start + 1 >= len(lines) or lines[start + 1] != TABLE_RULE:
        raise SourceError("SOURCES.md table header must be followed by its rule line.")
    rest = lines[start + 2:]
    end = next((index for index, line in enumerate(rest) if not line.strip()), len(rest))
    if any(line.strip() for line in rest[end:]):
        raise SourceError("SOURCES.md must end with the sources table.")
    rows: dict[str, SourceRow] = {}
    for line in rest[:end]:
        cells = _cells(line)
        if len(cells) != len(TABLE_HEADER.strip("|").split("|")):
            raise SourceError("SOURCES.md rows must have 8 cells.")
        row = SourceRow(*cells)
        try:
            row.check()
        except SourceError as exc:
            raise SourceError(f"SOURCES.md row '{row.key}': {exc}") from None
        if row.key in rows:
            raise SourceError(f"SOURCES.md has two rows for '{row.key}'.")
        rows[row.key] = row
    return "\n".join(lines[:start]).rstrip("\n"), rows


def format_sources_md(preamble: str, rows: dict[str, SourceRow]) -> str:
    """SOURCES.md with the preamble and one row per key, sorted by key."""
    table = [TABLE_HEADER, TABLE_RULE]
    for key in sorted(rows):
        rows[key].check()
        table.append("| " + " | ".join(cell.replace("|", "\\|") for cell in astuple(rows[key])) + " |")
    return f"{preamble}\n\n" + "\n".join(table) + "\n"
