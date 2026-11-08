import hashlib
import time

from fastapi.routing import APIRoute
from redis.exceptions import RedisError

from app.core.errors import AppError
from app.core.rate_limit import LUA_WINDOW


async def beta_limit(request, principal, namespace):
    window = int(time.time()) // 60
    state = request.app.state
    subject = hashlib.sha256(str(principal.user_id).encode()).hexdigest()
    key = f"weibiye:beta:{namespace}:{subject}:{window}"
    try:
        count = (
            (await state.redis.eval(LUA_WINDOW, 1, key, 60))
            if state.settings.rate_limit_backend == "redis"
            else await state.limiter.hit(key, window)
        )
    except RedisError:
        raise AppError(503, "RATE_LIMIT_UNAVAILABLE", "内测接口暂不可用。") from None
    if count > (10 if namespace == "claim" else 60):
        raise AppError(429, "RATE_LIMITED", "请求较频繁，请稍后再试。")


class BoundedBetaRoute(APIRoute):
    def get_route_handler(self):
        original = super().get_route_handler()

        async def bounded(request):
            if request.method == "POST":
                parts, size = [], 0
                async for chunk in request.stream():
                    size += len(chunk)
                    if size > 4096:
                        raise AppError(413, "BETA_REQUEST_TOO_LARGE", "请求内容超过大小限制。")
                    parts.append(chunk)
                request._body = b"".join(parts)
            return await original(request)

        return bounded
