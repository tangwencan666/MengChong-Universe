"""Chat-only admission counters; never share or clear auth keys."""

import hashlib
import time
from uuid import uuid4

from redis.exceptions import RedisError

from app.core.errors import AppError
from app.core.rate_limit import LUA_WINDOW

RESERVE = """
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[4]) then return 0 end
redis.call('ZADD', KEYS[1], ARGV[2], ARGV[3])
redis.call('EXPIRE', KEYS[1], 15)
return 1
"""
RENEW = """
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
if not redis.call('ZSCORE', KEYS[1], ARGV[3]) then return 0 end
redis.call('ZADD', KEYS[1], ARGV[2], ARGV[3])
redis.call('EXPIRE', KEYS[1], 15)
return 1
"""


async def command_limit(request, principal):
    state = request.app.state
    window = int(time.time()) // 60
    peer = request.client.host if request.client else "unknown"
    for subject, limit in (
        (str(principal.user_id), state.settings.chat_commands_per_minute),
        ("ip:" + peer, state.settings.chat_ip_commands_per_minute),
    ):
        subject = hashlib.sha256(subject.encode()).hexdigest()
        key = f"weibiye:chat:{state.chat_scope}:limit:{subject}:{window}"
        if state.settings.rate_limit_backend == "redis":
            try:
                count = await state.redis.eval(LUA_WINDOW, 1, key, 60)
            except RedisError:
                raise AppError(503, "RATE_LIMIT_UNAVAILABLE", "聊天限流暂不可用。") from None
        else:
            count = await state.limiter.hit(key, window)
        if count > limit:
            raise AppError(
                429,
                "RATE_LIMITED",
                "请求较频繁，请稍后再试。",
                {"Retry-After": str(60 - int(time.time()) % 60)},
            )


async def stream_slot(request, principal, token=None, *, release=False):
    state = request.app.state
    token, new = token or uuid4().hex, token is None
    key = f"weibiye:chat:{state.chat_scope}:streams:{principal.user_id}"
    timestamp = time.time()
    try:
        if state.settings.rate_limit_backend == "redis":
            if release:
                await state.redis.zrem(key, token)
                return token
            success = await state.redis.eval(
                RESERVE if new else RENEW,
                1,
                key,
                timestamp,
                timestamp + 15,
                token,
                state.settings.chat_stream_limit,
            )
        else:
            async with state.chat_stream_lock:
                state.chat_streams = {
                    k: {t: exp for t, exp in values.items() if exp > timestamp}
                    for k, values in state.chat_streams.items()
                    if any(exp > timestamp for exp in values.values())
                }
                slots = state.chat_streams.setdefault(key, {})
                if release:
                    slots.pop(token, None)
                    return token
                success = len(slots) < state.settings.chat_stream_limit if new else token in slots
                if success:
                    slots[token] = timestamp + 15
        if not success:
            raise AppError(
                429, "CHAT_CAPACITY_LIMIT", "同时打开的聊天连接较多。", {"Retry-After": "5"}
            )
        return token
    except RedisError:
        raise AppError(503, "RATE_LIMIT_UNAVAILABLE", "聊天连接管理暂不可用。") from None
