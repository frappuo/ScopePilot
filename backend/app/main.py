from contextlib import asynccontextmanager
import logging

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from app.config import get_settings
from app.middleware import AppTokenMiddleware, BearerAuthMiddleware, BodySizeLimitMiddleware
from app.routes import analyze, ask, health, me, quiz
from app.services.errors import AnalysisError


def _configure_logging() -> None:
    """Send app.* logs (INFO and up) to stderr once; uvicorn does not configure them."""
    logger = logging.getLogger("app")
    logger.setLevel(logging.INFO)
    if not any(getattr(handler, "_scopepilot", False) for handler in logger.handlers):
        handler = logging.StreamHandler()
        handler.setFormatter(logging.Formatter("%(levelname)s %(name)s: %(message)s"))
        handler._scopepilot = True
        logger.addHandler(handler)


_configure_logging()


@asynccontextmanager
async def lifespan(app: FastAPI):
    get_settings()  # Validate configuration before accepting requests.
    yield


app = FastAPI(title="ScopePilot", version="0.1.0", lifespan=lifespan)
app.add_middleware(BodySizeLimitMiddleware)
# Last added runs first, so the order is AppToken -> Bearer (/v1/* only) ->
# BodySize: unauthorized requests are rejected before any body is read.
app.add_middleware(BearerAuthMiddleware)
app.add_middleware(AppTokenMiddleware)
app.include_router(health.router)
app.include_router(analyze.router)
app.include_router(ask.router)
app.include_router(quiz.router)
app.include_router(me.router)


@app.exception_handler(AnalysisError)
async def analysis_error_handler(request: Request, exc: AnalysisError) -> JSONResponse:
    return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail}, headers=exc.headers)
