// Terminal rendering for the CLI: colours, a line-streamed Markdown
// renderer, diffs, tool-call summaries and a spinner. No dependencies, and
// everything degrades to plain text when stdout is not a terminal or
// NO_COLOR is set, so piped output stays clean.

'use strict';

const path = require('path');
const { buildDiffView } = require('./lineDiff.cjs');

const useColor = () => !!process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== 'dumb';

const CODES = { bold: 1, dim: 2, italic: 3, underline: 4, red: 31, green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36, gray: 90 };

/** @type {Record<string, (s: string) => string>} */
const c = {};
for (const [name, code] of Object.entries(CODES)) {
  c[name] = (s) => (useColor() ? `\x1b[${code}m${s}\x1b[0m` : String(s));
}

const width = () => Math.max(40, Math.min(process.stdout.columns || 100, 160));

function inline(s) {
  if (!useColor()) return s;
  return s
    .replace(/`([^`\n]+)`/g, (_, code) => c.cyan(code))
    .replace(/\*\*([^*\n]+)\*\*/g, (_, t) => c.bold(t))
    .replace(/(^|[\s(])\*([^*\s][^*\n]*)\*(?=[\s).,;:!?]|$)/g, (_, pre, t) => `${pre}${c.italic(t)}`);
}

/**
 * Renders streamed Markdown a line at a time. Text-protocol tool calls
 * ("TOOL_CALL: {...}") are swallowed — the tool line printed by the caller
 * stands in for them.
 * @param {(s: string) => void} write
 */
function makeMarkdownStream(write) {
  let buf = '';
  let inCode = false;
  let hidden = false;
  let printedAny = false;

  const renderLine = (line) => {
    const fence = line.match(/^\s*```(.*)$/);
    if (fence) {
      inCode = !inCode;
      const lang = inCode ? fence[1].trim() : '';
      return c.gray(inCode ? `  ┌─${lang ? ` ${lang} ` : ''}` : '  └─');
    }
    if (inCode) return `${c.gray('  │ ')}${line}`;
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) return c.bold(h[1].length <= 2 ? c.underline(h[2]) : h[2]);
    const bullet = line.match(/^(\s*)[-*]\s+(.*)$/);
    if (bullet) return `${bullet[1]}${c.cyan('•')} ${inline(bullet[2])}`;
    if (/^\s*>/.test(line)) return c.gray(line);
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) return c.gray('─'.repeat(Math.min(40, width() - 2)));
    return inline(line);
  };

  const emit = (line) => {
    if (!printedAny && !line.trim()) return; // no leading blank lines
    printedAny = true;
    write(`${renderLine(line)}\n`);
  };

  return {
    token(t) {
      if (hidden) return;
      buf += t;
      const marker = buf.indexOf('TOOL_CALL:');
      if (marker !== -1) {
        const before = buf.slice(0, marker);
        for (const line of before.split('\n')) if (line.trim()) emit(line);
        buf = '';
        hidden = true;
        return;
      }
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        emit(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    },
    /** End of one model response. Returns true if any text was shown. */
    end() {
      if (!hidden && buf.trim()) emit(buf);
      if (inCode) write(`${c.gray('  └─')}\n`);
      const shown = printedAny;
      buf = '';
      inCode = false;
      hidden = false;
      printedAny = false;
      return shown;
    },
  };
}

/** Renders a whole Markdown string at once. */
function renderMarkdown(text) {
  let out = '';
  const s = makeMarkdownStream((x) => (out += x));
  s.token(String(text || ''));
  s.end();
  return out;
}

/**
 * A coloured unified-style diff.
 * @param {string} before
 * @param {string} after
 * @param {{maxLines?: number, indent?: string}} [opts]
 * @returns {{text: string, add: number, del: number}}
 */
function renderDiff(before, after, { maxLines = 60, indent = '    ' } = {}) {
  const view = buildDiffView(before || '', after || '', { context: 2, maxLines });
  const rows = [];
  const w = width() - indent.length - 8;
  view.hunks.forEach((h, i) => {
    if (i > 0) rows.push(`${indent}${c.gray('  ⋯')}`);
    let o = h.oldStart;
    let n = h.newStart;
    for (const l of h.lines) {
      const num = String(l.t === '+' ? n : o).padStart(4);
      const text = l.s.length > w ? `${l.s.slice(0, w - 1)}…` : l.s;
      if (l.t === '+') rows.push(`${indent}${c.green(`${num} + ${text}`)}`);
      else if (l.t === '-') rows.push(`${indent}${c.red(`${num} - ${text}`)}`);
      else rows.push(`${indent}${c.gray(`${num}   ${text}`)}`);
      if (l.t !== '+') o++;
      if (l.t !== '-') n++;
    }
  });
  if (view.truncated) rows.push(`${indent}${c.gray('  … diff truncated')}`);
  return { text: rows.join('\n'), add: view.add, del: view.del };
}

