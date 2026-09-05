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
const { markAgentRead, markAgentWrite } = require('./fileTracker.cjs');
const { saveTasks, taskProgress } = require('./taskList.cjs');
const lsp = require('./lsp.cjs');
const codeIndex = require('./codeIndex.cjs');
const terminal = require('./terminal.cjs');

// Per-tool output budgets. A single global cap silently cut large file reads
// mid-function, and the agent then edited against a file it had only half
// seen — a correctness failure, not a display one. Reads and command output
// get real room; the line caps bound pathological files (minified bundles,
// generated code) independently of the total.
const LIMITS = {
  read: 48_000,
  command: 48_000,
  search: 48_000,
  default: 12_000,
  maxLines: 2_000,
  maxLineChars: 2_000,
};

// Long-running background processes (dev servers, watchers) started via
// run_background, keyed by an id handed back to the model so it can poll
// output or stop them later. Module-level because a single extension host
// process serves one workspace at a time.
const backgroundProcs = new Map(); // id -> {proc, output: string[], exitCode: number|null}
let backgroundIdCounter = 0;

function truncate(s, limit = LIMITS.default) {
  if (typeof s !== 'string') s = String(s);
  if (s.length <= limit) return s;
  return s.slice(0, limit) + `\n...[truncated ${s.length - limit} more characters]`;
}

