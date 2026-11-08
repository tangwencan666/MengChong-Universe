import json
import sqlite3
import subprocess
import sys
from contextlib import closing
from pathlib import Path

import pytest
from auth_helpers import csrf, login
from fastapi.testclient import TestClient
from qq_p871_helpers import NOW, SECRET, RecordingHTTP, credentials
from test_memory_api import account
from test_p85_instances import adopt

from app.core.event_loop import new_event_loop
from app.modules.qq_p87.contracts import Rejected
from app.modules.qq_p87.store import MockStore
from app.modules.qq_p871.config import QQOptions
from app.modules.qq_p871.sandbox import create_local_app, load_local, prepare_local


def test_prepare_and_load_only_new_owned_sqlite_with_real_migration_and_identity(tmp_path):
    target = prepare_local(root=tmp_path)
    folder, path, run = load_local(target, root=tmp_path)
    assert folder.name == "sandbox-" + run and path.name == "application.sqlite3"
    with closing(sqlite3.connect(path)) as db:
        assert db.execute("SELECT version_num FROM alembic_version").fetchone() == ("0006",)
    assert SECRET not in target.read_text(encoding="utf-8")
    # Arbitrary files and transplanted targets cannot claim this isolation identity.
    unrelated = tmp_path / "target.json"
    unrelated.write_bytes(target.read_bytes())
    with pytest.raises(Rejected, match="QQ_SANDBOX_IDENTITY_INVALID"):
        load_local(unrelated, root=tmp_path)


def test_fixture_identity_or_migration_change_is_not_bypassed(tmp_path):
    target = prepare_local(root=tmp_path)
    _, path, _ = load_local(target, root=tmp_path)
    with closing(sqlite3.connect(path)) as db:
        db.execute("UPDATE p871_sandbox_identity SET kind='foreign'")
        db.commit()
    with pytest.raises(Rejected, match="QQ_SANDBOX_IDENTITY_INVALID"):
        load_local(target, root=tmp_path)


def test_live_factory_needs_explicit_network_authorization_before_initialization(tmp_path):
    target = prepare_local(root=tmp_path)
    options = QQOptions("official-webhook", True, True, credentials())
    with pytest.raises(Rejected, match="QQ_NETWORK_NOT_AUTHORIZED"):
        create_local_app(target, options, root=tmp_path)
    assert not (target.parent / "qq-metadata.sqlite3").exists()


def test_local_composition_keeps_app_accounts_and_synthetic_credit_across_restart(tmp_path):
    target = prepare_local(root=tmp_path)
    options = QQOptions("official-webhook", False, True, credentials())
    recorded = RecordingHTTP()
    app = create_local_app(
        target, options, transport=recorded.transport(), root=tmp_path, now=lambda: NOW
    )
    with TestClient(
        app,
        backend_options={"loop_factory": new_event_loop},
        headers={"Origin": "http://testserver"},
    ) as client:
        assert client.get("/api/v1/qq/sandbox-ready").json() == {
            "status": "isolated-qq-mock-model-ready",
            "paid_model_enabled": False,
            "shared_database": False,
            "redis_required": False,
        }
        account(client)
        assert "weibiye_session" not in client.cookies
        assert client.app.state.settings.session_cookie.startswith("p871_")
        owner = client.get("/api/v1/auth/me").json()["id"]
        assert len(client.get("/api/v1/pet-instances/species").json()["items"]) == 8
        identity = adopt(client, species="moon")["pet_instance_id"]
        start = client.post(
            "/api/v1/qq/bindings/challenges",
            json={"pet_instance_id": identity},
            headers=csrf(client),
        )
        assert start.status_code == 200
        state = app.state.qq_p871_channel
        assert (
            state.store.db.execute(
                "SELECT granted FROM accounts WHERE owner=?", (owner,)
            ).fetchone()[0]
            == 5
        )
        assert not recorded.requests
    assert state.closed and state.adapter.http.closed
    reopened = create_local_app(
        target, options, transport=recorded.transport(), root=tmp_path, now=lambda: NOW
    )
    with TestClient(
        reopened,
        backend_options={"loop_factory": new_event_loop},
        headers={"Origin": "http://testserver"},
    ) as client:
        result = login(client, email="memory-a@example.com")
        assert result.status_code == 200
        assert any(row["pet_id"] == identity for row in client.get("/api/v1/pets").json()["items"])
        second = client.post(
            "/api/v1/qq/bindings/challenges",
            json={"pet_instance_id": identity},
            headers=csrf(client),
        )
        assert second.status_code == 200
        store = reopened.state.qq_p871_channel.store
        assert store.db.execute("SELECT count(*) FROM accounts").fetchone()[0] == 1
        assert not client.app.state.settings.real_llm_enabled
    assert not recorded.requests


def test_serve_without_gates_exits_before_credentials_and_never_starts_listener():
    result = subprocess.run(
        [sys.executable, "-B", "-m", "scripts.p871_qq_sandbox", "--serve"],
        cwd=Path(__file__).parents[1],
        capture_output=True,
        text=True,
        timeout=10,
    )
    assert result.returncode == 2 and "both QQ confirmation flags" in result.stderr


def test_configuration_target_cannot_enable_shared_database_or_paid_models(tmp_path):
    target = prepare_local(root=tmp_path)
    data = json.loads(target.read_text(encoding="utf-8"))
    data["shared_database"] = True
    target.write_text(json.dumps(data), encoding="utf-8")
    with pytest.raises(Rejected, match="QQ_SANDBOX_IDENTITY_INVALID"):
        load_local(target, root=tmp_path)


def test_failed_adapter_startup_still_closes_only_its_own_metadata_store(tmp_path, monkeypatch):
    target = prepare_local(root=tmp_path)
    closed = []
    original = MockStore.close

    def close(store):
        closed.append(store.path)
        return original(store)

    monkeypatch.setattr(MockStore, "close", close)
    options = QQOptions("official-webhook", True, True, credentials())
    app = create_local_app(
        target,
        options,
        authorize_network=True,
        root=tmp_path,
        transport=RecordingHTTP().transport(),
    )
    with (
        pytest.raises(Rejected, match="QQ_TEST_TRANSPORT_REQUIRED"),
        TestClient(app, backend_options={"loop_factory": new_event_loop}),
    ):
        pass
    assert closed == [target.parent / "qq-metadata.sqlite3"]
