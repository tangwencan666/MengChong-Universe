"""Existing ownership, memory, idempotency and Mock-only quota pipeline over WSS."""

from app.modules.qq_p87.contracts import Rejected, SendNotAccepted
from app.modules.qq_p871.adapter import OfficialQQAdapter
from app.modules.qq_p871.http import OfficialHTTP
from app.modules.qq_p871.runtime import OfficialSandboxPetChannel


class TestBudgetHTTP(OfficialHTTP):
    def __init__(self, *args, outbound_limit=2, **kwargs):
        if type(outbound_limit) is not int or not 1 <= outbound_limit <= 2:
            raise Rejected("QQ_WS_SEND_BUDGET_INVALID")
        super().__init__(*args, **kwargs)
        self.outbound_limit, self.outbound_attempts = outbound_limit, 0

    async def reply(self, *args, **kwargs):
        if self.outbound_attempts >= self.outbound_limit:
            raise SendNotAccepted("QQ_WS_SEND_BUDGET_EXHAUSTED")
        # Conservative attempts, not success count; no refund on uncertainty.
        self.outbound_attempts += 1
        return await super().reply(*args, **kwargs)


class WebSocketQQAdapter(OfficialQQAdapter):
    name = "qq-official-websocket-sandbox"


class WebSocketPetChannel(OfficialSandboxPetChannel):
    _audit_channel = "qq-official-ws-sandbox-c2c"
