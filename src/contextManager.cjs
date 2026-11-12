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

// Budgets used when the user hasn't set one (contextBudgetTokens: 0).
const LOCAL_SMALL_BUDGET = 8_000; // < 7B: runs on modest hardware, where a big window costs real memory
const LOCAL_BUDGET = 16_000;
const CLOUD_BUDGET_CAP = 100_000;
const OPENAI_COMPAT_BUDGET = 32_000;
const REPLY_RESERVE = 8_192;

/**
 * How much conversation to send per request.
 *
 * A fixed 6k budget made sense for a 3B model on a laptop and wasted almost
 * everything a hosted 250k-context model offers: long tasks lost their own
 * early steps for no reason. An explicit setting always wins; otherwise the
 * budget follows the model — what it supports, and whether a big window
 * costs local memory or nothing.
 *
 * @param {{host: string, provider?: string, model: string, configured?: number}} opts
 * @returns {Promise<number>}
 */
async function resolveContextBudget({ host, provider, model, configured }) {
  if (Number(configured) > 0) return Math.floor(Number(configured));
  if (provider === 'openai-compatible') return OPENAI_COMPAT_BUDGET;
  const { modelInfo } = require('./ollamaClient.cjs');
  const info = await modelInfo({ host, model });
  const ceiling = info.contextLength ? Math.max(2_000, info.contextLength - REPLY_RESERVE) : Infinity;
  if (info.cloud) return Math.min(CLOUD_BUDGET_CAP, ceiling === Infinity ? CLOUD_BUDGET_CAP : ceiling);
  const base = info.paramsB !== null && info.paramsB < 7 ? LOCAL_SMALL_BUDGET : LOCAL_BUDGET;
  return Math.min(base, ceiling);
}

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

/** Rough size of a whole history, in tokens. */
function historyTokens(history) {
  let n = 0;
  for (const m of history) n += estimateTokens(m.content) + 4;
  return n;
}

module.exports = { estimateTokens, historyTokens, buildContextMessages, resolveContextBudget, DEFAULT_BUDGET_TOKENS };
