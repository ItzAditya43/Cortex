// Thin wrapper around Ollama's local HTTP API (/api/chat), used from the
// extension host. Supports streaming so the webview can show tokens as they
// arrive. Tool-calling is implemented ourselves via prompting (see
// systemPrompt.cjs) so this works with any chat-capable model, not just ones
// with "native" function calling.

'use strict';

const CONNECT_RETRIES = 1; // one retry beyond the initial attempt, for transient connection hiccups only
const RETRY_DELAY_MS = 400;
const IDLE_TIMEOUT_MS = 90_000;
// Before the first byte the model may still be loading from disk and
// evaluating a long prompt on CPU, which legitimately takes longer than any
// gap between two streamed tokens.
const FIRST_BYTE_TIMEOUT_MS = 180_000;

// Room left for the model's own reply on top of the prompt budget. A
// write_file of a whole module is the largest thing a reply carries.
const REPLY_HEADROOM_TOKENS = 4096;
const MIN_NUM_CTX = 8192;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The context window to ask Ollama for.
 *
 * Without an explicit num_ctx Ollama uses its own default (4096 on a small
 * GPU), regardless of how much history Cortex decided to send — the prompt
 * is then silently cut from the front, and the first thing lost is the tool
 * protocol in the system prompt. Sizing the window from the same budget the
 * context manager trims to keeps the two in agreement. Rounded to 1024 so
 * small budget tweaks don't force a model reload every request.
 *
 * @param {number} [budgetTokens]
 * @param {number} [explicit] user override (cortex.numCtx); 0/undefined = derive
 */
function numCtxFor(budgetTokens, explicit) {
  if (explicit && explicit > 0) return Math.floor(explicit);
  if (!budgetTokens || budgetTokens <= 0) return undefined;
  return Math.max(MIN_NUM_CTX, Math.ceil((budgetTokens + REPLY_HEADROOM_TOKENS) / 1024) * 1024);
}

function stalledError(ms) {
  // Deliberately NOT named AbortError: callers treat that as "the user
  // pressed Stop" and end the turn silently, which would make a stalled
  // model look identical to a cancelled one — silence, with no explanation.
  return Object.assign(
    new Error(
      `Ollama stopped responding (no output for ${ms / 1000}s). The model may be overloaded or still loading — try again, or switch models.`
    ),
    { name: 'TimeoutError' }
  );
}

/**
 * @param {object} opts
 * @param {string} opts.host
 * @param {string} opts.model
 * @param {Array<{role:string, content:string}>} opts.messages
 * @param {number} [opts.temperature]
 * @param {number} [opts.numCtx]        context window to request (see numCtxFor)
 * @param {(chunk: string) => void} [opts.onToken] called with each incremental token as it streams in
 * @param {(chunk: string) => void} [opts.onThinking] reasoning tokens from thinking models (never part of the reply)
 * @param {(usage: {promptTokens: number, completionTokens: number, totalDurationMs: number}) => void} [opts.onUsage]
 * @param {AbortSignal} [opts.signal]
 * @param {(message: string) => void} [opts.logFn] optional diagnostic sink — never throws, never required
 * @returns {Promise<string>} the full assistant message content
 */
