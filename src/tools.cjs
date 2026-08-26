// All tools the agent may use. Each tool has:
//   description : shown to the model in the system prompt
//   confirm      : whether the human must approve before it runs
//   preview(args, root) : optional — for file-mutating tools, returns
//                          {path, before, after} so the UI can render a diff
//                          before the user approves
//   run(args, root)      : the actual implementation, returns a string result

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');
const { appendMemoryNote } = require('./memory.cjs');
const { indexNote } = require('./semanticMemory.cjs');
const { wrapCommand } = require('./sandbox.cjs');

const MAX_RESULT_CHARS = 8000;

// Long-running background processes (dev servers, watchers) started via
// run_background, keyed by an id handed back to the model so it can poll
// output or stop them later. Module-level because a single extension host
// process serves one workspace at a time.
const backgroundProcs = new Map(); // id -> {proc, output: string[], exitCode: number|null}
let backgroundIdCounter = 0;

function truncate(s) {
  if (typeof s !== 'string') s = String(s);
  if (s.length <= MAX_RESULT_CHARS) return s;
  return s.slice(0, MAX_RESULT_CHARS) + `\n...[truncated ${s.length - MAX_RESULT_CHARS} more characters]`;
}

// Resolve a user/model-supplied relative path against the workspace root,
// and refuse to let tools escape outside of it.
function safePath(root, p) {
  const full = path.resolve(root, p || '.');
  const rel = path.relative(root, full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`path "${p}" resolves outside the workspace and is not allowed`);
  }
  return full;
}

