import pytest
from qq_p872_helpers import event, hello, ready

from app.modules.qq_p87.contracts import Rejected
from app.modules.qq_p872.state import C2C_INTENT, GatewayState, Reconnect
from app.modules.qq_p872.transport import gateway_url


def test_identify_requests_only_minimal_bundle_after_hello_and_waits_for_ready():
    state = GatewayState()
    state.connect(0)
    identify = state.receive(hello(), 1, "SYNTHETIC_TOKEN")
    assert identify == {
        "op": 2,
        "d": {
            "token": "QQBot SYNTHETIC_TOKEN",
            "intents": C2C_INTENT,
            "shard": [0, 1],
            "properties": {"$os": "windows"},
        },
    }
    assert state.phase == "identify"
    state.receive(ready(), 2, "SYNTHETIC_TOKEN")
    assert state.phase == "ready" and state.cursor == 1


def test_heartbeat_reports_processed_cursor_ack_watchdog_and_server_requested_beat():
    state = GatewayState()
    state.connect(0)
    state.receive(hello(1000), 0, "SYNTHETIC_TOKEN")
    state.receive(ready(), 0, "SYNTHETIC_TOKEN")
    state.receive(event(2), 0.2, "SYNTHETIC_TOKEN")
    assert state.cursor == 1  # receiving is not the durable admission boundary
    state.commit(2)
    assert state.tick(1) == {"op": 1, "d": 2}
    state.receive({"op": 11}, 1.1, "SYNTHETIC_TOKEN")
    assert state.receive({"op": 1}, 1.2, "SYNTHETIC_TOKEN") == {"op": 1, "d": 2}
    with pytest.raises(Reconnect):
        state.tick(2.2)


def test_resume_allows_replays_before_resumed_and_never_moves_cursor_backwards():
    state = GatewayState()
    state.connect(0)
    state.receive(hello(), 0, "SYNTHETIC_TOKEN")
    state.receive(ready(), 0, "SYNTHETIC_TOKEN")
    state.commit(4)
    state.connect(2)
    resume = state.receive(hello(), 3, "NEW_SYNTHETIC_TOKEN")
    assert resume == {
        "op": 6,
        "d": {"token": "QQBot NEW_SYNTHETIC_TOKEN", "session_id": "SYNTHETIC_SESSION", "seq": 4},
    }
    state.receive(event(5), 4, "NEW_SYNTHETIC_TOKEN")
    assert state.phase == "replaying" and state.cursor == 4
    state.commit(5)
    state.receive({"op": 0, "t": "RESUMED", "s": 6, "d": ""}, 5, "NEW_SYNTHETIC_TOKEN")
    state.commit(2)
    assert state.cursor == 6 and state.phase == "ready"


@pytest.mark.parametrize("op,fresh", [(7, False), (9, True)])
def test_reconnect_and_invalid_session_have_different_reset_rules(op, fresh):
    state = GatewayState(session="SYNTHETIC_SESSION", cursor=20, phase="ready")
    with pytest.raises(Reconnect) as error:
        state.receive({"op": op}, 0, "SYNTHETIC_TOKEN")
    assert error.value.fresh is fresh
    if fresh:
        state.clear()
    state.connect(2)
    assert state.receive(hello(), 3, "SYNTHETIC_TOKEN")["op"] == (2 if fresh else 6)


@pytest.mark.parametrize("bad", [True, 0, 999, 120001, "45000", None])
def test_untrusted_heartbeat_interval_cannot_create_a_busy_loop(bad):
    state = GatewayState()
    state.connect(0)
    with pytest.raises(Rejected):
        state.receive(hello(bad), 0, "SYNTHETIC_TOKEN")


@pytest.mark.parametrize(
    "frame",
    [event(), {"op": False}, {"op": 0, "s": True, "t": "READY"}, {"op": 0, "s": 1, "t": "RESUMED"}],
)
def test_dispatch_before_auth_or_malformed_control_is_refused(frame):
    state = GatewayState()
    state.connect(0)
    with pytest.raises(Rejected):
        state.receive(frame, 0, "SYNTHETIC_TOKEN")


def test_handshake_and_ready_deadlines_do_not_wait_forever():
    state = GatewayState()
    state.connect(0)
    with pytest.raises(Reconnect):
        state.tick(5)
    state.connect(10)
    state.receive(hello(), 11, "SYNTHETIC_TOKEN")
    with pytest.raises(Reconnect):
        state.tick(21)


@pytest.mark.parametrize(
    "url",
    [
        "ws://api.bot.qq.com/websocket",
        "wss://evil.invalid/websocket",
        "wss://api.bot.qq.com.evil.invalid/websocket",
        "wss://api.bot.qq.com:444/websocket",
        "wss://user:secret@api.bot.qq.com/websocket",
        "wss://api.bot.qq.com/websocket?token=x",
        "wss://api.bot.qq.com/other",
        None,
    ],
)
def test_gateway_discovery_cannot_redirect_credentials_or_connect_to_arbitrary_hosts(url):
    with pytest.raises(Rejected, match="QQ_WS_GATEWAY_INVALID"):
        gateway_url(url)
