"""Explicit consent, pseudonyms and daily enums. Never accepts arbitrary diagnostics."""

import hashlib
import hmac
import secrets
from datetime import timedelta

from sqlalchemy import delete, inspect, select, text

from app.core.errors import AppError
from app.modules.beta_quota.privacy_models import BetaConsent, BetaTelemetryEvent
from app.modules.beta_quota.service import now

POLICY = "beta-minimal-1"
CLIENT_EVENTS = frozenset({"active", "fault_network", "fault_startup", "fault_renderer"})
KINDS = CLIENT_EVENTS | {"enrolled", "interaction_mock", "interaction_real"}
NOTICE = (
    "默认不收集使用统计。开启后仅记录UTC日期、随机去标识化代号、主动使用、"
    "Mock或真实回复完成、固定故障类别，用于首次互动及D1/D7统计，最多保留30天。"
    "不收集聊天正文、记忆、密码、Token、API Key、IP、设备标识或任意错误文本。"
    "跨日统计需要关联代号，属于去标识化而非绝对匿名；后台同意记录仍关联账号。"
    "可随时关闭并删除对应事件，不影响聊天及免费额度。"
)


def available(settings):
    return bool(getattr(settings, "beta_telemetry_enabled", False))


async def require_schema(db):
    connection = await db.connection()
    names = await connection.run_sync(lambda c: set(inspect(c).get_table_names()))
    if not {
        "beta_telemetry_consents",
        "beta_telemetry_events",
        "beta_quota_schema_version",
    }.issubset(names):
        raise AppError(503, "BETA_METRICS_UNAVAILABLE", "统计存储尚未就绪。")
    if list(
        (await db.execute(text("SELECT version_num FROM beta_quota_schema_version"))).scalars()
    ) != ["q0002"]:
        raise AppError(503, "BETA_METRICS_UNAVAILABLE", "统计存储尚未就绪。")


async def status(db, owner, settings):
    if not available(settings):
        return {"available": False, "enabled": False, "policy_version": POLICY, "notice": NOTICE}
    row = await db.get(BetaConsent, owner)
    return {
        "available": True,
        "enabled": bool(row and row.enabled),
        "policy_version": POLICY,
        "notice": NOTICE,
    }


async def consent(db, owner, settings, enabled, policy):
    if not available(settings):
        raise AppError(503, "BETA_METRICS_DISABLED", "本环境未开启内测统计。")
    if policy != POLICY:
        raise AppError(409, "BETA_POLICY_CHANGED", "请先阅读当前统计说明。")
    row = await db.scalar(
        select(BetaConsent).where(BetaConsent.owner_id == owner).with_for_update()
    )
    timestamp = now()
    if row is None:
        row = BetaConsent(
            owner_id=owner, enabled=False, policy_version=POLICY, decided_at=timestamp
        )
        db.add(row)
    if not enabled:
        if row.subject:
            await db.execute(
                delete(BetaTelemetryEvent).where(BetaTelemetryEvent.subject == row.subject)
            )
        row.enabled, row.subject, row.cohort_day = False, None, None
    elif not row.enabled:
        material = owner.bytes + secrets.token_bytes(32)
        row.subject = hmac.new(
            settings.beta_telemetry_hmac_key.get_secret_value().encode(), material, hashlib.sha256
        ).hexdigest()
        row.enabled, row.cohort_day = True, timestamp.date()
    row.policy_version, row.decided_at = POLICY, timestamp
    await db.flush()
    if row.enabled:
        await record(db, owner, settings, "enrolled")


async def record(db, owner, settings, kind):
    if kind not in KINDS:
        raise ValueError("Unknown minimal telemetry event")
    if not available(settings):
        return False
    # Same User -> consent lock order as opt-out and generation finalization.
    row = await db.scalar(
        select(BetaConsent)
        .where(BetaConsent.owner_id == owner)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if row is None or not row.enabled or not row.subject:
        return False
    today = now().date()
    dedupe = hashlib.sha256(f"{row.subject}:{kind}:{today}".encode()).hexdigest()
    if (
        await db.scalar(
            select(BetaTelemetryEvent.id).where(BetaTelemetryEvent.dedupe_key == dedupe)
        )
        is None
    ):
        db.add(
            BetaTelemetryEvent(
                subject=row.subject,
                kind=kind,
                day=today,
                cohort_day=row.cohort_day,
                dedupe_key=dedupe,
            )
        )
        await db.flush()
    return True


async def prune(db):
    # Operator job only. There is no scheduler or automatic shared-DB mutation.
    await db.execute(
        delete(BetaTelemetryEvent).where(BetaTelemetryEvent.day < now().date() - timedelta(days=30))
    )


def aggregate(events, as_of):
    """Calendar-day UTC metrics for consenting cohorts; no immature D1/D7 denominator."""
    subjects, active, mock, real, attempts, successes = {}, set(), set(), set(), set(), set()
    for event in events:
        if event["day"] > as_of:
            continue
        subject, kind, day, cohort = (
            event[key] for key in ["subject", "kind", "day", "cohort_day"]
        )
        if kind == "enrolled":
            subjects[subject] = min(subjects.get(subject, cohort), cohort)
        if kind == "active":
            active.add((subject, day))
        if kind == "interaction_mock":
            mock.add(subject)
        if kind == "interaction_real":
            real.add(subject)
        if kind in {"install_attempt", "install_success"} and event.get("attempt_hash"):
            (attempts if kind == "install_attempt" else successes).add(
                (subject, event["attempt_hash"])
            )

    subjects = {
        subject: cohort
        for subject, cohort in subjects.items()
        if as_of - timedelta(days=30) <= cohort <= as_of
    }

    def rate(numerator, denominator):
        return {
            "numerator": numerator,
            "denominator": denominator,
            "rate": numerator / denominator if denominator else None,
        }

    def retention(days):
        eligible = {
            subject
            for subject, cohort in subjects.items()
            if cohort + timedelta(days=days) <= as_of
        }
        return rate(
            sum(
                (subject, subjects[subject] + timedelta(days=days)) in active
                for subject in eligible
            ),
            len(eligible),
        )

    return {
        "cohort": "explicitly-consenting-users",
        "calendar": "UTC",
        "installation_success": rate(len(attempts & successes), len(attempts)),
        "first_interaction_real": rate(len(real & subjects.keys()), len(subjects)),
        "first_interaction_mock": rate(len(mock & subjects.keys()), len(subjects)),
        "D1": retention(1),
        "D7": retention(7),
    }
