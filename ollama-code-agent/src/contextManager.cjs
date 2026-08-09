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

/**
 * @param {string} systemPrompt
 * @param {Array<{role: string, content: string}>} history
 * @param {number} [budgetTokens]
 * @returns {Array<{role: string, content: string}>}
 */
function buildContextMessages(systemPrompt, history, budgetTokens = DEFAULT_BUDGET_TOKENS) {
  const systemTokens = estimateTokens(systemPrompt);
  let remaining = Math.max(0, budgetTokens - systemTokens);
  const kept = [];
  let droppedCount = 0;

  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    const cost = estimateTokens(msg.content);
    // Always keep at least the most recent message, even if it alone
    // blows the budget — an empty turn is worse than an oversized one.
    if (cost <= remaining || kept.length === 0) {
      kept.unshift(msg);
      remaining -= cost;
    } else {
      droppedCount = i + 1;
      break;
    }
  }

  const messages = [{ role: 'system', content: systemPrompt }];
  if (droppedCount > 0) {
    messages.push({
      role: 'user',
      content:
        `SYSTEM NOTE: ${droppedCount} earlier message(s) in this chat were omitted to fit the model's context ` +
        `window. Proceed using only what's visible below; if you need something from earlier, ask the user.`,
    });
  }
  messages.push(...kept);
  return messages;
}

module.exports = { estimateTokens, buildContextMessages, DEFAULT_BUDGET_TOKENS };
