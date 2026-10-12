from typing import Annotated

from fastapi import APIRouter, BackgroundTasks, Depends, File, Query, Response, UploadFile
from starlette.concurrency import run_in_threadpool

from app.config import Settings, get_settings
from app.dependencies import current_user
from app.schemas.ask import AskResponse
from app.schemas.experiment import Experiment, ExperimentAskRequest, ExperimentPage, ExperimentUpdate
from app.schemas.quiz import QuizResponse
from app.services.auth import AuthenticatedUser
from app.services.logbook import (
    ask_experiment,
    create_experiment,
    delete_experiment,
    list_experiments,
    purge_expired_drafts,
    quiz_experiment,
    read_experiment,
    update_experiment,
)

router = APIRouter(prefix="/v1")


@router.post("/experiments", response_model=Experiment, status_code=201)
async def create(
    image: Annotated[UploadFile, File(description="Single JPEG, PNG, or WebP microscopy image")],
    user: Annotated[AuthenticatedUser, Depends(current_user)],
    settings: Annotated[Settings, Depends(get_settings)],
    background_tasks: BackgroundTasks,
) -> Experiment:
    try:
        data = await image.read(settings.max_image_bytes + 1)
    finally:
        await image.close()
    experiment = await run_in_threadpool(create_experiment, user.user_id, data, image.content_type, settings)
    # After the response, so purging never delays or fails the request.
    background_tasks.add_task(purge_expired_drafts, user.user_id, settings)
    return experiment


@router.get("/experiments", response_model=ExperimentPage)
async def list_(
    user: Annotated[AuthenticatedUser, Depends(current_user)],
    settings: Annotated[Settings, Depends(get_settings)],
    background_tasks: BackgroundTasks,
    limit: Annotated[int, Query(ge=1, le=50)] = 20,
    cursor: Annotated[str | None, Query(min_length=1, max_length=200)] = None,
) -> ExperimentPage:
    page = await run_in_threadpool(list_experiments, user.user_id, limit, cursor, settings)
    background_tasks.add_task(purge_expired_drafts, user.user_id, settings)
    return page


@router.get("/experiments/{experiment_id}", response_model=Experiment)
async def read(
    experiment_id: str,
    user: Annotated[AuthenticatedUser, Depends(current_user)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> Experiment:
    return await run_in_threadpool(read_experiment, user.user_id, experiment_id, settings)


@router.patch("/experiments/{experiment_id}", response_model=Experiment)
async def update(
    experiment_id: str,
    body: ExperimentUpdate,
    user: Annotated[AuthenticatedUser, Depends(current_user)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> Experiment:
    return await run_in_threadpool(update_experiment, user.user_id, experiment_id, body, settings)


@router.delete("/experiments/{experiment_id}", status_code=204)
async def delete(
    experiment_id: str,
    user: Annotated[AuthenticatedUser, Depends(current_user)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> Response:
    await run_in_threadpool(delete_experiment, user.user_id, experiment_id, settings)
    return Response(status_code=204)


@router.post("/experiments/{experiment_id}/ask", response_model=AskResponse)
async def ask(
    experiment_id: str,
    body: ExperimentAskRequest,
    user: Annotated[AuthenticatedUser, Depends(current_user)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> AskResponse:
    return await run_in_threadpool(ask_experiment, user.user_id, experiment_id, body.question, settings)


@router.post("/experiments/{experiment_id}/quiz", response_model=QuizResponse)
async def quiz(
    experiment_id: str,
    user: Annotated[AuthenticatedUser, Depends(current_user)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> QuizResponse:
    return await run_in_threadpool(quiz_experiment, user.user_id, experiment_id, settings)
