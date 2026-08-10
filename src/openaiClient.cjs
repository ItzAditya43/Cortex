// Thin client for any OpenAI-compatible /v1/chat/completions endpoint
// (OpenAI itself, LM Studio, vLLM, llama.cpp server, OpenRouter, etc).
// Mirrors ollamaClient.cjs's chat()/listModels() shape so the rest of the
// extension (agentLoop.cjs) doesn't need to know which provider is active —
// see provider.cjs for the dispatch.

'use strict';

const CONNECT_RETRIES = 1;
const RETRY_DELAY_MS = 400;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {object} opts
 * @param {string} opts.host       base URL, e.g. https://api.openai.com or http://localhost:1234
 * @param {string} [opts.apiKey]
 * @param {string} opts.model
 * @param {Array<{role:string, content:string}>} opts.messages
 * @param {number} [opts.temperature]
 * @param {(chunk: string) => void} [opts.onToken]
 * @param {AbortSignal} [opts.signal]
 * @param {(message: string) => void} [opts.logFn]
 * @returns {Promise<string>}
 */
async function chat({ host, apiKey, model, messages, temperature = 0.2, onToken, signal, logFn }) {
  const url = `${host.replace(/\/$/, '')}/v1/chat/completions`;
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  let res;
  let connectErr;
  for (let attempt = 0; attempt <= CONNECT_RETRIES; attempt++) {
    try {
      res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model, messages, temperature, stream: true }),
        signal,
      });
      connectErr = null;
      break;
    } catch (err) {
      const e = /** @type {Error} */ (err);
      if (e.name === 'AbortError') throw e;
      connectErr = e;
      logFn?.(`connect attempt ${attempt + 1}/${CONNECT_RETRIES + 1} to ${url} failed: ${e.message}`);
      if (attempt < CONNECT_RETRIES) await sleep(RETRY_DELAY_MS);
    }
  }
  if (connectErr) {
    throw new Error(`Could not reach ${url} after ${CONNECT_RETRIES + 1} attempt(s) (${connectErr.message})`);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const msg = `API error ${res.status}: ${text || res.statusText}`;
    logFn?.(msg);
    throw new Error(msg);
  }

  if (!res.body) {
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content ?? '';
    if (onToken && content) onToken(content);
    return content;
  }

  let full = '';
  let buf = '';
  for await (const bytes of res.body) {
    buf += Buffer.isBuffer(bytes) ? bytes.toString('utf8') : Buffer.from(bytes).toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') {
        logFn?.(`response ${full.length} chars (streamed)`);
        return full;
      }
      let obj;
      try {
        obj = JSON.parse(payload);
      } catch {
        continue;
      }
      const delta = obj.choices?.[0]?.delta?.content;
      if (delta) {
        full += delta;
        if (onToken) onToken(delta);
      }
    }
  }
  logFn?.(`response ${full.length} chars (stream ended)`);
  return full;
}

/**
 * @param {{host: string, apiKey?: string}} opts
 * @returns {Promise<Array<{name: string, size: number}>>}
 */
async function listModels({ host, apiKey }) {
  const headers = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const res = await fetch(`${host.replace(/\/$/, '')}/v1/models`, { headers });
  if (!res.ok) throw new Error(`Failed to list models from ${host} (HTTP ${res.status})`);
  const data = await res.json();
  return (data.data || []).map((m) => ({ name: m.id, size: 0 }));
}

module.exports = { chat, listModels };
