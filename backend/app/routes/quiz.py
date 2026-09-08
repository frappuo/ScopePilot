from typing import Annotated

from fastapi import APIRouter, Depends
from starlette.concurrency import run_in_threadpool

from app.config import Settings, get_settings
from app.schemas.quiz import QuizRequest, QuizResponse
from app.services.gemini import generate_quiz

router = APIRouter()


@router.post("/quiz", response_model=QuizResponse)
async def quiz(
    request: QuizRequest,
    settings: Annotated[Settings, Depends(get_settings)],
) -> QuizResponse:
    return await run_in_threadpool(generate_quiz, request.analysis, settings)
