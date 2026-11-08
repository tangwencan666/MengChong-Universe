"""Loopback management app plus an explicitly enabled outbound official gateway."""

from contextlib import asynccontextmanager

from app.modules.qq_p87.contracts import Rejected
from app.modules.qq_p87.mocks import MockModel
from app.modules.qq_p871.sandbox import create_local_app

from .channel import TestBudgetHTTP, WebSocketPetChannel, WebSocketQQAdapter
from .protocol import WebSocketProtocol
from .runner import GatewayRunner
from .transport import OfficialConnector


def create_websocket_app(
    target,
    options,
    *,
    approved_c2c=False,
    authorize_network=False,
    connector=None,
    transport=None,
    runner_options=None,
    **local_options,
):
    if options.mode != "official-websocket" or not approved_c2c:
        raise Rejected("QQ_WS_C2C_APPROVAL_REQUIRED")
    if connector is None:
        connector = OfficialConnector(authorize_network=authorize_network)
    elif transport is None or options.allow_network:
        raise Rejected("QQ_WS_TEST_TRANSPORT_REQUIRED")

    def factory(store, reader):
        http = TestBudgetHTTP(
            options.credentials,
            allow_network=options.allow_network,
            allow_send=options.allow_send,
            transport=transport,
        )
        now = local_options.get("now")
        if now is None:
            import time

            def now():
                return int(time.time())

        adapter = WebSocketQQAdapter(WebSocketProtocol(options.credentials.app_id), http, now=now)
        return WebSocketPetChannel(store, reader, MockModel(), adapter, now=now, enable=True)

    app = create_local_app(
        target,
        options,
        authorize_network=authorize_network,
        channel_factory=factory,
        receive_callback=False,
        transport=transport,
        **local_options,
    )
    original = app.router.lifespan_context

    @app.get("/api/v1/qq/ws-status", include_in_schema=False)
    async def ws_status():
        runner = getattr(app.state, "qq_p872_runner", None)
        return (
            runner.snapshot() if runner else {"status": "not-started", "paid_model_enabled": False}
        )

    @asynccontextmanager
    async def lifespan(app):
        async with original(app):
            runner = GatewayRunner(
                app.state.qq_p871_channel, connector, approved_c2c=True, **(runner_options or {})
            )
            app.state.qq_p872_runner = runner
            runner.start()
            try:
                yield
            finally:
                await runner.close()

    app.router.lifespan_context = lifespan
    return app
