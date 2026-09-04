// Stale-context detection.
//
// The agent reads a file, then reasons about it for several steps. If you
// edit that file in the editor meanwhile, every later edit_file is built on
// content that no longer exists — the snippet either fails to match, or
// (worse) matches something you didn't intend. Cline hit this hard enough
// to build a FileContextTracker for it; this is the same idea.
//
// The crux is distinguishing the agent's OWN writes from yours: without
// that, every tool write looks like an external change and the agent spends
// its turn re-reading files it just wrote. Writes made through the tools
// stamp themselves here first, so only genuinely external edits are flagged.

'use strict';

const fs = require('fs');
const path = require('path');

// relative path -> { readAt, mtimeAtRead, agentWroteAt }
const tracked = new Map();

function mtimeOf(root, relPath) {
  try {
    return fs.statSync(path.resolve(root, relPath)).mtimeMs;
  } catch {
    return null;
  }
}

/** Records that the agent read this file, snapshotting the mtime it saw. */
function markAgentRead(root, relPath) {
  if (!root || !relPath) return;
  const entry = tracked.get(relPath) || {};
  entry.readAt = Date.now();
  entry.mtimeAtRead = mtimeOf(root, relPath);
  tracked.set(relPath, entry);
}

/**
 * Records that the agent itself wrote this file, so the resulting mtime bump
 * is not later mistaken for an edit by the user.
 */
function markAgentWrite(root, relPath) {
  if (!root || !relPath) return;
  const entry = tracked.get(relPath) || {};
  entry.agentWroteAt = Date.now();
  entry.mtimeAtRead = mtimeOf(root, relPath);
  tracked.set(relPath, entry);
}

/**
 * @returns {string|null} a warning to inject into the tool result if this
 *   file changed on disk since the agent last read/wrote it, else null.
 */
function checkStale(root, relPath) {
  if (!root || !relPath) return null;
  const entry = tracked.get(relPath);
  if (!entry || entry.mtimeAtRead == null) return null;
  const current = mtimeOf(root, relPath);
  if (current == null || current <= entry.mtimeAtRead) return null;
  // The mtime moved and it wasn't us — refresh the baseline so the same
  // change is only reported once, then warn.
  entry.mtimeAtRead = current;
  tracked.set(relPath, entry);
  return `${relPath} was modified outside Cortex since you last read it`;
}

/**
 * Builds a warning covering every tracked file that changed externally —
 * used to tell the model to re-read before trusting its cached view.
 * @returns {string|null}
 */
function getStaleWarning(root) {
  if (!root) return null;
  const stale = [];
  for (const relPath of tracked.keys()) {
    const warning = checkStale(root, relPath);
    if (warning) stale.push(relPath);
  }
  if (stale.length === 0) return null;
  return (
    `NOTE: these file(s) were changed outside Cortex since you last read them: ${stale.join(', ')}. ` +
    `Re-read any of them you are about to edit — your cached view is out of date.`
  );
}

function reset() {
  tracked.clear();
}

module.exports = { markAgentRead, markAgentWrite, checkStale, getStaleWarning, reset };
