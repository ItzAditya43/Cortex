"""AgentRuntime - the core agent loop."""

from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import AsyncIterator, Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.config import settings
from src.providers.gateway import ModelGateway
from src.providers.base import GenerationOptions, TokenEvent, ToolCallEvent, DoneEvent, ErrorEvent
from src.tools.executor import ToolExecutor
from src.tools.registry import is_safe_command
from src.memory.service import MemoryService
from src.memory.summarizer import ConversationSummarizer
from src.db.models import Session as SessionDB, Message as MessageDB, ConversationSummary

log = logging.getLogger("agent_os.runtime")


class AgentRuntime:
    """Core agent runtime: manages message processing, tool execution, and memory."""

    def __init__(
        self,
        session_id: str,
        project_path: str,
        provider_name: str = "",
        model: str = "",
        db_session: AsyncSession | None = None,
    ):
        self.session_id = session_id
        self.project_path = project_path
        self.provider_name = provider_name or settings.provider
        self.model = model or settings.model

        self.messages: list[dict] = []
        self.turn_count: int = 0
        self.tool_results: list[dict] = []

        self.db_session = db_session
        self.gateway = ModelGateway(provider_name=self.provider_name, model=self.model)
        self.tool_executor = ToolExecutor(project_path=project_path, session_id=session_id)
        self.summarizer = ConversationSummarizer()

        if db_session:
            self.memory_service = MemoryService(db_session)
        else:
            self.memory_service = None

    async def process_message(self, user_message: str) -> AsyncIterator[dict]:
        """Core agent loop. Yields events as they happen."""
        log.info("[PROCESS_MESSAGE] START session=%s msg=%r", self.session_id, user_message[:100])
        self.messages.append({"role": "user", "content": user_message})
        self.turn_count += 1

        iteration_count = 0
        max_iterations = 15  # Safety limit

        while iteration_count < max_iterations:
            iteration_count += 1
            log.info("[ITERATION %d/%d] session=%s", iteration_count, max_iterations, self.session_id)

            # 1. Build context
            context_text = await self._build_context(user_message)
            options = GenerationOptions(
                temperature=settings.temperature,
                max_tokens=settings.max_tokens,
            )

            # 2. Stream model response
            accumulated_text = ""
            tool_calls: list[dict] = []
            token_count = 0

            try:
                log.info("[PROVIDER_CALL] session=%s model=%s provider=%s", self.session_id, self.model, self.provider_name)
                async for event in self.gateway.stream(context_text, options):
                    if isinstance(event, TokenEvent):
                        accumulated_text += event.content
                        token_count += 1
                        yield {"type": "token", "content": event.content}
                    elif isinstance(event, ToolCallEvent):
                        tool_calls.append({
                            "id": event.id,
                            "name": event.tool,
                            "params": event.params,
                            "thought": event.thought,
                        })
                        yield {
                            "type": "tool_call",
                            "id": event.id,
                            "tool": event.tool,
                            "params": event.params,
                            "thought": event.thought,
                        }
                    elif isinstance(event, ErrorEvent):
                        log.error("[PROVIDER_ERROR] session=%s msg=%s", self.session_id, event.message)
                        yield {"type": "error", "message": event.message}
                        return
                    elif isinstance(event, DoneEvent):
                        log.info("[PROVIDER_DONE] session=%s", self.session_id)
                        break
            except Exception as e:
                log.exception("[PROVIDER_EXCEPTION] session=%s", self.session_id)
                yield {"type": "error", "message": f"Model error: {str(e)}"}
                return

            log.info("[STREAM_COMPLETE] session=%s tokens=%d tool_calls=%d text_len=%d",
                     self.session_id, token_count, len(tool_calls), len(accumulated_text))

            # Save assistant message
            self.messages.append({
                "role": "assistant",
                "content": accumulated_text,
                "tool_calls": tool_calls if tool_calls else None,
            })

            # 3. Check if we need to execute tools
            if not tool_calls:
                # No tools → agent is done
                break

            # 4. Execute each tool call
            for tc in tool_calls:
                await self._save_db_message("assistant", accumulated_text, tool_name=tc.get("name"))

                # Check approval requirement
                requires_approval = self._check_approval_needed(tc)

                if requires_approval:
                    yield {
                        "type": "approval_request",
                        "tool_call_id": tc["id"],
                        "tool_name": tc["name"],
                        "params": tc["params"],
                    }

                # Execute the tool
                start_time = time.time()
                try:
                    result = await self.tool_executor.execute(tc["name"], tc["params"])
                except Exception as e:
                    result = {"error": str(e)}
                duration_ms = (time.time() - start_time) * 1000

                result["tool_call_id"] = tc["id"]
                result["duration_ms"] = duration_ms

                yield {
                    "type": "tool_result",
                    "tool_call_id": tc["id"],
                    "result": result,
                }

                # Save result to state
                self.tool_results.append(result)
                self.messages.append({
                    "role": "tool",
                    "tool_call_id": tc["id"],
                    "tool_name": tc["name"],
                    "content": json.dumps(result, default=str),
                })

                # Auto-index if file was written
                if tc["name"] in ("write_file", "create_file") and self.memory_service:
                    file_path = result.get("path", "")
                    if file_path:
                        try:
                            asyncio.ensure_future(
                                self.memory_service.index_file(self.project_path, file_path)
                            )
                        except Exception:
                            pass

            # 5. Summarize every 6 turns (non-blocking)
            if self.turn_count % 6 == 0:
                asyncio.ensure_future(self._update_summary())

        # Fire-and-forget summary update so done event is NOT blocked
        if self.messages:
            asyncio.ensure_future(self._update_summary())

        log.info("[PROCESS_MESSAGE] DONE session=%s turn=%d", self.session_id, self.turn_count)
        yield {"type": "done", "reason": "completed", "turn_count": self.turn_count}

    async def _build_context(self, user_message: str) -> str:
        """Build the context string from available sources."""
        parts = []

        # System prompt
        parts.append("System Prompt:\nYou are Agent OS, an autonomous coding assistant. "
                      "You can read and write files, run commands, and search the codebase.\n"
                      "When you need to use a tool, output it in <tool_call> tags:\n"
                      '<tool_call>\n{"name": "tool_name", "params": {...}}\n</tool_call>\n')

        # Project memory
        if self.memory_service:
            try:
                pm = await self.memory_service.get_project_memory(self.project_path)
                if pm.get("stack"):
                    parts.append(f"Project Stack:\n{json.dumps(pm['stack'], indent=2)}\n")
                if pm.get("conventions"):
                    parts.append(f"Conventions:\n" + "\n".join(f"- {c}" for c in pm["conventions"]) + "\n")
            except Exception:
                pass

        # Conversation summary
        if self.db_session:
            try:
                result = await self.db_session.execute(
                    select(ConversationSummary).where(ConversationSummary.session_id == self.session_id)
                )
                row = result.scalar_one_or_none()
                if row:
                    parts.append(f"Conversation Summary:\n{row.summary}\n")
            except Exception:
                pass

        # Recent messages (last 8)
        if self.messages:
            recent = self.messages[-8:]
            msg_text = "Recent Messages:\n"
            for m in recent:
                role = m["role"]
                content = m.get("content", "")
                if len(content) > 1000:
                    content = content[:1000] + "..."
                if m.get("tool_name"):
                    msg_text += f"  {role} (tool: {m['tool_name']}): {content}\n"
                else:
                    msg_text += f"  {role}: {content}\n"
            parts.append(msg_text)

        # Recent tool results
        if self.tool_results:
            tr_text = "Recent Tool Results:\n"
            for r in self.tool_results[-3:]:
                tr_text += f"  [Tool: {r.get('tool_call_id', '?')}]\n"
                if "error" in r:
                    tr_text += f"  Error: {r['error']}\n"
                elif "stdout" in r:
                    stdout = r.get("stdout", "")[:500]
                    tr_text += f"  stdout: {stdout}\n"
                    if r.get("exit_code") != 0:
                        tr_text += f"  exit_code: {r['exit_code']}\n"
                elif "diff" in r:
                    diff = r.get("diff", "")[:500]
                    tr_text += f"  diff: {diff}\n"
            parts.append(tr_text)

        # User message
        parts.append(f"User's Current Message:\n{user_message}\n")

        return "\n\n".join(parts)

    def _check_approval_needed(self, tool_call: dict) -> bool:
        """Check if a tool call requires user approval."""
        name = tool_call.get("name", "")
        always_approve = {"read_file", "list_directory", "search_files", "git_status", "git_diff"}
        always_require = {"delete_file", "git_commit"}

        if name in always_approve:
            return False
        if name in always_require:
            return True
        if name == "run_command":
            command = tool_call.get("params", {}).get("command", "")
            return not is_safe_command(command)
        if name in ("write_file", "create_file"):
            return True

        return False

    async def _save_db_message(self, role: str, content: str, **kwargs):
        """Save a message to the database."""
        if self.db_session is None:
            return
        try:
            msg = MessageDB(
                session_id=self.session_id,
                role=role,
                content=content,
                tool_call_id=kwargs.get("tool_call_id"),
                tool_name=kwargs.get("tool_name"),
                token_count=len(content) // 4,
            )
            self.db_session.add(msg)
            await self.db_session.commit()
        except Exception:
            await self.db_session.rollback()

    async def _update_summary(self):
        """Update the conversation summary."""
        if self.db_session is None:
            return
        try:
            summary_text = await self.summarizer.summarize(self.messages)
            result = await self.db_session.execute(
                select(ConversationSummary).where(ConversationSummary.session_id == self.session_id)
            )
            row = result.scalar_one_or_none()
            if row:
                row.summary = summary_text
                row.turn_count = self.turn_count
            else:
                self.db_session.add(ConversationSummary(
                    session_id=self.session_id,
                    summary=summary_text,
                    turn_count=self.turn_count,
                    model_used=f"{self.provider_name}/{self.model}",
                ))
            await self.db_session.commit()
        except Exception:
            await self.db_session.rollback()

    async def shutdown(self) -> dict:
        """Save final state and close session."""
        return {
            "session_id": self.session_id,
            "summary_saved": True,
            "turns": self.turn_count,
        }