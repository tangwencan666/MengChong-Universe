import logging
from uuid import uuid4

import pytest
from pydantic import ValidationError

from app.agent.providers import MockLLM, OpenAIProvider, build_provider
from app.agent.sse import mock_demo_events
from app.core.config import Settings
from app.core.errors import AppError
from app.core.logging import RedactingFormatter
from app.core.security import Principal, Role, ensure_owner
from app.modules.community.schemas import PublicPost
from app.modules.wallet.service import AmountCommand


def test_real_model_has_two_explicit_gates(settings, monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError("Network client must not be constructed")

    monkeypatch.setattr("app.agent.providers.AsyncOpenAI", forbidden)
    assert isinstance(build_provider(settings), MockLLM)
    with pytest.raises(AppError, match="真实模型调用未启用"):
        OpenAIProvider(settings)
    with pytest.raises(ValidationError):
        Settings(llm_provider="openai", real_llm_enabled=False)


def test_production_and_cors_configuration_fail_closed():
    with pytest.raises(ValidationError):
        Settings(cors_origins=["*"])
    with pytest.raises(ValidationError):
        Settings(environment="production", demo_enabled=True)


def test_owner_boundary_even_for_admin():
    owner = uuid4()
    ensure_owner(Principal(owner), owner)
    with pytest.raises(AppError) as exc:
        ensure_owner(Principal(uuid4(), Role.ADMIN), owner)
    assert exc.value.status == 404


def test_public_post_dto_excludes_private_identity():
    assert not {"owner_id", "email", "password_hash"} & PublicPost.model_fields.keys()


@pytest.mark.parametrize("amount", [1.5, 1.0, "1", True, 0, -1, 9223372036854775808])
def test_wallet_rejects_noninteger_or_invalid_amount(amount):
    with pytest.raises(ValidationError):
        AmountCommand(amount=amount, idempotency_key="test-idempotency-01")


def test_logs_redact_and_omit_untrusted_exception_details():
    record = logging.LogRecord(
        "weibiye",
        logging.INFO,
        "test",
        1,
        "Bearer fictional-secret demo@example.com password=fictional",
        (),
        None,
    )
    record.authorization = "must-not-be-serialized"
    value = RedactingFormatter().format(record)
    assert "fictional" not in value and "demo@example.com" not in value
    assert "must-not-be" not in value


async def test_failed_stream_never_emits_done(monkeypatch):
    class FailingGraph:
        async def astream(self, *args, **kwargs):
            yield {"text": "partial"}
            raise RuntimeError("sensitive-provider-detail")

    monkeypatch.setattr("app.agent.sse.build_companion_graph", lambda _: FailingGraph())
    events = "".join([event async for event in mock_demo_events("demo", "request-test")])
    assert "event: error" in events
    assert "event: done" not in events
    assert "sensitive-provider" not in events
