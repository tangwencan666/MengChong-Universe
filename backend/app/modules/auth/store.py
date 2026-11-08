import asyncio
import hashlib
import time

from fastapi import Request
from redis.exceptions import RedisError

from app.core.errors import AppError
from app.core.rate_limit import LUA_WINDOW


class AuthStore:
    """Redis in normal operation; explicit bounded memory implementation for isolated tests."""

    def __init__(self, cache=None):
        self.cache = cache
        self.values: dict[str, tuple[str, float]] = {}
        self.lock = asyncio.Lock()

    async def access(self, operation: str, key: str, ttl: int = 600, value: str = "1"):
        key = f"weibiye:auth:{key}"
        if self.cache is not None:
            try:
                if operation == "get":
                    return await self.cache.get(key)
                if operation == "increment":
                    return int(await self.cache.eval(LUA_WINDOW, 1, key, ttl))
                return await self.cache.set(key, value, ex=ttl)
            except RedisError:
                raise AppError(503, "AUTH_STORE_UNAVAILABLE", "认证服务暂时不可用。") from None
        async with self.lock:
            now = time.time()
            self.values = {k: v for k, v in self.values.items() if v[1] > now}
            if operation == "get":
                return self.values.get(key, (None, 0))[0]
            if len(self.values) >= 10000 and key not in self.values:
                raise AppError(503, "AUTH_STORE_CAPACITY", "认证服务暂时不可用。")
            if operation == "increment":
                old, expiry = self.values.get(key, ("0", now + ttl))
                value = str(int(old) + 1)
            else:
                expiry = now + ttl
            self.values[key] = (value, expiry)
            return int(value) if operation == "increment" else True


async def rate_limit(request: Request, purpose: str, limit: int, subject: str = "", seconds=900):
    peer = request.client.host if request.client else "unknown"
    subject = subject or peer
    key = hashlib.sha256(subject.encode()).hexdigest()
    window = int(time.time()) // seconds
    count = await request.app.state.auth_store.access(
        "increment", f"limit:{purpose}:{key}:{window}", seconds
    )
    if count > limit:
        raise AppError(429, "RATE_LIMITED", "请求过于频繁，请稍后再试。")
