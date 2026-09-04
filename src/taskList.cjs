// Durable task checklist (Cline calls its version a "focus chain").
//
// A long task outlives its own transcript: context gets trimmed, /compact
// replaces the history with a summary, and the agent loses track of which
// sub-steps it already finished. Because this list lives on disk and is
// re-injected into the system prompt every turn, it survives all of that —
// it's the one piece of state that persists across compaction.
//
// Stored as plain Markdown so it's readable and hand-editable; the user can
// tick or add items themselves and the agent sees it on the next turn.

'use strict';

const fs = require('fs');
const path = require('path');

const FILE = path.join('.cortex', 'TASKS.md');

function taskFile(root) {
  const full = path.join(root, FILE);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  return full;
}

/** @returns {string} the raw markdown checklist, or '' if none exists */
function loadTasks(root) {
  if (!root) return '';
  const f = path.join(root, FILE);
  if (!fs.existsSync(f)) return '';
  try {
    return fs.readFileSync(f, 'utf8').trim();
  } catch {
    return '';
  }
}

function saveTasks(root, markdown) {
  if (!root) return;
  try {
    fs.writeFileSync(taskFile(root), (markdown || '').trim() + '\n');
  } catch {
    // best-effort — never fail a turn over the checklist
  }
}

function clearTasks(root) {
  if (!root) return;
  try {
    const f = path.join(root, FILE);
    if (fs.existsSync(f)) fs.unlinkSync(f);
  } catch {
    // best-effort
  }
}

/** @returns {{done: number, total: number}} progress counts parsed from the checklist */
function taskProgress(root) {
  const md = loadTasks(root);
  if (!md) return { done: 0, total: 0 };
  const items = md.match(/^\s*[-*]\s*\[[ xX]\]/gm) || [];
  const done = items.filter((i) => /\[[xX]\]/.test(i)).length;
  return { done, total: items.length };
}

module.exports = { loadTasks, saveTasks, clearTasks, taskProgress };
