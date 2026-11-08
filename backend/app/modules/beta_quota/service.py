"""Caller-owned transactions. Lock order: User/Chat -> UTC day -> account -> reservation.

Money fields are conservative budget reservations, NOT supplier invoice amounts.
No model key, prompt, response, raw invitation or arbitrary error is persisted here.
"""

import hashlib
import json
import re
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, inspect, select, text

from app.core.errors import AppError
from app.modules.beta_quota.models import (
    BetaAccount,
    BetaBase,
    BetaDay,
    BetaInvitation,
    BetaQuotaEvent,
    BetaReservation,
)

QUOTA_TABLES = frozenset(
    {
        "beta_invitations",
        "beta_quota_accounts",
        "beta_quota_days",
        "beta_quota_reservations",
        "beta_quota_events",
    }
)


class QuotaRejected(AppError):
    def __init__(self, code="BETA_QUOTA_UNAVAILABLE", status=429):
        super().__init__(status, code, "内测额度或请求预算暂不可用，请稍后查看额度。")


def now():
    return datetime.now(UTC)


def aware(value):
    return value.replace(tzinfo=value.tzinfo or UTC).astimezone(UTC)


async def clock(db):
    # All production workers use the database clock, not per-machine UTC skew.
    if db.bind.dialect.name == "postgresql":
        return aware(await db.scalar(select(func.clock_timestamp())))
    return now()


async def schema_ready(db, *, required=False):
    connection = await db.connection()
    present = await connection.run_sync(lambda c: inspect(c).has_table("beta_quota_schema_version"))
    if not present:
        if required:
            raise QuotaRejected(status=503)
        return False
    versions = list(
        (await db.execute(text("SELECT version_num FROM beta_quota_schema_version"))).scalars()
    )

    def manifest_matches(c):
        inspector = inspect(c)
        if not QUOTA_TABLES.issubset(inspector.get_table_names()):
            return False
        for name, table in BetaBase.metadata.tables.items():
            if name not in QUOTA_TABLES:
                continue
            columns = {item["name"]: item for item in inspector.get_columns(name)}
            if any(
                column.name not in columns or column.nullable != columns[column.name]["nullable"]
                for column in table.columns
            ):
                return False
            if set(inspector.get_pk_constraint(name)["constrained_columns"]) != {
                c.name for c in table.primary_key.columns
            }:
                return False
            unique = {
                tuple(item["column_names"]) for item in inspector.get_unique_constraints(name)
            }
            expected = {
                tuple(c.name for c in constraint.columns)
                for constraint in table.constraints
                if constraint.__class__.__name__ == "UniqueConstraint"
            }
            if not expected.issubset(unique):
                return False
        return True

    if (
        len(versions) != 1
        or versions[0] not in {"q0001", "q0002"}
        or not await connection.run_sync(manifest_matches)
    ):
        raise QuotaRejected(status=503)
    return True


def enabled(settings):
    return bool(getattr(settings, "beta_quota_enabled", False))


def valid_policy(settings):
    if not enabled(settings) or not settings.beta_pricing_attested:
        raise QuotaRejected("BETA_QUOTA_DISABLED", 503)
    if (
        settings.beta_request_ceiling_microusd <= 0
        or settings.beta_global_daily_budget_microusd <= 0
    ):
        raise QuotaRejected(status=503)


def invitation_hash(code):
    if not isinstance(code, str) or not re.fullmatch(r"[A-Za-z0-9_-]{32,128}", code):
        raise QuotaRejected("BETA_INVITATION_UNAVAILABLE", 409)
    return hashlib.sha256(code.encode("ascii")).hexdigest()


