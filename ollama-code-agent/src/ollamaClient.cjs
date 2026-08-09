// Thin wrapper around Ollama's local HTTP API (/api/chat), used from the
// extension host. Supports streaming so the webview can show tokens as they
// arrive. Tool-calling is implemented ourselves via prompting (see
// systemPrompt.cjs) so this works with any chat-capable model, not just ones
// with "native" function calling.

'use strict';

const CONNECT_RETRIES = 1; // one retry beyond the initial attempt, for transient connection hiccups only
const RETRY_DELAY_MS = 400;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {object} opts
 * @param {string} opts.host
 * @param {string} opts.model
 * @param {Array<{role:string, content:string}>} opts.messages
 * @param {number} [opts.temperature]
 * @param {(chunk: string) => void} [opts.onToken] called with each incremental token as it streams in
 * @param {AbortSignal} [opts.signal]
 * @param {(message: string) => void} [opts.logFn] optional diagnostic sink — never throws, never required
 * @returns {Promise<string>} the full assistant message content
 */
async function chat({ host, model, messages, temperature = 0.2, onToken, signal, logFn }) {
  let res;
  let connectErr;
  for (let attempt = 0; attempt <= CONNECT_RETRIES; attempt++) {
    try {
      res = await fetch(`${host}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages, stream: true, options: { temperature } }),
        signal,
      });
      connectErr = null;
      break;
    } catch (err) {
      const e = /** @type {Error} */ (err);
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

  logFn?.(`POST ${host}/api/chat model=${model} messages=${messages.length}`);

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const msg = `Ollama API error ${res.status}: ${text || res.statusText}`;
    logFn?.(msg);
    throw new Error(msg);
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
  for await (const bytes of res.body) {
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
      if (obj.message?.content) {
        full += obj.message.content;
        if (onToken) onToken(obj.message.content);
      }
      if (obj.done) {
        logFn?.(`response ${full.length} chars (streamed)`);
        return full;
      }
    }
  }
  logFn?.(`response ${full.length} chars (stream ended without done:true)`);
  return full;
}

/**
 * @param {{host: string}} opts
 * @returns {Promise<Array<{name: string, size: number}>>}
 */
async function listModels({ host }) {
  const res = await fetch(`${host}/api/tags`);
  if (!res.ok) throw new Error('Failed to list local models from Ollama. Is "ollama serve" running?');
  const data = /** @type {{models?: Array<{name: string, size: number}>}} */ (await res.json());
  return (data.models || []).map((m) => ({ name: m.name, size: m.size }));
}

module.exports = { chat, listModels };
