"""Actual isolated PostgreSQL, separate processes, no SDK or shared database access."""

import asyncio
import multiprocessing
import os
from concurrent.futures import ProcessPoolExecutor
from datetime import timedelta
from pathlib import Path
from types import SimpleNamespace
from uuid import UUID, uuid4

import pytest
from alembic import command
from alembic.config import Config
from beta_helpers import beta_settings, install_beta_schema
from sqlalchemy import create_engine, func, select, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.config import Settings
from app.core.event_loop import new_event_loop
from app.modules.beta_quota import service as quota
from app.modules.beta_quota.models import BetaAccount, BetaDay, BetaInvitation, BetaReservation
from app.modules.users.models import User
from scripts.p83_test_target import load_target

BARRIER = None


def initialize(barrier):
    global BARRIER
    BARRIER = barrier


def worker(url, schema, owner, operation, generation_id, changes):
    global BARRIER
    settings = beta_settings(Settings(environment="test"), **changes)

    async def perform():
        engine = create_async_engine(
            url,
            pool_size=1,
            max_overflow=0,
            connect_args={
                "options": f"-csearch_path={schema} -clock_timeout=5000 -cstatement_timeout=15000"
            },
        )
        factory = async_sessionmaker(engine, expire_on_commit=False)
        try:
            async with factory() as db, db.begin():
                user = await db.scalar(select(User).where(User.id == UUID(owner)).with_for_update())
                item = SimpleNamespace(
                    id=UUID(generation_id),
                    owner_id=user.id,
                    provider="deepseek",
                    model="deepseek-flash",
                    state="running",
                    usage=None,
                )
                try:
                    if operation == "reserve":
                        await quota.reserve(db, item, settings)
                    elif operation == "dispatch":
                        await quota.dispatch(
                            db, item, settings, [{"role": "user", "content": "offline"}], "fixed"
                        )
                    else:
                        await quota.claim(
                            db, user, "p83-postgres-offline-invitation-00000001", settings
                        )
                    return "admitted"
                except quota.QuotaRejected as error:
                    return error.code
        finally:
            await engine.dispose()

    if BARRIER is not None:
        BARRIER.wait(timeout=30)
        BARRIER = None
    return asyncio.run(perform(), loop_factory=new_event_loop)


@pytest.fixture
def postgres():
    supplied = os.environ.get("WEIBIYE_P83_POSTGRES_TARGET")
    if not supplied:
        pytest.skip("Explicit newly-created P83 PostgreSQL target required")
    target, url = load_target(supplied)
    # Only this attested new DB receives schemas. No defaults, shared DSNs or drop.
    outer = create_engine(url, connect_args={"connect_timeout": 5})
    schema = "p83_" + uuid4().hex
    with outer.begin() as connection:
        assert connection.scalar(text("select current_database()")) == "p83_fixture"
        connection.execute(text(f'CREATE SCHEMA "{schema}"'))
    outer.dispose()
    engine = create_engine(url, connect_args={"options": f"-csearch_path={schema}"})
    config = Config(str(Path(__file__).parents[2] / "alembic.ini"))
    with engine.begin() as connection:
        config.attributes["connection"] = connection
        command.upgrade(config, "head")
    install_beta_schema(engine)
    yield engine, url, schema, target
    engine.dispose()


def accounts(engine, count):
    owners = [uuid4() for _ in range(count)]
    with engine.begin() as db:
        for owner in owners:
            db.execute(
                User.__table__.insert().values(
                    id=owner,
                    email=f"p83-{owner.hex}@example.com",
                    password_hash="not-a-login-hash",
                    display_name="offline",
                    role="user",
                    status="active",
                    email_verified_at=quota.now(),
                )
            )
            db.execute(
                BetaAccount.__table__.insert().values(
                    owner_id=owner,
                    granted=20,
                    reserved=0,
                    spent=0,
                    active=0,
                    expires_at=quota.now() + timedelta(days=7),
                )
            )
    return owners


def simultaneous(
    url, schema, owners, operation="reserve", generation_id=None, workers=None, **changes
):
    context = multiprocessing.get_context("spawn")
    size = min(workers or len(owners), len(owners))
    barrier = context.Barrier(size)
    with ProcessPoolExecutor(
        max_workers=size, mp_context=context, initializer=initialize, initargs=(barrier,)
    ) as pool:
        futures = [
            pool.submit(
                worker, url, schema, str(owner), operation, str(generation_id or uuid4()), changes
            )
            for owner in owners
        ]
        return [future.result(timeout=60) for future in futures]


