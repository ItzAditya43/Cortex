// Builds the message array actually sent to Ollama each turn.
//
// The naive approach (send the whole history, or just slice the last N
// messages) either blows past small local models' context windows or
// silently drops context the model actually needed. This does a rough,
// dependency-free token-budget trim instead: keep as much recent history as
// fits, and if anything had to be dropped, tell the model so explicitly
// rather than leaving a silent gap it can't reason about.
//
// No real tokenizer dependency is used (that would mean bundling a
// model-specific BPE table for models we don't control) — chars/4 is a
// standard rough-and-ready approximation that's good enough for budgeting.

'use strict';

const CHARS_PER_TOKEN = 4;
const DEFAULT_BUDGET_TOKENS = 6000;

function estimateTokens(text) {
  return Math.ceil((text || '').length / CHARS_PER_TOKEN);
}

// Cuts the middle out of a message too large to send whole, keeping its
// head (what was asked / the start of a file) and tail (an error, the end of
// a command's output). Sending it unclipped doesn't work either: the server
// truncates the prompt itself, from the front, taking the system prompt and
// the task with it.
function clipToTokens(msg, maxTokens) {
  const content = String(msg.content || '');
  const maxChars = Math.max(400, maxTokens * CHARS_PER_TOKEN);
  if (content.length <= maxChars) return msg;
  const head = Math.floor(maxChars * 0.7);
  const tail = maxChars - head;
  const omitted = content.length - head - tail;
  return {
    ...msg,
    content:
      `${content.slice(0, head)}\n\n...[${omitted} characters omitted to fit the context window — ` +
      `re-read a narrower part (or search for what you need) if it mattered]...\n\n${content.slice(-tail)}`,
  };
}

/**
 * @param {string} systemPrompt
 * @param {Array<{role: string, content: string}>} history
 * @param {number} [budgetTokens]
 * @returns {Array<{role: string, content: string}>}
 */
function buildContextMessages(systemPrompt, history, budgetTokens = DEFAULT_BUDGET_TOKENS) {
  const systemTokens = estimateTokens(systemPrompt);
  let remaining = Math.max(0, budgetTokens - systemTokens);

  // The first real user message is the task itself. Dropping it — which a
  // plain newest-first trim does as soon as a long tool-heavy run fills the
  // budget — leaves the model executing tool results with no idea what it
  // was asked to do. Reserve room for it up front and always send it, so
  // truncation eats the middle (replaceable tool noise) instead of the goal.
  const anchorIndex = history.findIndex((m) => m.role === 'user' && !String(m.content || '').startsWith('TOOL_RESULT'));
  // A pasted log can make the task itself bigger than the whole window; only
  // then is it clipped.
  const anchor = anchorIndex === -1 ? null : clipToTokens(history[anchorIndex], remaining);
  if (anchor) remaining = Math.max(0, remaining - estimateTokens(anchor.content));

  const kept = [];
  let droppedCount = 0;

  for (let i = history.length - 1; i > anchorIndex; i--) {
    const msg = history[i];
    const cost = estimateTokens(msg.content);
    if (cost <= remaining) {
      kept.unshift(msg);
      remaining -= cost;
    } else if (kept.length === 0) {
      // Always keep the most recent message — an empty turn is worse than a
      // clipped one — but clipped to what is left, never sent oversized.
      kept.unshift(clipToTokens(msg, remaining));
      remaining = 0;
    } else {
      droppedCount = i - anchorIndex;
      break;
    }
  }

  const messages = [{ role: 'system', content: systemPrompt }];
  if (anchor) messages.push(anchor);
  if (droppedCount > 0) {
    messages.push({
      role: 'user',
      content:
        `SYSTEM NOTE: ${droppedCount} intermediate message(s) were omitted to fit the model's context window. ` +
        `The original request above is still authoritative — keep working toward it. If you need a detail from ` +
        `the omitted steps, re-read the relevant file rather than guessing.`,
    });
  }
  messages.push(...kept);
  return messages;
}

module.exports = { estimateTokens, buildContextMessages, DEFAULT_BUDGET_TOKENS };
