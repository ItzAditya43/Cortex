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
const { verifySyntax } = require('./verify.cjs');
const { pickModel } = require('./router.cjs');
const { getStaleWarning } = require('./fileTracker.cjs');
const { classifyError } = require('./errorClassification.cjs');
const lsp = require('./lsp.cjs');

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

// Parses EVERY TOOL_CALL in a response, not just the first.
//
// One call per round-trip means reading five files costs five full model
// round-trips. Letting the model emit several read-only calls at once and
// running them together collapses that into one, which is the single
// biggest latency win available here and costs no quality — strong models
// batch reads naturally when told they can.
//
// Mutating calls are deliberately NOT batched: each one needs its own
// approval, diff and checkpoint, and later edits in a batch could be built
// on assumptions invalidated by earlier ones.
function parseToolCalls(text) {
  const calls = [];
  let rest = text;
  let offset = 0;
  while (true) {
    const parsed = parseToolCall(rest);
    if (!parsed.attempted) break;
    calls.push(parsed);
    if (!parsed.ok) break; // stop at the first malformed one so the model gets a clear error
    // advance past this call's closing brace to look for the next one
    const idx = rest.indexOf('TOOL_CALL:');
    const nextSearchFrom = idx + 'TOOL_CALL:'.length;
    const following = rest.slice(nextSearchFrom);
    const nextIdx = following.indexOf('TOOL_CALL:');
    if (nextIdx === -1) break;
    rest = following.slice(nextIdx);
    offset += nextSearchFrom + nextIdx;
    if (calls.length >= 8) break; // sanity cap
  }
  return calls;
}

// Emergency in-place compaction for a context overflow mid-turn. Keeps the
// task (the first user message) and the most recent exchanges, replacing the
// middle with a marker — the same shape the context manager already assumes,
// so nothing downstream has to know this happened.
function compactHistoryInPlace(history) {
  if (history.length <= 4) return 0;
  const keepTail = 4;
  const first = history[0];
  const tail = history.slice(-keepTail);
  const droppedCount = history.length - keepTail - 1;
  if (droppedCount <= 0) return 0;
  history.length = 0;
  history.push(first, {
    role: 'user',
    content: `TOOL_RESULT: SYSTEM NOTE — ${droppedCount} earlier step(s) were dropped because the conversation exceeded the model's context window. The original request above still stands. Re-read any file you need rather than relying on memory of it.`,
  }, ...tail);
  return droppedCount;
}

