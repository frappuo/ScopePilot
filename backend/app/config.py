from functools import lru_cache
from pathlib import Path

from pydantic import Field, SecretStr, ValidationError
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
