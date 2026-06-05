"""SQLAlchemy ORM models for Agent OS."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import Column, String, Text, Integer, Float, DateTime, ForeignKey, JSON
from sqlalchemy.orm import DeclarativeBase, relationship


class Base(DeclarativeBase):
    pass


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _uuid() -> str:
    return str(uuid.uuid4())


class Session(Base):
    __tablename__ = "sessions"

    id = Column(String, primary_key=True, default=_uuid)
    project_path = Column(String, nullable=False)
    provider = Column(String, nullable=False, default="ollama")
    model = Column(String, nullable=False)
    status = Column(String, nullable=False, default="active")
    created_at = Column(DateTime, nullable=False, default=_utcnow)
    last_active = Column(DateTime, nullable=False, default=_utcnow, onupdate=_utcnow)
    turn_count = Column(Integer, nullable=False, default=0)
    session_metadata = Column("metadata", JSON, nullable=True)

    messages = relationship("Message", back_populates="session", cascade="all, delete-orphan")
    summary = relationship("ConversationSummary", back_populates="session", uselist=False, cascade="all, delete-orphan")
    tool_executions = relationship("ToolExecution", back_populates="session", cascade="all, delete-orphan")


class Message(Base):
    __tablename__ = "messages"

    id = Column(Integer, primary_key=True, autoincrement=True)
    session_id = Column(String, ForeignKey("sessions.id"), nullable=False)
    role = Column(String, nullable=False)  # 'user', 'assistant', 'system', 'tool'
    content = Column(Text, nullable=False)
    tool_call_id = Column(String, nullable=True)
    tool_name = Column(String, nullable=True)
    token_count = Column(Integer, nullable=True)
    created_at = Column(DateTime, nullable=False, default=_utcnow)

    session = relationship("Session", back_populates="messages")


class ConversationSummary(Base):
    __tablename__ = "conversation_summaries"

    session_id = Column(String, ForeignKey("sessions.id"), primary_key=True)
    summary = Column(Text, nullable=False)
    last_updated = Column(DateTime, nullable=False, default=_utcnow)
    turn_count = Column(Integer, nullable=False)
    model_used = Column(String, nullable=True)

    session = relationship("Session", back_populates="summary")


class ProjectMemory(Base):
    __tablename__ = "project_memories"

    project_path = Column(String, primary_key=True)
    stack = Column(JSON, nullable=False, default=dict)
    conventions = Column(JSON, nullable=False, default=list)
    important_files = Column(JSON, nullable=False, default=list)
    last_tasks = Column(JSON, nullable=False, default=list)
    updated_at = Column(DateTime, nullable=False, default=_utcnow, onupdate=_utcnow)


class ToolExecution(Base):
    __tablename__ = "tool_executions"

    id = Column(Integer, primary_key=True, autoincrement=True)
    session_id = Column(String, ForeignKey("sessions.id"), nullable=False)
    tool_call_id = Column(String, nullable=False)
    tool_name = Column(String, nullable=False)
    params = Column(JSON, nullable=False)
    result = Column(JSON, nullable=True)
    duration_ms = Column(Float, nullable=True)
    approved = Column(Integer, nullable=True)
    created_at = Column(DateTime, nullable=False, default=_utcnow)

    session = relationship("Session", back_populates="tool_executions")


class VectorIndexMetadata(Base):
    __tablename__ = "vector_index_metadata"

    project_path = Column(String, primary_key=True)
    last_indexed = Column(DateTime, nullable=True)
    total_files = Column(Integer, nullable=True)
    total_chunks = Column(Integer, nullable=True)
    index_version = Column(Integer, nullable=False, default=1)