/**
 * @param {object} opts
 * @param {Array} opts.history           mutable array of {role, content} messages (mutated in place)
 * @param {string} opts.root             workspace root directory
 * @param {string} opts.host             ollama host
 * @param {string} opts.model            ollama model name
 * @param {string} [opts.fastModel]      optional smaller/faster model routed to for read-only investigation steps (see router.cjs)
 * @param {number} opts.temperature
 * @param {number} opts.maxSteps
 * @param {string} opts.memoryNotes
 * @param {string} [opts.openFile]
 * @param {{text: string, file?: string, startLine?: number, endLine?: number}} [opts.selection] currently highlighted editor text, if any
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
    fastModel,
    escalateModel,
    temperature,
    maxSteps,
    memoryNotes,
    openFile,
    selection,
    planMode,
    contextBudgetTokens = DEFAULT_BUDGET_TOKENS,
    testCommand,
    onTestRun,
    ctx,
    signal,
    onToken,
    onUsage,
    onRecovery,
    onToolCall,
    requestApproval,
    onToolResult,
    onFinal,
    onError,
    onLog,
  } = opts;

  let steps = 0;
  let usedMutatingTool = false;
  let codeFenceNudged = false;
  let testRan = false;
  let consecutiveFailures = 0;
  let contextRecoveries = 0;
  let rateLimitBackoffs = 0;
  const editFailuresByPath = new Map(); // path -> consecutive edit_file misses, drives the whole-file fallback
  const callSignatures = new Map(); // "tool(args)" -> times seen, for loop detection

  while (steps < maxSteps) {
    if (signal?.aborted) return;
    steps++;

    // If the same tool call has failed (or produced a syntax-broken edit)
    // twice in a row, the small/fast model is probably stuck — escalate to
    // a stronger model for the next attempt instead of retrying the same
    // mistake indefinitely.
    const escalating = !!escalateModel && escalateModel !== model && consecutiveFailures >= 2;
    const activeModel = escalating ? escalateModel : pickModel({ model, fastModel, usedMutatingTool, isFirstStep: steps === 1 });
    const routedLabel = escalating ? ' (escalated after repeated failures)' : activeModel !== model ? ' (routed: fast)' : '';
    const system = buildSystemPrompt({ memoryNotes, cwd: root, openFile, planMode, selection });
    const messages = buildContextMessages(system, history, contextBudgetTokens);
    onLog?.(`step ${steps}: sending ${messages.length} message(s) to ${activeModel}${routedLabel} (budget ${contextBudgetTokens} tok)`);

    let reply;
    try {
      reply = await chat({ host, provider, apiKey, model: activeModel, messages, temperature, signal, onToken, onUsage, logFn: onLog });
    } catch (err) {
      // Only stay silent when the USER actually cancelled. Any other abort
      // (a stalled model, a dropped connection) must be reported, or the
      // turn just ends with no output and no explanation.
      if (err.name === 'AbortError' && signal?.aborted) return;

      const failure = classifyError(err);
      onLog?.(`step ${steps}: ${failure.kind} error — ${err.message}`);

      // Some failures the loop can actually fix rather than hand to the user.
      if (failure.kind === 'context' && contextRecoveries < 1) {
        contextRecoveries++;
        onLog?.(`step ${steps}: context overflow — compacting history and retrying`);
        onRecovery?.('context', 'The conversation outgrew the context window — summarizing it and continuing.');
        const dropped = compactHistoryInPlace(history);
        if (dropped > 0) {
          steps--; // the failed call shouldn't consume a step
          continue;
        }
      }
      if (failure.retryable && failure.kind === 'rate-limit' && rateLimitBackoffs < 2) {
        rateLimitBackoffs++;
        const waitMs = 2000 * rateLimitBackoffs;
        onRecovery?.('rate-limit', `Rate limited — waiting ${waitMs / 1000}s before retrying.`);
        await new Promise((r) => setTimeout(r, waitMs));
        steps--;
        continue;
      }

      onError(failure.advice ? `${err.message}\n\n${failure.advice}` : err.message);
      return;
    }

    const parsed = parseToolCall(reply);

    if (!parsed.attempted) {
      // Small models frequently "explain" a change with a fenced code block
      // instead of actually calling write_file/edit_file — nothing gets
      // saved to disk even though the response looks like it did the work.
      // Give one nudge back before accepting it as a genuine final answer.
      if (/```/.test(reply) && !codeFenceNudged) {
        codeFenceNudged = true;
        history.push({ role: 'assistant', content: reply });
        history.push({
          role: 'user',
          content:
            'TOOL_RESULT: You printed a code block instead of calling a tool, so nothing was saved. If you intended to change a file, respond with TOOL_CALL: {"name": "write_file"|"edit_file", "arguments": {...}} instead. If you were just showing an example/explanation with no file change intended, say so in plain text without any ``` fences.',
        });
        continue;
      }
      // Before accepting a final answer, if this turn actually changed
      // files, give the project's own test command one chance to catch
      // what pre-diff syntax verification can't (logic errors, broken
      // integration) — same idea as Claude Code running tests after edits,
      // instead of trusting the model's own "this should work now".
      if (usedMutatingTool && testCommand && !testRan && steps < maxSteps) {
        testRan = true;
        onLog?.(`step ${steps}: turn modified files — running test command: ${testCommand}`);
        const testResult = await tools.run_command.run({ command: testCommand }, root, ctx);
        const failed = /^ERROR|EXIT CODE: [1-9]/.test(testResult);
        onTestRun?.(testCommand, testResult, failed);
        if (failed) {
          history.push({ role: 'assistant', content: reply });
          history.push({
            role: 'user',
            content: `TOOL_RESULT: Your changes were made, but running the test command ("${testCommand}") failed:\n${testResult}\n\nFix the failure, or explain to the user why it's expected/unrelated.`,
          });
          continue;
        }
        onLog?.(`step ${steps}: tests passed`);
      }
      history.push({ role: 'assistant', content: reply });
      onFinal(reply.trim(), steps);
      return;
    }

    history.push({ role: 'assistant', content: reply });

    if (!parsed.ok) {
      const msg = `ERROR: your TOOL_CALL JSON was invalid (${parsed.error}). Respond again with a single valid TOOL_CALL: {...} line, making sure all string values properly escape newlines as \\n.`;
      history.push({ role: 'user', content: `TOOL_RESULT: ${msg}` });
      onToolResult(msg, true, null);
      consecutiveFailures++;
      continue;
    }

    // Batch path: several read-only calls in one response run concurrently
    // and come back as a single combined result, turning N round-trips into
    // one. Anything mutating falls through to the single-call path below so
    // it keeps its own approval, diff and checkpoint.
    const allCalls = parseToolCalls(reply);
    if (allCalls.length > 1 && allCalls.every((c) => c.ok && tools[c.data.name] && tools[c.data.name].readOnly)) {
      const batch = allCalls.map((c) => ({ name: c.data.name, args: c.data.arguments || {}, callId: crypto.randomUUID() }));
      onLog?.(`step ${steps}: running ${batch.length} read-only tool calls in parallel`);
      for (const b of batch) onToolCall(b.name, b.args, b.callId);

      const settled = await Promise.all(
        batch.map(async (b) => {
          try {
            const out = await tools[b.name].run(b.args, root, ctx);
            return { ...b, result: out, isError: typeof out === 'string' && out.startsWith('ERROR') };
          } catch (err) {
            return { ...b, result: `ERROR running tool: ${err.message}`, isError: true };
          }
        })
      );

      for (const r of settled) onToolResult(r.result, r.isError, r.callId);
      consecutiveFailures = settled.every((r) => r.isError) ? consecutiveFailures + 1 : 0;
      const combined = settled
        .map((r) => `--- ${r.name}(${JSON.stringify(r.args)}) ---\n${r.result}`)
        .join('\n\n');
      const stale = getStaleWarning(root);
      history.push({ role: 'user', content: `TOOL_RESULT:\n${combined}${stale ? `\n\n${stale}` : ''}` });
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

    if (tool.confirm) usedMutatingTool = true; // route to the main model from here on, even if this call gets declined

    const args = toolCall.arguments || {};

    // Loop breaker. Models get stuck repeating one identical call — the
    // benchmark caught a run making the same search_code call 14 times,
    // burning the entire step budget without ever acting on the answer.
    // Re-running a read-only tool with identical arguments cannot produce
    // new information, so say so plainly instead of replaying it.
    const signature = `${toolCall.name}(${JSON.stringify(args)})`;
    const seen = (callSignatures.get(signature) || 0) + 1;
    callSignatures.set(signature, seen);
    if (seen >= 3) {
      const msg =
        `ERROR: you have now called ${signature} ${seen} times with identical arguments and gotten the same ` +
        `result each time — repeating it cannot tell you anything new. Either act on the result you already ` +
        `have, try a DIFFERENT tool or different arguments, or give your final answer explaining what you found.`;
      history.push({ role: 'user', content: `TOOL_RESULT: ${msg}` });
      onLog?.(`step ${steps}: loop detected — ${signature} repeated ${seen}x`);
      onToolResult(msg, true, null);
      consecutiveFailures++;
      continue;
    }

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

    // read-only sandbox mode is a hard block, independent of approval policy
    // — matches Codex CLI: sandboxMode decides what's even possible, approvalPolicy
    // decides what's asked about within that.
    if (ctx?.sandboxMode === 'read-only' && (tool.kind === 'edit' || tool.kind === 'command')) {
      const msg = `ERROR: the "${toolCall.name}" tool is disabled — sandbox mode is "read-only". Investigate and report back instead of making changes.`;
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

    // Pre-diff self-verification: catch a syntax-broken edit before the user
    // spends time reviewing the diff, and before it's silently accepted as a
    // successful TOOL_RESULT — local models are more prone to this than
    // Claude/GPT-class models, so this closes a real gap cheaply.
    let verification = null;
    if (snapshot && snapshot.after !== undefined) {
      verification = verifySyntax(snapshot.path, snapshot.after);
      if (verification) snapshot.verification = verification;
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

    if (!isError && verification && verification.ok === false) {
      result += `\n\nSYNTAX WARNING: the file you just wrote does not parse. Details: ${verification.message}\nFix this before moving on — either re-read the file and correct it, or explain the issue to the user.`;
    }
    // Real compiler/linter errors from the language server, for the file
    // just edited. verifySyntax only proves the file parses; this catches
    // the errors that actually matter (unresolved imports, type mismatches,
    // lint violations) in milliseconds, without waiting for a test run.
    if (!isError && tool.kind === 'edit' && args.path && lsp.available()) {
      const problems = await lsp.getDiagnosticsAfterEdit(root, args.path).catch(() => null);
      if (problems) {
        result += `\n\nPROBLEMS reported by the language server after this edit:\n${problems}\nFix these before moving on.`;
        isError = true; // count it as a failure so escalation/fallback logic sees a stuck edit
      }
    }

    consecutiveFailures = isError || (verification && verification.ok === false) ? consecutiveFailures + 1 : 0;

    // If the user edited a file in their editor while the agent was mid-turn,
    // the agent's cached view of it is stale — say so now, before it builds
    // another edit on content that no longer exists.
    const staleWarning = getStaleWarning(root);
    if (staleWarning) result += `\n\n${staleWarning}`;

    // Adaptive edit strategy: snippet-based edits that keep missing on the
    // same file are the classic infinite-retry trap. After two misses, stop
    // suggesting a better snippet and switch the model to a whole-file
    // rewrite, which has no matching step to fail.
    if (isError && tool.kind === 'edit' && args.path) {
      const misses = (editFailuresByPath.get(args.path) || 0) + 1;
      editFailuresByPath.set(args.path, misses);
      if (misses >= 2) {
        result +=
          `\n\nSTRATEGY CHANGE: edit_file has now failed ${misses} times on ${args.path}. Stop retrying snippet edits ` +
          `on this file. Call read_file to get its current contents, then use write_file with the COMPLETE updated ` +
          `file — that has no snippet to mismatch.`;
      }
    } else if (!isError && tool.kind === 'edit' && args.path) {
      editFailuresByPath.delete(args.path);
    }

    history.push({ role: 'user', content: `TOOL_RESULT:\n${result}` });
    onLog?.(`step ${steps}: tool result [${callId}] ${isError ? 'ERROR' : 'ok'} (${String(result).length} chars)`);
    onToolResult(result, isError, callId, isError ? undefined : snapshot);
  }

  onError('Stopped: too many steps without a final answer. Try starting a new chat or narrowing your request.');
}

module.exports = { runTurn, parseToolCall, parseToolCalls };
