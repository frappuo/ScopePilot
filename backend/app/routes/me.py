from typing import Annotated

from fastapi import APIRouter, Depends

from app.dependencies import current_user
from app.schemas.me import MeResponse
from app.services.auth import AuthenticatedUser

router = APIRouter(prefix="/v1")


@router.get("/me", response_model=MeResponse)
def me(user: Annotated[AuthenticatedUser, Depends(current_user)]) -> MeResponse:
    return MeResponse(user_id=user.user_id, email=user.email)
