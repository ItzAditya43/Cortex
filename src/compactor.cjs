// Conversation compaction: replaces the older part of a long history with a
// model-written brief, keeping the most recent exchanges verbatim.
//
// Trimming (contextManager.cjs) keeps a long session inside the window but
// forgets what it drops. A summary keeps the decisions, the files touched
// and what is left to do, which is what a long task actually needs to
// survive. Used automatically by the agent loop when a conversation
// outgrows its budget, and by /compact in both front-ends.

'use strict';

const { chat } = require('./provider.cjs');
const { estimateTokens } = require('./contextManager.cjs');

const SUMMARY_PREFIX = '[Earlier conversation summary]';

const SUMMARY_SYSTEM = `You are compacting the transcript of a coding-agent session so the agent can continue with a fresh context window. Write a brief the agent can resume from with no other memory of the session. Use these sections, omitting any that are empty:

## Request
What the user asked for, including constraints and preferences they stated. Quote the most recent request verbatim.

## Done so far
Concrete changes made (file paths, function names, commands run and their outcome). Be specific — "edited src/auth.js: added token refresh in login()" not "worked on auth".

## Key findings
Facts learned about the codebase that would be expensive to rediscover (where things live, how they connect, gotchas, failing tests and their errors).

## Remaining
What is still to do, in order, and the immediate next step.

Plain Markdown, no preamble, no closing remarks. Do not invent anything that is not in the transcript.`;

function isSummary(msg) {
  return msg?.role === 'user' && String(msg.content || '').startsWith(SUMMARY_PREFIX);
}

// Where the verbatim tail starts: as many recent messages as fit in
// `tailTokens`, beginning on an assistant message so a tool call is never
// separated from its result.
function tailStart(history, tailTokens) {
  let used = 0;
  let start = history.length;
  for (let i = history.length - 1; i >= 1; i--) {
    used += estimateTokens(history[i].content);
    if (used > tailTokens && start < history.length) break;
    if (history[i].role === 'assistant') start = i;
    if (used > tailTokens) break;
  }
  return start;
}

function renderTranscript(messages, maxChars) {
  const perMessage = 6000;
  const parts = messages.map((m) => {
    let c = String(m.content || '');
    if (c.length > perMessage) c = `${c.slice(0, perMessage * 0.6)}\n...[${c.length - perMessage} chars omitted]...\n${c.slice(-perMessage * 0.4)}`;
    return `### ${m.role === 'assistant' ? 'AGENT' : c.startsWith('TOOL_RESULT') ? 'TOOL' : 'USER'}\n${c}`;
  });
  let text = parts.join('\n\n');
  if (text.length > maxChars) {
    // Keep the opening (the task) and the latest work; the middle is the
    // most replaceable part of any transcript.
    const head = Math.floor(maxChars * 0.3);
    text = `${text.slice(0, head)}\n\n...[middle of the transcript omitted]...\n\n${text.slice(-(maxChars - head))}`;
  }
  return text;
}

/**
 * Summarizes `history` in place.
 * @param {object} opts
 * @param {Array<{role: string, content: string}>} opts.history  mutated on success
 * @param {{host: string, provider?: string, apiKey?: string, model: string, numCtx?: number}} opts.chatOpts
 * @param {number} [opts.budgetTokens]   the context budget the conversation has to fit in
 * @param {boolean} [opts.keepTail]      keep recent exchanges verbatim (default true)
 * @param {AbortSignal} [opts.signal]
 * @param {(message: string) => void} [opts.logFn]
 * @returns {Promise<{ok: boolean, summarized: number, summary?: string, reason?: string}>}
 */
async function compactHistory({ history, chatOpts, budgetTokens = 8000, keepTail = true, signal, logFn }) {
  if (!Array.isArray(history) || history.length < 3) return { ok: false, summarized: 0, reason: 'nothing to compact' };
  const cut = keepTail ? tailStart(history, Math.floor(budgetTokens * 0.25)) : history.length;
  const older = history.slice(0, cut);
  if (older.length < 2) return { ok: false, summarized: 0, reason: 'nothing to compact' };

  // The summarizer's own prompt has to fit the same window.
  const maxChars = Math.max(8000, Math.floor(budgetTokens * 0.6) * 4);
  let summary;
  try {
    summary = await chat({
      ...chatOpts,
      temperature: 0.1,
      signal,
      logFn,
      messages: [
        { role: 'system', content: SUMMARY_SYSTEM },
        { role: 'user', content: `Transcript to compact:\n\n${renderTranscript(older, maxChars)}` },
      ],
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    return { ok: false, summarized: 0, reason: err.message };
  }
  summary = String(summary || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  if (summary.length < 40) return { ok: false, summarized: 0, reason: 'the model returned an empty summary' };

  const tail = history.slice(cut);
  history.length = 0;
  history.push({ role: 'user', content: `${SUMMARY_PREFIX}\n${summary}\n\n(The conversation above this point was compacted into this summary. Continue the work from here; re-read files rather than trusting memory of their contents.)` }, ...tail);
  return { ok: true, summarized: older.length, summary };
}

module.exports = { compactHistory, isSummary, SUMMARY_PREFIX, tailStart };
