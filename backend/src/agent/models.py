"""Pydantic models for the agent system."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from pydantic import BaseModel, Field


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


# ── Context Assembly ──

class FileContent(BaseModel):
    path: str
    content: str
    line_count: int = 0
    relevance_score: float = 0.0


class ContextSection(BaseModel):
    name: str
    content: str
    priority: int
    token_count: int = 0
    dropped: bool = False


class AssembledContext(BaseModel):
    text: str
    sections: list[ContextSection] = []
    total_tokens: int = 0
    dropped_sections: list[str] = []


# ── Messages ──

class Message(BaseModel):
    role: str  # 'user', 'assistant', 'system', 'tool'
    content: str
    tool_call_id: str | None = None
    tool_name: str | None = None
    token_count: int | None = None
    created_at: datetime | None = None


# ── Tool Calls ──

class ToolCall(BaseModel):
    id: str
    name: str
    params: dict[str, Any] = {}
    thought: str = ""


class ToolResult(BaseModel):
    tool_call_id: str
    result: dict[str, Any] = {}
    error: str | None = None
    duration_ms: float = 0.0


# ── Project Memory ──

class ProjectMemory(BaseModel):
    stack: dict[str, str] = {}
    conventions: list[str] = []
    important_files: list[str] = []
    last_tasks: list[str] = []
    ignored_paths: list[str] = [
        "node_modules", ".next", "dist", "build",
        "__pycache__", ".venv", "venv", ".git", ".agent",
    ]


# ── Session ──

class SessionCreate(BaseModel):
    project_path: str
    provider: str = "ollama"
    model: str = ""
    auto_index: bool = True


class SessionResponse(BaseModel):
    session_id: str
    created_at: datetime
    project_path: str
    project_memory: ProjectMemory = Field(default_factory=ProjectMemory)


class SessionStatus(BaseModel):
    session_id: str
    status: str
    turn_count: int
    created_at: datetime
    last_active: datetime


class SessionShutdown(BaseModel):
    session_id: str
    summary_saved: bool = True
    project_memory_saved: bool = True
    turns: int = 0
    duration_seconds: float = 0.0


class ConversationSummaryOut(BaseModel):
    session_id: str
    summary: str
    last_updated: datetime
    turn_count: int


# ── Completion ──

class CompletionRequest(BaseModel):
    session_id: str
    context: AssembledContext
    options: dict[str, Any] = {}


# ── Tool Execution ──

class ToolExecuteRequest(BaseModel):
    session_id: str
    tool_call: ToolCall


class ToolExecuteBatchRequest(BaseModel):
    session_id: str
    tool_calls: list[ToolCall]


class ToolExecuteResponse(BaseModel):
    tool_call_id: str
    result: dict[str, Any] = {}


class ToolExecuteBatchResponse(BaseModel):
    results: list[ToolExecuteResponse]


# ── Memory / RAG ──

class IndexRequest(BaseModel):
    project_path: str


class IndexFileRequest(BaseModel):
    project_path: str
    file_path: str


class IndexResponse(BaseModel):
    task_id: str = ""
    status: str = "indexing"
    estimated_files: int = 0


class IndexStatusResponse(BaseModel):
    task_id: str
    status: str
    files_indexed: int = 0
    total_chunks: int = 0
    duration_seconds: float = 0.0


class IndexFileResponse(BaseModel):
    file_path: str
    chunks: int = 0
    status: str = "indexed"


class RetrieveRequest(BaseModel):
    project_path: str
    query: str
    top_k: int = 3
    session_id: str | None = None


class RetrievedChunk(BaseModel):
    file_path: str
    content: str
    score: float = 0.0
    start_line: int = 0
    end_line: int = 0


class RetrieveResponse(BaseModel):
    query: str
    results: list[RetrievedChunk] = []


# ── Health ──

class ProviderStatus(BaseModel):
    available: bool = False
    model: str = ""
    latency_ms: float = 0.0
    error: str = ""


class HealthResponse(BaseModel):
    status: str = "healthy"
    providers: dict[str, ProviderStatus] = {}
    memory: dict[str, str] = {}
    version: str = "0.1.0"