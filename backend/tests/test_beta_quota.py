"""Disposable SQLite unit cases. PostgreSQL multi-process coverage is separate."""

import asyncio
from datetime import timedelta
from types import SimpleNamespace
from uuid import uuid4

import pytest
from alembic import command
from alembic.config import Config
from beta_helpers import beta_settings, install_beta_schema
from sqlalchemy import func, select, text

from app.core.config import Settings
from app.core.event_loop import new_event_loop
from app.db.session import build_database
from app.modules.beta_quota import service as quota
from app.modules.beta_quota.models import (
    BetaAccount,
    BetaDay,
    BetaInvitation,
    BetaQuotaEvent,
    BetaReservation,
)

CODE = "p83-synthetic-invitation-never-a-real-secret-0001"


@pytest.fixture
def ledger(auth_database):
    engine, settings = auth_database
    install_beta_schema(engine)
    return engine, beta_settings(settings)


def run(ledger, scenario):
    async def perform():
        engine, factory = build_database(ledger[1].database_url.get_secret_value())
        try:
            await scenario(factory, ledger[1])
        finally:
            await engine.dispose()

    asyncio.run(perform(), loop_factory=new_event_loop)


async def seed(factory, owner=None, granted=4):
    owner = owner or uuid4()
    async with factory() as db, db.begin():
        db.add(
            BetaAccount(
                owner_id=owner,
                granted=granted,
                reserved=0,
                spent=0,
                active=0,
                expires_at=quota.now() + timedelta(days=8),
            )
        )
    return owner


def generation(owner, **changes):
    return SimpleNamespace(
        **(
            {
                "id": uuid4(),
                "owner_id": owner,
                "provider": "deepseek",
                "model": "deepseek-flash",
                "state": "queued",
                "usage": None,
            }
            | changes
        )
    )


async def reserve(factory, item, settings):
    async with factory() as db, db.begin():
        await quota.reserve(db, item, settings)


async def dispatch(factory, item, settings, content="offline input"):
    async with factory() as db, db.begin():
        await quota.dispatch(
            db, item, settings, [{"role": "user", "content": content}], "fixed system"
        )


def test_invitation_is_single_use_and_account_can_only_receive_one_grant(ledger):
    async def scenario(factory, settings):
        owner = SimpleNamespace(id=uuid4(), status="active", email_verified_at=quota.now())
        other = SimpleNamespace(id=uuid4(), status="active", email_verified_at=quota.now())
        async with factory() as db, db.begin():
            db.add(
                BetaInvitation(
                    code_hash=quota.invitation_hash(CODE),
                    grant_requests=4,
                    expires_at=quota.now() + timedelta(days=1),
                    grant_expires_at=quota.now() + timedelta(days=7),
                )
            )
        async with factory() as db, db.begin():
            first = await quota.claim(db, owner, CODE, settings)
            again = await quota.claim(db, owner, CODE, settings)
            assert first is again and again.granted == 4
        with pytest.raises(quota.QuotaRejected):
            async with factory() as db, db.begin():
                await quota.claim(db, other, CODE, settings)
        async with factory() as db:
            assert await db.scalar(select(func.count()).select_from(BetaAccount)) == 1
            invitation = await db.get(BetaInvitation, quota.invitation_hash(CODE))
            assert invitation.claimed_by == owner.id and invitation.code_hash != CODE

    run(ledger, scenario)


def test_unverified_accounts_and_expired_invites_do_not_gain_credit(ledger):
    async def scenario(factory, settings):
        user = SimpleNamespace(id=uuid4(), status="active", email_verified_at=None)
        with pytest.raises(quota.QuotaRejected) as error:
            async with factory() as db, db.begin():
                await quota.claim(db, user, CODE, settings)
        assert error.value.code == "BETA_VERIFIED_ACCOUNT_REQUIRED"
        user.email_verified_at = quota.now()
        async with factory() as db, db.begin():
            db.add(
                BetaInvitation(
                    code_hash=quota.invitation_hash(CODE),
                    grant_requests=4,
                    expires_at=quota.now() - timedelta(seconds=1),
                    grant_expires_at=quota.now() + timedelta(days=7),
                )
            )
        with pytest.raises(quota.QuotaRejected):
            async with factory() as db, db.begin():
                await quota.claim(db, user, CODE, settings)

    run(ledger, scenario)


