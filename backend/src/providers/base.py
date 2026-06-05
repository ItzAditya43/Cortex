"""Abstract base class for model providers."""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import AsyncIterator


@dataclass
class GenerationOptions:
    temperature: float = 0.2
    max_tokens: int = 4096
    stop: list[str] = field(default_factory=lambda: ["<DONE>"])


@dataclass
class GenerationResult:
    text: str
    finish_reason: str = "stop"
    model: str = ""
    usage: dict | None = None


@dataclass
class TokenEvent:
    type: str = "token"
    content: str = ""


@dataclass
class ToolCallEvent:
    type: str = "tool_call"
    id: str = ""
    tool: str = ""
    params: dict = field(default_factory=dict)
    thought: str = ""


@dataclass
class DoneEvent:
    type: str = "done"
    reason: str = "stopped"


@dataclass
class ErrorEvent:
    type: str = "error"
    message: str = ""


AgentEvent = TokenEvent | ToolCallEvent | DoneEvent | ErrorEvent


class ModelProvider(ABC):
    """Unified interface for model providers."""

    @abstractmethod
    async def generate(self, prompt: str, options: GenerationOptions | None = None) -> GenerationResult:
        """Non-streaming completion."""
        ...

    @abstractmethod
    async def stream(self, prompt: str, options: GenerationOptions | None = None) -> AsyncIterator[AgentEvent]:
        """Streaming completion yielding events."""
        ...  # pragma: no cover
        # This is a async generator, so we need a yield statement
        yield TokenEvent(content="")

    @abstractmethod
    def count_tokens(self, text: str) -> int:
        """Estimate token count for a text."""
        ...

    @abstractmethod
    def name(self) -> str:
        """Provider name."""
        ...


def count_tokens_heuristic(text: str) -> int:
    """Fast token count heuristic: ~4 chars per token for code."""
    return max(1, len(text) // 4)