def test_hundred_synthetic_accounts_cannot_overspend_daily_budget(postgres):
    engine, url, schema, _ = postgres
    outcomes = simultaneous(
        url,
        schema,
        accounts(engine, 100),
        workers=8,
        beta_global_daily_requests=9,
        beta_global_daily_budget_microusd=550,
    )
    assert outcomes.count("admitted") == 5
    assert outcomes.count("BETA_DAILY_BUDGET_EXHAUSTED") == 95
    with engine.connect() as db:
        day = db.execute(select(BetaDay.__table__)).mappings().one()
        assert day["reserved_requests"] == 5 and day["reserved_cost"] == 500


@pytest.mark.parametrize(
    "changes,expected",
    [
        ({"beta_global_daily_requests": 3, "beta_global_daily_budget_microusd": 1000}, 3),
        ({"beta_global_daily_requests": 10, "beta_global_daily_budget_microusd": 250}, 2),
    ],
)
def test_global_caps_cannot_be_overspent_by_separate_processes(postgres, changes, expected):
    engine, url, schema, _ = postgres
    outcomes = simultaneous(url, schema, accounts(engine, 6), **changes)
    assert outcomes.count("admitted") == expected, outcomes
    with engine.connect() as db:
        assert db.scalar(select(func.count()).select_from(BetaReservation)) == expected
        day = db.execute(select(BetaDay.__table__)).mappings().one()
        assert day["reserved_requests"] == expected and day["reserved_cost"] == expected * 100


def test_account_concurrency_is_not_a_process_local_lock(postgres):
    engine, url, schema, _ = postgres
    owner = accounts(engine, 1)[0]
    outcomes = simultaneous(url, schema, [owner] * 5)
    assert outcomes.count("admitted") == 1, outcomes
    assert outcomes.count("BETA_ACCOUNT_LIMIT") == 4


def test_dispatched_generation_cannot_be_admitted_twice_after_worker_restart(postgres):
    engine, url, schema, _ = postgres
    owner = accounts(engine, 1)[0]
    generation_id = uuid4()
    with engine.begin() as db:
        db.execute(
            BetaDay.__table__.insert().values(
                day=quota.now().date(),
                reserved_requests=1,
                spent_requests=0,
                reserved_cost=100,
                spent_cost=0,
                blocked=False,
            )
        )
        db.execute(
            BetaAccount.__table__.update()
            .where(BetaAccount.owner_id == owner)
            .values(reserved=1, active=1)
        )
        db.execute(
            BetaReservation.__table__.insert().values(
                generation_id=generation_id,
                owner_id=owner,
                day=quota.now().date(),
                provider="deepseek",
                model="deepseek-flash",
                pricing_version="p83-offline-synthetic",
                ceiling_microusd=100,
                input_bytes_limit=32768,
                output_tokens_limit=512,
                state="reserved",
                created_at=quota.now(),
            )
        )
    outcomes = simultaneous(url, schema, [owner] * 2, "dispatch", generation_id)
    assert outcomes.count("admitted") == 1, outcomes
    assert outcomes.count("BETA_DISPATCH_ALREADY_ADMITTED") == 1


def test_one_invitation_cannot_be_redeemed_by_two_accounts(postgres):
    engine, url, schema, _ = postgres
    owners = [uuid4(), uuid4()]
    with engine.begin() as db:
        for owner in owners:
            db.execute(
                User.__table__.insert().values(
                    id=owner,
                    email=f"p83-{owner.hex}@example.com",
                    password_hash="not-a-login-hash",
                    display_name="offline",
                    role="user",
                    status="active",
                    email_verified_at=quota.now(),
                )
            )
        db.execute(
            BetaInvitation.__table__.insert().values(
                code_hash=quota.invitation_hash("p83-postgres-offline-invitation-00000001"),
                grant_requests=20,
                expires_at=quota.now() + timedelta(days=1),
                grant_expires_at=quota.now() + timedelta(days=7),
            )
        )
    outcomes = simultaneous(url, schema, owners, "claim")
    assert outcomes.count("admitted") == 1, outcomes
    with engine.connect() as db:
        assert db.scalar(select(func.count()).select_from(BetaAccount)) == 1