const tools = {
  read_file: {
    description: 'Read a file\'s contents (with line numbers). Arguments: {"path": string}',
    confirm: false,
    readOnly: true,
    run: ({ path: p }, root) => {
      const full = safePath(root, p);
      if (!fs.existsSync(full)) return `ERROR: file not found: ${p}`;
      if (fs.statSync(full).isDirectory()) return `ERROR: ${p} is a directory, use list_dir`;
      const content = fs.readFileSync(full, 'utf8');
      const numbered = content.split('\n').map((l, i) => `${i + 1}\t${l}`).join('\n');
      return truncate(numbered);
    },
  },

  write_file: {
    description: 'Create a new file or fully overwrite an existing file. Arguments: {"path": string, "content": string}',
    confirm: true,
    kind: 'edit',
    preview: ({ path: p, content }, root) => {
      const full = safePath(root, p);
      const before = fs.existsSync(full) && !fs.statSync(full).isDirectory() ? fs.readFileSync(full, 'utf8') : '';
      return { path: p, before, after: content ?? '' };
    },
    run: ({ path: p, content }, root) => {
      const full = safePath(root, p);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content ?? '');
      return `OK: wrote ${(content ?? '').length} chars to ${p}`;
    },
  },

  edit_file: {
    description:
      'Replace one exact, unique snippet of text in a file with new text. Use this for small/targeted changes. Arguments: {"path": string, "old_str": string, "new_str": string}',
    confirm: true,
    kind: 'edit',
    preview: ({ path: p, old_str, new_str }, root) => {
      const full = safePath(root, p);
      if (!fs.existsSync(full)) return { path: p, error: `file not found: ${p}` };
      const before = fs.readFileSync(full, 'utf8');
      if (!old_str) return { path: p, error: 'old_str must not be empty' };
      const count = before.split(old_str).length - 1;
      if (count === 0) return { path: p, error: `old_str not found in ${p}` };
      if (count > 1) return { path: p, error: `old_str matches ${count} places in ${p}, needs more context` };
      const after = before.replace(old_str, new_str ?? '');
      return { path: p, before, after };
    },
    run: ({ path: p, old_str, new_str }, root) => {
      const full = safePath(root, p);
      if (!fs.existsSync(full)) return `ERROR: file not found: ${p}`;
      const content = fs.readFileSync(full, 'utf8');
      if (!old_str) return 'ERROR: old_str must not be empty';
      const count = content.split(old_str).length - 1;
      if (count === 0) return `ERROR: old_str not found in ${p}. Re-read the file and match exactly.`;
      if (count > 1) return `ERROR: old_str matches ${count} places in ${p}. Add more surrounding context to make it unique.`;
      fs.writeFileSync(full, content.replace(old_str, new_str ?? ''));
      return `OK: edited ${p}`;
    },
  },

  list_dir: {
    description: 'List files and folders at a path, non-recursive. Arguments: {"path": string}',
    confirm: false,
    readOnly: true,
    run: ({ path: p }, root) => {
      const full = safePath(root, p || '.');
      if (!fs.existsSync(full)) return `ERROR: path not found: ${p}`;
      const entries = fs.readdirSync(full, { withFileTypes: true });
      const lines = entries
        .filter((e) => !['node_modules', '.git', '.cortex'].includes(e.name))
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .sort();
      return lines.join('\n') || '(empty directory)';
    },
  },

  search_code: {
    description: 'Search for a text pattern across files (like grep -rn). Arguments: {"pattern": string, "path": string (optional, default ".")}',
    confirm: false,
    readOnly: true,
    run: ({ pattern, path: p }, root) => {
      if (!pattern) return 'ERROR: pattern is required';
      try {
        const dir = safePath(root, p || '.');
        const out = execSync(
          `grep -rn --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.cortex -- ${JSON.stringify(pattern)} ${JSON.stringify(dir)}`,
          { encoding: 'utf8', maxBuffer: 1024 * 1024 * 10 }
        );
        return truncate(out || '(no matches)');
      } catch (err) {
        if (err.status === 1) return '(no matches)';
        return `ERROR: ${err.message}`;
      }
    },
  },

  run_command: {
    description: 'Run a shell command in the workspace root (e.g. tests, linters, git, build steps) and return stdout/stderr. Arguments: {"command": string}',
    confirm: true,
    kind: 'command',
    run: ({ command }, root, ctx) => {
      if (!command) return 'ERROR: command is required';
      const { command: toRun, sandboxed } = ctx?.sandboxMode === 'workspace-write'
        ? wrapCommand(command, root, { allowNetwork: !!ctx.sandboxAllowNetwork })
        : { command, sandboxed: false };
      try {
        const out = execSync(toRun, { encoding: 'utf8', cwd: root, maxBuffer: 1024 * 1024 * 10, timeout: 60_000 });
        return truncate(`${sandboxed ? '[sandboxed]\n' : ''}${out || '(command produced no output)'}`);
      } catch (err) {
        return truncate(
          `${sandboxed ? '[sandboxed]\n' : ''}EXIT CODE: ${err.status}\nSTDOUT:\n${err.stdout || ''}\nSTDERR:\n${err.stderr || err.message}`
        );
      }
    },
  },

  remember: {
    description: 'Save a short, durable note to long-term memory for future sessions (e.g. project conventions, decisions made). Arguments: {"note": string}',
    confirm: false,
    run: ({ note }, root, ctx) => {
      if (!note) return 'ERROR: note is required';
      appendMemoryNote(root, note);
      // Fire-and-forget: indexing for semantic recall shouldn't block the
      // agent loop or fail the tool call if the embedding model is unavailable.
      if (ctx?.host) indexNote(root, ctx.host, note).catch(() => {});
      return 'OK: saved to long-term memory';
    },
  },

  run_background: {
    description:
      'Start a long-running shell command (dev server, watcher, build --watch) in the background and return an id immediately instead of blocking. Use read_background_output to poll its output and stop_background_process to kill it. Arguments: {"command": string}',
    confirm: true,
    kind: 'command',
    run: ({ command }, root, ctx) => {
      if (!command) return 'ERROR: command is required';
      const id = `bg${++backgroundIdCounter}`;
      const { command: toRun, sandboxed } = ctx?.sandboxMode === 'workspace-write'
        ? wrapCommand(command, root, { allowNetwork: !!ctx.sandboxAllowNetwork })
        : { command, sandboxed: false };
      const proc = spawn(toRun, { cwd: root, shell: true });
      const entry = { proc, output: [], exitCode: null };
      backgroundProcs.set(id, entry);
      proc.stdout.on('data', (d) => entry.output.push(d.toString()));
      proc.stderr.on('data', (d) => entry.output.push(d.toString()));
      proc.on('exit', (code) => {
        entry.exitCode = code;
      });
      return `OK: started background process ${id} (pid ${proc.pid})${sandboxed ? ' [sandboxed]' : ''}. Use read_background_output {"id":"${id}"} to check on it.`;
    },
  },

  read_background_output: {
    description: 'Read accumulated stdout/stderr from a process started with run_background, and whether it has exited. Arguments: {"id": string}',
    confirm: false,
    readOnly: true,
    run: ({ id }) => {
      const entry = backgroundProcs.get(id);
      if (!entry) return `ERROR: no background process with id ${id}`;
      const out = entry.output.join('');
      const status = entry.exitCode === null ? 'still running' : `exited with code ${entry.exitCode}`;
      return truncate(`status: ${status}\n\n${out || '(no output yet)'}`);
    },
  },

  stop_background_process: {
    description: 'Kill a background process started with run_background. Arguments: {"id": string}',
    confirm: true,
    kind: 'command',
    run: ({ id }) => {
      const entry = backgroundProcs.get(id);
      if (!entry) return `ERROR: no background process with id ${id}`;
      if (entry.exitCode !== null) return `OK: process ${id} had already exited (code ${entry.exitCode})`;
      entry.proc.kill();
      return `OK: sent kill signal to ${id}`;
    },
  },

  delegate_task: {
    description:
      'Delegate a self-contained sub-task to a fresh sub-agent (its own context window, same tools except delegate_task itself) and get back its final answer. Use for well-scoped chunks of a larger task (e.g. "write tests for utils.js") to keep your own context focused. Arguments: {"task": string}',
    confirm: false,
    run: async ({ task }, root, ctx) => {
      if (!task) return 'ERROR: task is required';
      if (!ctx || !ctx.delegateConfig) return 'ERROR: delegation is not available in this context';
      const depth = ctx.delegateDepth || 0;
      if (depth >= 1) return 'ERROR: sub-agents cannot delegate further (depth limit reached). Do the task directly instead.';
      // Lazy require: agentLoop.cjs requires this module at load time, so a
      // top-level require here would deadlock on the circular import.
      const { runTurn } = require('./agentLoop.cjs');
      const subHistory = [{ role: 'user', content: task }];
      let finalText = null;
      let errorText = null;
      await runTurn({
        history: subHistory,
        root,
        host: ctx.delegateConfig.host,
        provider: ctx.delegateConfig.provider,
        apiKey: ctx.delegateConfig.apiKey,
        model: ctx.delegateConfig.model,
        fastModel: ctx.delegateConfig.fastModel,
        temperature: ctx.delegateConfig.temperature,
        maxSteps: Math.min(ctx.delegateConfig.maxSteps, 15),
        memoryNotes: '',
        planMode: false,
        contextBudgetTokens: ctx.delegateConfig.contextBudgetTokens,
        ctx: { ...ctx, delegateDepth: depth + 1 },
        onToken: () => {},
        onToolCall: (name, args, callId) => ctx.onSubTaskEvent?.('toolCall', { name, args, callId }),
        requestApproval: async () => true, // sub-agents run fully autonomously within the same trust boundary as the parent call
        onToolResult: (result, isError, callId) => ctx.onSubTaskEvent?.('toolResult', { result, isError, callId }),
        onFinal: (text) => {
          finalText = text;
        },
        onError: (msg) => {
          errorText = msg;
        },
      });
      if (errorText) return `ERROR from sub-agent: ${errorText}`;
      return `Sub-agent result:\n${finalText || '(sub-agent produced no final answer)'}`;
    },
  },

  delete_file: {
    description: 'Delete a file (not a directory). Arguments: {"path": string}',
    confirm: true,
    kind: 'edit',
    preview: ({ path: p }, root) => {
      const full = safePath(root, p);
      const before = fs.existsSync(full) && !fs.statSync(full).isDirectory() ? fs.readFileSync(full, 'utf8') : '';
      return { path: p, before, after: '' };
    },
    run: ({ path: p }, root) => {
      const full = safePath(root, p);
      if (!fs.existsSync(full)) return `ERROR: file not found: ${p}`;
      if (fs.statSync(full).isDirectory()) return `ERROR: ${p} is a directory, refusing to delete_file it`;
      fs.unlinkSync(full);
      return `OK: deleted ${p}`;
    },
  },

  rename_file: {
    description: 'Rename or move a file to a new path within the workspace. Arguments: {"from": string, "to": string}',
    confirm: true,
    kind: 'edit',
    preview: ({ from, to }, root) => {
      const full = safePath(root, from);
      const before = fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : '';
      return { path: `${from} -> ${to}`, before, after: before };
    },
    run: ({ from, to }, root) => {
      const fullFrom = safePath(root, from);
      const fullTo = safePath(root, to);
      if (!fs.existsSync(fullFrom)) return `ERROR: file not found: ${from}`;
      fs.mkdirSync(path.dirname(fullTo), { recursive: true });
      fs.renameSync(fullFrom, fullTo);
      return `OK: renamed ${from} -> ${to}`;
    },
  },

  read_url: {
    description: 'Fetch a URL over HTTP(S) and return its text content (HTML tags stripped for readability). Arguments: {"url": string}',
    confirm: false,
    readOnly: true,
    run: async ({ url }) => {
      if (!url) return 'ERROR: url is required';
      let parsed;
      try {
        parsed = new URL(url);
      } catch {
        return `ERROR: invalid url: ${url}`;
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return `ERROR: only http/https urls are allowed`;
      }
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
        const contentType = res.headers.get('content-type') || '';
        const raw = await res.text();
        let text = raw;
        if (contentType.includes('html')) {
          text = raw
            .replace(/<script[\s\S]*?<\/script>/gi, ' ')
            .replace(/<style[\s\S]*?<\/style>/gi, ' ')
            .replace(/<[^>]+>/g, ' ')
            .replace(/&nbsp;/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        }
        return truncate(`HTTP ${res.status} ${contentType}\n\n${text}`);
      } catch (err) {
        return `ERROR fetching ${url}: ${err.message}`;
      }
    },
  },

  notify_webhook: {
    description:
      'Send a short notification message to the configured Slack/Discord/generic webhook (set via the "cortex.webhookUrl" setting). Use sparingly, e.g. to flag a long task finished or a decision needs human input. Arguments: {"message": string}',
    confirm: true,
    run: async ({ message }, root, ctx) => {
      const webhookUrl = ctx?.webhookUrl;
      if (!webhookUrl) return 'ERROR: no webhook configured. Set "cortex.webhookUrl" in settings first.';
      if (!message) return 'ERROR: message is required';
      try {
        const isDiscord = webhookUrl.includes('discord.com');
        const body = isDiscord ? { content: message } : { text: message };
        const res = await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) return `ERROR: webhook returned HTTP ${res.status}`;
        return 'OK: notification sent';
      } catch (err) {
        return `ERROR sending webhook: ${err.message}`;
      }
    },
  },

  multi_edit: {
    description:
      'Apply several edit_file-style patches (possibly across different files) as one atomic operation — either all succeed or none are written. Use this instead of several edit_file calls when a change spans multiple files, to avoid leaving the codebase half-edited if a later patch fails. Arguments: {"edits": [{"path": string, "old_str": string, "new_str": string}, ...]}',
    confirm: true,
    kind: 'edit',
    preview: ({ edits }, root) => {
      if (!Array.isArray(edits) || edits.length === 0) return { path: '(multi_edit)', error: 'edits must be a non-empty array' };
      const summaries = [];
      for (const e of edits) {
        const full = safePath(root, e.path);
        if (!fs.existsSync(full)) return { path: e.path, error: `file not found: ${e.path}` };
        const before = fs.readFileSync(full, 'utf8');
        const count = before.split(e.old_str || '').length - 1;
        if (!e.old_str) return { path: e.path, error: `old_str empty for ${e.path}` };
        if (count === 0) return { path: e.path, error: `old_str not found in ${e.path}` };
        if (count > 1) return { path: e.path, error: `old_str matches ${count} places in ${e.path}, needs more context` };
        summaries.push(`${e.path}: 1 change`);
      }
      return { path: `${edits.length} file(s)`, before: '', after: summaries.join('\n') };
    },
    run: ({ edits }, root) => {
      if (!Array.isArray(edits) || edits.length === 0) return 'ERROR: edits must be a non-empty array';
      // Validate every patch applies cleanly before writing anything, so a
      // failure partway through never leaves some files edited and others not.
      const planned = [];
      for (const e of edits) {
        let full;
        try {
          full = safePath(root, e.path);
        } catch (err) {
          return `ERROR: ${err.message}`;
        }
        if (!fs.existsSync(full)) return `ERROR: file not found: ${e.path} (no files were changed)`;
        const before = fs.readFileSync(full, 'utf8');
        if (!e.old_str) return `ERROR: old_str empty for ${e.path} (no files were changed)`;
        const count = before.split(e.old_str).length - 1;
        if (count === 0) return `ERROR: old_str not found in ${e.path} (no files were changed)`;
        if (count > 1) return `ERROR: old_str matches ${count} places in ${e.path}, needs more context (no files were changed)`;
        planned.push({ full, path: e.path, after: before.replace(e.old_str, e.new_str ?? '') });
      }
      for (const p of planned) fs.writeFileSync(p.full, p.after);
      return `OK: applied ${planned.length} edit(s) across ${new Set(planned.map((p) => p.path)).size} file(s): ${planned.map((p) => p.path).join(', ')}`;
    },
  },

  find_symbol: {
    description:
      'Find where a function/class/const/variable named `name` is DEFINED (not just mentioned) — greps for common declaration patterns (function/class/const/let/def/interface/type) across the workspace. Faster and more precise than search_code when you know the symbol name. Arguments: {"name": string, "path": string (optional, default ".")}',
    confirm: false,
    readOnly: true,
    run: ({ name, path: p }, root) => {
      if (!name) return 'ERROR: name is required';
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = `(function|class|const|let|var|def|interface|type|struct|fn)\\s+${escaped}\\b|${escaped}\\s*[:=]\\s*(function|\\(|async)`;
      try {
        const dir = safePath(root, p || '.');
        const out = execSync(
          `grep -rnE --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.cortex -- ${JSON.stringify(pattern)} ${JSON.stringify(dir)}`,
          { encoding: 'utf8', maxBuffer: 1024 * 1024 * 10 }
        );
        return truncate(out || `(no definition found for "${name}")`);
      } catch (err) {
        if (err.status === 1) return `(no definition found for "${name}")`;
        return `ERROR: ${err.message}`;
      }
    },
  },

  find_references: {
    description:
      'Find every place `name` is USED/referenced across the workspace (all mentions, not just the definition) — use after find_symbol to see callers/usages before changing or removing something. Arguments: {"name": string, "path": string (optional, default ".")}',
    confirm: false,
    readOnly: true,
    run: ({ name, path: p }, root) => {
      if (!name) return 'ERROR: name is required';
      try {
        const dir = safePath(root, p || '.');
        const out = execSync(
          `grep -rn --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.cortex -w -- ${JSON.stringify(name)} ${JSON.stringify(dir)}`,
          { encoding: 'utf8', maxBuffer: 1024 * 1024 * 10 }
        );
        const lines = (out || '').trim().split('\n').filter(Boolean);
        return truncate(lines.length ? `${lines.length} reference(s):\n${lines.join('\n')}` : `(no references found for "${name}")`);
      } catch (err) {
        if (err.status === 1) return `(no references found for "${name}")`;
        return `ERROR: ${err.message}`;
      }
    },
  },
};

function toolListForPrompt() {
  return Object.entries(tools).map(([name, t]) => `- ${name}: ${t.description}`).join('\n');
}

// Lets external integrations (currently: mcpManager.cjs) add/remove tools
// into the same registry the agent loop already reads from, so MCP-provided
// tools show up in the system prompt and go through the normal
// confirm/preview/approval pipeline like any built-in tool.
function registerExternalTool(name, toolDef) {
  tools[name] = toolDef;
}

function unregisterExternalTool(name) {
  delete tools[name];
}

module.exports = { tools, toolListForPrompt, safePath, registerExternalTool, unregisterExternalTool };
