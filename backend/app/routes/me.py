from typing import Annotated

from fastapi import APIRouter, Depends
from starlette.concurrency import run_in_threadpool

from app.config import Settings, get_settings
from app.dependencies import current_user
from app.schemas.me import MeResponse
from app.services.auth import AuthenticatedUser
from app.services.logbook import get_daily_usage

router = APIRouter(prefix="/v1")


@router.get("/me", response_model=MeResponse)
async def me(
    user: Annotated[AuthenticatedUser, Depends(current_user)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> MeResponse:
    usage = await run_in_threadpool(get_daily_usage, user.user_id, settings)
    return MeResponse(user_id=user.user_id, email=user.email, usage=usage)