async function chat({ host, model, messages, temperature = 0.2, numCtx, onToken, onThinking, onUsage, signal, logFn }) {
  // Idle watchdog: if the model stalls mid-generation (no bytes for 90s —
  // common with an overloaded/hung local model), abort instead of hanging
  // the whole turn forever with the UI stuck on "busy" and no way out.
  // The fetch gets its own AbortController up front so aborting it is what
  // actually unblocks a pending read.
  const idleController = new AbortController();
  const onOuterAbort = () => idleController.abort(signal.reason);
  if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  signal?.addEventListener('abort', onOuterAbort);
  let idleTimer;
  let timedOut = false;
  let armedMs = FIRST_BYTE_TIMEOUT_MS;
  const resetIdleTimer = (ms = IDLE_TIMEOUT_MS) => {
    clearTimeout(idleTimer);
    armedMs = ms;
    idleTimer = setTimeout(() => {
      timedOut = true;
      idleController.abort();
    }, ms);
  };

  // Every exit path — connect failure, HTTP error, stream end, abort — goes
  // through the finally below. A timer left armed on an early throw kept the
  // process alive for 90s and later aborted a request that had long finished.
  try {
    const options = { temperature };
    if (numCtx) options.num_ctx = numCtx;

    let res;
    let connectErr;
    for (let attempt = 0; attempt <= CONNECT_RETRIES; attempt++) {
      try {
        resetIdleTimer(FIRST_BYTE_TIMEOUT_MS);
        res = await fetch(`${host}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, messages, stream: true, options }),
          signal: idleController.signal,
        });
        connectErr = null;
        break;
      } catch (err) {
        const e = /** @type {Error} */ (err);
        if (timedOut) throw stalledError(armedMs);
        if (e.name === 'AbortError') throw e;
        connectErr = e;
        logFn?.(`connect attempt ${attempt + 1}/${CONNECT_RETRIES + 1} to ${host} failed: ${e.message}`);
        if (attempt < CONNECT_RETRIES) await sleep(RETRY_DELAY_MS);
      }
    }
    if (connectErr) {
      throw new Error(
        `Could not reach Ollama at ${host} after ${CONNECT_RETRIES + 1} attempt(s). Is "ollama serve" running? (${connectErr.message})`
      );
    }

    logFn?.(`POST ${host}/api/chat model=${model} messages=${messages.length}${numCtx ? ` num_ctx=${numCtx}` : ''}`);

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const msg = `Ollama API error ${res.status}: ${text || res.statusText}`;
      logFn?.(msg);
      throw Object.assign(new Error(msg), { status: res.status });
    }

    if (!res.body) {
      const data = /** @type {{message?: {content?: string}}} */ (await res.json());
      const content = data.message?.content ?? '';
      if (onToken && content) onToken(content);
      logFn?.(`response ${content.length} chars (non-streaming)`);
      return content;
    }

    let full = '';
    let buf = '';
    try {
      for await (const bytes of res.body) {
        resetIdleTimer();
        buf += Buffer.isBuffer(bytes) ? bytes.toString('utf8') : Buffer.from(bytes).toString('utf8');
        let nl;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let obj;
          try {
            obj = JSON.parse(line);
          } catch {
            continue;
          }
          if (obj.error) {
            // Ollama reports mid-stream failures (OOM, model crash) as an
            // error object on the stream rather than an HTTP status.
            throw new Error(`Ollama error: ${obj.error}`);
          }
          // Thinking models (gpt-oss, qwen3.x, gemma4...) stream their
          // reasoning separately and send empty content meanwhile. Ignoring
          // it left the panel blank for as long as the model thought.
          if (obj.message?.thinking && onThinking) onThinking(obj.message.thinking);
          if (obj.message?.content) {
            full += obj.message.content;
            if (onToken) onToken(obj.message.content);
          }
          if (obj.done) {
            // Ollama reports real token counts on the final chunk; surfacing
            // them is the only way the UI can show context utilisation rather
            // than guessing from a chars/4 heuristic.
            if (onUsage && (obj.prompt_eval_count || obj.eval_count)) {
              onUsage({
                promptTokens: obj.prompt_eval_count || 0,
                completionTokens: obj.eval_count || 0,
                totalDurationMs: obj.total_duration ? Math.round(obj.total_duration / 1e6) : 0,
              });
            }
            logFn?.(`response ${full.length} chars (streamed)`);
            return full;
          }
        }
      }
    } catch (err) {
      // Aborting the fetch is what unblocks a stalled read, but it surfaces
      // as a generic "This operation was aborted" — report why it ended.
      if (timedOut) throw stalledError(armedMs);
      throw err;
    }
    if (timedOut) throw stalledError(armedMs);
    if (signal?.aborted) {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    }
    logFn?.(`response ${full.length} chars (stream ended without done:true)`);
    return full;
  } finally {
    clearTimeout(idleTimer);
    signal?.removeEventListener('abort', onOuterAbort);
  }
}

/**
 * @param {{host: string}} opts
 * @returns {Promise<Array<{name: string, size: number}>>}
 */
async function listModels({ host }) {
  const res = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error('Failed to list local models from Ollama. Is "ollama serve" running?');
  const data = /** @type {{models?: Array<{name: string, size: number}>}} */ (await res.json());
  return (data.models || []).map((m) => ({ name: m.name, size: m.size }));
}

module.exports = { chat, listModels, numCtxFor };
