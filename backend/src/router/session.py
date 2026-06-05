"""Session management endpoints."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.db.database import get_session as get_db_session
from src.db.models import Session as SessionDB, Message as MessageDB, ConversationSummary
from src.memory.service import MemoryService
from src.agent.models import (
    SessionCreate, SessionResponse, SessionStatus, SessionShutdown,
    ConversationSummaryOut, ProjectMemory,
)
from src.config import settings

router = APIRouter(prefix="/api/session", tags=["session"])


@router.post("", response_model=SessionResponse, status_code=201)
async def create_session(
    req: SessionCreate,
    db: AsyncSession = Depends(get_db_session),
):
    """Create a new agent session."""
    session_id = str(uuid.uuid4())
    model = req.model or settings.model

    db_session_obj = SessionDB(
        id=session_id,
        project_path=req.project_path,
        provider=req.provider,
        model=model,
        status="active",
    )
    db.add(db_session_obj)
    await db.commit()

    # Load project memory
    memory_service = MemoryService(db)
    pm_data = await memory_service.get_project_memory(req.project_path)
    pm = ProjectMemory(**pm_data)

    # Trigger auto-indexing in background
    if req.auto_index:
        import asyncio
        asyncio.ensure_future(
            memory_service.index_project_files(req.project_path)
        )

    return SessionResponse(
        session_id=session_id,
        created_at=datetime.now(timezone.utc),
        project_path=req.project_path,
        project_memory=pm,
    )


@router.get("/{session_id}", response_model=SessionStatus)
async def get_session(
    session_id: str,
    db: AsyncSession = Depends(get_db_session),
):
    """Get session status."""
    result = await db.execute(
        select(SessionDB).where(SessionDB.id == session_id)
    )
    row = result.scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Session not found")
    return SessionStatus(
        session_id=row.id,
        status=row.status,
        turn_count=row.turn_count,
        created_at=row.created_at,
        last_active=row.last_active,
    )


@router.delete("/{session_id}", response_model=SessionShutdown)
async def shutdown_session(
    session_id: str,
    db: AsyncSession = Depends(get_db_session),
):
    """Shutdown and save session."""
    result = await db.execute(
        select(SessionDB).where(SessionDB.id == session_id)
    )
    row = result.scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Session not found")

    row.status = "closed"
    await db.commit()

    return SessionShutdown(
        session_id=session_id,
        summary_saved=True,
        turns=row.turn_count,
    )


@router.get("/{session_id}/summary", response_model=ConversationSummaryOut)
async def get_summary(
    session_id: str,
    db: AsyncSession = Depends(get_db_session),
):
    """Get conversation summary."""
    result = await db.execute(
        select(ConversationSummary).where(
            ConversationSummary.session_id == session_id
        )
    )
    row = result.scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="No summary found")
    return ConversationSummaryOut(
        session_id=row.session_id,
        summary=row.summary,
        last_updated=row.last_updated,
        turn_count=row.turn_count,
    )


@router.get("/{session_id}/project-memory", response_model=ProjectMemory)
async def get_project_memory(
    session_id: str,
    db: AsyncSession = Depends(get_db_session),
):
    """Get project memory for a session's project."""
    result = await db.execute(
        select(SessionDB).where(SessionDB.id == session_id)
    )
    row = result.scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Session not found")

    memory_service = MemoryService(db)
    pm_data = await memory_service.get_project_memory(row.project_path)
    return ProjectMemory(**pm_data)


@router.put("/{session_id}/project-memory")
async def update_project_memory(
    session_id: str,
    memory: ProjectMemory,
    db: AsyncSession = Depends(get_db_session),
):
    """Update project memory."""
    result = await db.execute(
        select(SessionDB).where(SessionDB.id == session_id)
    )
    row = result.scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Session not found")

    memory_service = MemoryService(db)
    await memory_service.update_project_memory(
        row.project_path, memory.model_dump()
    )
    return {"saved": True}