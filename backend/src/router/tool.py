"""Tool execution endpoints."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.db.database import get_session
from src.db.models import Session as SessionDB, ToolExecution
from src.tools.executor import ToolExecutor
from src.agent.models import (
    ToolExecuteRequest, ToolExecuteResponse,
    ToolExecuteBatchRequest, ToolExecuteBatchResponse,
)

router = APIRouter(prefix="/api/tool", tags=["tool"])


@router.post("/execute", response_model=ToolExecuteResponse)
async def execute_tool(
    req: ToolExecuteRequest,
    db_session: AsyncSession = Depends(get_session),
):
    """Execute a single tool."""
    # Validate session
    result = await db_session.execute(
        select(SessionDB).where(SessionDB.id == req.session_id)
    )
    session_row = result.scalar_one_or_none()
    if not session_row:
        raise HTTPException(status_code=404, detail="Session not found")

    executor = ToolExecutor(
        project_path=session_row.project_path,
        session_id=req.session_id,
    )

    import time
    start = time.time()
    result_data = await executor.execute(
        req.tool_call.name, dict(req.tool_call.params)
    )
    duration_ms = (time.time() - start) * 1000

    # Log execution
    try:
        log = ToolExecution(
            session_id=req.session_id,
            tool_call_id=req.tool_call.id,
            tool_name=req.tool_call.name,
            params=dict(req.tool_call.params),
            result=result_data,
            duration_ms=duration_ms,
        )
        db_session.add(log)
        await db_session.commit()
    except Exception:
        await db_session.rollback()

    return ToolExecuteResponse(
        tool_call_id=req.tool_call.id,
        result=result_data,
    )


@router.post("/execute-batch", response_model=ToolExecuteBatchResponse)
async def execute_tool_batch(
    req: ToolExecuteBatchRequest,
    db_session: AsyncSession = Depends(get_session),
):
    """Execute multiple tools in parallel."""
    result = await db_session.execute(
        select(SessionDB).where(SessionDB.id == req.session_id)
    )
    session_row = result.scalar_one_or_none()
    if not session_row:
        raise HTTPException(status_code=404, detail="Session not found")

    executor = ToolExecutor(
        project_path=session_row.project_path,
        session_id=req.session_id,
    )

    import asyncio, time

    async def execute_one(tc):
        start = time.time()
        res = await executor.execute(tc.name, dict(tc.params))
        duration_ms = (time.time() - start) * 1000
        return ToolExecuteResponse(tool_call_id=tc.id, result=res)

    results = await asyncio.gather(
        *[execute_one(tc) for tc in req.tool_calls]
    )

    return ToolExecuteBatchResponse(results=list(results))