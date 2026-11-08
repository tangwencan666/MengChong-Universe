import asyncio
import json
import subprocess
import sys
from pathlib import Path

import pytest
from auth_helpers import csrf
from fastapi.testclient import TestClient
from qq_p871_helpers import NOW, credentials
from qq_p872_helpers import FakeConnector, FakeSocket, GatewayHTTP, event, hello, ready
from test_memory_api import account
from test_p85_instances import adopt

from app.core.event_loop import new_event_loop
from app.modules.qq_p87.contracts import Rejected
from app.modules.qq_p871.config import QQOptions, load_options
from app.modules.qq_p871.sandbox import prepare_local
from app.modules.qq_p872.app import create_websocket_app
from app.modules.qq_p872.runner import GatewayRunner


def test_default_command_ignores_credentials_and_no_serve_flags_cannot_connect():
    base = [sys.executable, "-B", "-m", "scripts.p872_qq_websocket"]
    result = subprocess.run(
        base, cwd=Path(__file__).parents[1], capture_output=True, text=True, timeout=10
    )
    assert result.returncode == 0 and json.loads(result.stdout)["credentials_read"] is False
    assert json.loads(result.stdout)["real_qq_connections"] == 0
    bad = subprocess.run(
        base + ["--serve"],
        cwd=Path(__file__).parents[1],
        capture_output=True,
        text=True,
        timeout=10,
    )
    assert bad.returncode == 2 and "all three" in bad.stderr


def test_mode_and_permission_checks_precede_any_secret_read_or_runner_start():
    class NeverRead(dict):
        def get(self, key, default=None):
            assert key not in {"WEIBIYE_QQ_APP_ID", "WEIBIYE_QQ_APP_SECRET"}
            return super().get(key, default)

    with pytest.raises(Rejected, match="QQ_CREDENTIAL_ACCESS_NOT_AUTHORIZED"):
        load_options(NeverRead(WEIBIYE_QQ_MODE="official-websocket"))
    with pytest.raises(Rejected, match="QQ_WS_C2C_APPROVAL_REQUIRED"):
        GatewayRunner(None, None)
    with pytest.raises(Rejected, match="QQ_WS_C2C_APPROVAL_REQUIRED"):
        create_websocket_app(None, QQOptions())


def test_invalid_cli_options_cannot_echo_a_mistaken_credential_value():
    result = subprocess.run(
        [
            sys.executable,
            "-B",
            "-m",
            "scripts.p872_qq_websocket",
            "--app-secret",
            "SYNTHETIC_NEVER_ECHO_THIS",
        ],
        cwd=Path(__file__).parents[1],
        capture_output=True,
        text=True,
        timeout=10,
    )
    assert result.returncode == 2
    assert "SYNTHETIC_NEVER_ECHO_THIS" not in result.stdout + result.stderr


def test_real_local_auth_adoption_two_sided_binding_then_one_mock_reply_without_webhook(tmp_path):
    target = prepare_local(root=tmp_path)
    options = QQOptions("official-websocket", False, True, credentials())
    http = GatewayHTTP()
    socket = FakeSocket([hello(), ready()])
    connector = FakeConnector([socket])
    app = create_websocket_app(
        target,
        options,
        approved_c2c=True,
        connector=connector,
        transport=http.transport(),
        root=tmp_path,
        now=lambda: NOW,
        local_port=38712,
    )
    with TestClient(
        app,
        backend_options={"loop_factory": new_event_loop},
        headers={"Origin": "http://testserver"},
    ) as client:
        client.portal.call(socket.drained.wait)
        assert client.post("/api/v1/qq/callback", json={}).status_code == 404
        account(client)
        pet = adopt(client, species="hajimi")["pet_instance_id"]
        created = client.post(
            "/api/v1/qq/bindings/challenges", json={"pet_instance_id": pet}, headers=csrf(client)
        )
        token = created.json()["token"]

        async def deliver_control():
            socket.drained.clear()
            await socket.frames.put(event(2, text="/bind " + token))
            await socket.drained.wait()
            channel = app.state.qq_p871_channel
            await asyncio.gather(*list(channel._tasks))

        client.portal.call(deliver_control)
        assert len(http.sends) == 1
        code = http.sends[0]["content"].split("：", 1)[1]
        bound = client.post(
            "/api/v1/qq/bindings/confirm",
            json={
                "token": token,
                "confirmation": code,
                "allow_memory": False,
            },
            headers=csrf(client),
        )
        assert bound.status_code == 200

        async def deliver_chat():
            await socket.frames.put(event(3, identity="ROBOT1.0_actual_test", text="你好"))
            await app.state.qq_p872_runner._task

        client.portal.call(deliver_chat)
        status = client.get("/api/v1/qq/ws-status").json()
        assert status["status"] == "test_complete" and status["chat_attempts"] == 1
        assert status["outbound_attempts"] == 2 and status["paid_model_enabled"] is False
        assert len(http.sends) == 2 and "测试Mock" in http.sends[1]["content"]
        assert "p871_" in app.state.settings.session_cookie
    assert socket.closed and not app.state.qq_p871_channel._tasks
    assert app.state.qq_p871_channel.adapter.http.closed
