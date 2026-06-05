"""ConversationSummarizer - compresses conversation history."""

from __future__ import annotations

from src.config import settings
from src.providers.gateway import ModelGateway
from src.providers.base import GenerationOptions


class ConversationSummarizer:
    """Summarizes conversation history to fit within token budget."""

    def __init__(self):
        self._gateway: ModelGateway | None = None

    async def _get_gateway(self) -> ModelGateway:
        if self._gateway is None:
            self._gateway = ModelGateway(provider_name="ollama", model=settings.model)
        return self._gateway

    async def summarize(self, messages: list[dict]) -> str:
        """Summarize a list of conversation messages."""
        if not messages:
            return ""

        # Build the conversation text
        conversation_text = ""
        for msg in messages[-20:]:  # Only last 20 messages
            role = msg.get("role", "unknown")
            content = msg.get("content", "")
            if len(content) > 500:
                content = content[:500] + "..."
            if msg.get("tool_name"):
                conversation_text += f"{role} (tool: {msg['tool_name']}): {content}\n"
            else:
                conversation_text += f"{role}: {content}\n"

        summary_prompt = (
            "Summarize the following conversation concisely in 2-3 sentences. "
            "Focus on: the task being worked on, decisions made, "
            "files modified, commands run, and current status.\n\n"
            f"{conversation_text}\n\n"
            "Summary:"
        )

        try:
            gateway = await self._get_gateway()
            result = await gateway.generate(
                summary_prompt,
                GenerationOptions(temperature=0.3, max_tokens=200),
            )
            return result.text.strip()
        except Exception:
            # Fallback: just take first few messages
            if messages:
                first = messages[0].get("content", "")
                return f"Conversation about: {first[:100]}..."
            return ""

    async def summarize_messages(self, messages: list[dict], previous_summary: str = "") -> str:
        """Rolling summary - combines previous summary with new messages."""
        if not previous_summary:
            return await self.summarize(messages)

        # Only summarize the recent messages not yet summarized
        recent_text = ""
        for msg in messages[-5:]:
            role = msg.get("role", "unknown")
            content = msg.get("content", "")
            if len(content) > 300:
                content = content[:300] + "..."
            recent_text += f"{role}: {content}\n"

        rolling_prompt = (
            "Here is the previous conversation summary:\n"
            f"{previous_summary}\n\n"
            "Here are the most recent messages:\n"
            f"{recent_text}\n\n"
            "Provide an updated summary incorporating the new messages. "
            "Keep it to 2-3 sentences."
        )

        try:
            gateway = await self._get_gateway()
            result = await gateway.generate(
                rolling_prompt,
                GenerationOptions(temperature=0.3, max_tokens=200),
            )
            return result.text.strip()
        except Exception:
            return previous_summary