"""Pet-local LangGraph memory boundary. No extraction or saving occurs here."""

from sqlalchemy import select, update

from app.agent.memory_boundary import MemoryEpoch
from app.agent.prompts import generation_prompt
from app.agent.provider_selection import resolved_generation_settings
from app.db.capabilities import require_capability
from app.modules.companion.models import ChatGeneration
from app.modules.memory.budget import BudgetResult, assemble_budgeted_context
from app.modules.memory.injection import GenerationMemoryRuntime
from app.modules.memory.privacy import screen
from app.modules.memory.retrieval import rank_memories
from app.modules.pets.memory_policy import (
    clock,
    eligible_candidates,
    materialize_pet,
    pet_memory_epoch,
)
from app.modules.pets.models import PetGenerationContext, PetMemoryPreferences
from app.modules.users.models import User

__all__ = ["PetGenerationMemoryRuntime", "pet_memory_epoch", "materialize_pet"]


class PetGenerationMemoryRuntime(GenerationMemoryRuntime):
    def __init__(self, runner, claim):
        super().__init__(runner, claim)
        self.pet_id = claim.pet_id
        self.settings = runner.settings.model_copy()
        if (
            runner.settings.dev_deepseek_pet_owner_id is not None
            or runner.settings.dev_deepseek_pet_id is not None
            or runner.settings.local_deepseek_pets
        ):
            self.settings = resolved_generation_settings(
                runner.settings, self.owner, self.pet_id, claim.provider, claim.model
            )

    def plain_provider_context(self):
        """Real chat retains privacy fences while verified memory injection is off."""
        from app.agent.chat_runner import _MemoryContextUnavailable

        if self.claim.provider == "mock" and self.claim.model is None:
            return False
        if (
            self.claim.provider not in {"deepseek", "openai"}
            or not isinstance(self.claim.model, str)
            or not self.claim.model
            or self.settings.memory_injection_enabled
        ):
            raise _MemoryContextUnavailable
        return True

    async def authorize_memory(self, state):
        from app.agent.chat_runner import _FenceLost
        from app.core.errors import AppError

        plain = self.plain_provider_context()
        async with self.runner._locked(self.claim.identity) as locked:
            if locked is None:
                raise _FenceLost
            db, session, generation, _ = locked
            self.check(db, session, generation)
            enabled = False
            if not plain:
                pref = await db.scalar(
                    select(PetMemoryPreferences).where(
                        PetMemoryPreferences.pet_id == self.pet_id,
                        PetMemoryPreferences.owner_id == self.owner,
                    )
                )
                enabled = bool(
                    self.settings.memory_injection_enabled
                    and pref
                    and pref.long_term_memory_enabled
                )
            reason = "enabled" if enabled else "disabled"
            try:
                screen("", state["messages"][-1]["content"])
            except AppError:
                enabled, reason = False, "sensitive_query"
            return {
                "memory_policy_snapshot": {
                    "enabled": enabled,
                    "epoch": str(self.claim.memory_epoch),
                    "pet_id": str(self.pet_id),
                    "reason": reason,
                }
            }

    async def retrieve_memory(self, state):
        from app.agent.chat_runner import _FenceLost

        if self.plain_provider_context():
            if state["memory_policy_snapshot"]["enabled"]:
                raise _FenceLost
            return {"memory_hits": []}
        if not state["memory_policy_snapshot"]["enabled"]:
            return {"memory_hits": []}
        async with self.runner._locked(self.claim.identity) as locked:
            if locked is None:
                raise _FenceLost
            db, session, generation, _ = locked
            self.check(db, session, generation)
            at = clock()
            candidates = await eligible_candidates(db, self.owner, self.pet_id, at=at)
            return {
                "memory_hits": rank_memories(
                    state["messages"][-1]["content"],
                    candidates,
                    self.owner,
                    limit=self.settings.memory_max_items,
                    at=at,
                )
            }

    async def budget_context(self, state):
        from app.agent.chat_runner import _MemoryContextUnavailable

        if self.plain_provider_context():
            if state["memory_hits"] or state["memory_policy_snapshot"]["enabled"]:
                raise _MemoryContextUnavailable
            # P3 already bounds loaded history to 21 owner/pet messages, 32k
            # historical characters and 4k current characters. Preserve that
            # exact plain-chat input; Mock units are not a paid-model tokenizer.
            return {
                "memory_budget": BudgetResult(
                    messages=[dict(message) for message in state["messages"]],
                    system_prompt=generation_prompt(
                        self.claim.prompt_version, self.claim.persona_snapshot
                    ),
                    selected_hits=[],
                    used_tokens=[],
                    report={"counter_version": "plain-chat-bounds/1"},
                )
            }
        try:
            budget = assemble_budgeted_context(
                state["messages"],
                generation_prompt(self.claim.prompt_version, self.claim.persona_snapshot),
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

    async def validate_snapshot(self, db, state):
        """Validate exact grants immediately before dispatch; no cached content authority."""
        from app.agent.chat_runner import _FenceLost

        if self.plain_provider_context():
            budget = state["memory_budget"]
            if (
                state["memory_policy_snapshot"]["enabled"]
                or state["memory_hits"]
                or budget.selected_hits
                or budget.used_tokens
            ):
                raise _FenceLost
            return
        at = clock()
        candidates = {
            item.id: item for item in await eligible_candidates(db, self.owner, self.pet_id, at=at)
        }
        for hit in state["memory_budget"].selected_hits:
            current = candidates.get(hit.candidate.id)
            if (
                current is None
                or current.version != hit.candidate.version
                or current.grant_id != hit.candidate.grant_id
            ):
                raise _FenceLost

    async def before_provider(self, state):
        from app.agent.chat_runner import _FenceLost

        current_settings = resolved_generation_settings(
            self.runner.settings, self.owner, self.pet_id, self.claim.provider, self.claim.model
        )
        if current_settings.memory_injection_enabled != self.settings.memory_injection_enabled:
            raise _FenceLost
        if self.dispatched:
            raise _FenceLost
        cancelled = await materialize_pet(self.runner.session_factory, self.owner, self.pet_id)
        for generation_id in cancelled:
            self.runner.cancel(generation_id)
        async with self.runner._locked(self.claim.identity) as locked:
            if locked is None:
                raise _FenceLost
            db, session, generation, _ = locked
            await require_capability(db, "pets")
            # _locked holds User first; re-read account eligibility at the exact
            # provider boundary, including a disable after the job was accepted.
            active = await db.scalar(
                select(User.id).where(
                    User.id == self.owner,
                    User.status == "active",
                )
            )
            if active is None:
                raise _FenceLost
            policy: MemoryEpoch = await pet_memory_epoch(db, self.owner, self.pet_id, lock=True)
            db.info["memory_policy"] = policy
            self.check(db, session, generation)
            context = await db.scalar(
                select(PetGenerationContext).where(
                    PetGenerationContext.generation_id == generation.id,
                    PetGenerationContext.owner_id == self.owner,
                    PetGenerationContext.pet_id == self.pet_id,
                    PetGenerationContext.session_id == session.id,
                )
            )
            if (
                context is None
                or context.memory_epoch != self.claim.memory_epoch
                or context.persona_version != self.claim.persona_version
                or context.persona_snapshot != self.claim.persona_snapshot
            ):
                raise _FenceLost
            table = ChatGeneration.__table__
            previous = await db.scalar(
                select(table.c.memory_snapshot_at).where(
                    table.c.id == generation.id,
                    table.c.owner_id == self.owner,
                )
            )
            if previous is not None:
                raise _FenceLost
            await self.validate_snapshot(db, state)
            budget = state["memory_budget"]
            context.memory_refs = [
                {
                    "memory_id": str(hit.candidate.id),
                    "memory_version": hit.candidate.version,
                    "grant_event_id": str(hit.candidate.grant_id),
                    "privacy_epoch": str(policy.epoch),
                    "used_tokens": used,
                    "counter_version": budget.report["counter_version"],
                    "rank": rank,
                }
                for rank, (hit, used) in enumerate(
                    zip(budget.selected_hits, budget.used_tokens, strict=True), 1
                )
            ]
            await db.execute(
                update(table)
                .where(
                    table.c.id == generation.id,
                    table.c.owner_id == self.owner,
                )
                .values(memory_snapshot_at=clock())
            )
            await db.flush()
        self.dispatched = True