async def claim(db, user, code, settings):
    valid_policy(settings)
    await schema_ready(db, required=True)
    if user.status != "active" or user.email_verified_at is None:
        raise QuotaRejected("BETA_VERIFIED_ACCOUNT_REQUIRED", 403)
    # Caller locks User, so duplicate claims for one account serialize across workers.
    account = await db.get(BetaAccount, user.id)
    if account is not None:
        return account
    invitation = await db.scalar(
        select(BetaInvitation)
        .where(BetaInvitation.code_hash == invitation_hash(code))
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    timestamp = await clock(db)
    if (
        invitation is None
        or invitation.claimed_by is not None
        or aware(invitation.expires_at) <= timestamp
        or aware(invitation.grant_expires_at) <= timestamp
    ):
        raise QuotaRejected("BETA_INVITATION_UNAVAILABLE", 409)
    account = BetaAccount(
        owner_id=user.id,
        granted=invitation.grant_requests,
        reserved=0,
        spent=0,
        active=0,
        expires_at=invitation.grant_expires_at,
    )
    db.add(account)
    invitation.claimed_by, invitation.claimed_at = user.id, timestamp
    await db.flush()
    return account


async def _day(db, day):
    # An upsert creates exactly one lockable row even at midnight across workers.
    if db.bind.dialect.name == "postgresql":
        from sqlalchemy.dialects.postgresql import insert
    elif db.bind.dialect.name == "sqlite":
        from sqlalchemy.dialects.sqlite import insert
    else:
        raise QuotaRejected(status=503)
    await db.execute(
        insert(BetaDay)
        .values(
            day=day,
            reserved_requests=0,
            spent_requests=0,
            reserved_cost=0,
            spent_cost=0,
            blocked=False,
        )
        .on_conflict_do_nothing(index_elements=[BetaDay.day])
    )
    return await db.scalar(
        select(BetaDay)
        .where(BetaDay.day == day)
        .with_for_update()
        .execution_options(populate_existing=True)
    )


async def _daily_count(db, owner, day):
    return await db.scalar(
        select(func.count())
        .select_from(BetaReservation)
        .where(
            BetaReservation.owner_id == owner,
            BetaReservation.day == day,
            BetaReservation.state != "released",
        )
    )


def _event(db, reservation, kind, timestamp, delta=0):
    db.add(
        BetaQuotaEvent(
            generation_id=reservation.generation_id,
            kind=kind,
            at=timestamp,
            budget_delta_microusd=delta,
        )
    )


async def reserve(db, generation, settings):
    if generation.provider == "mock" or not enabled(settings):
        return
    valid_policy(settings)
    await schema_ready(db, required=True)
    if generation.provider != "deepseek" or generation.model != settings.beta_model:
        raise QuotaRejected("BETA_MODEL_NOT_ALLOWED", 403)
    timestamp = await clock(db)
    day = await _day(db, timestamp.date())
    account = await db.scalar(
        select(BetaAccount)
        .where(BetaAccount.owner_id == generation.owner_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    old = await db.get(BetaReservation, generation.id)
    if old is not None:
        if (old.owner_id, old.provider, old.model) != (
            generation.owner_id,
            generation.provider,
            generation.model,
        ):
            raise QuotaRejected(status=503)
        return
    ceiling = settings.beta_request_ceiling_microusd
    if (
        day.blocked
        or day.spent_requests + day.reserved_requests >= settings.beta_global_daily_requests
        or day.spent_cost + day.reserved_cost + ceiling > settings.beta_global_daily_budget_microusd
    ):
        raise QuotaRejected("BETA_DAILY_BUDGET_EXHAUSTED")
    if (
        account is None
        or aware(account.expires_at) <= timestamp
        or account.spent + account.reserved >= account.granted
    ):
        raise QuotaRejected("BETA_ACCOUNT_QUOTA_EXHAUSTED")
    if (
        account.active >= settings.beta_account_concurrent
        or await _daily_count(db, generation.owner_id, day.day)
        >= settings.beta_account_daily_requests
    ):
        raise QuotaRejected("BETA_ACCOUNT_LIMIT")
    row = BetaReservation(
        generation_id=generation.id,
        owner_id=generation.owner_id,
        day=day.day,
        provider=generation.provider,
        model=generation.model,
        pricing_version=settings.beta_pricing_version,
        ceiling_microusd=ceiling,
        input_bytes_limit=settings.beta_max_input_bytes,
        output_tokens_limit=settings.deepseek_max_tokens,
        state="reserved",
        created_at=timestamp,
    )
    day.reserved_requests += 1
    day.reserved_cost += ceiling
    account.reserved += 1
    account.active += 1
    db.add(row)
    await db.flush()
    _event(db, row, "reserved", timestamp, ceiling)
    await db.flush()


async def dispatch(db, generation, settings, messages, system_prompt):
    if generation.provider == "mock":
        return
    present = await schema_ready(
        db, required=enabled(settings) or settings.environment == "production"
    )
    if not present:
        return  # Existing explicitly authorized development P8.1 path only.
    valid_policy(settings)
    snapshot = await db.get(BetaReservation, generation.id)
    if snapshot is None:
        raise QuotaRejected(status=503)
    timestamp = await clock(db)
    day = await _day(db, snapshot.day)
    account = await db.scalar(
        select(BetaAccount)
        .where(BetaAccount.owner_id == generation.owner_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    row = await db.scalar(
        select(BetaReservation)
        .where(BetaReservation.generation_id == generation.id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    timestamp = await clock(db)
    if (
        row is None
        or row.state != "reserved"
        or (row.owner_id, row.provider, row.model)
        != (generation.owner_id, generation.provider, generation.model)
    ):
        raise QuotaRejected("BETA_DISPATCH_ALREADY_ADMITTED", 409)
    if timestamp.date() != row.day or timestamp - aware(row.created_at) > timedelta(minutes=5):
        raise QuotaRejected("BETA_RESERVATION_EXPIRED")
    if (
        day.blocked
        or day.spent_requests + day.reserved_requests > settings.beta_global_daily_requests
        or day.spent_cost + day.reserved_cost > settings.beta_global_daily_budget_microusd
    ):
        raise QuotaRejected("BETA_DAILY_BUDGET_EXHAUSTED")
    if (
        account is None
        or aware(account.expires_at) <= timestamp
        or account.active > settings.beta_account_concurrent
        or await _daily_count(db, generation.owner_id, row.day)
        > settings.beta_account_daily_requests
    ):
        raise QuotaRejected("BETA_ACCOUNT_LIMIT")
    if (
        row.model != settings.beta_model
        or row.pricing_version != settings.beta_pricing_version
        or row.ceiling_microusd != settings.beta_request_ceiling_microusd
        or settings.deepseek_max_tokens > row.output_tokens_limit
    ):
        raise QuotaRejected("BETA_POLICY_CHANGED", 503)
    payload = [{"role": "system", "content": system_prompt}, *messages]
    size = len(json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
    if size > min(row.input_bytes_limit, settings.beta_max_input_bytes):
        raise QuotaRejected("BETA_INPUT_LIMIT", 422)
    row.state, row.dispatched_at = "dispatched", timestamp
    _event(db, row, "dispatched", timestamp)
    await db.flush()
    # The caller MUST commit before constructing the provider stream. A second
    # worker/lease can never admit this generation again, including after crash.


async def settle(db, generation):
    if generation.provider == "mock" or not await schema_ready(db):
        return
    snapshot = await db.get(BetaReservation, generation.id)
    if snapshot is None:
        return
    day = await _day(db, snapshot.day)
    account = await db.scalar(
        select(BetaAccount)
        .where(BetaAccount.owner_id == generation.owner_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    row = await db.scalar(
        select(BetaReservation)
        .where(BetaReservation.generation_id == generation.id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if row.state in {"released", "settled"}:
        return
    if account is None or row.owner_id != generation.owner_id:
        raise QuotaRejected(status=503)
    dispatched = row.state == "dispatched"
    day.reserved_requests -= 1
    day.reserved_cost -= row.ceiling_microusd
    account.reserved -= 1
    account.active -= 1
    timestamp = await clock(db)
    row.state = "settled" if dispatched else "released"
    row.finished_at, row.outcome = timestamp, generation.state
    if dispatched:
        # Unknown/cancelled/failed supplier usage NEVER refunds an admitted call.
        day.spent_requests += 1
        day.spent_cost += row.ceiling_microusd
        account.spent += 1
        usage = generation.usage
        if (
            isinstance(usage, dict)
            and set(usage) == {"input_tokens", "output_tokens"}
            and all(type(v) is int and 0 <= v <= 1000000000 for v in usage.values())
        ):
            row.input_tokens, row.output_tokens = usage["input_tokens"], usage["output_tokens"]
            if (
                row.output_tokens > row.output_tokens_limit
                or row.input_tokens > row.input_bytes_limit + 4096
            ):
                day.blocked = True  # Contract violation: stop subsequent requests.
    _event(db, row, row.state, timestamp, 0 if dispatched else -row.ceiling_microusd)
    await db.flush()


async def snapshot(db, owner, settings):
    valid_policy(settings)
    await schema_ready(db, required=True)
    account = await db.get(BetaAccount, owner)
    if account is None:
        return {"claimed": False, "remaining": 0, "daily_remaining": 0, "active": 0}
    timestamp = await clock(db)
    remaining = (
        max(0, account.granted - account.reserved - account.spent)
        if aware(account.expires_at) > timestamp
        else 0
    )
    return {
        "claimed": True,
        "remaining": remaining,
        "daily_remaining": min(
            remaining,
            max(
                0,
                settings.beta_account_daily_requests
                - await _daily_count(db, owner, timestamp.date()),
            ),
        ),
        "active": account.active,
        "expires_at": account.expires_at,
    }
