"""Per-generation LangGraph adapter; no extraction or memory-saving side effects."""

from sqlalchemy import select, update

from app.agent.chat_runner import _FenceLost, _MemoryContextUnavailable
from app.agent.memory_boundary import generation_memory_epoch, read_memory_epoch
from app.agent.prompts import get_prompt
from app.core.errors import AppError
from app.db.capabilities import require_capability
from app.modules.companion.models import ChatGeneration, ChatMessage, ChatSession
from app.modules.memory.budget import assemble_budgeted_context
from app.modules.memory.models import MemoryGenerationRef, MemoryPreferences
from app.modules.memory.policy import clock, eligible_candidates, materialize_invalidations
from app.modules.memory.privacy import screen
from app.modules.memory.retrieval import rank_memories
from app.modules.users.models import User


class GenerationMemoryRuntime:
    def __init__(self, runner, claim):
        self.runner, self.claim, self.settings = runner, claim, runner.settings
        self.owner = claim.identity.owner_id
        self.dispatched = False

    def check(self, db, session, generation):
        if (
            session.deleted_at is not None
            or generation.state != "running"
            or not self.runner._fenced(generation, self.claim)
            or not self.runner._memory_fenced(db, self.claim)
        ):
            raise _FenceLost

    async def authorize_memory(self, state):
        if self.claim.provider != "mock" or self.claim.model is not None:
            raise _MemoryContextUnavailable
        async with self.runner._locked(self.claim.identity) as locked:
            if locked is None:
                raise _FenceLost
            db, session, generation, _ = locked
            self.check(db, session, generation)
            pref = await db.get(MemoryPreferences, self.owner)
            enabled = bool(pref and pref.long_term_memory_enabled)
            reason = "enabled" if enabled else "disabled"
            try:
                screen("", state["messages"][-1]["content"])
            except AppError:
                enabled, reason = False, "sensitive_query"
            return {
                "memory_policy_snapshot": {
                    "enabled": enabled,
                    "epoch": str(self.claim.memory_epoch),
                    "reason": reason,
                }
            }

    async def retrieve_memory(self, state):
        if not state["memory_policy_snapshot"]["enabled"]:
            return {"memory_hits": []}
        async with self.runner._locked(self.claim.identity) as locked:
            if locked is None:
                raise _FenceLost
            db, session, generation, _ = locked
            self.check(db, session, generation)
            at = clock()
            candidates = await eligible_candidates(db, self.owner, at=at)
            hits = rank_memories(
                state["messages"][-1]["content"],
                candidates,
                self.owner,
                limit=self.settings.memory_max_items,
                at=at,
            )
            return {"memory_hits": hits}

    async def budget_context(self, state):
        try:
            budget = assemble_budgeted_context(
                state["messages"],
                get_prompt(state["prompt_version"]),
                state["memory_hits"],
                provider=self.claim.provider,
                model=self.claim.model,
                context_capacity=self.settings.memory_context_capacity,
                output_reserve=self.settings.memory_output_reserve,
                safety_margin=self.settings.memory_safety_margin,
                max_memory_tokens=self.settings.memory_max_tokens,
                max_memories=self.settings.memory_max_items,
            )
        except ValueError:
            raise _MemoryContextUnavailable from None
        return {"memory_budget": budget}

    async def assemble_context(self, state):
        budget = state["memory_budget"]
        return {
            "provider_messages": budget.messages,
            "provider_system_prompt": budget.system_prompt,
        }

    async def before_provider(self, state):
        """Authorize dispatch and save refs under one short transaction, then release locks.

        Privacy invalidations commit normally even when they cancel this generation.
        No network/provider code runs inside the transaction.
        """
        if self.dispatched:
            raise _FenceLost
        blocked = False
        async with self.runner.session_factory() as db, db.begin():
            await require_capability(db, "memory")
            user = await db.scalar(select(User).where(User.id == self.owner).with_for_update())
            if user is None or user.status != "active":
                raise _FenceLost
            policy = await read_memory_epoch(db, self.owner, lock=True)
            at = clock()
            cancelled = await materialize_invalidations(db, self.owner, at=at)
            after = await read_memory_epoch(db, self.owner)
            if cancelled or after.epoch != policy.epoch:
                blocked = True
            else:
                session = await db.scalar(
                    select(ChatSession)
                    .where(
                        ChatSession.id == self.claim.identity.session_id,
                        ChatSession.owner_id == self.owner,
                    )
                    .with_for_update()
                )
                generation = await db.scalar(
                    select(ChatGeneration)
                    .where(
                        ChatGeneration.id == self.claim.identity.generation_id,
                        ChatGeneration.session_id == self.claim.identity.session_id,
                        ChatGeneration.owner_id == self.owner,
                    )
                    .with_for_update()
                )
                if session is None or generation is None:
                    raise _FenceLost
                await db.scalar(
                    select(ChatMessage.id)
                    .where(
                        ChatMessage.id == generation.assistant_message_id,
                        ChatMessage.owner_id == self.owner,
                    )
                    .with_for_update()
                )
                db.info["memory_policy"] = policy
                db.info["generation_memory_epoch"] = await generation_memory_epoch(
                    db, generation.id, self.owner
                )
                self.check(db, session, generation)
                table = ChatGeneration.__table__
                previous = await db.scalar(
                    select(table.c.memory_snapshot_at).where(
                        table.c.id == generation.id, table.c.owner_id == self.owner
                    )
                )
                if previous is not None:
                    raise _FenceLost
                budget = state["memory_budget"]
                candidates = {
                    row.id: row for row in await eligible_candidates(db, self.owner, at=at)
                }
                for hit in budget.selected_hits:
                    current = candidates.get(hit.candidate.id)
                    if (
                        current is None
                        or current.version != hit.candidate.version
                        or current.grant_id != hit.candidate.grant_id
                    ):
                        raise _FenceLost
                for rank, (hit, used) in enumerate(
                    zip(budget.selected_hits, budget.used_tokens, strict=True), 1
                ):
                    item = hit.candidate
                    db.add(
                        MemoryGenerationRef(
                            generation_id=generation.id,
                            session_id=generation.session_id,
                            owner_id=self.owner,
                            memory_id=item.id,
                            memory_version=item.version,
                            grant_event_id=item.grant_id,
                            privacy_epoch=self.claim.memory_epoch,
                            used_tokens=used,
                            counter_version=budget.report["counter_version"],
                            rank=rank,
                        )
                    )
                await db.execute(
                    update(table)
                    .where(table.c.id == generation.id, table.c.owner_id == self.owner)
                    .values(memory_snapshot_at=at)
                )
                await db.flush()
        if blocked:
            raise _FenceLost
        self.dispatched = True
