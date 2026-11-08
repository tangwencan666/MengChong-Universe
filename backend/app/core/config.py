from functools import lru_cache
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit
from uuid import UUID

from pydantic import AliasChoices, BaseModel, ConfigDict, Field, SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class LocalPetModelBinding(BaseModel):
    """Backend-only authorization; display names never grant model access."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    owner_id: UUID
    pet_id: UUID


class Settings(BaseSettings):
    # Never implicitly read this checkout's parent .env or existing credentials.
    model_config = SettingsConfigDict(
        env_prefix="WEIBIYE_",
        extra="ignore",
        env_file=None,
        hide_input_in_errors=True,
        populate_by_name=True,
    )

    environment: Literal["development", "test", "production"] = "development"
    database_url: SecretStr = SecretStr(
        "postgresql+psycopg://weibiye:local-development-only@127.0.0.1:25433/weibiye"
    )
    redis_url: SecretStr = SecretStr("redis://127.0.0.1:26380/0")
    cors_origins: list[str] = ["http://127.0.0.1:35174", "http://localhost:35174"]
    llm_provider: Literal["mock", "openai", "deepseek"] = "mock"
    real_llm_enabled: bool = False
    openai_api_key: SecretStr | None = None
    openai_model: str = ""
    deepseek_api_key: SecretStr | None = Field(
        default=None,
        exclude=True,
        repr=False,
        validation_alias=AliasChoices("WEIBIYE_DEEPSEEK_API_KEY", "DEEPSEEK_API_KEY"),
    )
    deepseek_base_url: str = "https://api.deepseek.com"
    deepseek_model: Literal["deepseek-flash", "deepseek-v4-pro"] = "deepseek-flash"
    deepseek_max_tokens: int = Field(default=512, ge=1, le=2048)
    deepseek_timeout_seconds: float = Field(default=30, gt=0, le=120)
    # Development-only opt-in for one exact private pet; never match a display name.
    dev_deepseek_pet_owner_id: UUID | None = Field(default=None, repr=False)
    dev_deepseek_pet_id: UUID | None = Field(default=None, repr=False)
    local_deepseek_pets: list[LocalPetModelBinding] = Field(default_factory=list, max_length=32)
    local_deepseek_max_requests: int = Field(default=0, ge=0, le=100)
    local_deepseek_max_input_bytes: int = Field(default=8192, ge=256, le=32768)
    demo_enabled: bool = True
    rate_limit_backend: Literal["memory", "redis"] = "memory"
    demo_requests_per_minute: int = Field(default=20, ge=1, le=1000)
    auth_store_backend: Literal["redis", "memory"] = "redis"
    session_ttl_seconds: int = Field(default=86400, ge=1, le=604800)
    cookie_secure: bool = False
    require_verified_email: bool = False
    login_ip_limit: int = Field(default=30, ge=1, le=1000)
    login_account_limit: int = Field(default=8, ge=1, le=100)
    register_ip_limit: int = Field(default=8, ge=1, le=1000)
    frontend_origin: str = "http://127.0.0.1:35174"
    mock_mail_dir: Path | None = None
    recovery_ip_limit: int = Field(default=8, ge=1, le=1000)
    recovery_account_limit: int = Field(default=3, ge=1, le=100)
    reset_ttl_seconds: int = Field(default=1800, ge=60, le=3600)
    chat_runner_enabled: bool = True
    chat_max_running: int = Field(default=4, ge=1, le=4)
    chat_user_active_limit: int = Field(default=2, ge=1, le=10)
    chat_total_active_limit: int = Field(default=64, ge=1, le=1000)
    chat_commands_per_minute: int = Field(default=20, ge=1, le=1000)
    chat_ip_commands_per_minute: int = Field(default=100, ge=1, le=5000)
    chat_stream_limit: int = Field(default=3, ge=1, le=10)
    beta_quota_enabled: bool = False
    beta_telemetry_enabled: bool = False
    beta_telemetry_hmac_key: SecretStr | None = Field(default=None, repr=False)
    beta_account_daily_requests: int = Field(default=5, ge=1, le=1000)
    beta_account_concurrent: int = Field(default=1, ge=1, le=4)
    beta_global_daily_requests: int = Field(default=100, ge=1, le=100000)
    beta_global_daily_budget_microusd: int = Field(default=0, ge=0, le=1000000000000)
    beta_request_ceiling_microusd: int = Field(default=0, ge=0, le=1000000000)
    beta_max_input_bytes: int = Field(default=32768, ge=256, le=65536)
    beta_pricing_attested: bool = False
    beta_pricing_version: str = Field(
        default="unconfigured", min_length=1, max_length=60, pattern=r"^[A-Za-z0-9._-]+$"
    )
    beta_model: Literal["deepseek-flash", "deepseek-v4-pro"] = "deepseek-flash"
    chat_poll_seconds: float = Field(default=0.1, ge=0.01, le=1)
    chat_flush_seconds: float = Field(default=0.075, ge=0.01, le=0.1)
    chat_heartbeat_seconds: float = Field(default=5, ge=0.1, le=5)
    chat_event_retention_seconds: int = Field(default=86400, ge=86400)
    chat_queue_timeout_seconds: int = Field(default=60, ge=1, le=600)
    chat_run_timeout_seconds: int = Field(default=120, ge=1, le=600)
    chat_first_chunk_timeout_seconds: int = Field(default=30, ge=1, le=120)
    chat_output_max_chars: int = Field(default=8000, ge=1, le=8000)
    chat_lease_seconds: int = Field(default=15, ge=3, le=60)
    chat_renew_seconds: float = Field(default=5, ge=0.1, le=10)
    memory_management_enabled: bool = False
    memory_injection_enabled: bool = False
    memory_hmac_key: SecretStr | None = None
    memory_context_capacity: int = Field(default=32768, ge=2048, le=131072)
    memory_output_reserve: int = Field(default=512, ge=1, le=8192)
    memory_safety_margin: int = Field(default=256, ge=0, le=4096)
    memory_max_tokens: int = Field(default=1024, ge=0, le=1024)
    memory_max_items: int = Field(default=5, ge=1, le=5)

    @model_validator(mode="after")
    def validate_boundaries(self) -> "Settings":
        try:
            endpoint = urlsplit(self.deepseek_base_url)
            endpoint_port = endpoint.port
        except ValueError:
            raise ValueError("DeepSeek requires its fixed official HTTPS API origin") from None
        if (
            endpoint.scheme != "https"
            or endpoint.hostname != "api.deepseek.com"
            or endpoint_port not in {None, 443}
            or endpoint.username
            or endpoint.password
            or endpoint.query
            or endpoint.fragment
            or endpoint.path not in {"", "/", "/v1", "/v1/"}
        ):
            raise ValueError("DeepSeek requires its fixed official HTTPS API origin")
        self.deepseek_base_url = "https://api.deepseek.com" + (
            "/v1" if endpoint.path.startswith("/v1") else ""
        )
        scoped_deepseek = (
            self.dev_deepseek_pet_owner_id is not None or self.dev_deepseek_pet_id is not None
        )
        if scoped_deepseek and (
            self.dev_deepseek_pet_owner_id is None
            or self.dev_deepseek_pet_id is None
            or self.environment != "development"
            or self.llm_provider != "mock"
            or not self.real_llm_enabled
            or self.deepseek_api_key is None
            or not self.deepseek_api_key.get_secret_value().strip()
        ):
            raise ValueError(
                "Pet-specific DeepSeek requires development, base Mock, explicit enablement, "
                "a backend key and an exact owner/pet pair"
            )
        local_deepseek = bool(self.local_deepseek_pets)
        if local_deepseek or self.local_deepseek_max_requests:
            bindings = {(item.owner_id, item.pet_id) for item in self.local_deepseek_pets}
            if (
                not local_deepseek
                or len(bindings) != len(self.local_deepseek_pets)
                or scoped_deepseek
                or self.environment != "development"
                or self.llm_provider != "mock"
                or not self.real_llm_enabled
                or self.deepseek_api_key is None
                or not self.deepseek_api_key.get_secret_value().strip()
                or self.local_deepseek_max_requests < 1
                or self.deepseek_max_tokens > 512
            ):
                raise ValueError(
                    "Local DeepSeek requires development, base Mock, backend credentials, "
                    "unique owner/pet bindings, a finite request budget and <=512 output tokens"
                )
        if self.memory_injection_enabled and (
            not self.memory_management_enabled
            or self.llm_provider != "mock"
            or (self.real_llm_enabled and not (scoped_deepseek or local_deepseek))
        ):
            raise ValueError("Memory injection requires management and the local Mock provider")
        if self.memory_output_reserve + self.memory_safety_margin >= self.memory_context_capacity:
            raise ValueError("Memory context must reserve room for input")
        if self.memory_management_enabled and (
            self.memory_hmac_key is None
            or len(self.memory_hmac_key.get_secret_value().encode()) < 32
        ):
            raise ValueError("Memory management requires a stable server HMAC key of 32+ bytes")
        if self.chat_renew_seconds >= self.chat_lease_seconds:
            raise ValueError("Chat lease renewal must happen before lease expiration")
        origin = urlsplit(self.frontend_origin)
        if (
            origin.scheme not in {"http", "https"}
            or not origin.hostname
            or origin.username
            or origin.password
            or origin.query
            or origin.fragment
            or origin.path not in {"", "/"}
        ):
            raise ValueError(
                "frontend_origin must be a fixed HTTP(S) origin without credentials or a path"
            )
        self.frontend_origin = self.frontend_origin.rstrip("/")
        if self.mock_mail_dir is not None:
            root = Path(__file__).resolve().parents[3] / ".verification"
            if self.environment == "production" or not self.mock_mail_dir.resolve().is_relative_to(
                root.resolve()
            ):
                raise ValueError(
                    "File Mock mail is restricted to this checkout's ignored verification directory"
                )
        if "*" in self.cors_origins:
            raise ValueError("CORS requires explicit origins")
        if self.llm_provider == "openai" and (
            not self.real_llm_enabled or not self.openai_api_key or not self.openai_model
        ):
            raise ValueError("Real LLM requires explicit enablement, model, and server-side key")
        if self.llm_provider == "deepseek" and (
            not self.real_llm_enabled
            or self.deepseek_api_key is None
            or not self.deepseek_api_key.get_secret_value().strip()
        ):
            raise ValueError("DeepSeek requires explicit enablement and a backend-only key")
        if self.environment == "production" and (
            self.demo_enabled
            or self.rate_limit_backend != "redis"
            or self.auth_store_backend != "redis"
            or not self.cookie_secure
            or not self.require_verified_email
            or any(not origin.startswith("https://") for origin in self.cors_origins)
            or origin.scheme != "https"
        ):
            raise ValueError(
                "Production requires HTTPS origins, Secure cookies, verified email and Redis"
            )
        if self.beta_telemetry_enabled and (
            self.beta_telemetry_hmac_key is None
            or len(self.beta_telemetry_hmac_key.get_secret_value().encode()) < 32
        ):
            raise ValueError("Opt-in beta metrics require a stable backend HMAC key")
        if self.beta_quota_enabled and (
            not self.beta_pricing_attested
            or self.beta_pricing_version == "unconfigured"
            or self.beta_request_ceiling_microusd <= 0
            or self.beta_global_daily_budget_microusd < self.beta_request_ceiling_microusd
        ):
            raise ValueError(
                "Beta quota requires an attested conservative cost ceiling and price version"
            )
        if (
            self.environment == "production"
            and self.llm_provider != "mock"
            and not self.beta_quota_enabled
        ):
            raise ValueError("Production model requests require the beta server quota")
        if (
            self.beta_quota_enabled
            and self.environment != "test"
            and not self.database_url.get_secret_value().startswith("postgresql")
        ):
            raise ValueError("Beta hard quotas require PostgreSQL outside deterministic unit tests")
        return self

    @property
    def selected_model(self) -> str | None:
        if self.llm_provider == "mock":
            return None
        return self.deepseek_model if self.llm_provider == "deepseek" else self.openai_model

    @property
    def session_cookie(self) -> str:
        return "__Host-weibiye_session" if self.cookie_secure else "weibiye_session"

    @property
    def csrf_cookie(self) -> str:
        return "__Host-weibiye_csrf" if self.cookie_secure else "weibiye_csrf"


@lru_cache
def get_settings() -> Settings:
    return Settings()
