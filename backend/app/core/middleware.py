import logging
import time
from uuid import uuid4

from fastapi import FastAPI, Request


def install_request_middleware(app: FastAPI, *, production: bool) -> None:
    @app.middleware("http")
    async def request_context(request: Request, call_next):
        # Generate a server ID; never trust an arbitrary client value in logs.
        request.state.request_id = str(uuid4())
        started = time.monotonic()
        try:
            response = await call_next(request)
        except Exception:
            from app.core.errors import error_response

            response = error_response(request, 500, "INTERNAL_ERROR", "服务暂时不可用。")
        response.headers.update(
            {
                "X-Request-ID": request.state.request_id,
                "X-Content-Type-Options": "nosniff",
                "X-Frame-Options": "DENY",
                "Referrer-Policy": "no-referrer",
                "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
                "Cache-Control": "no-store",
            }
        )
        if production:
            response.headers["Strict-Transport-Security"] = "max-age=31536000"
        logging.getLogger("weibiye").info(
            "http_request",
            extra={
                "request_id": request.state.request_id,
                "method": request.method,
                "route": getattr(request.scope.get("route"), "path", "unmatched"),
                "status": response.status_code,
                "duration_ms": round((time.monotonic() - started) * 1000, 2),
            },
        )
        return response
