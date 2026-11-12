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
const { execFileSync, spawn } = require('child_process');
const { appendMemoryNote } = require('./memory.cjs');
const { indexNote } = require('./semanticMemory.cjs');
const { wrapCommand, shellQuote: shq } = require('./sandbox.cjs');
const { markAgentRead, markAgentWrite, hasSeen } = require('./fileTracker.cjs');
const { saveTasks, taskProgress } = require('./taskList.cjs');
const lsp = require('./lsp.cjs');
const codeIndex = require('./codeIndex.cjs');
const terminal = require('./terminal.cjs');
const { apiToolFor } = require('./toolSchemas.cjs');

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

const COMMAND_TIMEOUT_MS = 120_000;
const MAX_COMMAND_TIMEOUT_S = 1800;

/**
 * Runs a shell command without blocking the extension host.
 *
 * execSync froze all of VS Code for as long as a command ran — the chat
 * stopped streaming, Stop could not be clicked, other extensions hung. This
 * is the same contract, asynchronously, and it can be cancelled: a Stop or
 * timeout kills the whole process group, not just the shell wrapper.
 *
 * @param {string} command
 * @param {{cwd: string, timeoutMs?: number, signal?: AbortSignal, maxBytes?: number}} opts
 * @returns {Promise<{stdout: string, stderr: string, code: number|null, timedOut: boolean, aborted: boolean}>}
 */
function runShell(command, { cwd, timeoutMs = COMMAND_TIMEOUT_MS, signal, maxBytes = 10 * 1024 * 1024 }) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ stdout: '', stderr: '', code: null, timedOut: false, aborted: true });
      return;
    }
    const proc = spawn(command, { cwd, shell: true, detached: process.platform !== 'win32' });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    const kill = () => {
      try {
        if (process.platform !== 'win32' && proc.pid) process.kill(-proc.pid, 'SIGKILL');
        else proc.kill('SIGKILL');
      } catch {
        // already gone
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    const onAbort = () => {
      aborted = true;
      kill();
    };
    signal?.addEventListener('abort', onAbort);
    proc.stdout.on('data', (d) => {
      if (stdout.length < maxBytes) stdout += d.toString();
    });
    proc.stderr.on('data', (d) => {
      if (stderr.length < maxBytes) stderr += d.toString();
    });
    const finish = (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ stdout, stderr, code, timedOut, aborted });
    };
    proc.on('error', (err) => {
      stderr += err.message;
      finish(null);
    });
    proc.on('close', (code) => finish(code));
  });
}

const GREP_EXCLUDES = '--exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.cortex';

async function grep(flags, pattern, dir, root, signal) {
  let res = await runShell(`grep ${flags} ${GREP_EXCLUDES} -- ${shq(pattern)} ${shq(dir)}`, {
    cwd: root,
    timeoutMs: 30_000,
    signal,
  });
  // An invalid regex (models write PCRE-isms grep rejects) used to come
  // back as a bare grep error, and the model retried the identical call
  // until the loop breaker stopped it. Searching for the text literally is
  // almost always what was meant.
  let note = '';
  if (res.code === 2 && !flags.includes('F') && /unmatched|invalid|trailing backslash|unbalanced/i.test(res.stderr)) {
    res = await runShell(`grep ${flags.replace('E', '')}F ${GREP_EXCLUDES} -- ${shq(pattern)} ${shq(dir)}`, { cwd: root, timeoutMs: 30_000, signal });
    note = '(not a valid regex — searched for it as literal text)\n';
  }
  if (res.code === 1) return { ok: true, out: '', note };
  if (res.code !== 0) return { ok: false, out: res.timedOut ? 'search timed out after 30s' : res.stderr.trim() || `grep exited ${res.code}` };
  // Paths relative to the workspace are shorter and are what every other
  // tool takes as input.
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  return { ok: true, out: res.stdout.split(prefix).join(''), note };
}

// ripgrep when it is installed: several times faster than grep on a real
// repo, and it honours .gitignore, so build output and vendored code stop
// drowning the matches that matter. Looked up once per process.
let rgPath;
function findRg() {
  if (rgPath !== undefined) return rgPath;
  rgPath = null;
  if (process.env.CORTEX_NO_RG) return rgPath;
  try {
    execFileSync('rg', ['--version'], { stdio: 'ignore', timeout: 5000 });
    rgPath = 'rg';
  } catch {
    // not installed — callers fall back to grep / a directory walk
  }
  return rgPath;
}

/**
 * Runs a program with an argv (no shell), cancellable, output bounded.
 * @param {string} file
 * @param {string[]} args
 * @param {{cwd: string, timeoutMs?: number, signal?: AbortSignal, maxBytes?: number}} opts
 * @returns {Promise<{stdout: string, stderr: string, code: number|null, timedOut: boolean}>}
 */
