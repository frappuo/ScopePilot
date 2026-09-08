from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from app.config import get_settings
from app.routes import analyze, ask, health, quiz
from app.services.errors import AnalysisError

@asynccontextmanager
async def lifespan(app: FastAPI):
    get_settings()  # Validate configuration before accepting requests.
    yield


app = FastAPI(title="ScopePilot", version="0.1.0", lifespan=lifespan)
app.include_router(health.router)
app.include_router(analyze.router)
app.include_router(ask.router)
app.include_router(quiz.router)


@app.exception_handler(AnalysisError)
async def analysis_error_handler(request: Request, exc: AnalysisError) -> JSONResponse:
    return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})
