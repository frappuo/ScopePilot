from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

NonEmptyText = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]
# UTF-8 size of the compact JSON of a stored logbook analysis (field caps alone allow ~126 KB).
MAX_STORED_ANALYSIS_BYTES = 32 * 1024


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


class StoredAnalysis(AnalysisInput):
    """An analysis the logbook stores; experiment-scoped /ask and /quiz read it back."""

    @model_validator(mode="after")
    def _within_stored_size(self) -> "StoredAnalysis":
        if len(self.model_dump_json().encode("utf-8")) > MAX_STORED_ANALYSIS_BYTES:
            raise ValueError("Analysis is too large to store.")
        return self
