"""Only synthetic records and fixed Mock output; no app/DB/provider credentials."""

import json
from dataclasses import replace

import pytest

from app.agent.p863_context import Scope, ScopedText, SharedEvent, assemble_mock_context
from app.agent.providers import PrivateMockLLM

OWNER, PET, PEER, SESSION, EVENT = [f"10000000-0000-4000-8000-{n:012}" for n in range(1, 6)]
SCOPE = Scope(OWNER, PET, SESSION, 2, 3)
ROW = ScopedText(OWNER, PET, SESSION, "SYNTHETIC current private topic", privacy_epoch=3)
MEMORY = replace(ROW, session=None, text="SYNTHETIC authorized memory", authorized=True)
SHARED = SharedEvent(EVENT, OWNER, (PET, PEER), "cooperate", 100, 200, "friendly")


def compose(**patch):
    args = dict(
        provider="mock",
        scope=SCOPE,
        current_scope=lambda: SCOPE,
        persona={"description": "独立人格", "tone": "calm", "version": 2},
        history=[ROW],
        memories=[MEMORY],
        memory_consent=True,
        events=lambda _owner, _pet: [SHARED],
        now_ms=1000,
        discuss_events=True,
    )
    return assemble_mock_context(**(args | patch))


@pytest.mark.parametrize("field", ["owner", "pet", "session", "privacy_epoch"])
def test_history_scope_must_match_even_for_same_species_or_name(field):
    wrong = 4 if field == "privacy_epoch" else EVENT
    with pytest.raises(ValueError, match="Foreign"):
        compose(history=[replace(ROW, **{field: wrong})])


@pytest.mark.parametrize("field", ["owner", "pet", "authorized", "privacy_epoch"])
def test_only_consented_scoped_memories_can_enter_context(field):
    wrong = False if field == "authorized" else 4 if field == "privacy_epoch" else EVENT
    with pytest.raises(ValueError, match="Foreign"):
        compose(memories=[replace(MEMORY, **{field: wrong})])
    prompt, _, _ = compose(memory_consent=False, memories=[replace(MEMORY, **{field: wrong})])
    assert MEMORY.text not in prompt


@pytest.mark.parametrize("change", [{"owner": PEER}, {"participants": (PEER, SESSION)}])
def test_other_owner_and_nonparticipant_events_are_denied(change):
    with pytest.raises(ValueError, match="Foreign event"):
        compose(events=lambda *_: [replace(SHARED, **change)])


@pytest.mark.parametrize(
    "change",
    [
        {"deleted": True},
        {"ended_at": None},
        {"ended_at": 2000},
        {"visibility": "public"},
        {"kind": "invented_accusation"},
        {"outcome": "pending"},
    ],
)
def test_deleted_unfinished_or_untrusted_events_produce_no_claim(change):
    _, _, refs = compose(events=lambda *_: [replace(SHARED, **change)])
    assert refs == ()


def test_no_events_no_complaint_and_an_unrelated_topic_does_not_load_event_source():
    _, _, refs = compose(events=lambda *_: [])
    assert refs == ()

    def forbidden(*_):
        pytest.fail("Unrelated topic must not query social events")

    _, _, refs = compose(discuss_events=False, events=forbidden)
    assert refs == ()
    assert compose(already_shared=frozenset({EVENT}))[2] == ()


def test_persona_and_final_scope_fence_fail_closed():
    with pytest.raises(ValueError, match="scope"):
        compose(persona={"description": "different version", "tone": "calm", "version": 1})
    count = 0

    def epoch():
        nonlocal count
        count += 1
        return SCOPE if count == 1 else replace(SCOPE, privacy_epoch=4)

    with pytest.raises(ValueError, match="during"):
        compose(current_scope=epoch)


@pytest.mark.parametrize("provider", ["deepseek", "openai", "real", "Mock"])
def test_prototype_rejects_every_non_mock_provider(provider):
    with pytest.raises(ValueError, match="offline Mock"):
        compose(provider=provider)


def test_bounded_facts_only_recorded_self_actions_and_history_budget():
    shared = replace(SHARED, user_actions=((PET, "comfort"), (PEER, "chicken")))
    prompt, messages, refs = compose(events=lambda *_: [shared], history=[ROW] * 30)
    data = json.loads(prompt.split("\n", 1)[1])
    assert data["events"][0]["self_user_actions"] == ["comfort"]
    assert len(messages) <= 12 and sum(len(row["content"]) for row in messages) <= 8000
    assert data["persona"]["version"] == 2 and refs == (EVENT,)


async def test_assembled_context_streams_through_fixed_local_mock_without_a_network_request():
    prompt, messages, _ = compose()
    chunks = [part async for part in PrivateMockLLM().stream(messages, prompt)]
    assert len(chunks) > 1 and "Mock" in "".join(chunks)
    assert "真实模型" in "".join(chunks)
