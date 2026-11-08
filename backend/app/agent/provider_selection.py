"""Server-owned per-pet selection; client names/configuration never grant paid access."""

from dataclasses import dataclass
from uuid import UUID

from pydantic import ValidationError

from app.core.config import Settings
from app.core.errors import AppError


@dataclass(frozen=True)
class ChatProviderSelection:
    provider: str
    model: str | None
    memory_injection_enabled: bool


def _validated(settings: Settings) -> Settings:
    try:
        # Do not mutate shared settings when selecting one concurrent pet. The
        # secret is deliberately excluded from ordinary Settings serialization.
        return Settings.model_validate(
            settings.model_dump() | {"deepseek_api_key": settings.deepseek_api_key}
        )
    except (ValidationError, ValueError):
        raise AppError(503, "REAL_LLM_DISABLED", "聊天模型配置暂不可用。") from None


def _selection(settings: Settings, owner_id: UUID | None, pet_id: UUID | None):
    if (
        owner_id is not None
        and pet_id is not None
        and settings.dev_deepseek_pet_owner_id == owner_id
        and settings.dev_deepseek_pet_id == pet_id
    ) or any(
        (item.owner_id, item.pet_id) == (owner_id, pet_id) for item in settings.local_deepseek_pets
    ):
        return ChatProviderSelection("deepseek", settings.deepseek_model, False)
    return ChatProviderSelection(
        settings.llm_provider, settings.selected_model, settings.memory_injection_enabled
    )


def select_chat_provider(
    settings: Settings, owner_id: UUID | None = None, pet_id: UUID | None = None
) -> ChatProviderSelection:
    return _selection(_validated(settings), owner_id, pet_id)


def resolved_generation_settings(
    settings: Settings,
    owner_id: UUID,
    pet_id: UUID | None,
    provider: str,
    model: str | None,
) -> Settings:
    """Recheck a frozen real task before dispatch; never silently upgrade Mock.

    An already accepted Mock task may finish locally after a developer enables
    DeepSeek. Real tasks must still match the current exact owner/pet and model.
    Replaying a task never invokes selection or creates another upstream call.
    """
    validated = _validated(settings)
    if provider == "mock" and model is None:
        return validated
    chosen = _selection(validated, owner_id, pet_id)
    if provider not in {"deepseek", "openai"} or (provider, model) != (
        chosen.provider,
        chosen.model,
    ):
        raise AppError(503, "REAL_LLM_DISABLED", "这次回复的模型授权已改变，请重新确认。")
    if provider == validated.llm_provider:
        return validated
    # The single selected pet receives a separate validated configuration. Other
    # Mock pets keep their original consent-gated memory behavior and settings.
    return _validated(
        validated.model_copy(
            update={
                "llm_provider": "deepseek",
                "memory_injection_enabled": False,
                "dev_deepseek_pet_owner_id": None,
                "dev_deepseek_pet_id": None,
                "local_deepseek_pets": [],
                "local_deepseek_max_requests": 0,
            }
        )
    )
