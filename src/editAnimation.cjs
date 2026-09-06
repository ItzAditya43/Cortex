// Builds the "watch it edit" sweep for a proposed file change.
//
// The obvious implementation — stream the model's tokens straight into the
// real file — is the wrong one: a half-written file is on disk if anything
// fails, the language server lints garbage as it appears, and undo history
// fills with keystrokes nobody typed. Cline avoids all of that by animating
// over *virtual* documents and writing to disk once, after the fact. This
// does the same.
//
// The pacing is diff-aware rather than uniform, which is what makes it
// readable: zip through untouched lines so they register as motion rather
// than a teleport, then slow down through each changed run so the eye lands
// on what actually differs. Uniform scrolling reads as noise; this reads as
// "here, and here, and here".

'use strict';

const ZIP_FRAME_MS = 16;
const ZIP_LINES_PER_FRAME = 8;
const ZIP_MAX_FRAMES_PER_SPAN = 18;

const TYPE_FRAME_MS = 45;
const TYPE_MIN_RUN_MS = 350;
const TYPE_MAX_FRAMES_PER_RUN = 35;

// Without global ceilings, a file of many small alternating hunks can
// schedule minutes of animation and retain a full copy of the document per
// frame. Exceeding any of these means "just show the result".
const MAX_FRAMES = 200;
const MAX_DURATION_MS = 5_000;
const MAX_DIFF_LINES = 3_000; // beyond this the O(n*m) alignment isn't worth it

/**
 * Marks which lines of `after` are unchanged from `before`, via a longest
 * common subsequence over lines.
 * @returns {boolean[]} one flag per line of `after`; true = changed
 */
function changedLineFlags(beforeLines, afterLines) {
  const n = beforeLines.length;
  const m = afterLines.length;
  if (n * m > MAX_DIFF_LINES * MAX_DIFF_LINES) return afterLines.map(() => true);

  // Standard LCS table over lines.
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = beforeLines[i] === afterLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const changed = new Array(m).fill(true);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (beforeLines[i] === afterLines[j]) {
      changed[j] = false; // this line survived unchanged
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return changed;
}

/** Groups consecutive lines into runs of the same changed/unchanged state. */
function runsOf(flags) {
  const runs = [];
  let start = 0;
  for (let i = 1; i <= flags.length; i++) {
    if (i === flags.length || flags[i] !== flags[start]) {
      runs.push({ changed: flags[start], start, end: i }); // end exclusive
      start = i;
    }
  }
  return runs;
}

/**
 * @param {string} before  current file content ('' for a new file)
 * @param {string} after   proposed content
 * @returns {{frames: Array<{content: string, activeLine: number, delayMs: number, zip: boolean}>,
 *            firstChangedLine: number, totalMs: number}}
 *   A single frame means "render the result immediately" — nothing worth
 *   animating, or the animation would have blown its budget.
 */
function buildEditAnimation(before, after) {
  const beforeLines = String(before ?? '').split('\n');
  const afterLines = String(after ?? '').split('\n');
  const finalFrame = { content: after, activeLine: 0, delayMs: 0, zip: false };

  if (before === after) return { frames: [finalFrame], firstChangedLine: 0, totalMs: 0 };

  const flags = changedLineFlags(beforeLines, afterLines);
  const firstChangedLine = Math.max(0, flags.indexOf(true));

  // Each frame shows the new content down to the sweep line and the original
  // content below it — the "being rewritten top-down" effect.
  const frameAt = (line) => afterLines.slice(0, line).concat(beforeLines.slice(Math.min(line, beforeLines.length))).join('\n');

  const frames = [];
  let totalMs = 0;
  let blewBudget = false;

  const push = (line, delayMs, zip) => {
    if (frames.length >= MAX_FRAMES || totalMs >= MAX_DURATION_MS) {
      blewBudget = true;
      return false;
    }
    frames.push({ content: frameAt(line), activeLine: Math.max(0, line - 1), delayMs, zip });
    totalMs += delayMs;
    return true;
  };

  outer: for (const run of runsOf(flags)) {
    if (run.changed) {
      const lines = run.end - run.start;
      const steps = Math.min(lines, TYPE_MAX_FRAMES_PER_RUN);
      // A one-line change still needs to be visible, so short runs get a
      // longer dwell rather than a single 45ms flash.
      const perStep = Math.max(TYPE_FRAME_MS, Math.round(TYPE_MIN_RUN_MS / Math.max(1, steps)));
      for (let s = 1; s <= steps; s++) {
        const line = run.start + Math.round((s / steps) * lines);
        if (!push(line, perStep, false)) break outer;
      }
    } else {
      const lines = run.end - run.start;
      const steps = Math.min(Math.ceil(lines / ZIP_LINES_PER_FRAME), ZIP_MAX_FRAMES_PER_SPAN);
      for (let s = 1; s <= steps; s++) {
        const line = run.start + Math.round((s / steps) * lines);
        if (!push(line, ZIP_FRAME_MS, true)) break outer;
      }
    }
  }

  // The sweep must always land on exactly the proposed content — an
  // animation that ends on an approximation would show the user something
  // that is not what gets written.
  if (blewBudget || frames.length === 0) return { frames: [finalFrame], firstChangedLine, totalMs: 0 };
  frames[frames.length - 1] = { ...frames[frames.length - 1], content: after };
  return { frames, firstChangedLine, totalMs };
}

module.exports = { buildEditAnimation, changedLineFlags, MAX_FRAMES, MAX_DURATION_MS };
