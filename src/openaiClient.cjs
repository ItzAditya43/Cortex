// Client for any OpenAI-compatible /v1/chat/completions endpoint (OpenAI
// itself, OpenRouter, Groq, LM Studio, vLLM, llama.cpp server, Ollama's own
// /v1, ...). Mirrors ollamaClient.cjs's chat()/listModels() shape so the
// agent loop doesn't need to know which provider is active — see
// provider.cjs for the dispatch.
//
// Messages arrive in the shape the loop already builds for Ollama (native
// tool calls as {function: {name, arguments: object}}, results as
// {role: 'tool', tool_name}); they are converted to the OpenAI wire format
// here, and streamed tool-call fragments are assembled back into whole calls.

'use strict';

const CONNECT_RETRIES = 1;
const RETRY_DELAY_MS = 400;
const IDLE_TIMEOUT_MS = 120_000;
const FIRST_BYTE_TIMEOUT_MS = 240_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Accepts "https://api.openai.com", ".../v1" or ".../v1/" — all mean the same server. */
function baseUrl(host) {
  return String(host || '').replace(/\/+$/, '').replace(/\/v1$/, '');
}

/**
 * Ollama-shaped messages -> OpenAI wire format. Tool calls get ids (OpenAI
 * requires every tool result to name the call it answers); results are
 * matched to calls in order, which is the order the loop produced them in.
 * @param {Array<any>} messages
 */
function toOpenAiMessages(messages) {
  const out = [];
  let counter = 0;
  let pendingIds = [];
  for (const msg of messages) {
    if (msg.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
      pendingIds = [];
      const calls = msg.tool_calls.map((tc) => {
        const id = tc.id || `call_${++counter}`;
        pendingIds.push(id);
        const args = tc.function?.arguments ?? {};
        return { id, type: 'function', function: { name: tc.function?.name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } };
      });
      out.push({ role: 'assistant', content: msg.content || null, tool_calls: calls });
      continue;
    }
    if (msg.role === 'tool') {
      const id = msg.tool_call_id || pendingIds.shift();
      // A result with no call to answer (history trimmed mid-exchange) would
      // be rejected by the API; send it as plain context instead.
      if (!id) out.push({ role: 'user', content: `TOOL_RESULT:\n${msg.content}` });
      else out.push({ role: 'tool', tool_call_id: id, content: String(msg.content ?? '') });
      continue;
    }
    pendingIds = [];
    if (Array.isArray(msg.images) && msg.images.length) {
      out.push({
        role: msg.role,
        content: [
          { type: 'text', text: String(msg.content || '') },
          ...msg.images.map((b64) => ({ type: 'image_url', image_url: { url: b64.startsWith('data:') ? b64 : `data:image/png;base64,${b64}` } })),
        ],
      });
      continue;
    }
    out.push({ role: msg.role, content: String(msg.content ?? '') });
  }
  return out;
}

function stalledError(ms) {
  return Object.assign(new Error(`The model server stopped responding (no output for ${ms / 1000}s). Try again, or switch models.`), {
    name: 'TimeoutError',
  });
}

/**
 * @param {object} opts
 * @param {string} opts.host       base URL, e.g. https://api.openai.com or http://localhost:1234
 * @param {string} [opts.apiKey]
 * @param {string} opts.model
 * @param {Array<any>} opts.messages
 * @param {number} [opts.temperature]
 * @param {Array<object>} [opts.tools]   native tool definitions; calls arrive through onToolCalls
 * @param {(calls: Array<{function: {name: string, arguments: object}}>) => void} [opts.onToolCalls]
 * @param {(chunk: string) => void} [opts.onToken]
 * @param {(chunk: string) => void} [opts.onThinking]
 * @param {(usage: {promptTokens: number, completionTokens: number, totalDurationMs: number}) => void} [opts.onUsage]
 * @param {AbortSignal} [opts.signal]
 * @param {(message: string) => void} [opts.logFn]
 * @returns {Promise<string>}
 */
