// UI-agnostic agent loop: given a user message and a history, drives the
// plan -> tool call -> tool result -> ... -> final answer cycle against
// Ollama, invoking callbacks so any front-end (webview, CLI, tests) can
// render progress and gate mutating tools behind human approval.

'use strict';

const crypto = require('crypto');
const { chat } = require('./provider.cjs');
const { tools } = require('./tools.cjs');
const { buildSystemPrompt } = require('./systemPrompt.cjs');
const { buildContextMessages, DEFAULT_BUDGET_TOKENS } = require('./contextManager.cjs');

// Pull a TOOL_CALL: {...} instruction out of a model response.
//
// String-aware (braces inside quoted strings don't affect depth counting)
// and self-repairing: smaller/weaker local models frequently emit raw
// literal newlines/tabs inside JSON string values instead of escaping them
// as \n / \t, which would otherwise make JSON.parse throw. We fix those up
// on the fly instead of giving up.
function parseToolCall(text) {
  const marker = 'TOOL_CALL:';
  const idx = text.indexOf(marker);
  if (idx === -1) return { attempted: false };

  const after = text.slice(idx + marker.length);
  const start = after.indexOf('{');
  if (start === -1) {
    return { attempted: true, ok: false, error: 'no JSON object found after TOOL_CALL:', raw: after };
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;
  let sanitized = '';

  for (let i = start; i < after.length; i++) {
    const ch = after[i];
    if (inString) {
      if (escaped) {
        sanitized += ch;
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        sanitized += ch;
        escaped = true;
        continue;
      }
      if (ch === '"') {
        sanitized += ch;
        inString = false;
        continue;
      }
      if (ch === '\n') {
        sanitized += '\\n';
        continue;
      }
      if (ch === '\r') {
        sanitized += '\\r';
        continue;
      }
      if (ch === '\t') {
        sanitized += '\\t';
        continue;
      }
      sanitized += ch;
      continue;
    }
    if (ch === '"') {
      inString = true;
      sanitized += ch;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    sanitized += ch;
    if (depth === 0) {
      end = i;
      break;
    }
  }

  if (end === -1) {
    return { attempted: true, ok: false, error: 'unterminated JSON object (missing closing brace)', raw: after.slice(start) };
  }

  try {
    return { attempted: true, ok: true, data: JSON.parse(sanitized) };
  } catch (err) {
    return { attempted: true, ok: false, error: err.message, raw: sanitized };
  }
}

/**
 * @param {object} opts
 * @param {Array} opts.history           mutable array of {role, content} messages (mutated in place)
 * @param {string} opts.root             workspace root directory
 * @param {string} opts.host             ollama host
 * @param {string} opts.model            ollama model name
 * @param {number} opts.temperature
 * @param {number} opts.maxSteps
 * @param {string} opts.memoryNotes
 * @param {string} [opts.openFile]
 * @param {boolean} [opts.planMode]       when true, mutating tools (write_file/edit_file/run_command) are blocked
 * @param {number} [opts.contextBudgetTokens] rough token budget for history sent per turn (see contextManager.cjs)
 * @param {object} [opts.ctx]            passed through as tool.run's 3rd argument (webhook url, delegation config, etc.)
 * @param {AbortSignal} [opts.signal]
 * @param {(token: string) => void} opts.onToken           streamed assistant text
 * @param {(name: string, args: object, callId: string) => void} opts.onToolCall
 * @param {(name: string, args: object, callId: string) => Promise<boolean>} opts.requestApproval  called only for tools with confirm:true and autoApprove disabled
 * @param {(result: string, isError: boolean, callId: string, snapshot?: {path: string, before: string, after: string}) => void} opts.onToolResult
 * @param {(finalText: string, steps: number) => void} opts.onFinal
 * @param {(message: string) => void} opts.onError
 * @param {(message: string) => void} [opts.onLog]         optional diagnostic sink (wired to the host's OutputChannel)
 */
async function runTurn(opts) {
  const {
    history,
    root,
    host,
    provider,
    apiKey,
    model,
    temperature,
    maxSteps,
    memoryNotes,
    openFile,
    planMode,
    contextBudgetTokens = DEFAULT_BUDGET_TOKENS,
    ctx,
    signal,
    onToken,
    onToolCall,
    requestApproval,
    onToolResult,
    onFinal,
    onError,
    onLog,
  } = opts;

  let steps = 0;

  while (steps < maxSteps) {
    if (signal?.aborted) return;
    steps++;

    const system = buildSystemPrompt({ memoryNotes, cwd: root, openFile, planMode });
    const messages = buildContextMessages(system, history, contextBudgetTokens);
    onLog?.(`step ${steps}: sending ${messages.length} message(s) to ${model} (budget ${contextBudgetTokens} tok)`);

    let reply;
    try {
      reply = await chat({ host, provider, apiKey, model, messages, temperature, signal, onToken, logFn: onLog });
    } catch (err) {
      if (err.name === 'AbortError') return;
      onLog?.(`step ${steps}: error — ${err.message}`);
      onError(err.message);
      return;
    }

    const parsed = parseToolCall(reply);

    if (!parsed.attempted) {
      history.push({ role: 'assistant', content: reply });
      onFinal(reply.trim(), steps);
      return;
    }

    history.push({ role: 'assistant', content: reply });

    if (!parsed.ok) {
      const msg = `ERROR: your TOOL_CALL JSON was invalid (${parsed.error}). Respond again with a single valid TOOL_CALL: {...} line, making sure all string values properly escape newlines as \\n.`;
      history.push({ role: 'user', content: `TOOL_RESULT: ${msg}` });
      onToolResult(msg, true, null);
      continue;
    }

    const toolCall = parsed.data;
    const tool = tools[toolCall.name];

    if (!tool) {
      const msg = `ERROR: unknown tool "${toolCall.name}". Available: ${Object.keys(tools).join(', ')}`;
      history.push({ role: 'user', content: `TOOL_RESULT: ${msg}` });
      onToolResult(msg, true, null);
      continue;
    }

    const args = toolCall.arguments || {};
    const callId = crypto.randomUUID();
    onLog?.(`step ${steps}: tool call ${toolCall.name}(${JSON.stringify(args)}) [${callId}]`);
    onToolCall(toolCall.name, args, callId);

    if (planMode && tool.confirm) {
      const msg =
        `ERROR: the "${toolCall.name}" tool is disabled while in Plan Mode. Use read_file/list_dir/search_code to investigate, ` +
        `then respond with a plain-text plan (no tool call) describing what you would change and why. ` +
        `The user will switch you to Act Mode when they're ready for you to execute it.`;
      history.push({ role: 'user', content: `TOOL_RESULT: ${msg}` });
      onToolResult(msg, true, callId);
      continue;
    }

    if (tool.confirm) {
      const approved = await requestApproval(toolCall.name, args, callId);
      if (!approved) {
        const msg = 'User declined this action. Choose a different approach or ask the user what they want instead.';
        history.push({ role: 'user', content: `TOOL_RESULT: ${msg}` });
        onToolResult(msg, true, callId);
        continue;
      }
    }

    let snapshot;
    if (tool.preview) {
      try {
        const p = tool.preview(args, root);
        if (p && p.before !== undefined) snapshot = { path: p.path, before: p.before, after: p.after };
      } catch {
        // preview is best-effort for checkpointing; ignore failures here
      }
    }

    let result;
    let isError = false;
    try {
      result = await tool.run(args, root, ctx);
      isError = typeof result === 'string' && result.startsWith('ERROR');
    } catch (err) {
      result = `ERROR running tool: ${err.message}`;
      isError = true;
    }

    history.push({ role: 'user', content: `TOOL_RESULT:\n${result}` });
    onLog?.(`step ${steps}: tool result [${callId}] ${isError ? 'ERROR' : 'ok'} (${String(result).length} chars)`);
    onToolResult(result, isError, callId, isError ? undefined : snapshot);
  }

  onError('Stopped: too many steps without a final answer. Try starting a new chat or narrowing your request.');
}

module.exports = { runTurn, parseToolCall };
