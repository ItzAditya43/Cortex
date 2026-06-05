"""Completion streaming endpoint - the main agent loop entry point."""

from __future__ import annotations

import json
import logging
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.db.database import get_session
from src.db.models import Session as SessionDB
from src.agent.runtime import AgentRuntime
from src.agent.models import CompletionRequest

router = APIRouter(prefix="/api/completion", tags=["completion"])
log = logging.getLogger("agent_os.completion")


@router.post("/stream")
async def stream_completion(
    req: CompletionRequest,
    db_session: AsyncSession = Depends(get_session),
):
    """Stream a model completion. Main agent loop entry point."""
    log.info("[REQUEST_RECEIVED] session_id=%s sections=%d", req.session_id, len(req.context.sections))

    # Validate session
    result = await db_session.execute(
        select(SessionDB).where(SessionDB.id == req.session_id)
    )
    session_row = result.scalar_one_or_none()
    if not session_row:
        log.error("[SESSION_NOT_FOUND] session_id=%s", req.session_id)
        raise HTTPException(status_code=404, detail="Session not found")

    log.info("[SESSION_LOADED] session_id=%s provider=%s model=%s project=%s",
             session_row.id, session_row.provider, session_row.model, session_row.project_path)

    # Create runtime and process message
    runtime = AgentRuntime(
        session_id=req.session_id,
        project_path=session_row.project_path,
        provider_name=session_row.provider,
        model=session_row.model,
        db_session=db_session,
    )

    user_message = ""
    for section in req.context.sections:
        if section.name == "userMessage" and section.content:
            user_message = section.content
            break

    if not user_message:
        user_message = "Continue with the task."

    log.info("[RUNTIME_CREATED] session=%s msg_preview=%r", req.session_id, user_message[:80])

    async def event_stream():
        event_count = 0
        try:
            async for event in runtime.process_message(user_message):
                event_count += 1
                payload = json.dumps(event, default=str)
                log.info("[SSE_EVENT #%d] session=%s type=%s preview=%s",
                         event_count, req.session_id, event.get("type", "?"), payload[:200])
                yield f"data: {payload}\n\n"
        except Exception as e:
            log.exception("[STREAM_EXCEPTION] session=%s", req.session_id)
            yield f"data: {json.dumps({'type': 'error', 'message': str(e)}, default=str)}\n\n"
        log.info("[STREAM_CLOSED] session=%s events_sent=%d", req.session_id, event_count)

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
