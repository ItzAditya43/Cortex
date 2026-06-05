"""Application configuration via pydantic-settings."""

from __future__ import annotations

import os
from pathlib import Path
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    # Server
    host: str = "0.0.0.0"
    port: int = 8080
    debug: bool = True

    # Provider defaults
    provider: str = "ollama"
    model: str = "qwen2.5-coder:3b"
    temperature: float = 0.2
    max_tokens: int = 4096
    context_window: int = 8192

    # Ollama
    ollama_base_url: str = "http://localhost:11434"

    # OpenRouter
    openrouter_api_key: str = ""
    openrouter_base_url: str = "https://openrouter.ai/api/v1"
    openrouter_default_model: str = "google/gemma-2-9b-it:free"

    # Gemini
    gemini_api_key: str = ""
    gemini_base_url: str = "https://generativelanguage.googleapis.com/v1beta"
    gemini_default_model: str = "gemini-2.0-flash-exp"

    # Storage paths
    agent_home: str = str(Path.home() / ".agent")
    sqlite_path: str = ""
    chromadb_path: str = ""

    # Indexing
    auto_index: bool = True

    @property
    def resolved_sqlite_path(self) -> str:
        return self.sqlite_path or os.path.join(self.agent_home, "agent.db")

    @property
    def resolved_chromadb_path(self) -> str:
        return self.chromadb_path or os.path.join(self.agent_home, "chromadb")

    @property
    def ollama_available(self) -> bool:
        return True  # Checked at runtime via health endpoint

    @property
    def openrouter_available(self) -> bool:
        return bool(self.openrouter_api_key)

    @property
    def gemini_available(self) -> bool:
        return bool(self.gemini_api_key)

    class Config:
        env_prefix = "AGENT_OS_"
        env_file = ".env"
        env_file_encoding = "utf-8"


settings = Settings()