from collections.abc import AsyncIterator

from fastapi import Request
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine


def build_database(url: str):
    engine = create_async_engine(url, pool_pre_ping=True, echo=False)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def get_session(request: Request) -> AsyncIterator[AsyncSession]:
    factory: async_sessionmaker[AsyncSession] = request.app.state.session_factory
    async with factory() as session:
        try:
            yield session
        finally:
            # Services own explicit transaction boundaries; no implicit commit per request.
            await session.rollback()
