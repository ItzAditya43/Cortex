// Line-level diff for showing a file change in the chat.
//
// The chat used to pair line i of the old file with line i of the new one.
// One line inserted near the top shifted everything below it, so a one-line
// change rendered as the whole file deleted and re-added. This aligns the two
// versions properly (longest common subsequence over lines) and groups the
// result into hunks with a few lines of context, the way any diff tool does.
//
// Computed in the extension host and sent to the webview as hunks, so the
// panel receives the changed region rather than two full copies of the file.

'use strict';

// Common prefix/suffix are trimmed first, so the quadratic table only ever
// covers the region that actually changed. Beyond this many cells the middle
// is shown as a straight replacement rather than aligned.
const MAX_TABLE_CELLS = 4_000_000;

/**
 * @param {string[]} a
 * @param {string[]} b
 * @returns {Array<{t: ' '|'-'|'+', s: string}>}
 */
function diffLineArrays(a, b) {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  /** @type {Array<{t: ' '|'-'|'+', s: string}>} */
  const ops = [];
  for (let i = 0; i < start; i++) ops.push({ t: ' ', s: a[i] });

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const n = midA.length;
  const m = midB.length;
  if (n * m > MAX_TABLE_CELLS) {
    for (const s of midA) ops.push({ t: '-', s });
    for (const s of midB) ops.push({ t: '+', s });
  } else {
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = midA[i] === midB[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        ops.push({ t: ' ', s: midA[i] });
        i++;
        j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        ops.push({ t: '-', s: midA[i++] });
      } else {
        ops.push({ t: '+', s: midB[j++] });
      }
    }
    while (i < n) ops.push({ t: '-', s: midA[i++] });
    while (j < m) ops.push({ t: '+', s: midB[j++] });
  }

  for (let i = endA; i < a.length; i++) ops.push({ t: ' ', s: a[i] });
  return ops;
}

function splitLines(text) {
  const s = String(text ?? '');
  if (s === '') return [];
  const lines = s.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop(); // a trailing newline is not an extra empty line
  return lines;
}

/**
 * @param {string} before
 * @param {string} after
 * @param {{context?: number, maxLines?: number}} [opts]
 * @returns {{hunks: Array<{oldStart: number, newStart: number, lines: Array<{t: string, s: string}>}>,
 *            add: number, del: number, truncated: boolean}}
 */
function buildDiffView(before, after, { context = 3, maxLines = 400 } = {}) {
  const ops = diffLineArrays(splitLines(before), splitLines(after));
  let add = 0;
  let del = 0;
  for (const op of ops) {
    if (op.t === '+') add++;
    else if (op.t === '-') del++;
  }

  // Mark every op within `context` lines of a change as visible.
  const keep = new Array(ops.length).fill(false);
  for (let k = 0; k < ops.length; k++) {
    if (ops[k].t === ' ') continue;
    for (let c = Math.max(0, k - context); c <= Math.min(ops.length - 1, k + context); c++) keep[c] = true;
  }

  const hunks = [];
  let current = null;
  let oldLine = 1;
  let newLine = 1;
  let shown = 0;
  let truncated = false;
  for (let k = 0; k < ops.length; k++) {
    const op = ops[k];
    if (keep[k]) {
      if (shown >= maxLines) {
        truncated = true;
        break;
      }
      if (!current) {
        current = { oldStart: oldLine, newStart: newLine, lines: [] };
        hunks.push(current);
      }
      current.lines.push(op);
      shown++;
    } else {
      current = null;
    }
    if (op.t !== '+') oldLine++;
    if (op.t !== '-') newLine++;
  }
  return { hunks, add, del, truncated };
}

module.exports = { diffLineArrays, buildDiffView, splitLines };
