// Measures what a specific model on a specific machine can actually do.
//
// Everyone else picks agent behaviour from published benchmarks of a fixed
// set of hosted models. Ollama's catalogue is a long tail — quantisations,
// community fine-tunes, sizes from 0.5B to 400B — and nothing published
// covers it. So instead of guessing from the model's name, ask the model
// four short questions and configure the agent from the answers.
//
// The result drives real decisions: whether to use native tool calling or
// the text protocol, whether to allow batched reads, and whether this model
// is worth using for edits at all. Each probe is a single short completion,
// so the whole thing costs a few seconds.

'use strict';

const { chat } = require('./provider.cjs');
const { parseToolCall } = require('./agentLoop.cjs');

const TIMEOUT_MS = 45_000;

async function ask(cfg, messages, { signal } = {}) {
  return chat({
    host: cfg.host,
    provider: cfg.provider || 'ollama',
    apiKey: cfg.apiKey,
    model: cfg.model,
    temperature: 0,
    messages,
    signal,
  });
}

// 1. Does it emit the tool-call protocol at all, in the exact shape asked for?
async function probeProtocol(cfg) {
  const reply = await ask(cfg, [
    {
      role: 'system',
      content:
        'To use a tool, your ENTIRE response must be one line:\nTOOL_CALL: {"name": "<tool>", "arguments": {...}}\nNothing else — no explanation, no markdown fences.\nAvailable tool: read_file — arguments {"path": string}',
    },
    { role: 'user', content: 'Read the file src/index.js' },
  ]);
  const parsed = parseToolCall(reply);
  const clean = reply.trim().startsWith('TOOL_CALL:');
  const correct = parsed.attempted && parsed.ok && parsed.data?.name === 'read_file' && !!parsed.data?.arguments?.path;
  return {
    ok: correct,
    strict: correct && clean, // emitted ONLY the call, with no surrounding prose
    detail: correct ? (clean ? 'emits a clean tool call' : 'emits a tool call, but wraps it in prose') : 'did not produce a usable tool call',
  };
}

// 2. Does it keep JSON valid when the argument contains code with newlines?
//    This is the single most common cause of tool-call parse failures.
async function probeJsonEscaping(cfg) {
  const reply = await ask(cfg, [
    {
      role: 'system',
      content:
        'Respond with exactly one line:\nTOOL_CALL: {"name": "write_file", "arguments": {"path": "<path>", "content": "<content>"}}\nNewlines inside JSON strings must be escaped as \\n.',
    },
    { role: 'user', content: 'Write a file hi.js containing a two-line function that logs "hi".' },
  ]);
  const parsed = parseToolCall(reply);
  const raw = parsed.attempted && parsed.ok;
  // Did it need our repair pass, or was it valid as emitted?
  let validAsEmitted = false;
  if (parsed.attempted) {
    const start = reply.indexOf('{', reply.indexOf('TOOL_CALL:'));
    if (start !== -1) {
      try {
        JSON.parse(reply.slice(start, reply.lastIndexOf('}') + 1));
        validAsEmitted = true;
      } catch {
        validAsEmitted = false;
      }
    }
  }
  return {
    ok: raw,
    strict: validAsEmitted,
    detail: !raw ? 'multi-line content breaks its JSON' : validAsEmitted ? 'escapes newlines correctly' : 'needs newline repair (handled, but slower)',
  };
}

