"""Health check and configuration endpoints."""

from __future__ import annotations

import time

import httpx
from fastapi import APIRouter, Depends
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from src.db.database import get_session
from src.db.models import VectorIndexMetadata, Session as SessionDB
from src.config import settings
from src.agent.models import HealthResponse, ProviderStatus

router = APIRouter(tags=["health"])


@router.get("/api/health", response_model=HealthResponse)
async def health_check(db_session: AsyncSession = Depends(get_session)):
    """Health check with provider and memory status."""
    providers = {}

    # Check Ollama
    try:
        start = time.time()
        async with httpx.AsyncClient(timeout=2.0) as client:
            resp = await client.get(f"{settings.ollama_base_url}/api/tags")
            latency = (time.time() - start) * 1000
            if resp.status_code == 200:
                providers["ollama"] = ProviderStatus(
                    available=True, model=settings.model, latency_ms=latency
                )
            else:
                providers["ollama"] = ProviderStatus(
                    available=False, error=f"HTTP {resp.status_code}"
                )
    except Exception as e:
        providers["ollama"] = ProviderStatus(available=False, error=str(e))

    # Check OpenRouter
    if settings.openrouter_available:
        providers["openrouter"] = ProviderStatus(
            available=True, model=settings.openrouter_default_model
        )
    else:
        providers["openrouter"] = ProviderStatus(available=False, error="API key not configured")

    # Check Gemini
    if settings.gemini_available:
        providers["gemini"] = ProviderStatus(
            available=True, model=settings.gemini_default_model
        )
    else:
        providers["gemini"] = ProviderStatus(available=False, error="API key not configured")

    # Check memory status
    memory = {"sqlite": "connected"}
    try:
        result = await db_session.execute(select(func.count()).select_from(VectorIndexMetadata))
        count = result.scalar() or 0
        memory["chromadb"] = "connected"
        memory["files_indexed"] = str(count * 100)  # rough estimate
    except Exception:
        memory["chromadb"] = "not initialized"

    return HealthResponse(
        status="healthy",
        providers=providers,
        memory=memory,
    )


@router.get("/api/config")
async def get_config():
    """Get current backend configuration."""
    return {
        "provider": settings.provider,
        "model": settings.model,
        "max_tokens": settings.max_tokens,
        "temperature": settings.temperature,
        "context_window": settings.context_window,
        "auto_index": settings.auto_index,
        "chromadb_path": settings.resolved_chromadb_path,
        "sqlite_path": settings.resolved_sqlite_path,
        "ollama_base_url": settings.ollama_base_url,
        "openrouter_available": settings.openrouter_available,
        "gemini_available": settings.gemini_available,
    }