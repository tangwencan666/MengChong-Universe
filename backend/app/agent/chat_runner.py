"""Single-process, database-backed private-chat execution supervisor.

Each database operation owns a short-lived AsyncSession. Providers and LangGraph
run outside transactions, and HTTP event readers only see committed event rows.
"""

import asyncio
import logging
from collections.abc import AsyncIterator
from contextlib import aclosing, asynccontextmanager, suppress
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from functools import partial
from typing import Literal
from uuid import UUID

from langsmith import tracing_context
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlalchemy.orm import aliased

from app.agent.chat_protocol import TERMINAL_STATES, append_event, terminalize, utcnow
from app.agent.graph import build_companion_graph
from app.agent.local_deepseek_budget import LocalDeepSeekBudget, LocalModelBudgetError
from app.agent.memory_boundary import (
    generation_memory_epoch,
    historical_epoch_condition,
    read_memory_epoch,
)
from app.agent.prompts import get_prompt
from app.agent.provider_selection import resolved_generation_settings
from app.agent.providers import ProviderUsage, build_private_provider
from app.agent.state import AgentState, Message
from app.core.config import Settings
from app.db.capabilities import SchemaUnavailable, read_revision, require_enabled_capabilities
from app.modules.beta_quota.service import QuotaRejected
from app.modules.companion.models import ChatGeneration, ChatMessage, ChatSession
from app.modules.users.models import User

logger = logging.getLogger(__name__)
ACTIVE_STATES = ("queued", "running", "cancel_requested")


def _aware(value: datetime) -> datetime:
    return value.replace(tzinfo=value.tzinfo or UTC)


async def select_context_message_ids(
    db: AsyncSession,
    owner_id: UUID,
    session_id: UUID,
    current_user: ChatMessage,
    *,
    context_epoch_floor: int = 0,
    pet_id: UUID | None = None,
) -> list[str]:
    """Pin the last complete owned pairs, plus the current input exactly once.

    Call inside the accepting transaction after inserting the current user row.
    Complete pairs are selected through successful generations, so cancelled or
    failed assistant fragments cannot become historical model context.
    """
    if (
        current_user.owner_id != owner_id
        or current_user.session_id != session_id
        or current_user.role != "user"
        or current_user.status != "completed"
    ):
        raise ValueError("Invalid current context message")
    user = aliased(ChatMessage)
    assistant = aliased(ChatMessage)
    pairs = (
        await db.execute(
            select(user, assistant)
            .select_from(ChatGeneration)
            .join(
                ChatSession,
                (ChatSession.id == ChatGeneration.session_id)
                & (ChatSession.owner_id == ChatGeneration.owner_id),
            )
            .join(
                user,
                (user.id == ChatGeneration.user_message_id)
                & (user.session_id == ChatGeneration.session_id)
                & (user.owner_id == ChatGeneration.owner_id),
            )
            .join(
                assistant,
                (assistant.id == ChatGeneration.assistant_message_id)
                & (assistant.session_id == ChatGeneration.session_id)
                & (assistant.owner_id == ChatGeneration.owner_id),
            )
            .where(
                ChatGeneration.owner_id == owner_id,
                ChatGeneration.session_id == session_id,
                ChatGeneration.state == "completed",
                ChatSession.deleted_at.is_(None),
                user.role == "user",
                user.status == "completed",
                user.sequence < current_user.sequence,
                assistant.role == "assistant",
                assistant.status == "completed",
                context_epoch_condition(context_epoch_floor, pet_id),
            )
            .order_by(user.sequence.desc())
            .limit(10)
        )
    ).all()
    selected: list[tuple[ChatMessage, ChatMessage]] = []
    chars = 0
    for pair_user, pair_assistant in pairs:
        size = len(pair_user.content) + len(pair_assistant.content)
        if chars + size > 32_000:
            break
        selected.append((pair_user, pair_assistant))
        chars += size
    return [str(message.id) for pair in reversed(selected) for message in pair] + [
        str(current_user.id)
    ]


