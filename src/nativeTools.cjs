// Bridges the agent's canonical history to Ollama's native tool calling.
//
// History is always stored in the text protocol — assistant turns carry
// `TOOL_CALL: {...}` lines, results come back as `TOOL_RESULT: ...` user
// messages — because everything else (checkpoints, rewind, history replay,
// /compact, the eval) reads that format. For a model driven natively, the
// messages are converted just before sending, and the native tool calls in
// its reply are turned back into TOOL_CALL lines, so the loop downstream of
// the request does not know which mode produced them.

'use strict';

const { parseToolCalls } = require('./toolCallParser.cjs');

const RESULT_PREFIX = /^TOOL_RESULT:\s?/;
const BATCH_HEADER = /^--- ([\w.-]+)\((.*)\) ---$/gm;

/**
 * @param {Array<{role: string, content: string, images?: string[]}>} messages canonical messages (system first)
 * @returns {Array<object>} messages in Ollama's native tool-calling shape
 */
function toNativeMessages(messages) {
  const out = [];
  let pending = null; // names of the calls the previous assistant turn made, awaiting results
  for (const msg of messages) {
    const content = String(msg.content || '');
    if (msg.role === 'assistant') {
      const idx = content.indexOf('TOOL_CALL:');
      const calls = idx === -1 ? [] : parseToolCalls(content).filter((c) => c.ok);
      if (!calls.length) {
        out.push({ ...msg });
        pending = null;
        continue;
      }
      out.push({
        role: 'assistant',
        content: content.slice(0, idx).trim(),
        tool_calls: calls.map((c) => ({ function: { name: c.data.name, arguments: c.data.arguments || {} } })),
      });
      pending = calls.map((c) => c.data.name);
      continue;
    }
    if (msg.role === 'user' && pending && RESULT_PREFIX.test(content)) {
      const body = content.replace(RESULT_PREFIX, '').replace(/^\n/, '');
      for (const part of splitResults(body, pending)) out.push({ role: 'tool', tool_name: part.name, content: part.content });
      pending = null;
      continue;
    }
    pending = null;
    out.push({ ...msg });
  }
  return out;
}

// One tool message per call. A parallel batch comes back as one combined
// result with a "--- name(args) ---" header per call; split it back up.
function splitResults(body, names) {
  if (names.length <= 1) return [{ name: names[0], content: body }];
  const headers = [...body.matchAll(BATCH_HEADER)];
  if (headers.length !== names.length) return [{ name: names[0], content: body }, ...names.slice(1).map((name) => ({ name, content: '(see previous result)' }))];
  return headers.map((h, i) => ({
    name: h[1],
    content: body.slice(h.index + h[0].length, i + 1 < headers.length ? headers[i + 1].index : undefined).trim(),
  }));
}

/**
 * Turns a native reply back into canonical text.
 * @param {string} content
 * @param {Array<{function: {name: string, arguments: object|string}}>} toolCalls
 */
function synthesizeReply(content, toolCalls) {
  const lines = (toolCalls || []).map((tc) => {
    let args = tc.function?.arguments ?? {};
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args);
      } catch {
        args = {};
      }
    }
    return `TOOL_CALL: ${JSON.stringify({ name: tc.function?.name, arguments: args })}`;
  });
  return [String(content || '').trim(), ...lines].filter(Boolean).join('\n');
}

/**
 * Some models, offered native tools, write the call as JSON in their reply
 * instead (qwen2.5-coder does: a ```json {"name": ..., "arguments": ...}```
 * block). Recognised only when the reply is essentially just that object
 * and it names a real tool, so an explanation that shows JSON is untouched.
 *
 * @param {string} content
 * @param {Set<string>|string[]} toolNames
 * @returns {Array<{function: {name: string, arguments: object}}>}
 */
function extractJsonToolCalls(content, toolNames) {
  const names = toolNames instanceof Set ? toolNames : new Set(toolNames);
  const text = String(content || '').trim();
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  const body = (fenced ? fenced[1] : text).trim();
  if (!body.startsWith('{') && !body.startsWith('[')) return [];
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  const calls = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') return [];
    const name = item.name ?? item.function?.name;
    const args = item.arguments ?? item.parameters ?? item.function?.arguments ?? {};
    if (typeof name !== 'string' || !names.has(name) || typeof args !== 'object') return [];
    calls.push({ function: { name, arguments: args } });
  }
  return calls;
}

module.exports = { toNativeMessages, synthesizeReply, extractJsonToolCalls };
