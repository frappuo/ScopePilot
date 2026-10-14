from typing import Annotated

from fastapi import APIRouter, Depends, Response
from starlette.concurrency import run_in_threadpool

from app.config import Settings, get_settings
from app.dependencies import current_user
from app.schemas.me import AccountDeleteRequest, MeResponse
from app.services.auth import AuthenticatedUser
from app.services.errors import AnalysisError
from app.services.logbook import delete_account, get_daily_usage

router = APIRouter(prefix="/v1")

DELETE_UNFINISHED = "Account deletion did not finish. Please try again."


@router.get("/me", response_model=MeResponse)
async def me(
    user: Annotated[AuthenticatedUser, Depends(current_user)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> MeResponse:
    usage = await run_in_threadpool(get_daily_usage, user.user_id, settings)
    return MeResponse(user_id=user.user_id, email=user.email, usage=usage)


@router.delete("/me", status_code=204)
async def delete_me(
    body: AccountDeleteRequest,
    user: Annotated[AuthenticatedUser, Depends(current_user)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> Response:
    """204 once everything is gone. On 503 the app keeps its session and retries; it signs out only on 204."""
    try:
        await run_in_threadpool(delete_account, user.user_id, settings)
    except AnalysisError:
        # Every step is safe to repeat, so a retry with the same access token finishes the job.
        raise AnalysisError(503, DELETE_UNFINISHED) from None
    return Response(status_code=204)
