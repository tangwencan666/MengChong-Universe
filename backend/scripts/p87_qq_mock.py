"""Local synthetic demonstration. No login, QQ connection, HTTP server or model SDK."""

import argparse
import asyncio
import json
import secrets
from dataclasses import asdict
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

from app.modules.qq_p87.contracts import Context, Memory, Receipt
from app.modules.qq_p87.mocks import FixtureContextReader, MockModel, MockQQAdapter
from app.modules.qq_p87.runtime import MockPetChannel
from app.modules.qq_p87.store import MockStore

ROOT = Path(__file__).resolve().parents[2]


async def demonstrate(output: Path):
    owner, other, pet, sibling, foreign = [str(uuid4()) for _ in range(5)]
    clock = int(datetime(2026, 11, 3, 4, tzinfo=UTC).timestamp())
    memory = Memory(owner, pet, str(uuid4()), str(uuid4()), 1, "SYNTHETIC：我喜欢安静的陪伴。")
    reader = FixtureContextReader(
        [
            Context(owner, pet, "哈吉米一号", "温柔、安静", "warm", 1, 1, (memory,)),
            Context(owner, sibling, "哈吉米二号", "好奇、独立", "playful", 1, 1),
            Context(other, foreign, "刀盾", "勇敢、认真", "calm", 1, 1),
        ]
    )
    store = MockStore(secrets.token_bytes(32), path=output / "qq-channel-metadata.sqlite3")
    store.add_account(owner, 10)
    store.add_account(other, 10)
    store.add_bot("mock-main")
    adapter, model = MockQQAdapter({"mock-main": secrets.token_bytes(32)}), MockModel()
    service = MockPetChannel(store, reader, model, adapter, now=lambda: clock)
    try:
        for user, animal, subject in [(owner, pet, "synthetic-a"), (other, foreign, "synthetic-b")]:
            token = await service.start_binding(user, animal, "mock-main")
            proof = Receipt("mock-main", subject, "bind-" + subject, "0", "/bind " + token, clock)
            await service.prove_binding(*adapter.envelope(proof), token)
            confirmation = adapter.sent[-1].text.split("：", 1)[1]
            await service.confirm_binding(user, token, confirmation, memory=user == owner)
        adapter.sent.clear()
        first = Receipt("mock-main", "synthetic-a", "message-1", "0", "今天想安静待一会儿。", clock)
        a = await service.receive(*adapter.envelope(first))
        replay = await service.receive(*adapter.envelope(first))
        b = await service.receive(
            *adapter.envelope(
                Receipt(
                    "mock-main",
                    "synthetic-b",
                    "message-2",
                    "0",
                    "你好，刀盾。",
                    clock,
                )
            )
        )
        denied = await service.receive(
            *adapter.envelope(
                Receipt(
                    "mock-main",
                    "synthetic-unbound",
                    "message-3",
                    "0",
                    "你好。",
                    clock,
                )
            )
        )
        jobs = [dict(row) for row in store.db.execute("SELECT * FROM jobs ORDER BY created,id")]
        result = {
            "status": "P87_LOCAL_MOCK_DEMONSTRATED",
            "network_transport": "none",
            "real_qq_messages_sent": 0,
            "real_model_requests": 0,
            "actual_supplier_cost_usd": None,
            "mock_messages": len(adapter.sent),
            "mock_model_calls": model.calls,
            "results": [asdict(v) for v in (a, replay, b, denied)],
            "simulated_usage_ledger": jobs,
            "synthetic_replies": [v.text for v in adapter.sent],
            "limitations": [
                "Not a QQ signature or network acceptance test",
                "No real model or invoice",
            ],
        }
        assert [a.status, b.status, denied.status] == ["sent", "sent", "BINDING_REQUIRED"]
        assert replay.replay and model.calls == len(adapter.sent) == 2
    finally:
        await service.close()
        result_cleanup = {
            "tasks_remaining": len(service._tasks),
            "pending_replies": len(service._pending),
        }
        store.close()
    result["cleanup"] = result_cleanup
    (output / "results.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    parent = ROOT / ".verification" / "p87"
    output = (args.output or parent / ("mock-" + str(uuid4()))).absolute()
    if output.parent != parent or not output.name.startswith("mock-") or output.is_symlink():
        raise SystemExit("Use a new project .verification/p87/mock-* directory")
    if parent.exists() and parent.is_symlink():
        raise SystemExit("Unsafe evidence directory")
    parent.mkdir(parents=True, exist_ok=True)
    output.mkdir(exist_ok=False)
    result = asyncio.run(demonstrate(output))
    print(json.dumps({"status": result["status"], "evidence": str(output), "paid_requests": 0}))


if __name__ == "__main__":
    main()
