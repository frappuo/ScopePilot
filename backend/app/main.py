from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from app.config import get_settings
from app.routes import analyze, health
from app.services.errors import AnalysisError

get_settings()  # Fail at startup for invalid configuration; an absent key is allowed.
app = FastAPI(title="ScopePilot", version="0.1.0")
app.include_router(health.router)
app.include_router(analyze.router)


@app.exception_handler(AnalysisError)
async def analysis_error_handler(request: Request, exc: AnalysisError) -> JSONResponse:
    return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})
