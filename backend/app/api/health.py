import asyncio

from fastapi import APIRouter, Request
from redis.exceptions import RedisError
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from app.core.errors import AppError
from app.db.capabilities import SchemaUnavailable, require_enabled_capabilities

router = APIRouter(tags=["health"])


@router.get("/health/live")
async def live():
    return {"status": "ok", "service": "weibiye", "version": "0.1.0"}


@router.get("/health/ready")
async def ready(request: Request):
    try:
        async with asyncio.timeout(3):
            async with request.app.state.session_factory() as session:
                await session.execute(text("SELECT 1"))
                await require_enabled_capabilities(
                    session, request.app.state.settings, verify_schema=True
                )
            await request.app.state.redis.ping()
    except (TimeoutError, OSError, SQLAlchemyError, RedisError, SchemaUnavailable):
        raise AppError(503, "DEPENDENCIES_UNAVAILABLE", "数据库或缓存尚未就绪。") from None
    return {"status": "ready"}
