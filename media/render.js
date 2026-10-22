// Pure rendering helpers for the chat webview: markdown, tool-call hiding
// while a reply streams, one-line tool argument summaries, and diff hunks.
//
// Kept free of DOM access and webview state so the logic can be exercised by
// the unit tests (test/render.test.cjs loads this file in a vm sandbox) —
// main.js is the part that touches the document.
(function (root) {
  'use strict';

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------- markdown ----------
  // Fenced code, inline code, bold/italic/strike, headings, lists, quotes,
  // tables, rules, links. HTML in the text is always escaped first, so
  // nothing a model writes can inject markup.

  function renderInline(text) {
    // Inline code is pulled out first so emphasis markers inside it
    // (`a**b**`, `*ptr`) are left alone.
    const codes = [];
    let s = String(text).replace(/`([^`]+)`/g, (_m, code) => {
      codes.push(code);
      return `\u0000${codes.length - 1}\u0000`;
    });
    s = escapeHtml(s);
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>');
    s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="#" data-href="$2" class="md-link">$1</a>');
    s = s.replace(/\u0000(\d+)\u0000/g, (_m, i) => `<code>${escapeHtml(codes[Number(i)])}</code>`);
    return s;
  }

  function splitTableRow(line) {
    return line
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((c) => c.trim());
  }

  function renderMarkdown(text) {
    const lines = String(text || '').split('\n');
    let html = '';
    let i = 0;
    let inList = null; // 'ul' | 'ol'

    function closeList() {
      if (inList) {
        html += inList === 'ul' ? '</ul>' : '</ol>';
        inList = null;
      }
    }

    while (i < lines.length) {
      const line = lines[i];

      const fence = line.match(/^\s*```\s*([^\s`]*)/);
      if (fence) {
        closeList();
        const lang = fence[1] || '';
        const codeLines = [];
        i++;
        while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
          codeLines.push(lines[i]);
          i++;
        }
        i++; // skip closing fence (or run off the end while streaming)
        html +=
          `<div class="code-wrap"><div class="code-head"><span class="code-lang">${escapeHtml(lang)}</span>` +
          `<button class="copy-btn" title="Copy code">Copy</button></div>` +
          `<pre class="md-code"><code>${escapeHtml(codeLines.join('\n'))}</code></pre></div>`;
        continue;
      }

      // table: a header row followed by a |---|---| separator
      if (/\|/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
        closeList();
        const head = splitTableRow(line);
        i += 2;
        let body = '';
        while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim()) {
          body += `<tr>${splitTableRow(lines[i]).map((c) => `<td>${renderInline(c)}</td>`).join('')}</tr>`;
          i++;
        }
        html += `<table class="md-table"><thead><tr>${head.map((c) => `<th>${renderInline(c)}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table>`;
        continue;
      }

      const heading = line.match(/^(#{1,6})\s+(.*)$/);
      if (heading) {
        closeList();
        const level = Math.min(heading[1].length, 4);
        html += `<h${level} class="md-h">${renderInline(heading[2])}</h${level}>`;
        i++;
        continue;
      }

      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
        closeList();
        html += '<hr class="md-hr">';
        i++;
        continue;
      }

      const quote = line.match(/^\s*>\s?(.*)$/);
      if (quote) {
        closeList();
        const quoted = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) {
          quoted.push(lines[i].replace(/^\s*>\s?/, ''));
          i++;
        }
        html += `<blockquote class="md-quote">${renderMarkdown(quoted.join('\n'))}</blockquote>`;
        continue;
      }

      const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
      if (bullet) {
        if (inList !== 'ul') {
          closeList();
          html += '<ul class="md-list">';
          inList = 'ul';
        }
        const task = bullet[1].match(/^\[( |x|X)\]\s+(.*)$/);
        html += task
          ? `<li class="md-task">${task[1] === ' ' ? '☐' : '☑'} ${renderInline(task[2])}</li>`
          : `<li>${renderInline(bullet[1])}</li>`;
        i++;
        continue;
      }

      const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (numbered) {
        if (inList !== 'ol') {
          closeList();
          html += '<ol class="md-list">';
          inList = 'ol';
        }
        html += `<li>${renderInline(numbered[1])}</li>`;
        i++;
        continue;
      }

      closeList();
      if (line.trim() === '') {
        html += '<div class="md-br"></div>';
      } else {
        html += `<p class="md-p">${renderInline(line)}</p>`;
      }
      i++;
    }
    closeList();
    return html;
  }

  // ---------- streaming replies ----------
  const MARKER = 'TOOL_CALL:';

  /**
   * Splits a reply that is still streaming into the prose to show and
   * whether a tool call has started. The raw `TOOL_CALL: {...}` line —
   * often an entire file's contents as escaped JSON — is never shown; the
   * tool card replaces it once the call is parsed.
   * @param {string} buf
   * @returns {{text: string, toolPending: boolean, toolName: string|null}}
   */
  function splitStreamingReply(buf) {
    const s = String(buf || '');
    // A model offered native tools sometimes writes the call as a JSON
    // object instead; the host recovers it, and it should not flash by.
    const json = s.match(/^\s*(?:```(?:json)?\s*)?[[{]\s*(?:\{\s*)?"name"\s*:\s*"?([\w.\-]*)/);
    if (json) return { text: '', toolPending: true, toolName: json[1] || null };
    if (/^\s*(?:```(?:json)?\s*)?[[{]?\s*$/.test(s) && s.trim()) return { text: '', toolPending: false, toolName: null };
    const idx = s.indexOf(MARKER);
    if (idx !== -1) {
      const m = s.slice(idx).match(/"name"\s*:\s*"([\w.\-]+)"/);
      return { text: stripDanglingFence(s.slice(0, idx)), toolPending: true, toolName: m ? m[1] : null };
    }
    // A marker arriving across several tokens ("TOOL_", "CALL:") would
    // otherwise flash on screen before the rest of it lands.
    for (let k = Math.min(MARKER.length - 1, s.length); k > 0; k--) {
      if (s.endsWith(MARKER.slice(0, k))) return { text: s.slice(0, -k), toolPending: false, toolName: null };
    }
    return { text: s, toolPending: false, toolName: null };
  }

  // Models often wrap the tool call in a ```json fence; the opener is left
  // behind once the call itself is cut off.
  function stripDanglingFence(text) {
    return text.replace(/```[\w-]*\s*$/, '').trimEnd();
  }

  // ---------- tool cards ----------
  function clip(s, n) {
    s = String(s ?? '').replace(/\s+/g, ' ').trim();
    return s.length > n ? `${s.slice(0, n - 1)}…` : s;
  }

  /**
   * One readable line describing a tool call — the card header used to dump
   * the raw JSON arguments, which for write_file is the whole file.
   */
  function summarizeArgs(name, args) {
    const a = args || {};
    if (name === 'multi_edit' && Array.isArray(a.edits)) {
      const files = [...new Set(a.edits.map((e) => e && e.path).filter(Boolean))];
      return `${a.edits.length} edit${a.edits.length === 1 ? '' : 's'} · ${clip(files.join(', '), 80)}`;
    }
    if (name === 'rename_file' && a.from) return `${a.from} → ${a.to}`;
    if (Array.isArray(a.path)) return clip(a.path.join(', '), 90);
    if (typeof a.command === 'string') return `$ ${clip(a.command, 90)}`;
    if (typeof a.pattern === 'string') return `"${clip(a.pattern, 50)}"${a.path ? ` in ${a.path}` : ''}`;
    if (typeof a.path === 'string' && a.path) return a.path;
    for (const key of ['query', 'name', 'url', 'id', 'message', 'task', 'note']) {
      if (typeof a[key] === 'string' && a[key]) return clip(a[key], 90);
    }
    if (name === 'save_plan' && typeof a.steps === 'string') {
      const lines = a.steps.split('\n').filter((l) => l.trim());
      const done = lines.filter((l) => /\[[xX]\]/.test(l)).length;
      return `${done}/${lines.length} steps done`;
    }
    const json = JSON.stringify(a);
    return json === '{}' ? '' : clip(json, 90);
  }

  // ---------- diffs ----------
  /**
   * @param {{files: Array<{path: string, hunks: Array<{oldStart: number, newStart: number, lines: Array<{t: string, s: string}>}>, truncated?: boolean, created?: boolean}>,
   *          add: number, del: number, renamed?: string|null}} view
   */
  function diffViewHtml(view) {
    if (!view) return '';
    if (view.renamed && !view.add && !view.del) return `<div class="diff-note">renamed ${escapeHtml(view.renamed)}</div>`;
    const multi = view.files.length > 1;
    let html = '';
    for (const f of view.files) {
      if (multi) html += `<div class="diff-file">${escapeHtml(f.path)}${f.created ? ' <span class="diff-new">new</span>' : ''}</div>`;
      if (!f.hunks.length) {
        html += '<div class="diff-note">(no changes)</div>';
        continue;
      }
      f.hunks.forEach((h, idx) => {
        if (idx > 0 || h.oldStart > 1) html += `<div class="diff-gap">⋯ line ${h.newStart}</div>`;
        for (const l of h.lines) {
          const cls = l.t === '+' ? 'diff-add' : l.t === '-' ? 'diff-del' : 'diff-ctx';
          html += `<div class="diff-line ${cls}"><span class="diff-sign">${l.t === ' ' ? '' : l.t}</span>${escapeHtml(l.s) || ' '}</div>`;
        }
      });
      if (f.truncated) html += '<div class="diff-note">… diff truncated — open the diff editor for the rest</div>';
    }
    return html;
  }

  // ---------- @-mentions ----------
  /**
   * Ranks workspace files for the @-mention menu: the file name matching is
   * worth more than the directory, a prefix more than a substring, and a
   * scattered subsequence ("chvp" -> chatViewProvider) still counts.
   * @param {string} query
   * @param {string[]} files workspace-relative paths
   * @returns {string[]}
   */
  function rankFiles(query, files, limit = 12) {
    const q = String(query || '').toLowerCase();
    if (!q) return files.slice().sort((a, b) => a.split('/').length - b.split('/').length || a.length - b.length).slice(0, limit);
    const scored = [];
    for (const f of files) {
      const lower = f.toLowerCase();
      const base = lower.slice(lower.lastIndexOf('/') + 1);
      let score = 0;
      if (base === q) score = 100;
      else if (base.startsWith(q)) score = 80;
      else if (base.includes(q)) score = 60;
      else if (lower.includes(q)) score = 40;
      else {
        let i = 0;
        for (const ch of base) if (ch === q[i]) i++;
        if (i === q.length) score = 20;
        else {
          i = 0;
          for (const ch of lower) if (ch === q[i]) i++;
          if (i === q.length) score = 10;
        }
      }
      if (score) scored.push({ f, score: score - f.length / 1000 });
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, limit).map((x) => x.f);
  }

  /**
   * The @-mention being typed at the cursor, if any.
   * @returns {{start: number, query: string}|null}
   */
  function mentionAt(text, cursor) {
    const before = String(text).slice(0, cursor);
    const m = before.match(/(^|\s)@([^\s@]*)$/);
    return m ? { start: before.length - m[2].length - 1, query: m[2] } : null;
  }

  root.CortexRender = {
    rankFiles,
    mentionAt,
    escapeHtml,
    renderInline,
    renderMarkdown,
    splitStreamingReply,
    summarizeArgs,
    diffViewHtml,
  };
})(typeof window !== 'undefined' ? window : globalThis);
