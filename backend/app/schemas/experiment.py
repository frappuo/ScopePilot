from datetime import datetime
from typing import Literal

from pydantic import BaseModel

from app.schemas.analysis import Analysis


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
    """One row of the experiments list (used from PR 4)."""

    id: str
    title: str | None
    probable_specimen: str
    created_at: datetime
    thumb_url: str | None
