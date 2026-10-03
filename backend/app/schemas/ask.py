from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

from app.schemas.analysis import AnalysisInput

Question = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=500)]


class AskRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    analysis: AnalysisInput
    question: Question


class AskResponse(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    answer: str = Field(min_length=1)
