from typing import Annotated

from fastapi import APIRouter, Depends, File, UploadFile
from starlette.concurrency import run_in_threadpool

from app.config import Settings, get_settings
from app.dependencies import current_user
from app.schemas.experiment import Experiment
from app.services.auth import AuthenticatedUser
from app.services.logbook import create_experiment, read_experiment

router = APIRouter(prefix="/v1")


@router.post("/experiments", response_model=Experiment, status_code=201)
async def create(
    image: Annotated[UploadFile, File(description="Single JPEG, PNG, or WebP microscopy image")],
    user: Annotated[AuthenticatedUser, Depends(current_user)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> Experiment:
    try:
        data = await image.read(settings.max_image_bytes + 1)
    finally:
        await image.close()
    return await run_in_threadpool(create_experiment, user.user_id, data, image.content_type, settings)


@router.get("/experiments/{experiment_id}", response_model=Experiment)
async def read(
    experiment_id: str,
    user: Annotated[AuthenticatedUser, Depends(current_user)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> Experiment:
    return await run_in_threadpool(read_experiment, user.user_id, experiment_id, settings)
