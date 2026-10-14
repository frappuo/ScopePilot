from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict


class DailyUsage(BaseModel):
    """The caller's per-user Gemini quota for the current UTC day (create, experiment ask and quiz)."""

    used_today: int
    daily_limit: int
    remaining: int
    resets_at: datetime


class MeResponse(BaseModel):
    """usage is None if it could not be read; the session is still valid."""

    user_id: str
    email: str | None
    usage: DailyUsage | None


class AccountDeleteRequest(BaseModel):
    """Body of DELETE /v1/me. The exact phrase guards against a stray request, not a stolen token."""

    model_config = ConfigDict(extra="forbid")

    confirm: Literal["DELETE MY ACCOUNT"]
