import asyncio
import hashlib
import time

from fastapi import Request
from redis.exceptions import RedisError

from app.core.errors import AppError

LUA_WINDOW = """
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return count
"""


class MemoryWindowLimiter:
    """Single-process development only; never a production fallback."""

    def __init__(self):
        self.buckets: dict[tuple[str, int], int] = {}
        self.lock = asyncio.Lock()

    async def hit(self, key: str, window: int) -> int:
        async with self.lock:
            self.buckets = {k: v for k, v in self.buckets.items() if k[1] == window}
            if len(self.buckets) >= 10000 and (key, window) not in self.buckets:
                raise AppError(503, "LIMITER_CAPACITY", "服务暂时不可用。")
            bucket = (key, window)
            self.buckets[bucket] = self.buckets.get(bucket, 0) + 1
            return self.buckets[bucket]


async def demo_rate_limit(request: Request) -> None:
    settings = request.app.state.settings
    peer = request.client.host if request.client else "unknown"
    key = hashlib.sha256(peer.encode()).hexdigest()[:24]
    window = int(time.time()) // 60
    if settings.rate_limit_backend == "redis":
        try:
            count = await request.app.state.redis.eval(
                LUA_WINDOW, 1, f"weibiye:demo:{key}:{window}", 60
            )
        except RedisError:
            raise AppError(503, "RATE_LIMIT_UNAVAILABLE", "限流服务不可用。") from None
    else:
        count = await request.app.state.limiter.hit(key, window)
    if count > settings.demo_requests_per_minute:
        raise AppError(429, "RATE_LIMITED", "请求过于频繁，请稍后再试。")
