"""Bounded offline pipeline. No public route, provider SDK, QQ URL or arbitrary tools."""

import asyncio
from collections.abc import Callable
from dataclasses import asdict, dataclass

from .contracts import (
    Context,
    ContextReader,
    ModelRequest,
    Receipt,
    Rejected,
    ReplyChannel,
    Scope,
    SendNotAccepted,
    SendUncertain,
    Usage,
    uuid,
)
from .mocks import MockModel, MockQQAdapter, mock_input_tokens
from .pricing import ExamplePricing, Limits
from .safety import plain, screen_input, screen_output
from .store import MockStore


@dataclass(frozen=True)
class Result:
    status: str
    key: str | None = None
    replay: bool = False


@dataclass(repr=False)
class Pending:
    receipt: Receipt
    scope: Scope
    stamp: str
    text: str
    usage: Usage
    cost: int
    timer: asyncio.TimerHandle | None = None


class _PetChannelEngine:
    """Shared execution mechanics; public factories must enforce their own mode gates."""

    _reply_label = "【AI宠物·本地Mock】"
    _binding_label = "仅本地Mock绑定确认码："
    _audit_channel = "qq-mock-c2c"

    def __init__(
        self,
        store: MockStore,
        reader: ContextReader,
        model: MockModel,
        adapter: ReplyChannel,
        *,
        now: Callable[[], int],
        limits: Limits | None = None,
        pricing: ExamplePricing | None = None,
    ):
        self.store, self.reader, self.model, self.adapter, self.now = (
            store,
            reader,
            model,
            adapter,
            now,
        )
        self.limits, self.pricing = limits or Limits(), pricing or ExamplePricing()
        self._models = asyncio.Semaphore(self.limits.concurrent_models)
        self._sending = asyncio.Lock()
        self._pending: dict[str, Pending] = {}
        self._tasks: set[asyncio.Task] = set()
        self.closed = False

    def _context(self, context: Context, scope: Scope) -> str:
        if (
            context.owner != uuid(scope.owner)
            or context.pet != uuid(scope.pet)
            or context.persona_version < 1
            or context.privacy_epoch < 0
            or context.tone not in {"warm", "playful", "calm"}
            or len(context.memories) > 3
            or (context.memories and not scope.memory_allowed)
            or len(context.description) > 600
            or len(context.name) > 60
        ):
            raise Rejected("CONTEXT_SCOPE_DENIED")
        plain(context.name, 240)
        for memory in context.memories:
            if memory.owner != scope.owner or memory.pet != scope.pet or memory.version < 1:
                raise Rejected("MEMORY_SCOPE_DENIED")
            uuid(memory.id)
            uuid(memory.grant)
            plain(memory.content, 3000)
        return self.store.digest("context", asdict(context))

    async def start_binding(self, owner: str, pet: str, bot: str) -> str:
        if self.closed:
            raise Rejected("CHANNEL_CLOSED")
        context = await self.reader.read(uuid(owner), uuid(pet), allow_memory=False)
        if context.owner != owner or context.pet != pet:
            raise Rejected("PET_ACCESS_DENIED")
        return self.store.start_binding(owner, pet, bot, self.now())

    async def prove_binding(self, body: bytes, signature: str, token: str) -> None:
        if self.closed:
            raise Rejected("CHANNEL_CLOSED")
        task = asyncio.create_task(self._prove_binding(body, signature, token))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        await task

    async def _prove_binding(self, body: bytes, signature: str, token: str) -> None:
        receipt = self.adapter.verify(body, signature, self.now())
        confirmation = self.store.observe_binding(receipt, token, self.now())
        # Fixed control reply to the verified inbound sender, never a model recipient.
        await asyncio.wait_for(
            self.adapter.reply(receipt, self._binding_label + confirmation, sequence=1),
            self.limits.send_timeout_seconds,
        )

    async def confirm_binding(self, owner: str, token: str, confirmation: str, *, memory=False):
        if self.closed:
            raise Rejected("CHANNEL_CLOSED")
        row = self.store.binding_request(owner, token)
        context = await self.reader.read(owner, row["pet"], allow_memory=False)
        if context.owner != owner or context.pet != row["pet"]:
            raise Rejected("PET_ACCESS_DENIED")
        self.store.confirm_binding(owner, token, confirmation, self.now(), memory=memory)

    def _check_scope(self, scope: Scope, receipt: Receipt):
        if self.closed:
            raise Rejected("CHANNEL_CLOSED")
        if self.now() - receipt.timestamp > self.limits.reply_age_seconds:
            raise Rejected("REPLY_EXPIRED")
        if self.store.binding(receipt) != scope:
            raise Rejected("BINDING_CHANGED")

    async def _fresh(self, scope: Scope, receipt: Receipt, stamp: str | None = None) -> Context:
        self._check_scope(scope, receipt)
        context = await self.reader.read(scope.owner, scope.pet, allow_memory=scope.memory_allowed)
        # The reader may yield to another task that pauses/revokes this channel.
        self._check_scope(scope, receipt)
        current = self._context(context, scope)
        if stamp is not None and current != stamp:
            raise Rejected("PRIVACY_CHANGED")
        return context

    async def receive(self, body: bytes, signature: str) -> Result:
        return await self._receive(body, signature, wait=True)

    async def enqueue(self, body: bytes, signature) -> Result:
        """Acknowledge only after metadata admission; no raw text survives a crash."""
        return await self._receive(body, signature, wait=False)

    async def _receive(self, body: bytes, signature, *, wait: bool) -> Result:
        try:
            if self.closed:
                raise Rejected("CHANNEL_CLOSED")
            receipt = self.adapter.verify(body, signature, self.now())
            scope = self.store.binding(receipt)
            content = screen_input(receipt.text)
            ceiling = self.pricing.cost_micro_usd(
                Usage(self.limits.input_tokens, self.limits.output_tokens)
            )
            key, admitted = self.store.admission(
                receipt,
                scope,
                self.now(),
                ceiling,
                self.limits,
                self.pricing.version,
                channel=self._audit_channel,
            )
            if not admitted:
                return Result(self.store.state(scope.owner, key)["status"], key, True)
            task = asyncio.create_task(self._process(receipt, scope, key, content))
            self._tasks.add(task)
            task.add_done_callback(self._tasks.discard)
            return await task if wait else Result("admitted", key)
        except Rejected as error:
            return Result(error.code)

    async def _process(self, receipt, scope, key, content):
        acquired, usage, cost = False, None, None
        status = "blocked"
        try:
            await asyncio.wait_for(self._models.acquire(), self.limits.queue_timeout_seconds)
            acquired = True
            context = await self._fresh(scope, receipt)
            request = ModelRequest(scope.conversation_id, context, content)
            stamp = self._context(context, scope)
            if mock_input_tokens(request) > self.limits.input_tokens:
                raise Rejected("CONTEXT_LIMIT")
            self.store.mark(scope.owner, key, "generating")
            try:
                candidate = await asyncio.wait_for(
                    self.model.generate(request), self.limits.model_timeout_seconds
                )
            except TimeoutError:
                status = "model_timeout"
                return Result(status, key)
            usage = candidate.usage
            if (
                usage.input_tokens > self.limits.input_tokens
                or usage.output_tokens > self.limits.output_tokens
            ):
                raise Rejected("INVALID_SIMULATED_USAGE")
            cost = self.pricing.cost_micro_usd(usage)
            text = screen_output(
                self._reply_label + candidate.text,
                protected=self.store.protected(scope.owner),
            )
            pending = Pending(receipt, scope, stamp, text, usage, cost)
            status = await self._deliver(key, pending)
            if status == "delivery_failed":
                await self._fresh(scope, receipt, stamp)
                self._remember(key, pending)
            return Result(status, key)
        except asyncio.CancelledError:
            status = "abandoned"
            raise
        except TimeoutError:
            status = "queue_timeout"
            return Result(status, key)
        except Rejected as error:
            if error.code == "INVALID_SIMULATED_USAGE":
                usage, cost = None, None
            status = "blocked"
            return Result(error.code, key)
        except Exception:
            status = "model_failed"
            return Result(status, key)
        finally:
            self.store.finish(scope.owner, key, status, usage, cost)
            if acquired:
                self._models.release()

    async def _deliver(self, key: str, pending: Pending) -> str:
        async with self._sending:
            await self._fresh(pending.scope, pending.receipt, pending.stamp)
            self.store.mark(pending.scope.owner, key, "sending")
            try:
                await asyncio.wait_for(
                    self.adapter.reply(pending.receipt, pending.text, sequence=1),
                    self.limits.send_timeout_seconds,
                )
                return "sent"
            except SendNotAccepted:
                return "delivery_failed"
            except (SendUncertain, TimeoutError):
                return "delivery_unknown"
            except Exception:
                # A generic transport error cannot prove that nothing was sent.
                return "delivery_unknown"

    def _forget(self, key):
        value = self._pending.pop(key, None)
        if value:
            value.timer.cancel()

    def _remember(self, key, value):
        if len(self._pending) >= self.limits.pending:
            self._forget(next(iter(self._pending)))
        seconds = max(0, value.receipt.timestamp + self.limits.reply_age_seconds - self.now())
        value.timer = asyncio.get_running_loop().call_later(seconds, self._forget, key)
        self._pending[key] = value

    async def retry_delivery(self, owner: str, key: str) -> Result:
        if self.closed:
            raise Rejected("CHANNEL_CLOSED")
        task = asyncio.create_task(self._retry_delivery(owner, key))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        return await task

    async def _retry_delivery(self, owner: str, key: str) -> Result:
        pending = self._pending.get(key)
        if not pending or pending.scope.owner != uuid(owner):
            raise Rejected("RETRY_UNAVAILABLE")
        row = self.store.state(owner, key)
        if row["status"] != "delivery_failed" or row["delivery_attempts"] >= 2:
            raise Rejected("RETRY_UNAVAILABLE")
        try:
            status = await self._deliver(key, pending)
        except asyncio.CancelledError:
            self.store.finish(owner, key, "delivery_unknown", pending.usage, pending.cost)
            self._forget(key)
            raise
        except Rejected:
            self._forget(key)
            raise
        self.store.finish(owner, key, status, pending.usage, pending.cost)
        self._forget(key)
        return Result(status, key)

    def pause(self, bot: str | None = None):
        self.store.pause(bot)
        for key, value in list(self._pending.items()):
            if bot is None or value.scope.bot == bot:
                self._forget(key)

    def revoke(self, owner, bot, subject_hash):
        self.store.revoke(owner, bot, subject_hash)
        for key, value in list(self._pending.items()):
            if (
                value.scope.owner == owner
                and value.scope.bot == bot
                and value.scope.subject_hash == subject_hash
            ):
                self._forget(key)

    async def close(self):
        self.closed = True
        for task in list(self._tasks):
            task.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        for key in list(self._pending):
            self._forget(key)
        self.model.requests.clear()
        self.adapter.clear_captures()


class MockPetChannel(_PetChannelEngine):
    def __init__(self, store, reader, model, adapter, **options):
        if (
            not isinstance(model, MockModel)
            or not isinstance(adapter, MockQQAdapter)
            or model.name != "mock-pet-v1"
            or adapter.name != "mock-qq-only"
        ):
            raise Rejected("LIVE_CHANNEL_DISABLED")
        super().__init__(store, reader, model, adapter, **options)
