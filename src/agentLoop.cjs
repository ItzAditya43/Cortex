// UI-agnostic agent loop: given a user message and a history, drives the
// plan -> tool call -> tool result -> ... -> final answer cycle against
// Ollama, invoking callbacks so any front-end (webview, CLI, tests) can
// render progress and gate mutating tools behind human approval.

'use strict';

const crypto = require('crypto');
const { chat } = require('./provider.cjs');
const { tools, isToolAvailable, apiToolsFor } = require('./tools.cjs');
const { buildSystemPrompt } = require('./systemPrompt.cjs');
const { buildContextMessages, estimateTokens, historyTokens, resolveContextBudget } = require('./contextManager.cjs');
const { compactHistory } = require('./compactor.cjs');
const { verifySyntax } = require('./verify.cjs');
const { pickModel } = require('./router.cjs');
const { getStaleWarning } = require('./fileTracker.cjs');
const { classifyError } = require('./errorClassification.cjs');
const lsp = require('./lsp.cjs');
const { numCtxFor, modelInfo } = require('./ollamaClient.cjs');
const { toNativeMessages, synthesizeReply, extractJsonToolCalls } = require('./nativeTools.cjs');
const { parseToolCall, parseToolCalls } = require('./toolCallParser.cjs');

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

// Does the reply claim a file was or will be changed? Only then is a code
// fence evidence of an edit that never happened. Explanations, examples and
// review comments all contain fences too, and must be left alone.
function claimsAnEdit(text) {
  return /\b(?:I(?:'ve| have| will|'ll)?\s+(?:created|added|updated|written|wrote|modified|changed|implemented|fixed|replaced)|here(?:'s| is)\s+the\s+(?:updated|new|modified|corrected|fixed)\b|(?:updated|new|modified)\s+(?:file|version|contents)\s*:)/i.test(
    text
  );
}

// A reply that is only commentary about the nudge itself, rather than a real
// answer — the model defending itself instead of helping.
function looksLikeNudgeArtifact(text) {
  const t = text.trim();
  if (t.length > 600) return false; // a substantial answer is a real answer
  return /\b(?:did not intend|didn't intend|was (?:only|just) (?:explaining|illustrating|providing)|no (?:file )?changes? (?:were|was) (?:made|intended)|I was providing)/i.test(
    t
  );
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
 * @param {number} [opts.numCtx]          explicit Ollama context window; 0/undefined derives it from contextBudgetTokens
 * @param {string} [opts.provider]        'ollama' (default) or 'openai-compatible'
 * @param {'auto'|'native'|'text'} [opts.toolCalling] how tools are offered to the model (see resolveToolMode)
 * @param {string} [opts.apiKey]
 * @param {string} [opts.escalateModel]   stronger model to switch to after repeated failures
 * @param {string} [opts.testCommand]     run once after a turn that changed files; failures go back to the model
 * @param {(command: string, result: string, failed: boolean) => void} [opts.onTestRun]
 * @param {(usage: {promptTokens: number, completionTokens: number, totalDurationMs: number}) => void} [opts.onUsage]
 * @param {(kind: string, message: string) => void} [opts.onRecovery]
 * @param {(token: string) => void} [opts.onThinking]    reasoning tokens from thinking models, for display only
 * @param {(step: number, model: string) => void} [opts.onStep]  a new model request is starting
 * @param {object} [opts.ctx]            passed through as tool.run's 3rd argument (webhook url, delegation config, etc.)
 * @param {AbortSignal} [opts.signal]
 * @param {(token: string) => void} opts.onToken           streamed assistant text
 * @param {(name: string, args: object, callId: string) => void} opts.onToolCall
 * @param {(name: string, args: object, callId: string) => Promise<boolean|{approved: boolean, feedback?: string}>} opts.requestApproval  called only for tools with confirm:true and autoApprove disabled
 * @param {(info: {budgetTokens: number}) => void} [opts.onContext]   the context budget resolved for this turn
 * @param {(info: {summarized: number, summary?: string}) => void} [opts.onCompact]  the history was auto-compacted
 * @param {(result: string, isError: boolean, callId: string, snapshot?: {path: string, before: string, after: string, created?: boolean,
 *   renameFrom?: string, renameTo?: string, files?: Array<{path: string, before: string, after: string, created?: boolean}>}) => void} opts.onToolResult
 * @param {(finalText: string, steps: number) => void} opts.onFinal
 * @param {(message: string) => void} opts.onError
 * @param {(message: string) => void} [opts.onLog]         optional diagnostic sink (wired to the host's OutputChannel)
 */
// Below this size, measured: qwen2.5-coder:3b passed 8/12 benchmark tasks
// through the text protocol but 5/12 natively — it writes the call as JSON
// prose, or stops to ask instead of acting. gemma4:31b and gpt-oss:120b
// pass 12/12 natively.
const NATIVE_MIN_PARAMS_B = 7;

// Servers/models that rejected a native tools request: asked once, then the
// text protocol for the rest of the process.
const nativeUnsupported = new Set();

/**
 * Decides how tools are offered to a model. "auto" uses native tool calling
 * when the model supports it and is big enough to use it well (unknown size
 * counts as big enough), the text protocol otherwise. OpenAI-compatible
 * servers are assumed to support function calling until one says it doesn't.
 * @param {{host: string, model: string, provider?: string, toolCalling?: string}} opts
 * @returns {Promise<'native'|'text'>}
 */
async function resolveToolMode({ host, provider, model, toolCalling = 'auto' }) {
  if (toolCalling === 'text') return 'text';
  if (nativeUnsupported.has(`${host}|${model}`)) return 'text';
  if (toolCalling === 'native' || provider === 'openai-compatible') return 'native';
  const { capabilities, paramsB } = await modelInfo({ host, model });
  if (!capabilities.includes('tools')) return 'text';
  return paramsB !== null && paramsB < NATIVE_MIN_PARAMS_B ? 'text' : 'native';
}

// The header a multi-call result uses per call. Arguments are abbreviated:
// a write_file call would otherwise echo the whole file back into the
// context a second time.
function callHeader(name, args) {
  let a = JSON.stringify(args || {});
  if (a.length > 160) a = `${a.slice(0, 157)}...`;
  return `--- ${name}(${a}) ---`;
}

const BOOKKEEPING = new Set(['save_plan', 'remember']);
// `git commit` / `git push`, allowing global options before the subcommand
// (git -c user.name=x commit, git -C dir push).
const GIT_PUBLISH = /\bgit\s+(?:(?:-[cC]\s+\S+|--?[\w-]+(?:=\S+)?)\s+)*(commit|push)\b/;

// Did anything the user typed (not tool output, not a summary) mention
// committing or pushing?
function userAskedToPublish(history) {
  return history.some((m) => {
    if (m.role !== 'user') return false;
    const c = String(m.content || '');
    if (c.startsWith('TOOL_RESULT')) return false;
    return /\b(commit|push|pr|pull request|merge|ship it)\b/i.test(c);
  });
}

const MAX_AUTO_COMPACTIONS = 4;
const MAX_IDENTICAL_CALLS = 6;
// Tools whose whole argument is naturally a list.
const ARRAY_ARGUMENT = { multi_edit: 'edits', read_file: 'path' };

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
    numCtx,
    toolCalling = 'auto',
    testCommand,
    onTestRun,
    ctx,
    signal,
    onToken,
    onThinking,
    onStep,
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
  let unperformedEditReply = null;
  let testRan = false;
  let consecutiveFailures = 0;
  let contextRecoveries = 0;
  let rateLimitBackoffs = 0;
  let autoCompactions = 0;
  let emptyNudged = false;
  let parseFailures = 0;
  let stuckOn = null;
  let bookkeepingStreak = 0;
  const editFailuresByPath = new Map(); // path -> consecutive edit_file misses, drives the whole-file fallback
  const callSignatures = new Map(); // "tool(args)" -> times seen, for loop detection
  // Tools see the turn's abort signal so Stop cancels a running command or
  // search instead of waiting for it to finish.
  const toolCtx = { ...(ctx || {}), signal };
  const contextBudgetTokens = await resolveContextBudget({ host, provider, model, configured: opts.contextBudgetTokens });
  const contextWindow = provider === 'openai-compatible' ? undefined : numCtxFor(contextBudgetTokens, numCtx);
  opts.onContext?.({ budgetTokens: contextBudgetTokens });
  const reportUsage = onUsage ? (u) => onUsage({ ...u, contextBudget: contextBudgetTokens }) : undefined;

  /**
   * Runs one tool call through every gate (availability, loop breaker, plan
   * mode, sandbox, approval) and returns its result text. Never touches
   * `history` — the caller decides how results are written back, because one
   * response may carry several calls.
   * @returns {Promise<{result: string, isError: boolean, aborted?: boolean}>}
   */
  async function executeCall(toolCall) {
    const tool = tools[toolCall.name];
    if (!tool || !isToolAvailable(toolCall.name, root, ctx)) {
      const available = Object.keys(tools).filter((n) => isToolAvailable(n, root, ctx));
      const msg = tool
        ? `ERROR: the "${toolCall.name}" tool is not available here. Available: ${available.join(', ')}`
        : `ERROR: unknown tool "${toolCall.name}". Available: ${available.join(', ')}`;
      onToolResult(msg, true, null);
      return { result: msg, isError: true };
    }

    if (tool.confirm) usedMutatingTool = true; // route to the main model from here on, even if this call gets declined

    let args = toolCall.arguments || {};
    // A bare array where an object was expected: the model sent the list
    // itself ("arguments": [edit, edit]) instead of wrapping it. What it
    // meant is not in doubt, and rejecting it only gets the same call again.
    if (Array.isArray(args) && ARRAY_ARGUMENT[toolCall.name]) args = { [ARRAY_ARGUMENT[toolCall.name]]: args };
    if (typeof args === 'string') {
      const msg = `ERROR: the arguments for ${toolCall.name} were not valid JSON. Send the call again with a JSON object of arguments.`;
      onToolResult(msg, true, null);
      consecutiveFailures++;
      return { result: msg, isError: true };
    }

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
        `ERROR: you have now called ${signature.slice(0, 300)} ${seen} times with identical arguments and gotten the same ` +
        `result each time — repeating it cannot tell you anything new. Either act on the result you already ` +
        `have, try a DIFFERENT tool or different arguments, or give your final answer explaining what you found.`;
      onLog?.(`step ${steps}: loop detected — ${signature.slice(0, 200)} repeated ${seen}x`);
      onToolResult(msg, true, null);
      consecutiveFailures++;
      // Told three times and still repeating: more steps will not help, and
      // each one costs the user time and tokens.
      if (seen >= MAX_IDENTICAL_CALLS) stuckOn = signature;
      return { result: msg, isError: true };
    }

    // Note-taking is not progress. A model can re-save its plan with slightly
    // different wording forever, which the identical-call check above never
    // sees.
    if (BOOKKEEPING.has(toolCall.name)) {
      bookkeepingStreak++;
      if (bookkeepingStreak >= 3) {
        const msg =
          `ERROR: that is ${bookkeepingStreak} ${toolCall.name} calls in a row with no work in between. Stop taking notes: ` +
          `do the next step of the task with a different tool, or give your final answer if the task is finished.`;
        onToolResult(msg, true, null);
        consecutiveFailures++;
        if (bookkeepingStreak >= MAX_IDENTICAL_CALLS) stuckOn = `${toolCall.name} repeated ${bookkeepingStreak} times`;
        return { result: msg, isError: true };
      }
    } else bookkeepingStreak = 0;

    // Committing and pushing are the user's call. A model that decides by
    // itself to commit its work — small ones do, even when told not to —
    // is refused unless the conversation actually asked for it.
    const publishes =
      toolCall.name === 'git_commit' || (tool.kind === 'command' && GIT_PUBLISH.test(String(args.command || '')));
    if (publishes && !userAskedToPublish(history)) {
      const msg =
        `ERROR: the user did not ask for a commit or push, so this was not run. Leave the changes uncommitted and ` +
        `finish with a summary of what you changed — the user will commit when they are ready.`;
      onToolResult(msg, true, null);
      return { result: msg, isError: true };
    }

    const callId = crypto.randomUUID();
    onLog?.(`step ${steps}: tool call ${toolCall.name}(${JSON.stringify(args).slice(0, 500)}) [${callId}]`);
    onToolCall(toolCall.name, args, callId);

    if (planMode && tool.confirm) {
      const msg =
        `ERROR: the "${toolCall.name}" tool is disabled while in Plan Mode. Use read_file/list_dir/search_code to investigate, ` +
        `then respond with a plain-text plan (no tool call) describing what you would change and why. ` +
        `The user will switch you to Act Mode when they're ready for you to execute it.`;
      onToolResult(msg, true, callId);
      return { result: msg, isError: true };
    }

    // read-only sandbox mode is a hard block, independent of approval policy
    // — matches Codex CLI: sandboxMode decides what's even possible, approvalPolicy
    // decides what's asked about within that.
    if (ctx?.sandboxMode === 'read-only' && (tool.kind === 'edit' || tool.kind === 'command')) {
      const msg = `ERROR: the "${toolCall.name}" tool is disabled — sandbox mode is "read-only". Investigate and report back instead of making changes.`;
      onToolResult(msg, true, callId);
      return { result: msg, isError: true };
    }

    // What the call would do, worked out before anyone is asked about it.
    let planned = null;
    if (tool.preview) {
      try {
        planned = tool.preview(args, root);
      } catch {
        // preview is best-effort; the tool reports its own errors when run
      }
    }
    // An edit that cannot apply (snippet missing or ambiguous) changes
    // nothing when run — it only produces the detailed error. Asking a
    // person to approve that is asking them to approve a failure.
    if (tool.kind === 'edit' && planned && planned.error) {
      let result;
      try {
        result = String(await tool.run(args, root, toolCtx));
      } catch (err) {
        result = `ERROR running tool: ${err.message}`;
      }
      if (result.startsWith('ERROR')) {
        consecutiveFailures++;
        if (args.path) {
          const misses = (editFailuresByPath.get(args.path) || 0) + 1;
          editFailuresByPath.set(args.path, misses);
          if (misses >= 2) {
            result +=
              `\n\nSTRATEGY CHANGE: edit_file has now failed ${misses} times on ${args.path}. Stop retrying snippet edits ` +
              `on this file. Call read_file to get its current contents, then use write_file with the COMPLETE updated ` +
              `file — that has no snippet to mismatch.`;
          }
        }
        onToolResult(result, true, callId);
        return { result, isError: true };
      }
    }
    // Writing a file back with the contents it already has: nothing to
    // approve, nothing to undo, and the model needs to know it changed
    // nothing — otherwise it "fixes" the same file again and again.
    if (tool.kind === 'edit' && planned && !planned.error && !planned.created && !planned.renameFrom && planned.before === planned.after && toolCall.name !== 'delete_file') {
      const msg = `NO CHANGE: ${args.path || planned.path} already has exactly this content, so nothing was written. If you intended a change, your new text is identical to what is there — read the file again and work out what actually needs to differ.`;
      onToolResult(msg, false, callId);
      return { result: msg, isError: false };
    }

    if (tool.confirm) {
      // true/false, or {approved, feedback} when the user said why not.
      const decision = await requestApproval(toolCall.name, args, callId);
      // Stop pressed while the approval card was open: the turn is over, and
      // a late click must not run the action anyway.
      if (signal?.aborted) return { result: '', isError: true, aborted: true };
      const approved = decision === true || (decision && typeof decision === 'object' && decision.approved === true);
      if (!approved) {
        const feedback = decision && typeof decision === 'object' && decision.feedback ? String(decision.feedback).trim() : '';
        const msg = feedback
          ? `User declined this action and said: "${feedback}". Do what they asked instead.`
          : 'User declined this action. Choose a different approach or ask the user what they want instead.';
        onToolResult(msg, true, callId);
        return { result: msg, isError: true };
      }
    }

    let snapshot;
    if (planned && planned.before !== undefined && !planned.error) snapshot = { ...planned };

    // Pre-diff self-verification: catch a syntax-broken edit before the user
    // spends time reviewing the diff, and before it's silently accepted as a
    // successful TOOL_RESULT — local models are more prone to this than
    // Claude/GPT-class models, so this closes a real gap cheaply.
    let verification = null;
    if (snapshot && snapshot.after !== undefined) {
      // multi_edit carries one entry per file; its top-level path is a label.
      for (const f of snapshot.files || [snapshot]) {
        const v = verifySyntax(f.path, f.after);
        if (v && v.ok === false) {
          verification = { ...v, message: snapshot.files ? `${f.path}: ${v.message}` : v.message };
          break;
        }
        if (v) verification = v;
      }
      if (verification) snapshot.verification = verification;
    }

    let result;
    let isError = false;
    try {
      result = await tool.run(args, root, toolCtx);
      if (typeof result !== 'string') result = result == null ? '' : typeof result === 'object' ? JSON.stringify(result) : String(result);
      isError = result.startsWith('ERROR');
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
    // Something changed, so a search or read repeated from before the change
    // is a legitimate re-check, not a loop: the same question now has a
    // different answer.
    if (!isError && tool.kind === 'edit') callSignatures.clear();

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

    onLog?.(`step ${steps}: tool result [${callId}] ${isError ? 'ERROR' : 'ok'} (${String(result).length} chars)`);
    onToolResult(result, isError, callId, isError ? undefined : snapshot);
    return { result, isError };
  }

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
    const native = (await resolveToolMode({ host, provider, model: activeModel, toolCalling })) === 'native';
    const apiTools = native ? apiToolsFor({ root, ctx }) : undefined;
    const system = buildSystemPrompt({ memoryNotes, cwd: root, openFile, planMode, selection, ctx, nativeTools: native, model: activeModel });
    // Native tool schemas are part of the prompt the model sees, so they
    // come out of the same budget the history is trimmed to.
    const budget = native ? Math.max(1000, contextBudgetTokens - estimateTokens(JSON.stringify(apiTools))) : contextBudgetTokens;

    // Auto-compact: once the conversation no longer fits, summarize the
    // older part instead of letting the trim below silently drop it.
    if (
      autoCompactions < MAX_AUTO_COMPACTIONS &&
      history.length > 6 &&
      estimateTokens(system) + historyTokens(history) > budget * 0.92
    ) {
      autoCompactions++;
      onRecovery?.('compact', 'Context is nearly full — summarizing the earlier conversation to keep going.');
      try {
        const res = await compactHistory({
          history,
          chatOpts: { host, provider, apiKey, model, numCtx: contextWindow },
          budgetTokens: budget,
          signal,
          logFn: onLog,
        });
        onLog?.(res.ok ? `step ${steps}: auto-compacted ${res.summarized} message(s)` : `step ${steps}: auto-compact skipped — ${res.reason}`);
        if (res.ok) opts.onCompact?.(res);
      } catch (err) {
        if (err.name === 'AbortError' && signal?.aborted) return;
        onLog?.(`step ${steps}: auto-compact failed — ${err.message}`);
      }
    }

    const canonical = buildContextMessages(system, history, budget);
    const messages = native ? toNativeMessages(canonical) : canonical;
    onLog?.(
      `step ${steps}: sending ${messages.length} message(s) to ${activeModel}${routedLabel} (budget ${contextBudgetTokens} tok, ${native ? 'native' : 'text'} tools)`
    );
    onStep?.(steps, activeModel);
    let nativeCalls = [];

    let reply;
    try {
      reply = await chat({
        host,
        provider,
        apiKey,
        model: activeModel,
        messages,
        temperature,
        numCtx: contextWindow,
        tools: apiTools,
        onToolCalls: (calls) => nativeCalls.push(...calls),
        signal,
        onToken,
        onThinking,
        onUsage: reportUsage,
        logFn: onLog,
      });
    } catch (err) {
      // Only stay silent when the USER actually cancelled. Any other abort
      // (a stalled model, a dropped connection) must be reported, or the
      // turn just ends with no output and no explanation.
      if (err.name === 'AbortError' && signal?.aborted) return;

      // This server or model can't do function calling: remember that and
      // carry on with the text protocol rather than failing the turn.
      if (native && err.toolsUnsupported) {
        nativeUnsupported.add(`${host}|${activeModel}`);
        onLog?.(`step ${steps}: ${activeModel} rejected native tools — switching to the text protocol`);
        steps--;
        continue;
      }

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
      if (failure.retryable && failure.kind === 'rate-limit' && rateLimitBackoffs < 3) {
        rateLimitBackoffs++;
        const waitMs = 2000 * 2 ** (rateLimitBackoffs - 1);
        onRecovery?.('rate-limit', `Rate limited — waiting ${waitMs / 1000}s before retrying.`);
        await new Promise((r) => setTimeout(r, waitMs));
        steps--;
        continue;
      }

      onError(failure.advice ? `${err.message}\n\n${failure.advice}` : err.message);
      return;
    }

    if (native) {
      if (!nativeCalls.length) {
        // offered native tools, wrote the call as JSON text instead
        const fromText = extractJsonToolCalls(reply, new Set(apiTools.map((t) => t.function.name)));
        if (fromText.length) {
          onLog?.(`step ${steps}: recovered ${fromText.length} tool call(s) written as JSON text`);
          nativeCalls = fromText;
          reply = '';
        }
      }
      if (nativeCalls.length) reply = synthesizeReply(reply, nativeCalls);
    }

    const parsed = parseToolCall(reply);

    if (!parsed.attempted) {
      // A model that returns nothing at all (some do after a long tool
      // result) has not answered. One reminder, rather than an empty turn.
      if (!reply.trim() && steps < maxSteps && !emptyNudged) {
        emptyNudged = true;
        history.push({ role: 'assistant', content: '(no response)' });
        history.push({ role: 'user', content: 'TOOL_RESULT: Your last response was empty. Continue the task: call a tool, or give your final answer.' });
        continue;
      }
      // Models sometimes "explain" a change with a fenced code block instead
      // of calling write_file/edit_file, so nothing reaches disk even though
      // the reply reads like the work was done. Worth one nudge — but ONLY
      // when the reply actually claims an edit.
      //
      // Nudging on any code fence punishes the most common request there is:
      // "explain this", "show me an example", "what's wrong here" all answer
      // with a fence and no edit intended. Doing so replaced a correct
      // explanation with a defensive "I did not intend to change any files",
      // i.e. the guard destroyed the very answer the user asked for.
      if (/```/.test(reply) && !codeFenceNudged && claimsAnEdit(reply) && !usedMutatingTool && !planMode) {
        codeFenceNudged = true;
        unperformedEditReply = reply; // keep it: the retry may be worse than this
        history.push({ role: 'assistant', content: reply });
        history.push({
          role: 'user',
          content: native
            ? 'TOOL_RESULT: You described a file change but did not call a tool, so nothing was written. If you meant to change a file, call write_file or edit_file now. If you were only explaining or illustrating, repeat your explanation as your final answer — it was correct, it simply did not modify anything.'
            : 'TOOL_RESULT: You described a file change but did not call a tool, so nothing was written. If you meant to change a file, respond with a single TOOL_CALL: {"name": "write_file"|"edit_file", "arguments": {...}} line. If you were only explaining or illustrating, repeat your explanation as your final answer — it was correct, it simply did not modify anything.',
        });
        continue;
      }

      // If the nudge produced nothing better — no tool call, and a reply that
      // is now just meta-commentary about the nudge — the original answer was
      // the real one. Show that instead of the apology it turned into.
      if (unperformedEditReply && looksLikeNudgeArtifact(reply)) {
        history.push({ role: 'assistant', content: unperformedEditReply });
        onFinal(unperformedEditReply.trim(), steps);
        return;
      }
      // Before accepting a final answer, if this turn actually changed
      // files, give the project's own test command one chance to catch
      // what pre-diff syntax verification can't (logic errors, broken
      // integration) — same idea as Claude Code running tests after edits,
      // instead of trusting the model's own "this should work now".
      if (usedMutatingTool && testCommand && !testRan && steps < maxSteps) {
        testRan = true;
        onLog?.(`step ${steps}: turn modified files — running test command: ${testCommand}`);
        const testResult = await tools.run_command.run({ command: testCommand }, root, toolCtx);
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
      parseFailures++;
      // The same malformed call tends to come straight back. The second
      // time, spell the rules out and offer a way that needs less escaping.
      const msg =
        parseFailures < 2
          ? `ERROR: your TOOL_CALL JSON was invalid (${parsed.error}). Respond again with a single valid TOOL_CALL: {...} line, making sure all string values properly escape newlines as \\n.`
          : `ERROR: your TOOL_CALL JSON is still invalid (${parsed.error}). Do not resend the same text. JSON rules: every key and string uses double quotes; a double quote INSIDE a string is written \\" and a backslash \\\\; newlines are \\n; no trailing commas. Example: TOOL_CALL: {"name": "edit_file", "arguments": {"path": "a.js", "old_str": "x = \\"1\\"", "new_str": "x = \\"2\\""}}. If an edit keeps failing to encode, read the file and use write_file with the whole new contents instead.`;
      history.push({ role: 'user', content: `TOOL_RESULT: ${msg}` });
      onToolResult(msg, true, null);
      consecutiveFailures++;
      // Past this point the model is not going to produce valid JSON by
      // being told again; stop rather than spend the whole step budget.
      if (parseFailures >= MAX_IDENTICAL_CALLS) {
        onError(
          `Stopped: the model sent ${parseFailures} malformed tool calls in a row (${parsed.error}). ` +
            `This model is struggling with the tool format — try a larger model, or set toolCalling to "native" if it supports function calling.`
        );
        return;
      }
      continue;
    }
    parseFailures = 0;

    const allCalls = parseToolCalls(reply);
    const okCalls = allCalls.filter((c) => c.ok).map((c) => c.data);
    const malformedTail = allCalls.some((c) => !c.ok);

    // Batch path: several read-only calls in one response run concurrently
    // and come back as a single combined result, turning N round-trips into
    // one.
    if (okCalls.length > 1 && !malformedTail && okCalls.every((c) => tools[c.name]?.readOnly && isToolAvailable(c.name, root, ctx))) {
      const batch = okCalls.map((c) => ({ name: c.name, args: c.arguments || {}, callId: crypto.randomUUID() }));
      onLog?.(`step ${steps}: running ${batch.length} read-only tool calls in parallel`);
      for (const b of batch) onToolCall(b.name, b.args, b.callId);

      const settled = await Promise.all(
        batch.map(async (b) => {
          try {
            const out = await tools[b.name].run(b.args, root, toolCtx);
            return { ...b, result: out, isError: typeof out === 'string' && out.startsWith('ERROR') };
          } catch (err) {
            return { ...b, result: `ERROR running tool: ${err.message}`, isError: true };
          }
        })
      );

      for (const r of settled) onToolResult(r.result, r.isError, r.callId);
      consecutiveFailures = settled.every((r) => r.isError) ? consecutiveFailures + 1 : 0;
      const combined = settled.map((r) => `${callHeader(r.name, r.args)}\n${r.result}`).join('\n\n');
      const stale = getStaleWarning(root);
      history.push({ role: 'user', content: `TOOL_RESULT:\n${combined}${stale ? `\n\n${stale}` : ''}` });
      continue;
    }

    // Sequential path: every call in the response runs, in order, each
    // through its own approval, diff and checkpoint. A failure or a declined
    // call stops the rest — later calls were written assuming the earlier
    // ones worked, and running them anyway is how a half-applied change
    // happens.
    const outcomes = [];
    let stopReason = null;
    for (const call of okCalls) {
      if (stopReason) {
        outcomes.push({ call, result: `SKIPPED: not run because ${stopReason}. Send it again if it is still needed.` });
        continue;
      }
      const res = await executeCall(call);
      if (res.aborted || signal?.aborted) return;
      if (stuckOn) {
        history.push({ role: 'user', content: `TOOL_RESULT:\n${res.result}` });
        onError(
          `Stopped: the model kept repeating the same call (${stuckOn.slice(0, 120)}) without making progress. ` +
            `Rephrase the request or give it a hint — or try a larger model, which gets stuck like this far less often.`
        );
        return;
      }
      outcomes.push({ call, result: res.result });
      if (res.isError && okCalls.length > 1) {
        stopReason = /^User declined/.test(res.result) ? 'the user declined an earlier call in this response' : 'an earlier call in this response failed';
      }
    }

    let body = outcomes.length === 1 ? outcomes[0].result : outcomes.map((o) => `${callHeader(o.call.name, o.call.arguments)}\n${o.result}`).join('\n\n');
    if (malformedTail) {
      body += `\n\nNOTE: a further TOOL_CALL in your response had invalid JSON and was not run. Send it again as valid JSON if it is still needed.`;
    }
    // If the user edited a file in their editor while the agent was mid-turn,
    // the agent's cached view of it is stale — say so now, before it builds
    // another edit on content that no longer exists.
    const staleWarning = getStaleWarning(root);
    if (staleWarning) body += `\n\n${staleWarning}`;
    history.push({ role: 'user', content: `TOOL_RESULT:\n${body}` });
  }

  onError(
    `Stopped after ${maxSteps} steps without a final answer. The work so far is saved — say "continue" to carry on from here, or raise the step limit (maxSteps).`
  );
}

module.exports = { runTurn, parseToolCall, parseToolCalls, resolveToolMode, callHeader };