async function chat({ host, apiKey, model, messages, temperature = 0.2, tools, onToolCalls, onToken, onThinking, onUsage, signal, logFn }) {
  const url = `${baseUrl(host)}/v1/chat/completions`;
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const startedAt = Date.now();

  const controller = new AbortController();
  const onOuterAbort = () => controller.abort(signal.reason);
  if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  signal?.addEventListener('abort', onOuterAbort);
  let idleTimer;
  let timedOut = false;
  let armedMs = FIRST_BYTE_TIMEOUT_MS;
  const arm = (ms = IDLE_TIMEOUT_MS) => {
    clearTimeout(idleTimer);
    armedMs = ms;
    idleTimer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, ms);
  };

  try {
    const body = { model, messages: toOpenAiMessages(messages), temperature, stream: true, stream_options: { include_usage: true } };
    if (tools && tools.length) body.tools = tools;

    const post = async (payload) => {
      let connectErr;
      for (let attempt = 0; attempt <= CONNECT_RETRIES; attempt++) {
        try {
          arm(FIRST_BYTE_TIMEOUT_MS);
          return await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload), signal: controller.signal });
        } catch (err) {
          const e = /** @type {Error} */ (err);
          if (timedOut) throw stalledError(armedMs);
          if (e.name === 'AbortError') throw e;
          connectErr = e;
          logFn?.(`connect attempt ${attempt + 1}/${CONNECT_RETRIES + 1} to ${url} failed: ${e.message}`);
          if (attempt < CONNECT_RETRIES) await sleep(RETRY_DELAY_MS);
        }
      }
      throw new Error(`Could not reach ${url} after ${CONNECT_RETRIES + 1} attempt(s) (${connectErr.message})`);
    };

    let res = await post(body);
    let errText = res.ok ? '' : await res.text().catch(() => '');
    // Older/stricter servers reject fields they don't know. Usage is a
    // nicety; drop it and try once more before giving up.
    if (res.status === 400 && /stream_options|include_usage|unknown|unrecognized|extra/i.test(errText)) {
      delete body.stream_options;
      res = await post(body);
      errText = res.ok ? '' : await res.text().catch(() => '');
    }
    logFn?.(`POST ${url} model=${model} messages=${messages.length}${body.tools ? ` tools=${body.tools.length}` : ''}`);

    if (!res.ok) {
      const msg = `API error ${res.status}: ${errText || res.statusText}`;
      logFn?.(msg);
      const err = /** @type {Error & {status: number, toolsUnsupported?: boolean}} */ (Object.assign(new Error(msg), { status: res.status }));
      // The server (or this model on it) can't do function calling — the
      // loop falls back to the text protocol instead of failing the turn.
      if (body.tools && [400, 404, 422, 501].includes(res.status) && /tool|function/i.test(errText)) err.toolsUnsupported = true;
      throw err;
    }

    const report = (usage) => {
      if (onUsage && usage) {
        onUsage({ promptTokens: usage.prompt_tokens || 0, completionTokens: usage.completion_tokens || 0, totalDurationMs: Date.now() - startedAt });
      }
    };
    const deliverCalls = (raw) => {
      const calls = raw
        .filter((c) => c && c.function?.name)
        .map((c) => {
          let args = c.function.arguments;
          if (typeof args === 'string') {
            try {
              args = args.trim() ? JSON.parse(args) : {};
            } catch {
              // leave as the raw string — the loop reports the malformed JSON back to the model
            }
          }
          return { function: { name: c.function.name, arguments: args ?? {} } };
        });
      if (calls.length) onToolCalls?.(calls);
    };

    const contentType = res.headers.get('content-type') || '';
    if (!res.body || contentType.includes('application/json')) {
      const data = /** @type {any} */ (await res.json());
      const message = data.choices?.[0]?.message || {};
      const content = message.content ?? '';
      if (message.tool_calls?.length) deliverCalls(message.tool_calls);
      if (onToken && content) onToken(content);
      report(data.usage);
      return content;
    }

    let full = '';
    let buf = '';
    const partial = []; // tool calls assembled from streamed fragments, by index
    const decoder = new TextDecoder();
    const handle = (line) => {
      if (!line.startsWith('data:')) return false;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return true;
      let obj;
      try {
        obj = JSON.parse(payload);
      } catch {
        return false;
      }
      if (obj.error) throw new Error(`API error: ${obj.error.message || JSON.stringify(obj.error)}`);
      if (obj.usage) report(obj.usage);
      const delta = obj.choices?.[0]?.delta;
      if (!delta) return false;
      const thinking = delta.reasoning_content ?? delta.reasoning;
      if (thinking && onThinking) onThinking(thinking);
      if (delta.content) {
        full += delta.content;
        if (onToken) onToken(delta.content);
      }
      for (const tc of delta.tool_calls || []) {
        const i = tc.index ?? partial.length;
        const slot = (partial[i] = partial[i] || { function: { name: '', arguments: '' } });
        if (tc.function?.name) slot.function.name += tc.function.name;
        if (tc.function?.arguments != null) slot.function.arguments += typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments);
      }
      return false;
    };

    try {
      let done = false;
      for await (const bytes of res.body) {
        arm();
        buf += decoder.decode(bytes, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line && handle(line)) done = true;
        }
        if (done) break;
      }
      if (!done && buf.trim()) handle(buf.trim());
    } catch (err) {
      if (timedOut) throw stalledError(armedMs);
      throw err;
    }
    if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    deliverCalls(partial);
    logFn?.(`response ${full.length} chars${partial.length ? `, ${partial.length} tool call(s)` : ''} (streamed)`);
    return full;
  } finally {
    clearTimeout(idleTimer);
    signal?.removeEventListener('abort', onOuterAbort);
  }
}

/**
 * @param {{host: string, apiKey?: string}} opts
 * @returns {Promise<Array<{name: string, size: number}>>}
 */
async function listModels({ host, apiKey }) {
  /** @type {Record<string, string>} */
  const headers = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const res = await fetch(`${baseUrl(host)}/v1/models`, { headers, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Failed to list models from ${host} (HTTP ${res.status})`);
  const data = /** @type {any} */ (await res.json());
  return (data.data || []).map((m) => ({ name: m.id, size: 0 }));
}

module.exports = { chat, listModels, toOpenAiMessages, baseUrl };
