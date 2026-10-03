from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

from app.schemas.analysis import AnalysisInput

NonEmptyText = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]


class QuizRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    analysis: AnalysisInput


class QuizQuestion(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    question: str = Field(min_length=1)
    options: list[NonEmptyText] = Field(min_length=4, max_length=4)
    correct_answer: NonEmptyText
    explanation: str = Field(min_length=1)

    @model_validator(mode="after")
    def validate_options_and_answer(self) -> "QuizQuestion":
        if len(set(self.options)) != 4:
            raise ValueError("options must be unique")
        if self.correct_answer not in self.options:
            raise ValueError("correct_answer must match one option")
        return self


class QuizResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    questions: list[QuizQuestion] = Field(min_length=3, max_length=3)
