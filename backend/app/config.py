from functools import lru_cache
from pathlib import Path

from pydantic import Field, SecretStr, ValidationError, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=Path(__file__).resolve().parents[1] / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
        hide_input_in_errors=True,
    )

    gemini_api_key: SecretStr = SecretStr("")
    gemini_model: str = Field(default="gemini-2.5-flash", min_length=1)
    gemini_timeout_seconds: int = Field(default=60, gt=0, le=300)
    max_image_bytes: int = Field(default=10 * 1024 * 1024, gt=0)
    max_image_pixels: int = Field(default=20_000_000, gt=0)
    # Re-encoded bytes sent to Gemini; 14 MiB is ~18.7 MiB as base64,
    # under Gemini's ~20 MB inline request limit.
    max_encoded_image_bytes: int = Field(default=14 * 1024 * 1024, gt=0)
    # Body limit for every path except /analyze (which allows max_image_bytes
    # plus 64 KiB of multipart overhead) and /health (exempt).
    max_json_body_bytes: int = Field(default=64 * 1024, gt=0)
    # Gemini attempts per UTC day in this process; fallback attempts count.
    gemini_daily_call_limit: int = Field(default=100, gt=0)
    # Comma-separated; a str because pydantic-settings would JSON-decode a list.
    # Tried in order after gemini_model, only on quota (429) or missing model (404).
    gemini_fallback_models: str = ""

    @property
    def fallback_models(self) -> tuple[str, ...]:
        names = dict.fromkeys(name.strip() for name in self.gemini_fallback_models.split(","))
        return tuple(name for name in names if name and name != self.gemini_model.strip())

    @model_validator(mode="after")
    def _limit_fallback_models(self) -> "Settings":
        if len(self.fallback_models) > 3:
            raise ValueError("GEMINI_FALLBACK_MODELS accepts at most 3 models.")
        return self


@lru_cache
def get_settings() -> Settings:
    try:
        settings = Settings()
    except (ValidationError, ValueError, OSError):
        raise RuntimeError("Invalid backend environment configuration. Check your local settings.") from None
    if not settings.gemini_api_key.get_secret_value().strip():
        raise RuntimeError(
            "GEMINI_API_KEY is required. Set it in the environment or user-managed backend/.env."
        )
    return settings