function runFile(file, args, { cwd, timeoutMs = 30_000, signal, maxBytes = 4 * 1024 * 1024 }) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let proc;
    try {
      proc = spawn(file, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ stdout, stderr: err.message, code: null, timedOut });
      return;
    }
    const kill = () => {
      try {
        proc.kill('SIGKILL');
      } catch {
        // already gone
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    signal?.addEventListener('abort', kill);
    proc.stdout.on('data', (d) => {
      if (stdout.length < maxBytes) stdout += d.toString();
      else kill(); // enough to fill any result budget many times over
    });
    proc.stderr.on('data', (d) => {
      if (stderr.length < 64_000) stderr += d.toString();
    });
    const finish = (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', kill);
      resolve({ stdout, stderr, code, timedOut });
    };
    proc.on('error', (err) => {
      stderr += err.message;
      finish(null);
    });
    proc.on('close', finish);
  });
}

const RG_EXCLUDES = ['-g', '!.git/', '-g', '!.cortex/', '-g', '!node_modules/'];

/**
 * Content search through ripgrep. Returns null when rg is not installed so
 * the caller can fall back to grep.
 * @param {{pattern: string, dir: string, root: string, glob?: string, ignoreCase?: boolean, context?: number, literal?: boolean, word?: boolean, signal?: AbortSignal}} o
 */
async function rgSearch({ pattern, dir, root, glob, ignoreCase, context, literal, word, signal }) {
  const rg = findRg();
  if (!rg) return null;
  const base = ['--line-number', '--no-heading', '--color', 'never', '--hidden', '--max-columns', '400', '--max-columns-preview', ...RG_EXCLUDES];
  if (ignoreCase) base.push('-i');
  if (word) base.push('-w');
  if (glob) base.push('-g', glob);
  const ctxLines = Math.max(0, Math.min(10, Math.floor(Number(context) || 0)));
  if (ctxLines) base.push('-C', String(ctxLines));
  const rel = path.relative(root, dir) || '.';
  const run = (fixed) => runFile(rg, [...base, ...(fixed ? ['-F'] : []), '-e', pattern, rel], { cwd: root, signal });
  let res = await run(!!literal);
  let note = '';
  if (res.code === 2 && !literal && /regex parse error|unclosed|unopened|repetition|look-around|backreference/i.test(res.stderr)) {
    res = await run(true);
    note = '(not a valid regex — searched for it as literal text)\n';
  }
  if (res.timedOut) return { ok: false, out: 'search timed out after 30s — narrow it with "path" or "glob"' };
  if (res.code === 1 && !res.stdout) return { ok: true, out: '', note };
  if (res.code !== 0 && !res.stdout) return { ok: false, out: res.stderr.trim() || `rg exited ${res.code}` };
  return { ok: true, out: res.stdout.replace(/^\.\//gm, ''), note };
}

// `**` crosses directories, `*` and `?` stay inside one path segment,
// {a,b} alternates. Enough for the patterns models actually write.
function globToRegExp(glob) {
  let re = '';
  let depth = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      depth++;
      re += '(?:';
    } else if (c === '}' && depth) {
      depth--;
      re += ')';
    } else if (c === ',' && depth) re += '|';
    else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

// git with an argv, never a shell string, so a path or message can't be
// interpreted as shell syntax.
function git(root, args, input) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    input,
    maxBuffer: 10 * 1024 * 1024,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  });
}

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

// A numbered window of a file. Without offset/limit it is the top of the
// file; whenever something is left out the result says exactly which lines
// were shown and how to get the rest, so a model never edits against a file
// it believes it has seen in full but hasn't.
function renderFileWindow(content, offset, limit) {
  const lines = content.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop(); // trailing newline is not an extra line
  const total = lines.length;
  const start = Math.max(1, Math.floor(Number(offset) || 1));
  if (start > total && total > 0) return `ERROR: offset ${start} is past the end of the file (${total} lines)`;
  const want = Math.max(1, Math.min(LIMITS.maxLines, Math.floor(Number(limit) || LIMITS.maxLines)));
  const out = [];
  let chars = 0;
  let i = start - 1;
  for (; i < total && out.length < want; i++) {
    const l = lines[i];
    const shown = l.length > LIMITS.maxLineChars ? `${l.slice(0, LIMITS.maxLineChars)} …[${l.length - LIMITS.maxLineChars} more chars on this line]` : l;
    const row = `${i + 1}\t${shown}`;
    if (chars + row.length + 1 > LIMITS.read && out.length) break;
    out.push(row);
    chars += row.length + 1;
  }
  const end = start + out.length - 1;
  let text = out.join('\n');
  if (start > 1 || end < total) {
    text += `\n...[showing lines ${start}-${end} of ${total}${end < total ? ` — call read_file with "offset": ${end + 1} for more` : ''}]`;
  }
  return text;
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

// replace_all: every exact occurrence. No fuzzy matching here — relaxing the
// match across many sites at once is how the wrong thing gets rewritten.
function applyAll(content, oldStr, newStr) {
  const parts = content.split(oldStr);
  const count = parts.length - 1;
  if (count === 0) return { ok: false, reason: 'not-found', count: 0 };
  return { ok: true, how: 'exact', count, after: parts.join(newStr ?? '') };
}

const SKIP_DIRS = new Set(['node_modules', '.git', '.cortex', 'dist', 'build', 'out', '.next', '__pycache__', '.venv', 'venv', 'target']);

// Workspace-relative file paths, bounded so a huge repo can't stall a tool.
function listFiles(root, limit = 5000) {
  const out = [];
  const walk = (dir) => {
    if (out.length >= limit) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= limit) return;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name));
      } else if (e.isFile()) {
        out.push(path.relative(root, path.join(dir, e.name)));
      }
    }
  };
  walk(root);
  return out;
}

