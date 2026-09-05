// A local, human-readable record of everything the agent did.
//
// The competing products all ship telemetry — Cline sends traces to Langfuse,
// and analytics to their own backend. That answers the vendor's questions,
// not the user's. The user's question is the opposite one: *what did this
// thing just do to my machine?* Nobody answers it, because answering it
// requires admitting how much an agent does unattended.
//
// So this is the inverse of telemetry: same completeness, but written to
// .cortex/audit/ on the user's disk, never transmitted, and readable by them
// rather than by us. It is the artifact that makes "no telemetry" a
// verifiable claim instead of a marketing line.

'use strict';

const fs = require('fs');
const path = require('path');

const DIR = path.join('.cortex', 'audit');
const MAX_DAYS = 30;

function logFile(root, date = new Date()) {
  const d = path.join(root, DIR);
  fs.mkdirSync(d, { recursive: true });
  return path.join(d, `${date.toISOString().slice(0, 10)}.jsonl`);
}

// One JSON object per line: appendable without parsing, greppable, and
// resistant to a crash mid-write corrupting earlier entries.
function record(root, entry) {
  if (!root) return;
  try {
    fs.appendFileSync(logFile(root), JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
  } catch {
    // Auditing must never break a turn.
  }
}

const api = {
  turnStarted(root, { sessionId, model, prompt, mode, approvalPolicy, sandboxMode }) {
    record(root, { type: 'turn', sessionId, model, mode, approvalPolicy, sandboxMode, prompt: String(prompt || '').slice(0, 500) });
  },

  toolRan(root, { sessionId, tool, args, approved, isError, resultPreview }) {
    record(root, {
      type: 'tool',
      sessionId,
      tool,
      // Commands and paths are the parts a person auditing actually needs;
      // full file contents would make the log unreadable and enormous.
      target: args?.path || args?.command || args?.from || args?.url || undefined,
      approved,
      isError: !!isError,
      result: String(resultPreview || '').slice(0, 200),
    });
  },

  fileChanged(root, { sessionId, file, before, after }) {
    const b = String(before || '');
    const a = String(after || '');
    record(root, {
      type: 'file',
      sessionId,
      file,
      bytesBefore: Buffer.byteLength(b),
      bytesAfter: Buffer.byteLength(a),
      linesBefore: b ? b.split('\n').length : 0,
      linesAfter: a ? a.split('\n').length : 0,
    });
  },

  blocked(root, { sessionId, tool, reason, detail }) {
    record(root, { type: 'blocked', sessionId, tool, reason, detail });
  },

  networkCall(root, { sessionId, url, via }) {
    // Deliberately its own type: "did this ever talk to the network" is the
    // single most common thing someone wants to check.
    record(root, { type: 'network', sessionId, host: safeHost(url), via });
  },

  /** @returns {Array<object>} entries for the last `days` days, newest last */
  read(root, days = 7) {
    if (!root) return [];
    const out = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86_400_000);
      const f = logFile(root, d);
      if (!fs.existsSync(f)) continue;
      for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          out.push(JSON.parse(line));
        } catch {
          // skip a torn line rather than losing the file
        }
      }
    }
    return out;
  },

  /** Rolls up the log into the answers people actually ask of it. */
  summarize(root, days = 7) {
    const entries = api.read(root, days);
    const filesTouched = new Map();
    const commands = [];
    const networkHosts = new Set();
    const blocked = [];
    let turns = 0;
    let toolCalls = 0;
    let errors = 0;

    for (const e of entries) {
      if (e.type === 'turn') turns++;
      if (e.type === 'tool') {
        toolCalls++;
        if (e.isError) errors++;
        if (e.tool === 'run_command' || e.tool === 'run_background') commands.push({ at: e.at, command: e.target, approved: e.approved });
      }
      if (e.type === 'file') {
        const prev = filesTouched.get(e.file) || { edits: 0, net: 0 };
        filesTouched.set(e.file, { edits: prev.edits + 1, net: prev.net + (e.linesAfter - e.linesBefore) });
      }
      if (e.type === 'network') networkHosts.add(e.host);
      if (e.type === 'blocked') blocked.push(e);
    }

    return {
      days,
      turns,
      toolCalls,
      errors,
      files: [...filesTouched.entries()].map(([file, v]) => ({ file, ...v })).sort((a, b) => b.edits - a.edits),
      commands,
      networkHosts: [...networkHosts],
      blocked,
    };
  },

  /** Human-readable report — what gets shown when the user asks. */
  renderReport(root, days = 7) {
    const s = api.summarize(root, days);
    const lines = [];
    lines.push(`# Cortex audit — last ${s.days} day(s)`, '');
    lines.push(`${s.turns} turn(s), ${s.toolCalls} tool call(s), ${s.errors} error(s).`, '');

    lines.push('## Network');
    lines.push(
      s.networkHosts.length
        ? s.networkHosts.map((h) => `- ${h}`).join('\n')
        : '- No network calls recorded. Everything ran locally.'
    );
    lines.push('');

    lines.push('## Files changed');
    lines.push(
      s.files.length
        ? s.files.map((f) => `- ${f.file} — ${f.edits} edit(s), ${f.net >= 0 ? '+' : ''}${f.net} line(s)`).join('\n')
        : '- None.'
    );
    lines.push('');

    lines.push('## Commands run');
    lines.push(
      s.commands.length
        ? s.commands.map((c) => `- \`${c.command}\`${c.approved === false ? ' (auto-approved)' : ''}`).join('\n')
        : '- None.'
    );
    lines.push('');

    if (s.blocked.length) {
      lines.push('## Blocked for safety');
      lines.push(s.blocked.map((b) => `- ${b.tool}: ${b.detail || b.reason}`).join('\n'));
      lines.push('');
    }

    lines.push(`_Written to ${path.join(DIR, '<date>.jsonl')}. Never transmitted anywhere._`);
    return lines.join('\n');
  },

  prune(root, maxDays = MAX_DAYS) {
    try {
      const d = path.join(root, DIR);
      if (!fs.existsSync(d)) return;
      const cutoff = Date.now() - maxDays * 86_400_000;
      for (const name of fs.readdirSync(d)) {
        const stamp = Date.parse(name.replace('.jsonl', ''));
        if (Number.isFinite(stamp) && stamp < cutoff) fs.unlinkSync(path.join(d, name));
      }
    } catch {
      // best-effort
    }
  },
};

function safeHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return String(url || '').slice(0, 60);
  }
}

module.exports = api;
