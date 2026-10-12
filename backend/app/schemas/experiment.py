from datetime import datetime
from typing import Annotated, Literal
import unicodedata

from pydantic import AfterValidator, BaseModel, ConfigDict, StringConstraints, model_validator

from app.schemas.analysis import Analysis
from app.schemas.ask import Question


class Experiment(BaseModel):
    """A stored analysis (draft or saved).

    The image URLs are signed and expire after image_url_expires_in seconds. They are
    None if signing failed; fetching the experiment again signs them again.
    """

    id: str
    status: Literal["draft", "saved"]
    title: str | None
    notes: str
    analysis: Analysis
    created_at: datetime
    updated_at: datetime
    saved_at: datetime | None
    expires_at: datetime | None
    image_url: str | None
    thumb_url: str | None
    image_url_expires_in: int


class ExperimentSummary(BaseModel):
    """One row of the experiments list. Only the thumbnail URL is signed, never the full image."""

    id: str
    status: Literal["draft", "saved"]
    title: str | None
    probable_specimen: str
    created_at: datetime
    saved_at: datetime | None
    expires_at: datetime | None
    thumb_url: str | None


class ExperimentPage(BaseModel):
    """One page of the experiments list, newest first. next_cursor is None on the last page."""

    items: list[ExperimentSummary]
    next_cursor: str | None
    thumb_url_expires_in: int


# Controls (Cc, incl. C1), invisible format characters (Cf, e.g. U+202E, U+200B) and line or
# paragraph separators (Zl, Zp) would let a title hide or reorder text in list views.
_TITLE_FORBIDDEN_CATEGORIES = frozenset({"Cc", "Cf", "Zl", "Zp"})


def _plain_title(value: str) -> str:
    if any(unicodedata.category(char) in _TITLE_FORBIDDEN_CATEGORIES for char in value):
        raise ValueError("Title contains control or invisible characters.")
    return value


# Same limits as the CHECK constraints in supabase/migrations/0001_logbook.sql. No control
# characters in a title; notes keep tab, newline and carriage return. Postgres text cannot
# store NUL at all, so it would otherwise fail in the database as a 503.
Title = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120,
                                         pattern=r"^[^\x00-\x1f\x7f]*$"), AfterValidator(_plain_title)]
Notes = Annotated[str, StringConstraints(max_length=5000, pattern=r"^[^\x00-\x08\x0b\x0c\x0e-\x1f\x7f]*$")]


class ExperimentUpdate(BaseModel):
    """PATCH body. A null or absent field leaves the value unchanged; a title cannot be cleared.

    status "saved" saves a draft (saving a saved experiment changes nothing). There is no unsave.
    """

    model_config = ConfigDict(extra="forbid")

    title: Title | None = None
    notes: Notes | None = None
    status: Literal["saved"] | None = None

    @model_validator(mode="after")
    def _not_empty(self) -> "ExperimentUpdate":
        if self.title is None and self.notes is None and self.status is None:
            raise ValueError("Nothing to update.")
        return self


class ExperimentAskRequest(BaseModel):
    """Body of POST /v1/experiments/{id}/ask. The analysis comes from the stored experiment, never the client."""

    model_config = ConfigDict(extra="forbid")

    question: Question