// For "file not found": the files that probably were meant. A bare
// not-found sent small models straight to "please check the file exists";
// showing what is actually there lets them correct the guess themselves.
function suggestPaths(root, p) {
  const wanted = String(p || '');
  const base = path.basename(wanted).toLowerCase();
  const stem = base.replace(/\.[^.]+$/, '');
  const dir = path.dirname(wanted);
  const files = listFiles(root);
  const scored = [];
  for (const f of files) {
    const fb = path.basename(f).toLowerCase();
    let score = 0;
    if (fb === base) score += 10;
    else if (stem && fb.replace(/\.[^.]+$/, '') === stem) score += 6;
    else if (stem.length >= 3 && (fb.includes(stem) || stem.includes(fb.replace(/\.[^.]+$/, '')))) score += 3;
    if (dir !== '.' && path.dirname(f) === dir) score += 4;
    else if (dir !== '.' && f.startsWith(dir + path.sep)) score += 2;
    if (score > 0) scored.push({ f, score });
  }
  scored.sort((a, b) => b.score - a.score || a.f.length - b.f.length);
  const picks = scored.slice(0, 8).map((x) => x.f);
  if (picks.length) return `\nDid you mean one of these?\n${picks.map((f) => `  ${f}`).join('\n')}`;
  const top = files.slice(0, 30);
  return top.length ? `\nFiles in the workspace${files.length > 30 ? ' (first 30)' : ''}:\n${top.map((f) => `  ${f}`).join('\n')}` : '';
}

// For an edit_file miss: the region of the file that most resembles the
// snippet, with line numbers, so the model can copy the real text instead
// of guessing again.
function closestRegion(content, oldStr) {
  const fileLines = content.split(/\r?\n/);
  const snippetLines = String(oldStr).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!snippetLines.length || !fileLines.length) return '';
  const tokens = (s) => new Set(s.toLowerCase().match(/[a-z0-9_$]+/g) || []);
  const want = snippetLines.map(tokens);
  let best = { score: 0, at: -1 };
  for (let i = 0; i < fileLines.length; i++) {
    let score = 0;
    for (let k = 0; k < want.length && i + k < fileLines.length; k++) {
      const have = tokens(fileLines[i + k]);
      if (!want[k].size) continue;
      let hit = 0;
      for (const t of want[k]) if (have.has(t)) hit++;
      score += hit / want[k].size;
    }
    if (score > best.score) best = { score, at: i };
  }
  if (best.at === -1 || best.score / want.length < 0.3) return '';
  const from = Math.max(0, best.at - 2);
  const to = Math.min(fileLines.length, best.at + snippetLines.length + 2);
  const shown = fileLines.slice(from, to).map((l, k) => `${from + k + 1}\t${l}`).join('\n');
  return `\nThe closest text actually in the file (lines ${from + 1}-${to}):\n${shown}`;
}

// For an ambiguous edit: where the snippet occurs, with the line above each
// occurrence, so the model can see what to add to single one out. Telling it
// only "add more context" got the same snippet back; offering replace_all
// here got both occurrences rewritten when one was meant.
function ambiguousHint(content, oldStr, p) {
  const firstLine = String(oldStr).split(/\r?\n/).find((l) => l.trim()) || '';
  const lines = content.split(/\r?\n/);
  const at = [];
  for (let i = 0; i < lines.length && at.length < 6; i++) {
    if (firstLine.trim() && lines[i].includes(firstLine.trim())) at.push(i);
  }
  if (!at.length) return '';
  const shown = at
    .map((i) => `${i > 0 ? `${i}\t${lines[i - 1]}\n` : ''}${i + 1}\t${lines[i]}`)
    .join('\n  ...\n');
  return (
    `\nIt occurs at line${at.length === 1 ? '' : 's'} ${at.map((i) => i + 1).join(', ')} of ${p}:\n${shown}\n` +
    `Decide which ONE you mean and include the line above it in old_str (and in new_str, unchanged) so the snippet matches only there.`
  );
}

// True when write_file would replace a non-empty file the agent has neither
// read nor written in this session.
function unseenOverwrite(root, p, full) {
  try {
    if (!fs.existsSync(full) || hasSeen(root, p)) return false;
    return fs.statSync(full).size > 0;
  } catch {
    return false;
  }
}