def context_epoch_condition(floor, pet_id=None):
    if not floor:
        return True
    if pet_id is None:
        return historical_epoch_condition(floor)
    from app.modules.pets.models import PetGenerationContext

    return ChatGeneration.id.in_(
        select(PetGenerationContext.generation_id).where(
            PetGenerationContext.pet_id == pet_id,
            PetGenerationContext.memory_epoch >= floor,
        )
    )


@dataclass(frozen=True)
class _Identity:
    generation_id: UUID
    owner_id: UUID
    session_id: UUID
    pet_id: UUID | None = None


@dataclass(frozen=True)
class _Claim:
    identity: _Identity
    lease_version: int
    provider: str
    model: str | None
    prompt_version: str
    context_message_ids: tuple[str, ...]
    user_message_id: UUID
    memory_epoch: int = 0
    pet_id: UUID | None = None
    persona_snapshot: dict | None = None
    persona_version: int | None = None


@dataclass
class _Handle:
    claim: _Claim
    task: asyncio.Task


class _FenceLost(Exception):
    pass


class _ContextUnavailable(Exception):
    pass


class _MemoryPolicyChanged(Exception):
    pass


class _MemoryContextUnavailable(Exception):
    pass


class _FirstChunkTimeout(Exception):
    pass


class ChatRunner:
    def __init__(self, session_factory: async_sessionmaker[AsyncSession], settings: Settings):
        self.session_factory = session_factory
        self.settings = settings
        self._active: dict[UUID, _Handle] = {}
        self._wakeup = asyncio.Event()
        self._scan_lock = asyncio.Lock()
        self._supervisor: asyncio.Task | None = None
        self._closing = False
        self._storage_unavailable = False
        self.local_deepseek_budget = LocalDeepSeekBudget(settings)

    def start(self) -> None:
        if self._supervisor is None and not self._closing:
            self._supervisor = asyncio.create_task(
                self._supervise(), name="private-chat-supervisor"
            )

    def notify(self) -> None:
        self._wakeup.set()

    def cancel(self, generation_id: UUID) -> None:
        """Signal only after the cancelling/deleting command has committed."""
        handle = self._active.get(generation_id)
        if handle is not None:
            handle.task.cancel()
        self.notify()

    async def close(self) -> None:
        self._closing = True
        self.notify()
        if self._supervisor is not None:
            # Let an in-flight short DB operation finish its connection/session
            # cleanup. Cancelling during aiosqlite connection allocation can leave
            # the worker's newly opened connection without an owning coroutine.
            try:
                await asyncio.wait_for(asyncio.shield(self._supervisor), timeout=5)
            except TimeoutError:
                self._supervisor.cancel()
                with suppress(asyncio.CancelledError):
                    await self._supervisor
            self._supervisor = None
        handles = list(self._active.values())
        for handle in handles:
            handle.task.cancel()
        await asyncio.gather(*(handle.task for handle in handles), return_exceptions=True)
        # Also covers a claimed task cancelled before its coroutine first ran.
        for handle in handles:
            await self._safe_finish(handle.claim, "cancelled", reason="server_shutdown")

    async def run_once(self) -> bool:
        """Recover expired work and fully execute at most one queued job.

        Useful for deterministic isolated tests with the supervisor disabled.
        Returns whether a generation was recovered or claimed.
        """
        changed, tasks = await self._scan(claim_limit=1)
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        return changed

    async def _supervise(self) -> None:
        while not self._closing:
            self._wakeup.clear()
            try:
                await self._scan()
                self._storage_unavailable = False
            except (SQLAlchemyError, SchemaUnavailable):
                self._storage_failed()
            except Exception:
                # Do not log SDK/DB exceptions: they may contain private SQL parameters.
                logger.error("chat_runner_scan_failed")
            if self._closing:
                break
            delay = max(float(getattr(self.settings, "chat_poll_seconds", 0.1)), 0.05)
            if self._storage_unavailable:
                delay = max(delay, 1.0)
            with suppress(TimeoutError):
                await asyncio.wait_for(self._wakeup.wait(), delay)

    def _storage_failed(self) -> None:
        if not self._storage_unavailable:
            logger.warning("chat_runner_storage_unavailable")
        self._storage_unavailable = True

    @asynccontextmanager
    async def _locked(
        self, identity: _Identity
    ) -> AsyncIterator[tuple[AsyncSession, ChatSession, ChatGeneration, ChatMessage] | None]:
        await self._materialize_memory(identity.owner_id, identity.pet_id)
        async with self.session_factory() as db, db.begin():
            await require_enabled_capabilities(db, self.settings, verify_schema=False)
            # The same order as acceptance/cancellation, including quota User locks.
            owner = await db.scalar(
                select(User).where(User.id == identity.owner_id).with_for_update()
            )
            if owner is None:
                yield None
                return
            db.info["owner_active"] = owner.status == "active"
            if identity.pet_id is None:
                from app.modules.pets.chat import session_scope

                scope = await session_scope(db, identity.owner_id, None)
                db.info["memory_policy"] = await read_memory_epoch(db, identity.owner_id, lock=True)
            else:
                from app.modules.pets.memory_policy import pet_memory_epoch
                from app.modules.pets.models import Pet, PetChatBinding

                pet = await db.scalar(
                    select(Pet)
                    .where(
                        Pet.id == identity.pet_id,
                        Pet.owner_id == identity.owner_id,
                    )
                    .with_for_update()
                )
                if pet is None:
                    yield None
                    return
                db.info["pet_active"] = pet.status != "archived"
                db.info["memory_policy"] = await pet_memory_epoch(
                    db, identity.owner_id, identity.pet_id, lock=True
                )
                scope = (ChatSession.companion_id == pet.companion_id) & ChatSession.id.in_(
                    select(PetChatBinding.session_id).where(
                        PetChatBinding.owner_id == identity.owner_id,
                        PetChatBinding.pet_id == identity.pet_id,
                    )
                )
            session = await db.scalar(
                select(ChatSession)
                .where(
                    ChatSession.id == identity.session_id,
                    ChatSession.owner_id == identity.owner_id,
                    scope,
                )
                .with_for_update()
            )
            if session is None:
                yield None
                return
            generation = await db.scalar(
                select(ChatGeneration)
                .where(
                    ChatGeneration.id == identity.generation_id,
                    ChatGeneration.owner_id == identity.owner_id,
                    ChatGeneration.session_id == identity.session_id,
                )
                .with_for_update()
            )
            if generation is None:
                yield None
                return
            if identity.pet_id is None:
                db.info["generation_memory_epoch"] = await generation_memory_epoch(
                    db, generation.id, identity.owner_id
                )
            else:
                from app.modules.pets.models import PetGenerationContext

                context = await db.scalar(
                    select(PetGenerationContext).where(
                        PetGenerationContext.generation_id == generation.id,
                        PetGenerationContext.owner_id == identity.owner_id,
                        PetGenerationContext.pet_id == identity.pet_id,
                        PetGenerationContext.session_id == identity.session_id,
                    )
                )
                if context is None:
                    yield None
                    return
                db.info["pet_generation_context"] = context
                db.info["generation_memory_epoch"] = context.memory_epoch
            assistant = await db.scalar(
                select(ChatMessage)
                .where(
                    ChatMessage.id == generation.assistant_message_id,
                    ChatMessage.owner_id == identity.owner_id,
                    ChatMessage.session_id == identity.session_id,
                    ChatMessage.role == "assistant",
                )
                .with_for_update()
            )
            yield (db, session, generation, assistant) if assistant is not None else None

    async def _materialize_memory(self, owner_id, pet_id=None):
        if pet_id is None:
            from app.modules.memory.policy import materialize_owner

            cancelled = await materialize_owner(self.session_factory, owner_id)
        else:
            from app.modules.pets.memory_policy import materialize_pet

            cancelled = await materialize_pet(self.session_factory, owner_id, pet_id)
        for generation_id in cancelled:
            self.cancel(generation_id)
        return cancelled

    async def _scan(self, *, claim_limit: int | None = None) -> tuple[bool, list[asyncio.Task]]:
        changed = False
        tasks: list[asyncio.Task] = []
        async with self._scan_lock:
            async with self.session_factory() as db:
                await require_enabled_capabilities(db, self.settings)
                identities = (
                    await db.execute(
                        select(
                            ChatGeneration.id, ChatGeneration.owner_id, ChatGeneration.session_id
                        )
                        .join(
                            ChatSession,
                            (ChatSession.id == ChatGeneration.session_id)
                            & (ChatSession.owner_id == ChatGeneration.owner_id),
                        )
                        .where(ChatGeneration.state.in_(ACTIVE_STATES))
                        .order_by(ChatGeneration.created_at, ChatGeneration.id)
                    )
                ).all()
                pet_by_generation = {}
                if await read_revision(db) == "0006":
                    from app.modules.pets.models import PetGenerationContext

                    pet_by_generation = dict(
                        (
                            await db.execute(
                                select(
                                    PetGenerationContext.generation_id, PetGenerationContext.pet_id
                                ).where(
                                    PetGenerationContext.generation_id.in_(
                                        [row[0] for row in identities]
                                    )
                                )
                            )
                        ).all()
                    )
            max_running = min(int(getattr(self.settings, "chat_max_running", 4)), 4)
            slots = max(0, max_running - len(self._active))
            if claim_limit is not None:
                slots = min(slots, claim_limit)
            for generation_id, owner_id, session_id in identities:
                if self._closing:
                    break
                pet_id = pet_by_generation.get(generation_id)
                if await self._materialize_memory(owner_id, pet_id):
                    changed = True
                identity = _Identity(generation_id, owner_id, session_id, pet_id)
                claim: _Claim | None = None
                should_cancel = False
                async with self._locked(identity) as locked:
                    if locked is None:
                        continue
                    db, session, generation, assistant = locked
                    now = utcnow()
                    if generation.state in TERMINAL_STATES:
                        continue
                    expired = (
                        generation.lease_expires_at is None
                        or _aware(generation.lease_expires_at) <= now
                    )
                    if not self._memory_fenced(db):
                        await terminalize(
                            db,
                            session,
                            generation,
                            assistant,
                            "cancelled",
                            reason="memory_policy_changed",
                        )
                        changed = should_cancel = True
                    elif session.deleted_at is not None or generation.state == "cancel_requested":
                        await terminalize(db, session, generation, assistant, "cancelled")
                        changed = should_cancel = True
                    elif generation.state == "running" and expired:
                        await terminalize(
                            db,
                            session,
                            generation,
                            assistant,
                            "failed",
                            error_code="SERVER_RESTARTED",
                        )
                        changed = should_cancel = True
                    elif generation.state == "queued":
                        age = (now - _aware(generation.created_at)).total_seconds()
                        queue_timeout = float(
                            getattr(self.settings, "chat_queue_timeout_seconds", 60)
                        )
                        if age >= queue_timeout:
                            await terminalize(
                                db,
                                session,
                                generation,
                                assistant,
                                "failed",
                                error_code="QUEUE_TIMEOUT",
                            )
                            changed = True
                        elif slots > 0 and not self._closing:
                            generation.state = "running"
                            generation.started_at = now
                            generation.lease_version = (generation.lease_version or 0) + 1
                            generation.lease_expires_at = now + timedelta(
                                seconds=float(getattr(self.settings, "chat_lease_seconds", 15))
                            )
                            assistant.status = "streaming"
                            claim = _Claim(
                                identity,
                                generation.lease_version,
                                generation.provider,
                                generation.model,
                                generation.prompt_version,
                                tuple(generation.context_message_ids),
                                generation.user_message_id,
                                db.info["generation_memory_epoch"],
                                pet_id,
                                db.info["pet_generation_context"].persona_snapshot
                                if pet_id
                                else None,
                                db.info["pet_generation_context"].persona_version
                                if pet_id
                                else None,
                            )
                # All state/lease writes have committed before a provider can start.
                if should_cancel:
                    self.cancel(generation_id)
                if claim is not None:
                    task = asyncio.create_task(self._run(claim), name="private-chat-generation")
                    self._active[generation_id] = _Handle(claim, task)
                    task.add_done_callback(lambda done, key=generation_id: self._done(key, done))
                    tasks.append(task)
                    slots -= 1
                    changed = True
        return changed, tasks

    def _done(self, generation_id: UUID, task: asyncio.Task) -> None:
        handle = self._active.get(generation_id)
        if handle is not None and handle.task is task:
            self._active.pop(generation_id, None)
        if not task.cancelled() and task.exception() is not None:
            logger.error("chat_runner_generation_failed")
        self.notify()

    def _fenced(self, generation: ChatGeneration, claim: _Claim) -> bool:
        return (
            generation.state in {"running", "cancel_requested"}
            and generation.lease_version == claim.lease_version
            and generation.lease_expires_at is not None
            and _aware(generation.lease_expires_at) > utcnow()
        )

    @staticmethod
    def _memory_fenced(db, claim: _Claim | None = None) -> bool:
        epoch = db.info["generation_memory_epoch"]
        return (
            db.info.get("owner_active", True)
            and db.info.get("pet_active", True)
            and epoch == db.info["memory_policy"].epoch
            and (claim is None or epoch == claim.memory_epoch)
        )

    async def _authorize_dispatch(self, claim: _Claim) -> None:
        """Fence plain private-chat input immediately before Provider construction.

        Retrieval can be disabled while history still contains a formerly used
        memory or its source. This transaction is the plain-chat authorization
        point; the 0004 path only accesses the existing V4 fields.
        """
        resolved_generation_settings(
            self.settings, claim.identity.owner_id, claim.pet_id, claim.provider, claim.model
        )
        async with self._locked(claim.identity) as locked:
            if locked is None:
                raise _FenceLost
            db, session, generation, _ = locked
            owner_status = await db.scalar(
                select(User.status).where(User.id == claim.identity.owner_id)
            )
            if (
                owner_status != "active"
                or session.deleted_at is not None
                or generation.state != "running"
                or not self._fenced(generation, claim)
                or not self._memory_fenced(db, claim)
            ):
                raise _FenceLost

    async def _authorize_budget(self, claim, messages, system_prompt):
        from app.modules.beta_quota.service import dispatch

        async with self._locked(claim.identity) as locked:
            if locked is None:
                raise _FenceLost
            db, session, generation, _ = locked
            if (
                not self._fenced(generation, claim)
                or not self._memory_fenced(db, claim)
                or not db.info.get("owner_active")
                or db.info.get("pet_active") is False
                or session.deleted_at is not None
                or generation.state != "running"
            ):
                raise _FenceLost
            await dispatch(db, generation, self.settings, messages, system_prompt)
        # Reserve only after the database/privacy fence commits. The no-await
        # counter is shared by every pet/session in this runner, never per reply.
        if claim.provider == "deepseek" and (
            self.local_deepseek_budget.limit or self.settings.local_deepseek_pets
        ):
            self.local_deepseek_budget.admit(self.settings, messages, system_prompt)

    async def _load_context(self, claim: _Claim) -> list[Message]:
        await self._materialize_memory(claim.identity.owner_id, claim.pet_id)
        ids = claim.context_message_ids
        try:
            parsed_ids = [UUID(value) for value in ids]
        except (ValueError, TypeError, AttributeError) as exc:
            raise _ContextUnavailable from exc
        if (
            not ids
            or len(ids) > 21
            or len(ids) % 2 != 1
            or len(set(ids)) != len(ids)
            or parsed_ids[-1] != claim.user_message_id
        ):
            raise _ContextUnavailable
        async with self._locked(claim.identity) as locked:
            if locked is None:
                raise _ContextUnavailable
            db, session, generation, _ = locked
            policy = db.info["memory_policy"]
            accepted_epoch = db.info["generation_memory_epoch"]
            if policy.epoch != claim.memory_epoch or accepted_epoch != claim.memory_epoch:
                raise _MemoryPolicyChanged
            records = (
                await db.scalars(
                    select(ChatMessage)
                    .join(
                        ChatSession,
                        (ChatSession.id == ChatMessage.session_id)
                        & (ChatSession.owner_id == ChatMessage.owner_id),
                    )
                    .where(
                        ChatMessage.id.in_(parsed_ids),
                        ChatMessage.owner_id == claim.identity.owner_id,
                        ChatMessage.session_id == claim.identity.session_id,
                        ChatSession.deleted_at.is_(None),
                        ChatMessage.status == "completed",
                    )
                )
            ).all()
            by_id = {message.id: message for message in records}
            if len(by_id) != len(parsed_ids):
                raise _ContextUnavailable
            ordered = [by_id[message_id] for message_id in parsed_ids]
            for index, message in enumerate(ordered):
                expected_role = "user" if index % 2 == 0 else "assistant"
                if message.role != expected_role:
                    raise _ContextUnavailable
                if index and ordered[index - 1].sequence >= message.sequence:
                    raise _ContextUnavailable
            if sum(len(message.content) for message in ordered[:-1]) > 32_000:
                raise _ContextUnavailable
            if not 1 <= len(ordered[-1].content) <= 4_000:
                raise _ContextUnavailable
            # Revalidate the pinned complete-pair links instead of trusting JSON IDs.
            for index in range(0, len(ordered) - 1, 2):
                complete = await db.scalar(
                    select(ChatGeneration.id).where(
                        ChatGeneration.owner_id == claim.identity.owner_id,
                        ChatGeneration.session_id == claim.identity.session_id,
                        ChatGeneration.user_message_id == ordered[index].id,
                        ChatGeneration.assistant_message_id == ordered[index + 1].id,
                        ChatGeneration.state == "completed",
                        context_epoch_condition(policy.floor, claim.pet_id),
                    )
                )
                if complete is None:
                    raise _ContextUnavailable
            return [{"role": message.role, "content": message.content} for message in ordered]

    async def _renew(self, claim: _Claim, worker: asyncio.Task, abandon: asyncio.Event) -> None:
        try:
            while True:
                await asyncio.sleep(float(getattr(self.settings, "chat_renew_seconds", 5)))
                async with self._locked(claim.identity) as locked:
                    if locked is None:
                        raise _FenceLost
                    db, session, generation, assistant = locked
                    if not self._fenced(generation, claim):
                        raise _FenceLost
                    if not self._memory_fenced(db, claim):
                        await terminalize(
                            db,
                            session,
                            generation,
                            assistant,
                            "cancelled",
                            reason="memory_policy_changed",
                        )
                        worker.cancel()
                        return
                    if session.deleted_at is not None or generation.state == "cancel_requested":
                        await terminalize(db, session, generation, assistant, "cancelled")
                        worker.cancel()
                        return
                    generation.lease_expires_at = utcnow() + timedelta(
                        seconds=float(getattr(self.settings, "chat_lease_seconds", 15))
                    )
        except asyncio.CancelledError:
            raise
        except (SQLAlchemyError, SchemaUnavailable):
            self._storage_failed()
            abandon.set()
            worker.cancel()
        except _FenceLost:
            abandon.set()
            worker.cancel()
        except Exception:
            logger.error("chat_runner_renewal_failed")
            abandon.set()
            worker.cancel()

    async def _run(self, claim: _Claim) -> None:
        worker = asyncio.current_task()
        assert worker is not None
        abandon = asyncio.Event()
        renewer = asyncio.create_task(
            self._renew(claim, worker, abandon), name="private-chat-lease"
        )
        try:
            try:
                get_prompt(claim.prompt_version)
            except KeyError:
                await self._safe_finish(claim, "failed", error_code="PROMPT_UNAVAILABLE")
                return
            async with asyncio.timeout(
                float(getattr(self.settings, "chat_run_timeout_seconds", 120))
            ):
                messages = await self._load_context(claim)
                provider_settings = resolved_generation_settings(
                    self.settings,
                    claim.identity.owner_id,
                    claim.pet_id,
                    claim.provider,
                    claim.model,
                )
                provider = build_private_provider(provider_settings, claim.provider, claim.model)
                graph_options = {
                    "max_output_chars": min(
                        int(getattr(self.settings, "chat_output_max_chars", 8_000)), 8_000
                    )
                }
                if claim.provider != "mock":
                    graph_options["request_guard"] = partial(self._authorize_budget, claim)
                if claim.pet_id is not None:
                    from app.modules.pets.memory_runtime import PetGenerationMemoryRuntime

                    graph_options["memory_runtime"] = PetGenerationMemoryRuntime(self, claim)
                elif getattr(self.settings, "memory_injection_enabled", False):
                    from app.modules.memory.injection import GenerationMemoryRuntime

                    graph_options["memory_runtime"] = GenerationMemoryRuntime(self, claim)
                else:
                    graph_options["dispatch_guard"] = partial(self._authorize_dispatch, claim)
                graph = build_companion_graph(provider, **graph_options)
                state: AgentState = {
                    "messages": messages,
                    "prompt_version": claim.prompt_version,
                    "output": "",
                    "mode": claim.provider,
                }
                if claim.persona_snapshot is not None:
                    state["persona_snapshot"] = claim.persona_snapshot
                with tracing_context(enabled=False):
                    async with aclosing(graph.astream(state, stream_mode="custom")) as stream:
                        pending, reason = await self._consume(claim, stream)
                usage = None
                if claim.provider != "mock":
                    if reason == "stop":
                        provider_reason = getattr(provider, "finish_reason", None)
                        if provider_reason not in {"stop", "length"}:
                            raise RuntimeError("Provider returned no supported finish reason")
                        reason = provider_reason
                    usage = getattr(provider, "usage", None)
                    if usage is not None and (
                        not isinstance(usage, dict)
                        or set(usage) != {"input_tokens", "output_tokens"}
                        or any(type(value) is not int or value < 0 for value in usage.values())
                    ):
                        raise RuntimeError("Provider returned invalid usage")
                await self._finish(claim, "completed", pending=pending, reason=reason, usage=usage)
        except asyncio.CancelledError:
            if not abandon.is_set():
                await self._safe_finish(
                    claim,
                    "cancelled",
                    reason="server_shutdown" if self._closing else "user_cancelled",
                )
        except _FenceLost:
            # The rejected hook's transaction has exited. A separate fenced write
            # records cancellation only if this claim still owns a live lease.
            await self._safe_finish(claim, "cancelled", reason="memory_policy_changed")
        except _MemoryPolicyChanged:
            await self._safe_finish(claim, "cancelled", reason="memory_policy_changed")
        except _MemoryContextUnavailable:
            await self._safe_finish(claim, "failed", error_code="MEMORY_CONTEXT_UNAVAILABLE")
        except (SQLAlchemyError, SchemaUnavailable):
            # Stop consuming immediately. The expired lease later records a failure;
            # uncommitted chunks never become an event or a successful conclusion.
            self._storage_failed()
        except LocalModelBudgetError as error:
            await self._safe_finish(claim, "failed", error_code=error.code)
        except QuotaRejected:
            await self._safe_finish(claim, "failed", error_code="BETA_QUOTA_UNAVAILABLE")
        except _FirstChunkTimeout:
            await self._safe_finish(claim, "failed", error_code="FIRST_CHUNK_TIMEOUT")
        except TimeoutError:
            await self._safe_finish(claim, "failed", error_code="GENERATION_TIMEOUT")
        except _ContextUnavailable:
            await self._safe_finish(claim, "failed", error_code="CHAT_CONTEXT_UNAVAILABLE")
        except Exception:
            await self._safe_finish(claim, "failed", error_code="PROVIDER_FAILED")
        finally:
            renewer.cancel()
            with suppress(asyncio.CancelledError):
                await renewer

    async def _consume(
        self, claim: _Claim, stream: AsyncIterator[dict]
    ) -> tuple[str, Literal["stop", "length"]]:
        loop = asyncio.get_running_loop()
        first_deadline = loop.time() + float(
            getattr(self.settings, "chat_first_chunk_timeout_seconds", 30)
        )
        flush_seconds = float(getattr(self.settings, "chat_flush_seconds", 0.075))
        cap = min(int(getattr(self.settings, "chat_output_max_chars", 8_000)), 8_000)
        first = True
        pending = ""
        received = 0
        flush_deadline = loop.time() + flush_seconds
        next_chunk: asyncio.Task | None = None
        try:
            while True:
                if next_chunk is None:
                    next_chunk = asyncio.create_task(anext(stream))
                now = loop.time()
                if first and now >= first_deadline:
                    raise _FirstChunkTimeout
                timeout = first_deadline - now if first else None
                if pending:
                    until_flush = max(0.0, flush_deadline - now)
                    timeout = min(timeout, until_flush) if timeout is not None else until_flush
                done, _ = await asyncio.wait({next_chunk}, timeout=timeout)
                if not done:
                    if pending:
                        await self._flush(claim, pending)
                        pending = ""
                        flush_deadline = loop.time() + flush_seconds
                    continue
                completed_chunk = next_chunk
                next_chunk = None
                try:
                    chunk = completed_chunk.result()
                except StopAsyncIteration:
                    if first:
                        raise RuntimeError("Provider returned no output") from None
                    return pending, "stop"
                text = chunk.get("text")
                if not isinstance(text, str):
                    raise RuntimeError("Provider returned an invalid chunk")
                if not text:
                    continue
                first = False
                addition = text[: max(0, cap - received)]
                if not pending:
                    flush_deadline = loop.time() + flush_seconds
                pending += addition
                received += len(addition)
                if received >= cap:
                    return pending, "length"
                if len(pending) >= 256 or loop.time() >= flush_deadline:
                    await self._flush(claim, pending)
                    pending = ""
                    flush_deadline = loop.time() + flush_seconds
        finally:
            if next_chunk is not None:
                next_chunk.cancel()
                await asyncio.gather(next_chunk, return_exceptions=True)

    async def _flush(self, claim: _Claim, text: str) -> None:
        async with self._locked(claim.identity) as locked:
            if locked is None:
                raise _FenceLost
            db, session, generation, assistant = locked
            if not self._fenced(generation, claim):
                raise _FenceLost
            if not self._memory_fenced(db, claim):
                await terminalize(
                    db, session, generation, assistant, "cancelled", reason="memory_policy_changed"
                )
                stopped = True
            elif session.deleted_at is not None or generation.state == "cancel_requested":
                await terminalize(db, session, generation, assistant, "cancelled")
                # Raise outside the transaction so cancellation is committed.
                stopped = True
            else:
                stopped = False
                assistant.content += text
                await append_event(db, generation, "delta", {"text": text})
        if stopped:
            raise _FenceLost

    async def _finish(
        self,
        claim: _Claim,
        state: Literal["completed", "failed", "cancelled"],
        *,
        pending: str = "",
        reason: str = "stop",
        error_code: str | None = None,
        usage: ProviderUsage | None = None,
    ) -> None:
        async with self._locked(claim.identity) as locked:
            if locked is None:
                return
            db, session, generation, assistant = locked
            if not self._fenced(generation, claim):
                return
            if not self._memory_fenced(db, claim):
                pending = ""
                state = "cancelled"
                reason = "memory_policy_changed"
            if session.deleted_at is not None or generation.state == "cancel_requested":
                pending = ""
                state = "cancelled"
            if pending and state == "completed":
                assistant.content += pending
                await append_event(db, generation, "delta", {"text": pending})
            if state == "completed":
                generation.usage = usage if claim.provider != "mock" else None
            await terminalize(
                db, session, generation, assistant, state, reason=reason, error_code=error_code
            )
            if (
                getattr(self.settings, "beta_telemetry_enabled", False)
                and generation.state == "completed"
                and assistant.content.strip()
            ):
                from app.modules.beta_quota.privacy import record

                try:
                    async with db.begin_nested():
                        await record(
                            db,
                            generation.owner_id,
                            self.settings,
                            "interaction_mock"
                            if generation.provider == "mock"
                            else "interaction_real",
                        )
                except SQLAlchemyError:
                    logger.warning("beta_telemetry_unavailable")

    async def _safe_finish(self, claim: _Claim, state: str, **kwargs) -> None:
        try:
            await self._finish(claim, state, **kwargs)
        except (SQLAlchemyError, SchemaUnavailable):
            self._storage_failed()
        except Exception:
            logger.error("chat_runner_terminal_write_failed")
