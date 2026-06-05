"""Database engine and session factory."""

from __future__ import annotations

from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession

from src.config import settings
from src.db.models import Base


engine = create_async_engine(
    f"sqlite+aiosqlite:///{settings.resolved_sqlite_path}",
    echo=settings.debug,
    connect_args={"check_same_thread": False},
)

async_session_factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


async def init_db() -> None:
    """Create all tables if they don't exist."""
    import os
    os.makedirs(os.path.dirname(settings.resolved_sqlite_path), exist_ok=True)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)


async def get_session() -> AsyncSession:
    """Dependency: get a DB session."""
    async with async_session_factory() as session:
        try:
            yield session
        finally:
            await session.close()


async def close_db() -> None:
    """Dispose the engine on shutdown."""
    await engine.dispose()