const NOT_FOUND_HINT =
  'Re-read the file with read_file and copy the snippet verbatim. If it still fails, use write_file with the complete new file contents instead of retrying edit_file.';

/**
 * @typedef {object} ToolDef
 * @property {string} description
 * @property {boolean} [confirm]
 * @property {boolean} [readOnly]
 * @property {'edit'|'command'} [kind]
 * @property {object} [schema]
 * @property {(args: any, root: string) => any} [preview]
 * @property {(args: any, root: string, ctx?: any) => any} run
 */

/** @type {Record<string, ToolDef>} */
const tools = {
  read_file: {
    description:
      'Read one file, or several at once. Prefer passing an array — reading four files in one call costs one round-trip instead of four. Output is numbered "line<TAB>text". For a big file pass offset (1-based first line) and limit (line count) to read just a window. Arguments: {"path": string | string[], "offset": number (optional), "limit": number (optional)}',
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
        offset: { type: 'number', description: '1-based line to start from (single file only). Omit to start at the top.' },
        limit: { type: 'number', description: `How many lines to return (single file only). Default ${LIMITS.maxLines}.` },
      },
      required: ['path'],
    },
    run: ({ path: p, offset, limit }, root) => {
      if (Array.isArray(p)) {
        if (p.length === 0) return 'ERROR: path array is empty';
        if (p.length === 1) return tools.read_file.run({ path: p[0], offset, limit }, root);
        return truncate(
          p.map((one) => `--- ${one} ---\n${tools.read_file.run({ path: one }, root)}`).join('\n\n'),
          LIMITS.read
        );
      }
      if (!p || typeof p !== 'string') return 'ERROR: path is required';
      const full = safePath(root, p);
      if (!fs.existsSync(full)) return `ERROR: file not found: ${p}${suggestPaths(root, p)}`;
      if (fs.statSync(full).isDirectory()) return `ERROR: ${p} is a directory, use list_dir`;
      const buf = fs.readFileSync(full);
      if (buf.subarray(0, 8000).includes(0)) return `ERROR: ${p} looks like a binary file (${buf.length} bytes) — not shown`;
      const content = buf.toString('utf8');
      markAgentRead(root, p);
      return renderFileWindow(content, offset, limit);
    },
  },

  write_file: {
    description: 'Create a new file or fully overwrite an existing file. Arguments: {"path": string, "content": string}',
    confirm: true,
    kind: 'edit',
    preview: ({ path: p, content }, root) => {
      const full = safePath(root, p);
      const exists = fs.existsSync(full) && !fs.statSync(full).isDirectory();
      if (exists && unseenOverwrite(root, p, full)) return { path: p, error: `${p} exists and has not been read yet` };
      const before = exists ? fs.readFileSync(full, 'utf8') : '';
      return { path: p, before, after: content ?? '', created: !exists };
    },
    run: ({ path: p, content }, root) => {
      if (!p || typeof p !== 'string') return 'ERROR: path is required';
      const full = safePath(root, p);
      if (fs.existsSync(full) && fs.statSync(full).isDirectory()) return `ERROR: ${p} is a directory`;
      // Overwriting a file never looked at is how existing content gets
      // destroyed: the model writes what it imagines the file holds plus its
      // change. Reading first costs one call and makes the rewrite honest.
      if (unseenOverwrite(root, p, full)) {
        return `ERROR: ${p} already exists and you have not read it, so overwriting it would replace content you have not seen. Call read_file on it first, then either edit_file the part that needs to change or write_file the complete updated contents.`;
      }
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content ?? '');
      markAgentWrite(root, p);
      return `OK: wrote ${(content ?? '').length} chars to ${p}`;
    },
  },

  edit_file: {
    description:
      'Replace one exact, unique snippet of text in a file with new text. Use this for small/targeted changes. Set replace_all to true to replace EVERY occurrence instead (renaming a variable within a file). Arguments: {"path": string, "old_str": string, "new_str": string, "replace_all": boolean (optional)}',
    confirm: true,
    kind: 'edit',
    preview: ({ path: p, old_str, new_str, replace_all }, root) => {
      const full = safePath(root, p);
      if (!fs.existsSync(full)) return { path: p, error: `file not found: ${p}` };
      const before = fs.readFileSync(full, 'utf8');
      if (!old_str) return { path: p, error: 'old_str must not be empty' };
      const applied = replace_all ? applyAll(before, old_str, new_str) : applySnippet(before, old_str, new_str);
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
    run: ({ path: p, old_str, new_str, replace_all }, root) => {
      const full = safePath(root, p);
      if (!fs.existsSync(full)) return `ERROR: file not found: ${p}${suggestPaths(root, p)}`;
      const content = fs.readFileSync(full, 'utf8');
      if (!old_str) return 'ERROR: old_str must not be empty';
      if (old_str === new_str) return 'ERROR: old_str and new_str are identical — nothing to change';
      const applied = replace_all ? applyAll(content, old_str, new_str) : applySnippet(content, old_str, new_str);
      if (!applied.ok) {
        if (applied.reason === 'ambiguous') {
          return `ERROR: old_str matches ${applied.count} places in ${p}, so it is not clear which one to change.${ambiguousHint(content, old_str, p)}`;
        }
        return `ERROR: old_str not found in ${p}. ${NOT_FOUND_HINT}${closestRegion(content, old_str)}`;
      }
      fs.writeFileSync(full, applied.after);
      markAgentWrite(root, p);
      if (replace_all) return `OK: edited ${p} (replaced ${applied.count} occurrence${applied.count === 1 ? '' : 's'})`;
      return `OK: edited ${p}${applied.how === 'exact' ? '' : ` (matched ${applied.how} — your snippet's whitespace differed from the file)`}`;
    },
  },

  list_dir: {
    description: 'List files and folders at a path, non-recursive. Arguments: {"path": string}',
    confirm: false,
    readOnly: true,
    run: ({ path: p }, root) => {
      const full = safePath(root, p || '.');
      if (!fs.existsSync(full)) return `ERROR: path not found: ${p}${suggestPaths(root, p)}`;
      if (!fs.statSync(full).isDirectory()) return `ERROR: ${p} is a file, not a directory — use read_file`;
      const entries = fs.readdirSync(full, { withFileTypes: true });
      const lines = entries
        .filter((e) => !['node_modules', '.git', '.cortex'].includes(e.name))
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .sort();
      return lines.join('\n') || '(empty directory)';
    },
  },

  search_code: {
    description:
      'Search file contents across the workspace with a regular expression (e.g. "slugify|slug_ify" or "def \\w+_test"). Returns file:line:text, skipping .gitignore\'d files. Narrow it with glob (e.g. "*.ts", "src/**/*.py"), add context lines around each hit, or ignore case. Arguments: {"pattern": string, "path": string (optional, default "."), "glob": string (optional), "ignore_case": boolean (optional), "context": number (optional)}',
    confirm: false,
    readOnly: true,
    run: async ({ pattern, path: p, glob, ignore_case, context }, root, ctx) => {
      if (!pattern) return 'ERROR: pattern is required';
      const dir = safePath(root, p || '.');
      if (!fs.existsSync(dir)) return `ERROR: path not found: ${p}${suggestPaths(root, p)}`;
      let res = await rgSearch({ pattern, dir, root, glob, ignoreCase: !!ignore_case, context, signal: ctx?.signal });
      if (!res) {
        const flags = `-rnIE${ignore_case ? 'i' : ''}`;
        const extra = glob ? ` --include=${shq(path.basename(String(glob)))}` : '';
        res = await grep(flags + extra, pattern, dir, root, ctx?.signal);
      }
      const { ok, out, note } = res;
      if (!ok) return `ERROR: ${out}`;
      if (!out.trim()) return `${note || ''}(no matches)`;
      const lines = out.trimEnd().split('\n');
      const MAX_HITS = 250;
      const body = lines.length > MAX_HITS ? `${lines.slice(0, MAX_HITS).join('\n')}\n...[${lines.length - MAX_HITS} more lines — narrow the search with "path" or "glob"]` : lines.join('\n');
      return truncate(`${note || ''}${body}`, LIMITS.search);
    },
  },

  glob: {
    description:
      'Find files by name pattern, newest first — e.g. "**/*.test.ts", "src/**/index.{js,ts}", "*.md". Use this to locate files; use search_code to look inside them. Arguments: {"pattern": string, "path": string (optional, default ".")}',
    confirm: false,
    readOnly: true,
    run: async ({ pattern, path: p }, root, ctx) => {
      if (!pattern) return 'ERROR: pattern is required';
      const dir = safePath(root, p || '.');
      if (!fs.existsSync(dir)) return `ERROR: path not found: ${p}${suggestPaths(root, p)}`;
      // A bare name ("*.md", "config.json") means "anywhere", as in .gitignore.
      const pat = String(pattern).replace(/^\.\//, '');
      const anywhere = pat.includes('/') ? pat : `**/${pat}`;
      let files = null;
      const rg = findRg();
      if (rg) {
        const res = await runFile(rg, ['--files', '--hidden', ...RG_EXCLUDES, '-g', anywhere], { cwd: dir, signal: ctx?.signal });
        if (res.code === 0 || res.code === 1) files = res.stdout.split('\n').filter(Boolean).map((f) => f.replace(/^\.\//, ''));
      }
      if (!files) {
        const re = globToRegExp(anywhere);
        files = listFiles(dir, 20_000).map((f) => f.split(path.sep).join('/')).filter((f) => re.test(f));
      }
      if (!files.length) return `(no files match ${pattern})`;
      const relDir = path.relative(root, dir);
      const withTime = files.map((f) => {
        let mtime = 0;
        try {
          mtime = fs.statSync(path.join(dir, f)).mtimeMs;
        } catch {
          // vanished between listing and stat
        }
        return { f: relDir ? `${relDir.split(path.sep).join('/')}/${f}` : f, mtime };
      });
      withTime.sort((a, b) => b.mtime - a.mtime || a.f.localeCompare(b.f));
      const MAX = 200;
      const shown = withTime.slice(0, MAX).map((x) => x.f).join('\n');
      return truncate(withTime.length > MAX ? `${shown}\n...[${withTime.length - MAX} more — narrow the pattern]` : shown, LIMITS.search);
    },
  },

  run_command: {
    description: 'Run a shell command in the workspace root (e.g. tests, linters, git, build steps) and return stdout/stderr. Times out after 120s unless timeout_seconds says otherwise. Arguments: {"command": string, "timeout_seconds": number (optional)}',
    confirm: true,
    kind: 'command',
    run: async ({ command, timeout_seconds }, root, ctx) => {
      if (!command) return 'ERROR: command is required';
      const timeoutMs = Math.max(1, Math.min(MAX_COMMAND_TIMEOUT_S, Number(timeout_seconds) || COMMAND_TIMEOUT_MS / 1000)) * 1000;
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
      const res = await runShell(toRun, { cwd: root, signal: ctx?.signal, timeoutMs });
      const tag = sandboxed ? '[sandboxed]\n' : '';
      if (res.aborted) return `${tag}ERROR: command cancelled by the user`;
      if (res.timedOut) {
        return truncate(
          `${tag}ERROR: command timed out after ${timeoutMs / 1000}s and was killed. Pass a larger "timeout_seconds" if it legitimately needs longer. For servers and watchers use run_background instead.\nSTDOUT:\n${res.stdout}\nSTDERR:\n${res.stderr}`,
          LIMITS.command
        );
      }
      if (res.code === 0) {
        const out = res.stdout + (res.stderr.trim() ? `\nSTDERR:\n${res.stderr}` : '');
        return truncate(`${tag}${out.trim() ? out : '(command produced no output)'}`, LIMITS.command);
      }
      return truncate(`${tag}EXIT CODE: ${res.code}\nSTDOUT:\n${res.stdout}\nSTDERR:\n${res.stderr}`, LIMITS.command);
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
        toolCalling: ctx.delegateConfig.toolCalling,
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
      markAgentWrite(root, p);
      return `OK: deleted ${p}`;
    },
  },

  rename_file: {
    description: 'Rename or move a file to a new path within the workspace. Arguments: {"from": string, "to": string}',
    confirm: true,
    kind: 'edit',
    preview: ({ from, to }, root) => {
      const full = safePath(root, from);
      safePath(root, to);
      const before = fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : '';
      return { path: `${from} -> ${to}`, before, after: before, renameFrom: from, renameTo: to };
    },
    run: ({ from, to }, root) => {
      const fullFrom = safePath(root, from);
      const fullTo = safePath(root, to);
      if (!fs.existsSync(fullFrom)) return `ERROR: file not found: ${from}`;
      if (fs.existsSync(fullTo)) return `ERROR: ${to} already exists — refusing to overwrite it`;
      fs.mkdirSync(path.dirname(fullTo), { recursive: true });
      fs.renameSync(fullFrom, fullTo);
      markAgentWrite(root, to);
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
    // Same matching as run(), so the preview can never approve an edit the
    // run then rejects (or the reverse). Edits to one file apply in order.
    preview: ({ edits }, root) => {
      if (!Array.isArray(edits) || edits.length === 0) return { path: '(multi_edit)', error: 'edits must be a non-empty array' };
      const byPath = new Map();
      for (const e of edits) {
        const full = safePath(root, e.path);
        if (!byPath.has(e.path)) {
          if (!fs.existsSync(full)) return { path: e.path, error: `file not found: ${e.path}` };
          const before = fs.readFileSync(full, 'utf8');
          byPath.set(e.path, { path: e.path, before, after: before });
        }
        if (!e.old_str) return { path: e.path, error: `old_str empty for ${e.path}` };
        const entry = byPath.get(e.path);
        const applied = applySnippet(entry.after, e.old_str, e.new_str);
        if (!applied.ok) {
          return {
            path: e.path,
            error: applied.reason === 'ambiguous' ? `old_str matches ${applied.count} places in ${e.path}, needs more context` : `old_str not found in ${e.path}`,
          };
        }
        entry.after = applied.after;
      }
      const files = [...byPath.values()];
      const join = (side) => files.map((f) => `// ===== ${f.path} =====\n${f[side]}`).join('\n');
      return { path: `${files.length} file(s)`, before: join('before'), after: join('after'), files };
    },
    run: ({ edits }, root) => {
      if (!Array.isArray(edits) || edits.length === 0) return 'ERROR: edits must be a non-empty array';
      // Validate every patch applies cleanly before writing anything, so a
      // failure partway through never leaves some files edited and others not.
      // Several edits to the same file apply in order on top of each other.
      // Validating each against the original contents instead meant the
      // last one silently overwrote the earlier ones on write.
      const planned = new Map(); // path -> {full, after}
      for (const e of edits) {
        let full;
        try {
          full = safePath(root, e.path);
        } catch (err) {
          return `ERROR: ${err.message}`;
        }
        if (!planned.has(e.path)) {
          if (!fs.existsSync(full)) return `ERROR: file not found: ${e.path} (no files were changed)`;
          planned.set(e.path, { full, after: fs.readFileSync(full, 'utf8') });
        }
        if (!e.old_str) return `ERROR: old_str empty for ${e.path} (no files were changed)`;
        const entry = planned.get(e.path);
        const applied = applySnippet(entry.after, e.old_str, e.new_str);
        if (!applied.ok) {
          return applied.reason === 'ambiguous'
            ? `ERROR: old_str matches ${applied.count} places in ${e.path}, needs more context (no files were changed)`
            : `ERROR: old_str not found in ${e.path} (no files were changed). ${NOT_FOUND_HINT}`;
        }
        entry.after = applied.after;
      }
      for (const [rel, p] of planned) {
        fs.writeFileSync(p.full, p.after);
        markAgentWrite(root, rel);
      }
      return `OK: applied ${edits.length} edit(s) across ${planned.size} file(s): ${[...planned.keys()].join(', ')}`;
    },
  },

  git_status: {
    description:
      'Show the working tree status plus a summary of what changed (files added/modified/deleted, current branch). Use before committing, or to see what you have already changed this session. Arguments: {}',
    confirm: false,
    readOnly: true,
    run: (_args, root) => {
      try {
        const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
        const status = git(root, ['status', '--porcelain']);
        const stat = git(root, ['diff', '--stat', 'HEAD']);
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
    run: (/** @type {{path?: string, staged?: boolean}} */ { path: p, staged } = {}, root) => {
      try {
        const args = ['diff'];
        if (staged) args.push('--staged');
        if (p) args.push('--', safePath(root, p));
        return truncate(git(root, args) || '(no changes)');
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
          git(root, ['add', '--', ...paths.map((p) => safePath(root, p))]);
        } else {
          git(root, ['add', '-A']);
        }
        const staged = git(root, ['diff', '--staged', '--name-only']).trim();
        if (!staged) return 'ERROR: nothing staged to commit';
        // -F - keeps multi-line messages intact with no quoting involved.
        git(root, ['commit', '-F', '-'], message);
        const sha = git(root, ['rev-parse', '--short', 'HEAD']).trim();
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

  // Named and shaped to look nothing like file editing: as "update_tasks"
  // taking "a Markdown checklist", small models reached for it whenever a
  // request mentioned bullets or a .md file, and reported the edit as done.
  save_plan: {
    description:
      'Write down your own step-by-step plan for a long task (4+ steps) so it survives context trimming; it is shown back to you every turn. One step per line, prefix finished steps with "[x]". Changes no files. Arguments: {"steps": string}',
    confirm: false,
    run: ({ steps, markdown }, root) => {
      const text = typeof steps === 'string' ? steps : markdown;
      if (typeof text !== 'string' || !text.trim()) return 'ERROR: steps is required';
      // stored as a checklist so progress can be counted
      const checklist = text
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => (/^[-*]\s+\[[ xX]\]/.test(l) ? l : /^\[[xX]\]/.test(l) ? `- ${l}` : `- [ ] ${l.replace(/^[-*\d.)]+\s*/, '')}`))
        .join('\n');
      saveTasks(root, checklist);
      const { done, total } = taskProgress(root);
      return `OK: plan saved (${done}/${total} steps done). No files were changed.`;
    },
  },

  find_symbol: {
    description:
      'Find where a function/class/const/variable named `name` is DEFINED (not just mentioned) — greps for common declaration patterns (function/class/const/let/def/interface/type) across the workspace. Faster and more precise than search_code when you know the symbol name. Arguments: {"name": string, "path": string (optional, default ".")}',
    confirm: false,
    readOnly: true,
    run: async ({ name, path: p }, root, ctx) => {
      if (!name) return 'ERROR: name is required';
      // Ask the language server first: it knows which symbol is actually
      // meant, where grep only knows which lines contain the characters.
      const viaLsp = await lsp.findDefinitions(root, name).catch(() => null);
      if (viaLsp) return truncate(`(via language server)\n${viaLsp}`);
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = `(function|class|const|let|var|def|interface|type|struct|fn)\\s+${escaped}\\b|${escaped}\\s*[:=]\\s*(function|\\(|async)`;
      const dir = safePath(root, p || '.');
      const { ok, out } = (await rgSearch({ pattern, dir, root, signal: ctx?.signal })) || (await grep('-rnIE', pattern, dir, root, ctx?.signal));
      if (!ok) return `ERROR: ${out}`;
      return truncate(out || `(no definition found for "${name}")`, LIMITS.search);
    },
  },

  find_references: {
    description:
      'Find every place `name` is USED/referenced across the workspace (all mentions, not just the definition) — use after find_symbol to see callers/usages before changing or removing something. Arguments: {"name": string, "path": string (optional, default ".")}',
    confirm: false,
    readOnly: true,
    run: async ({ name, path: p }, root, ctx) => {
      if (!name) return 'ERROR: name is required';
      const viaLsp = await lsp.findReferences(root, name).catch(() => null);
      if (viaLsp) return truncate(`(via language server)\n${viaLsp}`);
      const dir = safePath(root, p || '.');
      const { ok, out } =
        (await rgSearch({ pattern: name, dir, root, literal: true, word: true, signal: ctx?.signal })) || (await grep('-rnIwF', name, dir, root, ctx?.signal));
      if (!ok) return `ERROR: ${out}`;
      const lines = out.trim().split('\n').filter(Boolean);
      return truncate(lines.length ? `${lines.length} reference(s):\n${lines.join('\n')}` : `(no references found for "${name}")`, LIMITS.search);
    },
  },
};

// Tools that cannot work in the current context stay out of the prompt:
// every listed tool costs prompt tokens on every step and is one more wrong
// choice a small model can make. Calling one anyway gets a clear error.
const AVAILABILITY = {
  notify_webhook: (_root, ctx) => !!ctx?.webhookUrl,
  delegate_task: (_root, ctx) => !!ctx?.delegateConfig && !((ctx.delegateDepth || 0) >= 1),
  diagnostics: () => lsp.available(),
  semantic_search: (root) => !!root && fs.existsSync(path.join(root, '.cortex', 'code-index.json')), // existence only — parsing it every step is costly
  read_background_output: () => backgroundProcs.size > 0,
  stop_background_process: () => backgroundProcs.size > 0,
};

function isToolAvailable(name, root, ctx) {
  if (!tools[name]) return false;
  const check = AVAILABILITY[name];
  try {
    return check ? !!check(root, ctx) : true;
  } catch {
    return false;
  }
}

// Grouped, most-used first, so the tools a task almost always needs are the
// first thing the model reads rather than scattered among niche ones.
/** @type {Array<[string, string[]]>} */
const TOOL_GROUPS = [
  ['Explore', ['read_file', 'list_dir', 'glob', 'search_code', 'find_symbol', 'find_references', 'semantic_search', 'diagnostics']],
  ['Change files', ['edit_file', 'write_file', 'multi_edit', 'delete_file', 'rename_file']],
  ['Run', ['run_command', 'run_background', 'read_background_output', 'stop_background_process']],
  ['Git', ['git_status', 'git_diff', 'git_commit']],
  ['Other', ['save_plan', 'remember', 'read_url', 'delegate_task', 'notify_webhook']],
];

/**
 * @param {{root?: string, ctx?: object}} [opts]
 */
function toolListForPrompt({ root, ctx } = {}) {
  const listed = new Set();
  const sections = [];
  for (const [title, names] of TOOL_GROUPS) {
    const lines = names
      .filter((n) => isToolAvailable(n, root, ctx))
      .map((n) => {
        listed.add(n);
        return `- ${n}: ${tools[n].description}`;
      });
    if (lines.length) sections.push(`${title}:\n${lines.join('\n')}`);
  }
  // MCP and anything else registered at runtime
  const extra = Object.keys(tools).filter((n) => !listed.has(n) && !TOOL_GROUPS.some(([, g]) => g.includes(n)));
  if (extra.length) sections.push(`Connected tools:\n${extra.map((n) => `- ${n}: ${tools[n].description}`).join('\n')}`);
  return sections.join('\n\n');
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

/**
 * The available tools in Ollama's native `tools` format, same order and
 * same availability rules as the text-protocol list.
 * @param {{root?: string, ctx?: object}} [opts]
 */
function apiToolsFor({ root, ctx } = {}) {
  const ordered = [...TOOL_GROUPS.flatMap(([, names]) => names), ...Object.keys(tools).filter((n) => !TOOL_GROUPS.some(([, g]) => g.includes(n)))];
  return [...new Set(ordered)].filter((n) => isToolAvailable(n, root, ctx)).map((n) => apiToolFor(n, tools[n]));
}

/** Kills every process started with run_background — called when a front-end exits. */
function stopAllBackground() {
  for (const entry of backgroundProcs.values()) {
    if (entry.exitCode !== null) continue;
    try {
      entry.proc.kill();
    } catch {
      // already gone
    }
  }
}

module.exports = { stopAllBackground, globToRegExp, findRg, tools, listFiles, toolListForPrompt, apiToolsFor, isToolAvailable, safePath, registerExternalTool, unregisterExternalTool, runShell };