@pytest.mark.parametrize("terminal", ["completed", "failed", "cancelled"])
def test_dispatched_terminal_states_charge_once_even_without_usage(ledger, terminal):
    async def scenario(factory, settings):
        owner = await seed(factory)
        item = generation(owner)
        await reserve(factory, item, settings)
        await dispatch(factory, item, settings)
        with pytest.raises(quota.QuotaRejected):
            await dispatch(factory, item, settings)
        item.state = terminal
        for _ in range(2):
            async with factory() as db, db.begin():
                await quota.settle(db, item)
        async with factory() as db:
            account = await db.get(BetaAccount, owner)
            day = await db.get(BetaDay, quota.now().date())
            assert (account.spent, account.reserved, account.active) == (1, 0, 0)
            assert (day.spent_requests, day.spent_cost, day.reserved_cost) == (1, 100, 0)
            assert await db.scalar(select(func.count()).select_from(BetaQuotaEvent)) == 3

    run(ledger, scenario)


def test_pre_dispatch_failure_releases_credit_and_idempotency_does_not_double_reserve(ledger):
    async def scenario(factory, settings):
        owner = await seed(factory)
        item = generation(owner)
        await reserve(factory, item, settings)
        await reserve(factory, item, settings)
        item.state = "cancelled"
        async with factory() as db, db.begin():
            await quota.settle(db, item)
        async with factory() as db:
            account = await db.get(BetaAccount, owner)
            assert (account.spent, account.reserved, account.active) == (0, 0, 0)
        await reserve(factory, generation(owner), settings)

    run(ledger, scenario)


def test_account_concurrency_and_daily_limits_span_pet_and_session_boundaries(ledger):
    async def scenario(factory, settings):
        owner = await seed(factory)
        first = generation(owner)
        await reserve(factory, first, settings)
        with pytest.raises(quota.QuotaRejected) as error:
            await reserve(factory, generation(owner), settings)
        assert error.value.code == "BETA_ACCOUNT_LIMIT"
        for index in range(2):
            item = first if index == 0 else generation(owner)
            if index:
                await reserve(factory, item, settings)
            await dispatch(factory, item, settings)
            item.state = "completed"
            async with factory() as db, db.begin():
                await quota.settle(db, item)
        with pytest.raises(quota.QuotaRejected):
            await reserve(factory, generation(owner), settings)

    run(ledger, scenario)


@pytest.mark.parametrize(
    "changes", [{"beta_global_daily_requests": 1}, {"beta_global_daily_budget_microusd": 100}]
)
def test_global_request_and_budget_caps_apply_across_accounts(ledger, changes):
    async def scenario(factory, settings):
        settings = settings.model_copy(update=changes)
        first, second = await seed(factory), await seed(factory)
        await reserve(factory, generation(first), settings)
        with pytest.raises(quota.QuotaRejected) as error:
            await reserve(factory, generation(second), settings)
        assert error.value.code == "BETA_DAILY_BUDGET_EXHAUSTED"

    run(ledger, scenario)


@pytest.mark.parametrize(
    "changes",
    [
        {"beta_quota_enabled": False},
        {"beta_pricing_version": "changed"},
        {"deepseek_max_tokens": 1024},
    ],
)
def test_dispatch_rechecks_policy_instead_of_reusing_admission(ledger, changes):
    async def scenario(factory, settings):
        item = generation(await seed(factory))
        await reserve(factory, item, settings)
        with pytest.raises(quota.QuotaRejected):
            await dispatch(factory, item, settings.model_copy(update=changes))
        async with factory() as db:
            assert (await db.get(BetaReservation, item.id)).state == "reserved"

    run(ledger, scenario)


