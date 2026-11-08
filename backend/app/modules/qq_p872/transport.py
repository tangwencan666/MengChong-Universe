"""Fixed WSS origin, verified TLS, no proxy/redirect or raw frame/secret logging."""

import logging
from contextlib import asynccontextmanager
from urllib.parse import urlsplit

from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed, InvalidStatus

from app.modules.qq_p87.contracts import Rejected

from .state import Disconnected

_quiet = logging.getLogger("weibiye.qq_ws.private")
_quiet.disabled = True
_quiet.propagate = False


def gateway_url(value):
    try:
        parsed = urlsplit(value)
        if (
            not isinstance(value, str)
            or len(value) > 512
            or parsed.scheme != "wss"
            or parsed.hostname != "api.bot.qq.com"
            or parsed.port not in {None, 443}
            or parsed.path not in {"/websocket", "/websocket/"}
            or parsed.username
            or parsed.password
            or parsed.query
            or parsed.fragment
        ):
            raise ValueError
        return value
    except (TypeError, ValueError, AttributeError):
        raise Rejected("QQ_WS_GATEWAY_INVALID") from None


class _NoRedirectConnect(connect):
    def process_redirect(self, exc):
        # Never follow redirects even before sending the Identify token.
        return Rejected("QQ_WS_REDIRECT_REJECTED") if isinstance(exc, InvalidStatus) else exc


class Socket:
    def __init__(self, connection):
        self._connection = connection

    async def recv(self):
        try:
            return await self._connection.recv()
        except ConnectionClosed as error:
            code = error.rcvd.code if error.rcvd else 1006
            raise Disconnected(code) from None
        except Exception:
            raise Disconnected() from None

    async def send(self, text):
        try:
            await self._connection.send(text)
        except Exception:
            raise Disconnected() from None


class OfficialConnector:
    def __init__(self, *, authorize_network=False):
        self.authorized = authorize_network

    @asynccontextmanager
    async def open(self, url):
        if not self.authorized:
            raise Rejected("QQ_WS_NETWORK_DISABLED")
        url = gateway_url(url)
        try:
            async with _NoRedirectConnect(
                url,
                proxy=None,
                compression=None,
                ping_interval=None,
                open_timeout=5,
                close_timeout=2,
                max_size=32768,
                max_queue=4,
                logger=_quiet,
            ) as connection:
                yield Socket(connection)
        except (Rejected, Disconnected):
            raise
        except InvalidStatus:
            raise Rejected("QQ_WS_HANDSHAKE_REJECTED") from None
        except Exception:
            raise Disconnected() from None
