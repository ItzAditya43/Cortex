"""FastAPI application entry point."""

from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from src.config import settings
from src.db.database import init_db, close_db

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s %(message)s",
    datefmt="%H:%M:%S",
)
for name in ("agent_os.runtime", "agent_os.completion", "agent_os.ollama"):
    logging.getLogger(name).setLevel(logging.INFO)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan: init DB on startup, cleanup on shutdown."""
    os.makedirs(settings.agent_home, exist_ok=True)
    await init_db()
    yield
    await close_db()


app = FastAPI(
    title="Agent OS Backend",
    description="Autonomous coding agent backend. Provides model inference, tool execution, and memory services.",
    version="0.1.0",
    lifespan=lifespan,
)

# CORS: allow VS Code webview and local dev
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Import and register routers
from src.router.health import router as health_router
from src.router.session import router as session_router
from src.router.completion import router as completion_router
from src.router.tool import router as tool_router
from src.router.memory import router as memory_router

app.include_router(health_router)
app.include_router(session_router)
app.include_router(completion_router)
app.include_router(tool_router)
app.include_router(memory_router)


@app.get("/")
async def root():
    return {
        "service": "Agent OS Backend",
        "version": "0.1.0",
        "docs": "/docs",
        "health": "/api/health",
    }