// Bounds a file's text by lines and per-line length before the total-size cap,
// so one pathological line can't consume the whole budget and hide the rest.
function clampFileText(text) {
  const lines = text.split('\n');
  const clippedLines = lines.slice(0, LIMITS.maxLines).map((l) =>
    l.length > LIMITS.maxLineChars ? `${l.slice(0, LIMITS.maxLineChars)} …[${l.length - LIMITS.maxLineChars} more chars on this line]` : l
  );
  const note = lines.length > LIMITS.maxLines ? `\n...[${lines.length - LIMITS.maxLines} more lines not shown]` : '';
  return clippedLines.join('\n') + note;
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

// Locates `oldStr` inside `content`, tolerating the near-miss mismatches
// every model makes regardless of size: trailing whitespace, tabs-vs-spaces,
// and CRLF-vs-LF. An exact hit always wins; fuzzy passes only run when the
// exact one fails, and only accept a UNIQUE match, so relaxing the match
// can never silently rewrite the wrong region.
//
// Returns {ok, start, end, how} on success, or {ok:false, reason, count}.
function locateSnippet(content, oldStr) {
  const exactCount = content.split(oldStr).length - 1;
  if (exactCount === 1) {
    const start = content.indexOf(oldStr);
    return { ok: true, start, end: start + oldStr.length, how: 'exact' };
  }
  if (exactCount > 1) return { ok: false, reason: 'ambiguous', count: exactCount };

  // Fuzzy passes, ordered most-conservative first. Each builds a regex from
  // the snippet where a specific class of insignificant difference is
  // allowed to vary, then requires exactly one match.
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const attempts = [
    // line-ending and trailing-whitespace insensitive
    {
      how: 'whitespace-insensitive',
      pattern: oldStr
        .split(/\r?\n/)
        .map((line) => escape(line.replace(/[ \t]+$/, '')) + '[ \\t]*')
        .join('\\r?\\n'),
    },
    // additionally indentation-insensitive (tabs vs spaces, depth changes)
    {
      how: 'indentation-insensitive',
      pattern: oldStr
        .split(/\r?\n/)
        .map((line) => '[ \\t]*' + escape(line.trim()) + '[ \\t]*')
        .join('\\r?\\n'),
    },
  ];

  for (const { how, pattern } of attempts) {
    let re;
    try {
      re = new RegExp(pattern, 'g');
    } catch {
      continue; // pathological snippet produced an invalid pattern — skip this pass
    }
    const matches = [...content.matchAll(re)];
    if (matches.length === 1) {
      return { ok: true, start: matches[0].index, end: matches[0].index + matches[0][0].length, how };
    }
    if (matches.length > 1) return { ok: false, reason: 'ambiguous', count: matches.length };
  }
  return { ok: false, reason: 'not-found', count: 0 };
}

// Applies an edit via locateSnippet, preserving the file's own indentation
// when the match was only found indentation-insensitively.
function applySnippet(content, oldStr, newStr) {
  const hit = locateSnippet(content, oldStr);
  if (!hit.ok) return hit;
  return { ok: true, how: hit.how, after: content.slice(0, hit.start) + (newStr ?? '') + content.slice(hit.end) };
}

const NOT_FOUND_HINT =
  'Re-read the file with read_file and copy the snippet verbatim. If it still fails, use write_file with the complete new file contents instead of retrying edit_file.';

const tools = {
  read_file: {
    description:
      'Read one file, or several at once. Prefer passing an array — reading four files in one call costs one round-trip instead of four. Arguments: {"path": string} or {"path": string[]}',
    confirm: false,
    readOnly: true,
    // Batching is part of the contract rather than something recovered by
    // parsing several tool-call lines out of one response, so the model
    // cannot express it in a shape we then have to repair.
    schema: {
      type: 'object',
      properties: {
        path: {
          description: 'A workspace-relative file path, or an array of them to read together.',
          anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, maxItems: 12 }],
        },
      },
      required: ['path'],
    },
    run: ({ path: p }, root) => {
      if (Array.isArray(p)) {
        if (p.length === 0) return 'ERROR: path array is empty';
        return truncate(
          p.map((one) => `--- ${one} ---\n${tools.read_file.run({ path: one }, root)}`).join('\n\n'),
          LIMITS.read
        );
      }
      const full = safePath(root, p);
      if (!fs.existsSync(full)) return `ERROR: file not found: ${p}`;
      if (fs.statSync(full).isDirectory()) return `ERROR: ${p} is a directory, use list_dir`;
      const content = fs.readFileSync(full, 'utf8');
      markAgentRead(root, p);
      const numbered = clampFileText(content)
        .split('\n')
        .map((l, i) => `${i + 1}\t${l}`)
        .join('\n');
      return truncate(numbered, LIMITS.read);
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
      markAgentWrite(root, p);
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
      const applied = applySnippet(before, old_str, new_str);
      if (!applied.ok) {
        return {
          path: p,
          error:
            applied.reason === 'ambiguous'
              ? `old_str matches ${applied.count} places in ${p}, needs more context`
              : `old_str not found in ${p}`,
        };
      }
      return { path: p, before, after: applied.after };
    },
    run: ({ path: p, old_str, new_str }, root) => {
      const full = safePath(root, p);
      if (!fs.existsSync(full)) return `ERROR: file not found: ${p}`;
      const content = fs.readFileSync(full, 'utf8');
      if (!old_str) return 'ERROR: old_str must not be empty';
      const applied = applySnippet(content, old_str, new_str);
      if (!applied.ok) {
        if (applied.reason === 'ambiguous') {
          return `ERROR: old_str matches ${applied.count} places in ${p}. Add more surrounding context to make it unique.`;
        }
        return `ERROR: old_str not found in ${p}. ${NOT_FOUND_HINT}`;
      }
      fs.writeFileSync(full, applied.after);
      markAgentWrite(root, p);
      return `OK: edited ${p}${applied.how === 'exact' ? '' : ` (matched ${applied.how} — your snippet's whitespace differed from the file)`}`;
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
        return truncate(out || '(no matches)', LIMITS.search);
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
    run: async ({ command }, root, ctx) => {
      if (!command) return 'ERROR: command is required';
      // Prefer VS Code's visible terminal so the user can watch (and keep)
      // what ran. Sandboxed commands deliberately stay on the child-process
      // path — bubblewrap wrapping is what provides the containment, and it
      // doesn't compose with the shell-integration wrapper.
      if (ctx?.useTerminal && ctx?.sandboxMode !== 'workspace-write') {
        try {
          const res = await terminal.runInTerminal(command, root);
          if (res) {
            const failed = res.exitCode !== undefined && res.exitCode !== 0;
            return truncate(
              `${failed ? `EXIT CODE: ${res.exitCode}\n` : ''}${res.output || '(command produced no output)'}`,
              LIMITS.command
            );
          }
        } catch {
          // fall through to the child-process path below
        }
      }
      const { command: toRun, sandboxed } = ctx?.sandboxMode === 'workspace-write'
        ? wrapCommand(command, root, { allowNetwork: !!ctx.sandboxAllowNetwork })
        : { command, sandboxed: false };
      try {
        const out = execSync(toRun, { encoding: 'utf8', cwd: root, maxBuffer: 1024 * 1024 * 10, timeout: 60_000 });
        return truncate(`${sandboxed ? '[sandboxed]\n' : ''}${out || '(command produced no output)'}`, LIMITS.command);
      } catch (err) {
        return truncate(
          `${sandboxed ? '[sandboxed]\n' : ''}EXIT CODE: ${err.status}\nSTDOUT:\n${err.stdout || ''}\nSTDERR:\n${err.stderr || err.message}`,
          LIMITS.command
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
      return truncate(`status: ${status}\n\n${out || '(no output yet)'}`, LIMITS.command);
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
        const applied = applySnippet(before, e.old_str, e.new_str);
        if (!applied.ok) {
          return applied.reason === 'ambiguous'
            ? `ERROR: old_str matches ${applied.count} places in ${e.path}, needs more context (no files were changed)`
            : `ERROR: old_str not found in ${e.path} (no files were changed). ${NOT_FOUND_HINT}`;
        }
        planned.push({ full, path: e.path, after: applied.after });
      }
      for (const p of planned) {
        fs.writeFileSync(p.full, p.after);
        markAgentWrite(root, p.path);
      }
      return `OK: applied ${planned.length} edit(s) across ${new Set(planned.map((p) => p.path)).size} file(s): ${planned.map((p) => p.path).join(', ')}`;
    },
  },

  git_status: {
    description:
      'Show the working tree status plus a summary of what changed (files added/modified/deleted, current branch). Use before committing, or to see what you have already changed this session. Arguments: {}',
    confirm: false,
    readOnly: true,
    run: (_args, root) => {
      try {
        const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: root, encoding: 'utf8' }).trim();
        const status = execSync('git status --porcelain', { cwd: root, encoding: 'utf8' });
        const stat = execSync('git diff --stat HEAD', { cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024 * 5 });
        return truncate(`branch: ${branch}\n\n${status || '(working tree clean)'}\n${stat}`);
      } catch (err) {
        return `ERROR: ${err.stderr || err.message}`;
      }
    },
  },

  git_diff: {
    description:
      'Show the actual diff of uncommitted changes, optionally for one path. Read this before writing a commit message so the message describes what really changed. Arguments: {"path": string (optional), "staged": boolean (optional)}',
    confirm: false,
    readOnly: true,
    run: ({ path: p, staged }, root) => {
      try {
        const target = p ? ` -- ${JSON.stringify(safePath(root, p))}` : '';
        const out = execSync(`git diff ${staged ? '--staged' : ''}${target}`, {
          cwd: root,
          encoding: 'utf8',
          maxBuffer: 1024 * 1024 * 10,
        });
        return truncate(out || '(no changes)');
      } catch (err) {
        return `ERROR: ${err.stderr || err.message}`;
      }
    },
  },

  git_commit: {
    description:
      'Stage the given paths (or all changes) and create a commit. Always run git_diff first and write a message describing the actual change and why. Arguments: {"message": string, "paths": string[] (optional, defaults to all changes)}',
    confirm: true,
    kind: 'command',
    run: ({ message, paths }, root) => {
      if (!message || !message.trim()) return 'ERROR: a commit message is required';
      try {
        if (Array.isArray(paths) && paths.length > 0) {
          for (const p of paths) execSync(`git add ${JSON.stringify(safePath(root, p))}`, { cwd: root });
        } else {
          execSync('git add -A', { cwd: root });
        }
        const staged = execSync('git diff --staged --name-only', { cwd: root, encoding: 'utf8' }).trim();
        if (!staged) return 'ERROR: nothing staged to commit';
        // -F - keeps multi-line messages intact and avoids any shell quoting
        // pitfalls with quotes/backticks in the message body.
        execSync('git commit -F -', { cwd: root, input: message, encoding: 'utf8' });
        const sha = execSync('git rev-parse --short HEAD', { cwd: root, encoding: 'utf8' }).trim();
        return `OK: committed ${sha}\n${staged}`;
      } catch (err) {
        return `ERROR: ${err.stderr || err.message}`;
      }
    },
  },

  semantic_search: {
    description:
      'Search the codebase by MEANING rather than exact text — e.g. "where do we handle auth failures" or "retry logic for network calls". Use this when you do not know the exact identifier to grep for; use search_code when you do. Requires the index (build it with the "Cortex: Build Code Index" command). Arguments: {"query": string, "topK": number (optional, default 8)}',
    confirm: false,
    readOnly: true,
    run: async ({ query, topK }, root, ctx) => {
      if (!query) return 'ERROR: query is required';
      let hits;
      try {
        hits = await codeIndex.search(root, query, { host: ctx?.host, topK: topK || 8 });
      } catch (err) {
        return `ERROR: semantic search failed (${err.message}). Is the embedding model pulled? ("ollama pull nomic-embed-text")`;
      }
      if (hits === null) return 'ERROR: no code index yet. Run the "Cortex: Build Code Index" command first, or use search_code instead.';
      if (hits.length === 0) return '(no semantically similar code found)';
      return truncate(
        hits
          .map((h) => `${h.path}:${h.startLine}-${h.endLine}  (score ${h.score.toFixed(3)})\n${h.text}`)
          .join('\n\n')
      );
    },
  },

  diagnostics: {
    description:
      "Get the editor's current compiler/linter errors and warnings (the same ones shown in the Problems panel) — real type errors, unresolved imports, lint violations. Far faster than running the test suite, and the fastest way to check whether an edit actually holds up. Arguments: {\"path\": string (optional, defaults to the whole workspace)}",
    confirm: false,
    readOnly: true,
    run: ({ path: p }, root) => {
      const out = lsp.getDiagnostics(root, p);
      if (out === null) return 'ERROR: diagnostics are only available inside the VS Code extension host, not the CLI.';
      return truncate(out || '(no problems reported)');
    },
  },

  update_tasks: {
    description:
      'Record or update your plan for a multi-step task as a Markdown checklist (e.g. "- [x] read config\\n- [ ] add the route"). This list is stored on disk and shown back to you every turn, so it survives context trimming and /compact — use it on any task with more than ~3 steps, and re-send the full updated list each time you finish a step. Arguments: {"markdown": string}',
    confirm: false,
    run: ({ markdown }, root) => {
      if (typeof markdown !== 'string' || !markdown.trim()) return 'ERROR: markdown checklist is required';
      saveTasks(root, markdown);
      const { done, total } = taskProgress(root);
      return `OK: task list updated (${done}/${total} done)`;
    },
  },

  find_symbol: {
    description:
      'Find where a function/class/const/variable named `name` is DEFINED (not just mentioned) — greps for common declaration patterns (function/class/const/let/def/interface/type) across the workspace. Faster and more precise than search_code when you know the symbol name. Arguments: {"name": string, "path": string (optional, default ".")}',
    confirm: false,
    readOnly: true,
    run: async ({ name, path: p }, root) => {
      if (!name) return 'ERROR: name is required';
      // Ask the language server first: it knows which symbol is actually
      // meant, where grep only knows which lines contain the characters.
      const viaLsp = await lsp.findDefinitions(root, name).catch(() => null);
      if (viaLsp) return truncate(`(via language server)\n${viaLsp}`);
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = `(function|class|const|let|var|def|interface|type|struct|fn)\\s+${escaped}\\b|${escaped}\\s*[:=]\\s*(function|\\(|async)`;
      try {
        const dir = safePath(root, p || '.');
        const out = execSync(
          `grep -rnE --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.cortex -- ${JSON.stringify(pattern)} ${JSON.stringify(dir)}`,
          { encoding: 'utf8', maxBuffer: 1024 * 1024 * 10 }
        );
        return truncate(out || `(no definition found for "${name}")`, LIMITS.search);
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
    run: async ({ name, path: p }, root) => {
      if (!name) return 'ERROR: name is required';
      const viaLsp = await lsp.findReferences(root, name).catch(() => null);
      if (viaLsp) return truncate(`(via language server)\n${viaLsp}`);
      try {
        const dir = safePath(root, p || '.');
        const out = execSync(
          `grep -rn --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.cortex -w -- ${JSON.stringify(name)} ${JSON.stringify(dir)}`,
          { encoding: 'utf8', maxBuffer: 1024 * 1024 * 10 }
        );
        const lines = (out || '').trim().split('\n').filter(Boolean);
        return truncate(lines.length ? `${lines.length} reference(s):\n${lines.join('\n')}` : `(no references found for "${name}")`, LIMITS.search);
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
