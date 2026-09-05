from typing import Annotated

from fastapi import APIRouter, Depends, File, UploadFile
from starlette.concurrency import run_in_threadpool

from app.config import Settings, get_settings
from app.schemas.analysis import Analysis
from app.services.gemini import analyze_image
from app.services.images import validate_image

router = APIRouter()


@router.post("/analyze", response_model=Analysis)
async def analyze(
    image: Annotated[UploadFile, File(description="Single JPEG, PNG, or WebP microscopy image")],
    settings: Annotated[Settings, Depends(get_settings)],
) -> Analysis:
    try:
        data = await image.read(settings.max_image_bytes + 1)
        mime_type = await run_in_threadpool(validate_image, data, image.content_type, settings)
    finally:
        await image.close()
    return await run_in_threadpool(analyze_image, data, mime_type, settings)
