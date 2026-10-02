"""Application configuration, loaded from environment variables (and an optional .env file)."""

from __future__ import annotations

from functools import lru_cache
from typing import Annotated, Literal

from pydantic import Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

_INSECURE_SECRETS = {"", "change-me", "changeme", "secret", "dev-secret-key-change-me"}


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    app_name: str = "Inventory Demand Forecasting"
    environment: Literal["development", "test", "production"] = "development"
    debug: bool = False
    log_level: str = "INFO"
    log_json: bool = True

    api_prefix: str = "/api/v1"
    cors_origins: Annotated[list[str], NoDecode] = Field(default_factory=lambda: ["http://localhost:5173"])

    database_url: str = "postgresql+asyncpg://inventory:inventory@localhost:5432/inventory"
    database_pool_size: int = 10
    database_max_overflow: int = 10
    database_echo: bool = False

    redis_url: str = "redis://localhost:6379/0"
    cache_enabled: bool = True
    cache_default_ttl_seconds: int = 300

    secret_key: SecretStr = SecretStr("dev-secret-key-change-me")
    jwt_algorithm: Literal["HS256", "HS384", "HS512"] = "HS256"
    access_token_expire_minutes: int = 60

    login_rate_limit_attempts: int = 10
    login_rate_limit_window_seconds: int = 300

    first_admin_email: str = "admin@example.com"
    first_admin_password: SecretStr = SecretStr("ChangeMe123!")
    seed_demo_data: bool = False

    # Background jobs: "arq" uses Redis + worker process; "inline" runs jobs in-process (tests).
    job_backend: Literal["arq", "inline"] = "arq"
    import_dir: str = "/tmp/inventory-imports"  # noqa: S108 - overridden via env in deployments
    max_import_file_mb: int = 50

    # Forecasting / replenishment defaults
    forecast_default_horizon_days: int = 30
    forecast_history_days: int = 365
    forecast_min_history_days: int = 14
    forecast_backtest_days: int = 28
    restock_review_period_days: int = 14
    nightly_forecast_hour_utc: int = 2

    @field_validator("cors_origins", mode="before")
    @classmethod
    def _split_origins(cls, value: object) -> object:
        if isinstance(value, str) and not value.strip().startswith("["):
            return [v.strip() for v in value.split(",") if v.strip()]
        return value

    @model_validator(mode="after")
    def _production_safety(self) -> Settings:
        if self.environment == "production":
            if (
                self.secret_key.get_secret_value() in _INSECURE_SECRETS
                or len(self.secret_key.get_secret_value()) < 32
            ):
                raise ValueError("SECRET_KEY must be set to a random value of >= 32 chars in production")
            if self.debug:
                raise ValueError("DEBUG must be false in production")
            if "*" in self.cors_origins:
                raise ValueError("Wildcard CORS origins are not allowed in production")
        return self

    @property
    def is_production(self) -> bool:
        return self.environment == "production"


@lru_cache
def get_settings() -> Settings:
    return Settings()
