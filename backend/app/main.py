from contextlib import asynccontextmanager
import logging

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from app.config import get_settings
from app.middleware import (AppTokenMiddleware, BearerAuthMiddleware, BodySizeLimitMiddleware,
                            LegacyApiMiddleware, log_path)
from app.routes import analyze, ask, experiments, health, me, quiz
from app.services.errors import AnalysisError


class AccessLogFilter(logging.Filter):
    """Rewrites uvicorn access lines: experiment IDs become {id} and query strings (cursors) are
    dropped. A record in an unknown format is dropped rather than risk logging an ID."""

    def filter(self, record: logging.LogRecord) -> bool:
        args = record.args
        # uvicorn: '%s - "%s %s HTTP/%s" %d' % (client, method, path with query, version, status)
        if not (isinstance(args, tuple) and len(args) == 5 and isinstance(args[2], str)):
            return False
        record.args = (args[0], args[1], log_path(args[2].split("?", 1)[0]), args[3], args[4])
        return True


def _configure_logging() -> None:
    """Send app.* logs (INFO and up) to stderr once; uvicorn does not configure them.

    httpx logs every request URL at INFO (the Supabase project URL, user and experiment ids),
    so it and httpcore are held at WARNING even if root logging is later set to INFO.
    """
    for name in ("httpx", "httpcore"):
        logging.getLogger(name).setLevel(logging.WARNING)
    logger = logging.getLogger("app")
    logger.setLevel(logging.INFO)
    if not any(getattr(handler, "_scopepilot", False) for handler in logger.handlers):
        handler = logging.StreamHandler()
        handler.setFormatter(logging.Formatter("%(levelname)s %(name)s: %(message)s"))
        handler._scopepilot = True
        logger.addHandler(handler)
    # uvicorn configures its loggers before importing the app, so this filter survives startup.
    # Production should also run with --no-access-log; this is the backstop.
    access = logging.getLogger("uvicorn.access")
    if not any(isinstance(f, AccessLogFilter) for f in access.filters):
        access.addFilter(AccessLogFilter())


_configure_logging()


@asynccontextmanager
async def lifespan(app: FastAPI):
    get_settings()  # Validate configuration before accepting requests.
    yield


app = FastAPI(title="ScopePilot", version="0.1.0", lifespan=lifespan)
app.add_middleware(BodySizeLimitMiddleware)
# Last added runs first, so the order is Legacy (410 while disabled) -> AppToken ->
# Bearer (/v1/* only) -> BodySize: rejected requests are answered before any body is read.
app.add_middleware(BearerAuthMiddleware)
app.add_middleware(AppTokenMiddleware)
app.add_middleware(LegacyApiMiddleware)
app.include_router(health.router)
app.include_router(analyze.router)
app.include_router(ask.router)
app.include_router(quiz.router)
app.include_router(me.router)
app.include_router(experiments.router)


@app.exception_handler(AnalysisError)
async def analysis_error_handler(request: Request, exc: AnalysisError) -> JSONResponse:
    return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail}, headers=exc.headers)
