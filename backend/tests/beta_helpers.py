from pathlib import Path

from alembic import command
from alembic.config import Config


def install_beta_schema(engine):
    config = Config(str(Path(__file__).parents[1] / "beta_quota_alembic.ini"))
    with engine.begin() as connection:
        config.attributes["connection"] = connection
        command.upgrade(config, "head")


def beta_settings(settings, **changes):
    return settings.model_copy(
        update={
            "beta_quota_enabled": True,
            "beta_pricing_attested": True,
            "beta_pricing_version": "p83-offline-synthetic",
            "beta_request_ceiling_microusd": 100,
            "beta_global_daily_budget_microusd": 500,
            "beta_global_daily_requests": 5,
            "beta_account_daily_requests": 2,
            "beta_account_concurrent": 1,
            "chat_runner_enabled": False,
            **changes,
        }
    )