const short = (s, n = 70) => {
  const one = String(s ?? '').replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

const LABELS = {
  read_file: ['Read', (a) => (Array.isArray(a.path) ? a.path.join(', ') : `${a.path ?? ''}${a.offset ? `:${a.offset}` : ''}`)],
  write_file: ['Write', (a) => a.path],
  edit_file: ['Edit', (a) => a.path],
  multi_edit: ['Edit', (a) => [...new Set((a.edits || []).map((e) => e.path))].join(', ')],
  delete_file: ['Delete', (a) => a.path],
  rename_file: ['Rename', (a) => `${a.from} → ${a.to}`],
  list_dir: ['List', (a) => a.path || '.'],
  glob: ['Glob', (a) => `${a.pattern}${a.path ? ` in ${a.path}` : ''}`],
  search_code: ['Search', (a) => `${a.pattern}${a.glob ? ` (${a.glob})` : ''}${a.path && a.path !== '.' ? ` in ${a.path}` : ''}`],
  find_symbol: ['Definition', (a) => a.name],
  find_references: ['References', (a) => a.name],
  semantic_search: ['Semantic search', (a) => a.query],
  run_command: ['Bash', (a) => a.command],
  run_background: ['Background', (a) => a.command],
  read_background_output: ['Output', (a) => a.id],
  stop_background_process: ['Stop', (a) => a.id],
  git_status: ['Git status', () => ''],
  git_diff: ['Git diff', (a) => a.path || ''],
  git_commit: ['Git commit', (a) => a.message],
  save_plan: ['Plan', () => ''],
  remember: ['Remember', (a) => a.note],
  read_url: ['Fetch', (a) => a.url],
  delegate_task: ['Sub-agent', (a) => a.task],
  notify_webhook: ['Notify', (a) => a.message],
};

/** "Read(src/a.js)" — the one-line name of a tool call. */
function toolTitle(name, args) {
  const [label, describe] = LABELS[name] || [name, (a) => (Object.keys(a || {}).length ? JSON.stringify(a) : '')];
  let detail = '';
  try {
    detail = describe(args || {}) || '';
  } catch {
    // odd arguments — the label alone is still useful
  }
  return { label, detail: short(detail, Math.max(30, width() - label.length - 10)) };
}

/** A few dim lines summarising a tool result. */
function summarizeResult(name, result, isError) {
  const text = String(result ?? '').trimEnd();
  const lines = text.split('\n');
  const max = isError ? 8 : name === 'run_command' || name === 'save_plan' ? 6 : 0;
  if (!isError) {
    if (name === 'read_file') return [`${lines.length} line${lines.length === 1 ? '' : 's'}`];
    if (['search_code', 'find_references', 'find_symbol', 'glob', 'list_dir', 'semantic_search'].includes(name)) {
      if (/^\(no /.test(text)) return [text];
      return [`${lines.length} result${lines.length === 1 ? '' : 's'}`];
    }
    if (max === 0) return [short(lines[0], width() - 8)];
  }
  // Command output puts what matters (the failure, the totals) at the end
  // of stdout; stderr is usually progress noise unless stdout is empty.
  if (name === 'run_command' && !/^ERROR/.test(text)) {
    const exit = text.match(/^(?:\[sandboxed\]\n)?EXIT CODE: (\d+)/);
    const body = text.replace(/^(?:\[sandboxed\]\n)?EXIT CODE: \d+\n/, '').replace(/^STDOUT:\n/, '');
    const [stdout, stderr = ''] = body.split(/\n?STDERR:\n/);
    const useful = (stdout.trim() ? stdout : stderr).split('\n').filter((l) => l.trim());
    const tail = useful.slice(-5).map((l) => short(l, width() - 8));
    const head = [];
    if (exit) head.push(`exit code ${exit[1]}`);
    if (useful.length > tail.length) head.push(`… ${useful.length - tail.length} earlier line${useful.length - tail.length === 1 ? '' : 's'}`);
    return [...head, ...tail];
  }
  if (lines.length <= max) return lines.map((l) => short(l, width() - 8));
  const shown = lines.slice(0, max).map((l) => short(l, width() - 8));
  shown.push(`… +${lines.length - max} line${lines.length - max === 1 ? '' : 's'}`);
  return shown;
}

/** Spinner on its own line, erased in place. No-op when stdout is not a TTY. */
function makeSpinner() {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let timer = null;
  let label = '';
  let startedAt = 0;
  let i = 0;
  const draw = () => {
    const secs = Math.round((Date.now() - startedAt) / 1000);
    process.stdout.write(`\r\x1b[2K${c.cyan(frames[i++ % frames.length])} ${c.gray(`${label}… ${secs}s · esc to interrupt`)}`);
  };
  return {
    start(text) {
      label = text;
      if (!process.stdout.isTTY) return;
      if (timer) return;
      startedAt = Date.now();
      draw();
      timer = setInterval(draw, 100);
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
      process.stdout.write('\r\x1b[2K');
    },
    get active() {
      return !!timer;
    },
  };
}

const fmtTokens = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));
const tildify = (p) => {
  const home = require('os').homedir();
  return p === home ? '~' : p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p;
};

module.exports = { c, useColor, width, makeMarkdownStream, renderMarkdown, renderDiff, toolTitle, summarizeResult, makeSpinner, short, fmtTokens, tildify };
