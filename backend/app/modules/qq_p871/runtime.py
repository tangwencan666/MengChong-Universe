"""Explicit official-protocol sandbox, with the existing P8.7 guarded Mock model."""

import asyncio
from dataclasses import replace

from app.modules.qq_p87.contracts import Rejected, SendNotAccepted
from app.modules.qq_p87.mocks import MockModel
from app.modules.qq_p87.pricing import Limits
from app.modules.qq_p87.runtime import _PetChannelEngine

from .adapter import OfficialQQAdapter


class OfficialSandboxPetChannel(_PetChannelEngine):
    _reply_label = "【AI宠物·测试Mock】"
    _binding_label = "QQ测试绑定确认码："
    _audit_channel = "qq-official-sandbox-c2c"

    def __init__(self, store, reader, model, adapter, *, enable=False, **options):
        if not enable:
            raise Rejected("QQ_SANDBOX_DISABLED")
        if not isinstance(model, MockModel) or model.name != "mock-pet-v1":
            raise Rejected("QQ_PAID_MODEL_DISABLED")
        if not isinstance(adapter, OfficialQQAdapter):
            raise Rejected("QQ_OFFICIAL_ADAPTER_REQUIRED")
        options.setdefault("limits", replace(Limits(), send_timeout_seconds=12))
        self.control_status = "none"
        super().__init__(store, reader, model, adapter, **options)

    async def enqueue_binding(self, body, supplied, token):
        if self.closed:
            raise Rejected("CHANNEL_CLOSED")
        receipt = self.adapter.verify(body, supplied, self.now())
        confirmation = self.store.observe_binding(receipt, token, self.now())

        # The proof hash is committed before ACK; no waiting for token I/O.
        async def send():
            try:
                await asyncio.wait_for(
                    self.adapter.reply(receipt, self._binding_label + confirmation, sequence=1),
                    self.limits.send_timeout_seconds,
                )
                self.control_status = "sent"
            except SendNotAccepted:
                self.control_status = "rejected"
            except asyncio.CancelledError:
                self.control_status = "unknown"
                raise
            except Exception:
                self.control_status = "unknown"

        task = asyncio.create_task(send())
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _deliver(self, key, pending):
        async def guard():
            await self._fresh(pending.scope, pending.receipt, pending.stamp)

        self.adapter.guard_send(pending.receipt, guard)
        try:
            return await super()._deliver(key, pending)
        finally:
            self.adapter.guard_send(pending.receipt, None)

    def pause(self, bot=None):
        super().pause(bot)
        if bot is None or bot == self.adapter.protocol.app_id:
            self.adapter.http.allow_send = False

    async def close(self):
        await super().close()
        await self.adapter.close()
