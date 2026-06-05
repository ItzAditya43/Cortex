"""Memory / RAG endpoints."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from src.db.database import get_session
from src.memory.service import MemoryService
from src.agent.models import (
    IndexRequest, IndexFileRequest, IndexResponse, IndexStatusResponse,
    IndexFileResponse, RetrieveRequest, RetrieveResponse, RetrievedChunk,
)

router = APIRouter(prefix="/api/memory", tags=["memory"])

# In-memory task tracking for async indexing
_index_tasks: dict[str, dict] = {}


@router.post("/index", response_model=IndexResponse, status_code=202)
async def index_project(
    req: IndexRequest,
    db_session: AsyncSession = Depends(get_session),
):
    """Index (or re-index) the entire project."""
    task_id = f"index_{uuid.uuid4().hex[:12]}"
    memory_service = MemoryService(db_session)

    _index_tasks[task_id] = {"status": "indexing", "files_indexed": 0, "total_chunks": 0}

    import asyncio

    async def run_index():
        try:
            result = await memory_service.index_project_files(req.project_path)
            _index_tasks[task_id] = {
                "status": "completed",
                "files_indexed": result.get("files_indexed", 0),
                "total_chunks": result.get("total_chunks", 0),
            }
        except Exception as e:
            _index_tasks[task_id] = {"status": "failed", "error": str(e)}

    asyncio.ensure_future(run_index())

    import os
    from pathlib import Path
    project = Path(req.project_path)
    estimated = 0
    if project.exists():
        for _ in project.rglob("*"):
            if _.is_file() and not _.name.startswith("."):
                estimated += 1

    return IndexResponse(
        task_id=task_id,
        status="indexing",
        estimated_files=min(estimated, 1000),
    )


@router.get("/index/{task_id}", response_model=IndexStatusResponse)
async def get_index_status(task_id: str):
    """Get indexing task status."""
    task = _index_tasks.get(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    return IndexStatusResponse(
        task_id=task_id,
        status=task.get("status", "unknown"),
        files_indexed=task.get("files_indexed", 0),
        total_chunks=task.get("total_chunks", 0),
        duration_seconds=task.get("duration", 0.0),
    )


@router.post("/index-file", response_model=IndexFileResponse)
async def index_file(
    req: IndexFileRequest,
    db_session: AsyncSession = Depends(get_session),
):
    """Index a single file (called on save)."""
    memory_service = MemoryService(db_session)
    result = await memory_service.index_file(req.project_path, req.file_path)
    return IndexFileResponse(
        file_path=result.get("file_path", req.file_path),
        chunks=result.get("chunks", 0),
        status=result.get("status", "error"),
    )


@router.post("/retrieve", response_model=RetrieveResponse)
async def retrieve_chunks(
    req: RetrieveRequest,
    db_session: AsyncSession = Depends(get_session),
):
    """Retrieve relevant file chunks for a query."""
    memory_service = MemoryService(db_session)
    chunks = await memory_service.retrieve_relevant_chunks(
        req.project_path, req.query, req.top_k
    )

    results = [
        RetrievedChunk(
            file_path=c.get("file_path", ""),
            content=c.get("content", ""),
            score=c.get("score", 0.0),
            start_line=c.get("start_line", 0),
            end_line=c.get("end_line", 0),
        )
        for c in chunks
    ]

    return RetrieveResponse(query=req.query, results=results)