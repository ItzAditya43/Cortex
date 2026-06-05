"""ModelGateway - unified interface dispatching to the correct provider."""

from __future__ import annotations

from typing import AsyncIterator

from src.config import settings
from src.providers.base import (
    ModelProvider,
    GenerationOptions,
    GenerationResult,
    AgentEvent,
)
from src.providers.ollama import OllamaProvider


class ModelGateway:
    """Gateway that selects and delegates to the configured model provider."""

    def __init__(self, provider_name: str | None = None, model: str | None = None):
        provider_name = provider_name or settings.provider
        model = model or settings.model

        self._provider: ModelProvider = self._create_provider(provider_name, model)
        self._provider_name = provider_name

    def _create_provider(self, provider_name: str, model: str) -> ModelProvider:
        if provider_name == "ollama":
            return OllamaProvider(model=model)
        elif provider_name == "openrouter":
            from src.providers.openrouter import OpenRouterProvider
            return OpenRouterProvider(model=model)
        elif provider_name == "gemini":
            from src.providers.gemini import GeminiProvider
            return GeminiProvider(model=model)
        else:
            raise ValueError(f"Unknown provider: {provider_name}")

    @property
    def provider(self) -> ModelProvider:
        return self._provider

    @property
    def provider_name(self) -> str:
        return self._provider_name

    async def generate(self, prompt: str, options: GenerationOptions | None = None) -> GenerationResult:
        opts = options or GenerationOptions(
            temperature=settings.temperature,
            max_tokens=settings.max_tokens,
        )
        return await self._provider.generate(prompt, opts)

    async def stream(self, prompt: str, options: GenerationOptions | None = None) -> AsyncIterator[AgentEvent]:
        opts = options or GenerationOptions(
            temperature=settings.temperature,
            max_tokens=settings.max_tokens,
        )
        async for event in self._provider.stream(prompt, opts):
            yield event

    def count_tokens(self, text: str) -> int:
        return self._provider.count_tokens(text)