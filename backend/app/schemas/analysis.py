from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

NonEmptyText = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]


class Analysis(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    probable_specimen: str = Field(min_length=1)
    visible_structures: list[NonEmptyText]
    observations: list[NonEmptyText]
    explanation: str = Field(min_length=1)
    limitations: list[NonEmptyText] = Field(min_length=1)


CappedText = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=1000)]


class AnalysisInput(Analysis):
    """Client-supplied analysis for /ask and /quiz; caps bound prompt size and cost."""

    probable_specimen: str = Field(min_length=1, max_length=300)
    visible_structures: list[CappedText] = Field(max_length=40)
    observations: list[CappedText] = Field(max_length=40)
    explanation: str = Field(min_length=1, max_length=6000)
    limitations: list[CappedText] = Field(min_length=1, max_length=40)
