import asyncio
from datetime import date, timedelta
from uuid import uuid4

import pytest
from beta_helpers import beta_settings, install_beta_schema
from pydantic import SecretStr, ValidationError
from sqlalchemy import func, select

from app.core.event_loop import new_event_loop
from app.db.session import build_database
from app.modules.beta_quota import privacy
from app.modules.beta_quota.privacy_models import BetaConsent, BetaTelemetryEvent
from app.modules.beta_quota.privacy_router import Event


def test_default_off_explicit_consent_idempotence_and_opt_out_erasure(auth_database):
    engine, base = auth_database
    install_beta_schema(engine)
    settings = beta_settings(
        base,
        beta_telemetry_enabled=True,
        beta_telemetry_hmac_key=SecretStr("p83-offline-only-hmac-never-production-0001"),
    )
    owner = uuid4()

    async def scenario():
        async_engine, factory = build_database(settings.database_url.get_secret_value())
        try:
            async with factory() as db, db.begin():
                assert await privacy.record(db, owner, settings, "active") is False
                assert await db.scalar(select(func.count()).select_from(BetaTelemetryEvent)) == 0
                await privacy.consent(db, owner, settings, True, privacy.POLICY)
                await privacy.record(db, owner, settings, "active")
                await privacy.record(db, owner, settings, "active")
                row = await db.get(BetaConsent, owner)
                assert len(row.subject) == 64 and owner.hex not in row.subject
            async with factory() as db, db.begin():
                assert await db.scalar(select(func.count()).select_from(BetaTelemetryEvent)) == 2
                await privacy.consent(db, owner, settings, False, privacy.POLICY)
                assert await db.scalar(select(func.count()).select_from(BetaTelemetryEvent)) == 0
                assert await privacy.record(db, owner, settings, "active") is False
        finally:
            await async_engine.dispose()

    asyncio.run(scenario(), loop_factory=new_event_loop)


def test_client_cannot_submit_chat_secrets_model_completions_or_installation_success():
    for payload in [
        {"kind": "active", "body": "private chat"},
        {"kind": "active", "api_key": "synthetic"},
        {"kind": "interaction_real"},
        {"kind": "install_success"},
        {"kind": "active", "day": "2026-11-02"},
    ]:
        with pytest.raises(ValidationError):
            Event.model_validate(payload)


def item(subject, kind, day, cohort, attempt=None):
    return {
        "subject": subject,
        "kind": kind,
        "day": day,
        "cohort_day": cohort,
        "attempt_hash": attempt,
    }


def test_retention_excludes_immature_cohorts_and_distinguishes_mock_from_real():
    today = date(2026, 11, 10)
    old, new = today - timedelta(days=7), today
    events = [
        item("old", "enrolled", old, old),
        item("new", "enrolled", new, new),
        item("old", "active", old + timedelta(days=1), old),
        item("old", "active", today, old),
        item("new", "interaction_mock", today, new),
    ]
    result = privacy.aggregate(events, today)
    assert result["D1"] == {"numerator": 1, "denominator": 1, "rate": 1.0}
    assert result["D7"] == {"numerator": 1, "denominator": 1, "rate": 1.0}
    assert result["first_interaction_real"]["numerator"] == 0
    assert result["first_interaction_mock"]["rate"] == 0.5
    assert privacy.aggregate([item("new", "enrolled", new, new)], today)["D7"]["rate"] is None


def test_installation_rate_requires_matching_attempt_and_never_uses_launch_as_denominator():
    today = date(2026, 11, 2)
    rows = [
        item("a", "install_attempt", today, today, "1"),
        item("a", "install_attempt", today, today, "2"),
        item("a", "install_success", today, today, "1"),
        item("b", "install_success", today, today, "unknown"),
        item("c", "active", today, today),
    ]
    assert privacy.aggregate(rows, today)["installation_success"] == {
        "numerator": 1,
        "denominator": 2,
        "rate": 0.5,
    }
    assert privacy.aggregate([], today)["installation_success"]["rate"] is None


def test_background_faults_are_not_user_retention_and_future_events_are_excluded():
    start = date(2026, 11, 1)
    rows = [
        item("a", "enrolled", start, start),
        item("a", "fault_network", start + timedelta(days=1), start),
        item("a", "active", start + timedelta(days=7), start),
    ]
    metrics = privacy.aggregate(rows, start + timedelta(days=1))
    assert metrics["D1"]["numerator"] == 0 and metrics["D7"]["denominator"] == 0
