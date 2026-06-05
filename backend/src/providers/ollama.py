"""Ollama model provider - local inference via HTTP."""

from __future__ import annotations

import json
import logging
import re
import uuid
from typing import AsyncIterator

import httpx

from src.config import settings

log = logging.getLogger("agent_os.ollama")
from src.providers.base import (
    ModelProvider,
    GenerationOptions,
    GenerationResult,
    TokenEvent,
    ToolCallEvent,
    DoneEvent,
    ErrorEvent,
    AgentEvent,
    count_tokens_heuristic,
)

TOOL_CALL_PATTERN = re.compile(r"<tool_call>(.*?)</tool_call>", re.DOTALL)
TOOL_CALL_JSON_PATTERN = re.compile(r"<tool_call>\s*({.*?})\s*</tool_call>", re.DOTALL)


def parse_tool_calls(text: str) -> list[dict]:
    """Parse <tool_call> tags from model output.

    Supports both XML format:
        <tool_call>
        <tool_name>read_file</tool_name>
        <parameters>
        <path>src/index.ts</path>
        </parameters>
        </tool_call>

    And JSON format:
        <tool_call>
        {"name": "read_file", "params": {"path": "src/index.ts"}}
        </tool_call>
    """
    tool_calls = []

    # Try JSON format first
    for match in TOOL_CALL_JSON_PATTERN.finditer(text):
        try:
            data = json.loads(match.group(1))
            if "name" in data:
                tool_calls.append({
                    "id": f"call_{uuid.uuid4().hex[:12]}",
                    "name": data["name"],
                    "params": data.get("params", {}),
                    "thought": data.get("thought", ""),
                })
        except (json.JSONDecodeError, KeyError):
            pass

    # If no JSON matches found, try XML format
    if not tool_calls:
        for match in TOOL_CALL_PATTERN.finditer(text):
            inner = match.group(1).strip()
            name_match = re.search(r"<tool_name>(.*?)</tool_name>", inner)
            if name_match:
                tool_calls.append({
                    "id": f"call_{uuid.uuid4().hex[:12]}",
                    "name": name_match.group(1).strip(),
                    "params": _parse_xml_params(inner),
                    "thought": "",
                })

    return tool_calls


def _parse_xml_params(xml_text: str) -> dict:
    """Parse <parameters> block from XML tool call."""
    params = {}
    param_match = re.search(r"<parameters>(.*?)</parameters>", xml_text, re.DOTALL)
    if param_match:
        inner = param_match.group(1)
        # Match <key>value</key> patterns
        for kv in re.finditer(r"<(\w+)>(.*?)</\1>", inner):
            params[kv.group(1)] = kv.group(2).strip()
    return params


class OllamaProvider(ModelProvider):
    """Provider for local Ollama inference."""

    def __init__(
        self,
        base_url: str = "",
        model: str = "",
    ):
        self.base_url = (base_url or settings.ollama_base_url).rstrip("/")
        self._model = model or settings.model

    @property
    def model(self) -> str:
        return self._model

    def name(self) -> str:
        return f"ollama/{self.model}"

    def count_tokens(self, text: str) -> int:
        return count_tokens_heuristic(text)

    async def generate(self, prompt: str, options: GenerationOptions | None = None) -> GenerationResult:
        opts = options or GenerationOptions()
        async with httpx.AsyncClient(timeout=120.0) as client:
            resp = await client.post(
                f"{self.base_url}/api/generate",
                json={
                    "model": self.model,
                    "prompt": prompt,
                    "stream": False,
                    "options": {
                        "temperature": opts.temperature,
                        "num_predict": opts.max_tokens,
                        "stop": opts.stop,
                    },
                },
            )
            resp.raise_for_status()
            data = resp.json()
            return GenerationResult(
                text=data.get("response", ""),
                finish_reason="stop",
                model=self.model,
                usage={"prompt_tokens": self.count_tokens(prompt)},
            )

    async def stream(self, prompt: str, options: GenerationOptions | None = None) -> AsyncIterator[AgentEvent]:
        opts = options or GenerationOptions()
        log.info("[OLLAMA_STREAM] model=%s url=%s/api/generate prompt_len=%d",
                 self.model, self.base_url, len(prompt))
        async with httpx.AsyncClient(timeout=300.0) as client:
            async with client.stream(
                "POST",
                f"{self.base_url}/api/generate",
                json={
                    "model": self.model,
                    "prompt": prompt,
                    "stream": True,
                    "options": {
                        "temperature": opts.temperature,
                        "num_predict": opts.max_tokens,
                        "stop": opts.stop,
                    },
                },
            ) as resp:
                if resp.is_error:
                    log.error("[OLLAMA_HTTP_ERROR] status=%d", resp.status_code)
                    yield ErrorEvent(message=f"Ollama error: {resp.status_code}")
                    return

                accumulated = ""
                line_count = 0
                async for line in resp.aiter_lines():
                    if not line.strip():
                        continue
                    try:
                        data = json.loads(line)
                    except json.JSONDecodeError:
                        log.warning("[OLLAMA_BAD_JSON] line=%s", line[:200])
                        continue

                    line_count += 1

                    # Detect Ollama error responses (HTTP 200 but error in body)
                    if "error" in data:
                        log.error("[OLLAMA_BODY_ERROR] error=%s", data["error"])
                        yield ErrorEvent(message=f"Ollama error: {data['error']}")
                        return

                    response_text = data.get("response", "")
                    if response_text:
                        accumulated += response_text
                        yield TokenEvent(content=response_text)

                    if data.get("done", False):
                        log.info("[OLLAMA_DONE] lines=%d accumulated_len=%d", line_count, len(accumulated))
                        break

        log.info("[OLLAMA_STREAM_END] accumulated_len=%d", len(accumulated))

        # Parse accumulated text for tool calls
        tool_calls = parse_tool_calls(accumulated)
        if tool_calls:
            log.info("[TOOL_CALLS_PARSED] count=%d", len(tool_calls))
        for tc in tool_calls:
            yield ToolCallEvent(
                id=tc["id"],
                tool=tc["name"],
                params=tc["params"],
                thought=tc.get("thought", ""),
            )

        yield DoneEvent(reason="stopped")
