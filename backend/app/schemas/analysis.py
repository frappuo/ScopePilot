from pydantic import BaseModel, ConfigDict, Field


class Analysis(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    probable_specimen: str = Field(min_length=1)
    visible_structures: list[str]
    observations: list[str]
    explanation: str = Field(min_length=1)
    limitations: list[str] = Field(min_length=1)
