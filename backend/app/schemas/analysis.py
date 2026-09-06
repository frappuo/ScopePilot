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
