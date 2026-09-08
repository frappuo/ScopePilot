from typing import Annotated

from fastapi import APIRouter, Depends
from starlette.concurrency import run_in_threadpool

from app.config import Settings, get_settings
from app.schemas.ask import AskRequest, AskResponse
from app.services.gemini import answer_question

router = APIRouter()


@router.post("/ask", response_model=AskResponse)
async def ask(
    request: AskRequest,
    settings: Annotated[Settings, Depends(get_settings)],
) -> AskResponse:
    return await run_in_threadpool(
        answer_question, request.analysis, request.question, settings
    )