def test_input_limit_and_cross_midnight_expiry_prevent_dispatch(ledger, monkeypatch):
    async def scenario(factory, settings):
        item = generation(await seed(factory))
        await reserve(factory, item, settings)
        with pytest.raises(quota.QuotaRejected) as error:
            await dispatch(factory, item, settings, "私密正文" * 20000)
        assert error.value.code == "BETA_INPUT_LIMIT"
        future = quota.now() + timedelta(days=1)
        monkeypatch.setattr(quota, "now", lambda: future)
        with pytest.raises(quota.QuotaRejected) as error:
            await dispatch(factory, item, settings)
        assert error.value.code == "BETA_RESERVATION_EXPIRED"

    run(ledger, scenario)


def test_usage_contract_violation_opens_global_breaker(ledger):
    async def scenario(factory, settings):
        owner = await seed(factory)
        item = generation(owner)
        await reserve(factory, item, settings)
        await dispatch(factory, item, settings)
        item.state, item.usage = "completed", {"input_tokens": 2, "output_tokens": 99999}
        async with factory() as db, db.begin():
            await quota.settle(db, item)
        with pytest.raises(quota.QuotaRejected) as error:
            await reserve(factory, generation(await seed(factory)), settings)
        assert error.value.code == "BETA_DAILY_BUDGET_EXHAUSTED"

    run(ledger, scenario)


def test_mock_bypasses_no_paid_budget_and_missing_or_corrupt_schema_fails_closed(ledger):
    async def scenario(factory, settings):
        item = generation(uuid4(), provider="mock", model=None)
        async with factory() as db, db.begin():
            await db.execute(text("DROP TABLE beta_quota_events"))
            await quota.reserve(db, item, settings)
            await quota.dispatch(db, item, settings, [], "")
        with pytest.raises(quota.QuotaRejected):
            await reserve(factory, generation(uuid4()), settings)

    run(ledger, scenario)


def test_online_migration_never_uses_an_implicit_database_url():
    from pathlib import Path

    config = Config(str(Path(__file__).parents[1] / "beta_quota_alembic.ini"))
    with pytest.raises(RuntimeError, match="Explicit verified target"):
        command.upgrade(config, "head")


def test_beta_policy_defaults_deny_and_enablement_needs_explicit_cost_attestation():
    from pydantic import ValidationError

    assert Settings().beta_quota_enabled is False
    with pytest.raises(ValidationError):
        Settings(beta_quota_enabled=True)


def production_options():
    from pydantic import SecretStr

    return {
        "environment": "production",
        "demo_enabled": False,
        "database_url": SecretStr("postgresql+psycopg://offline:fixture@127.0.0.1:1/p83"),
        "redis_url": SecretStr("redis://127.0.0.1:1/0"),
        "frontend_origin": "https://beta.weibiye.test",
        "cors_origins": ["https://beta.weibiye.test"],
        "cookie_secure": True,
        "require_verified_email": True,
        "auth_store_backend": "redis",
        "rate_limit_backend": "redis",
        "llm_provider": "mock",
        "real_llm_enabled": False,
        "beta_quota_enabled": True,
        "beta_pricing_attested": True,
        "beta_pricing_version": "p83-offline-synthetic",
        "beta_request_ceiling_microusd": 100,
        "beta_global_daily_budget_microusd": 1000,
    }


@pytest.mark.parametrize("mock_mail", [False, True])
def test_production_beta_rejects_missing_or_mock_mail_before_opening_database(mock_mail):
    from app.main import create_app
    from app.modules.auth.mail import MockMailSender

    settings = Settings(**production_options())
    with pytest.raises(ValueError, match="real mail sender"):
        create_app(settings, mailer=MockMailSender() if mock_mail else None)


def test_production_real_model_cannot_start_without_hard_quota():
    from pydantic import SecretStr, ValidationError

    options = production_options() | {
        "llm_provider": "deepseek",
        "real_llm_enabled": True,
        "deepseek_api_key": SecretStr("p83-sdk-mock-never-real"),
        "beta_quota_enabled": False,
    }
    with pytest.raises(ValidationError, match="server quota"):
        Settings(**options)