// 3. Will it batch several read-only calls into one response?
async function probeBatching(cfg) {
  const reply = await ask(cfg, [
    {
      role: 'system',
      content:
        'To use a tool emit a line: TOOL_CALL: {"name":"read_file","arguments":{"path":"<p>"}}\nYou MAY emit several such lines in one response to read several files at once. Tool: read_file.',
    },
    { role: 'user', content: 'Read a.js, b.js and c.js.' },
  ]);
  const count = (reply.match(/TOOL_CALL:/g) || []).length;
  const arrayForm = /"path"\s*:\s*\[/.test(reply);
  return {
    ok: count > 1 || arrayForm,
    strict: count >= 3 || arrayForm,
    detail: arrayForm ? 'uses array form' : count > 1 ? `batches ${count} calls per turn` : 'one call per turn only',
  };
}

// 4. Does it follow a negative instruction — the basis of Plan mode and of
//    every "do not touch anything else" request?
async function probeInstructionFollowing(cfg) {
  const reply = await ask(cfg, [
    { role: 'system', content: 'Answer with exactly one word, lowercase, no punctuation.' },
    { role: 'user', content: 'What colour is a clear midday sky?' },
  ]);
  const t = reply.trim().toLowerCase().replace(/[.!]$/, '');
  return { ok: /^[a-z]+$/.test(t), strict: t === 'blue', detail: `answered "${reply.trim().slice(0, 40)}"` };
}

// Does the server accept native function calling for this model? Cheaper and
// far more reliable than the text protocol when it works.
async function probeNativeTools(cfg) {
  try {
    const res = await fetch(`${cfg.host}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: cfg.model,
        stream: false,
        messages: [{ role: 'user', content: 'Read the file a.js' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'read_file',
              description: 'Read a file',
              parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
            },
          },
        ],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, strict: false, detail: `server rejected tools (HTTP ${res.status})` };
    const data = await res.json();
    const calls = data?.message?.tool_calls;
    const used = Array.isArray(calls) && calls.length > 0;
    return {
      ok: used,
      strict: used && calls[0]?.function?.name === 'read_file',
      detail: used ? 'supports native tool calling' : 'accepts the tools field but ignores it',
    };
  } catch (err) {
    return { ok: false, strict: false, detail: `native tool calling unavailable (${err.message})` };
  }
}

const PROBES = [
  { id: 'protocol', label: 'Tool-call protocol', weight: 3, run: probeProtocol },
  { id: 'json', label: 'JSON escaping', weight: 2, run: probeJsonEscaping },
  { id: 'native', label: 'Native tool calling', weight: 1, run: probeNativeTools },
  { id: 'batching', label: 'Parallel reads', weight: 1, run: probeBatching },
  { id: 'instructions', label: 'Instruction following', weight: 2, run: probeInstructionFollowing },
];

/**
 * @param {{host:string, provider?:string, apiKey?:string, model:string}} cfg
 * @param {(id: string, label: string) => void} [onStep]
 * @returns {Promise<{model, results, score, verdict, recommended}>}
 *   `recommended` is a settings patch the caller can apply to match the model.
 */
async function probeModel(cfg, onStep) {
  const results = {};
  let earned = 0;
  let possible = 0;

  for (const probe of PROBES) {
    onStep?.(probe.id, probe.label);
    let r;
    try {
      r = await Promise.race([
        probe.run(cfg),
        new Promise((_, rej) => setTimeout(() => rej(new Error('probe timed out')), TIMEOUT_MS)),
      ]);
    } catch (err) {
      r = { ok: false, strict: false, detail: err.message, inconclusive: true };
    }
    // A probe that timed out says nothing about the model — the server was
    // busy or the model was still loading. Scoring it as a failure would
    // rank a good model as weak, which is exactly the mistake the benchmark
    // made before infrastructure failures were separated out there.
    if (/timed out|timeout|aborted|unavailable|ECONNREFUSED|fetch failed/i.test(r.detail || '')) r.inconclusive = true;

    results[probe.id] = { ...r, label: probe.label };
    if (r.inconclusive) continue; // excluded from both sides of the ratio

    possible += probe.weight;
    // A strict pass earns full weight; a loose pass still counts for most of
    // it, since the agent handles the sloppy case — just less efficiently.
    earned += r.strict ? probe.weight : r.ok ? probe.weight * 0.6 : 0;
  }

  const inconclusive = Object.values(results).filter((r) => r.inconclusive);
  const score = possible > 0 ? Math.round((earned / possible) * 100) : null;

  let verdict;
  if (score === null) {
    verdict = 'Inconclusive — every probe timed out. The server is busy or the model is still loading; try again.';
  } else if (inconclusive.length >= PROBES.length - 1) {
    verdict = `Inconclusive — only one probe completed (${inconclusive.length} timed out). Try again when the server is idle.`;
  } else if (results.protocol && results.protocol.ok === false && !results.protocol.inconclusive) {
    verdict = 'Not usable for agent work — it cannot produce a tool call.';
  } else if (score >= 80) {
    verdict = 'Strong. Suitable as your main model.';
  } else if (score >= 55) {
    verdict = 'Workable. Good for reading and investigation; verify its edits.';
  } else {
    verdict = 'Weak. Usable as a fastModel for reads, but not for editing.';
  }
  if (inconclusive.length && score !== null) {
    verdict += ` (${inconclusive.length} probe(s) timed out and were not scored.)`;
  }

  // Never recommend a configuration change off an inconclusive run.
  const recommended = {};
  const trustworthy = score !== null && inconclusive.length < PROBES.length - 1;
  if (trustworthy && results.protocol.ok) {
    if (score >= 70) recommended.model = cfg.model;
    else recommended.fastModel = cfg.model;
  }
  if (results.native.ok) recommended.nativeTools = true;

  return { model: cfg.model, results, score, verdict, recommended, inconclusive: inconclusive.length, trustworthy };
}

module.exports = { probeModel, PROBES };
