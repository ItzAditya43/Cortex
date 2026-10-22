// Durable undo history. Snapshots used to live only in memory on the
// ChatViewProvider, so reloading the VS Code window silently threw away
// every undo point — the one moment you most want them. These are written
// under .cortex/snapshots/ instead, keyed by session, so "revert that edit"
// still works tomorrow.
//
// Deliberately not a shadow git repo (what Kilo Code uses): the agent only
// ever touches files through tools that already capture before/after
// content, so storing those pairs directly is simpler, has no git
// dependency, and cannot interfere with the user's own VCS state.

'use strict';

const fs = require('fs');
const path = require('path');

const DIR = path.join('.cortex', 'snapshots');
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024; // skip persisting huge files; in-memory revert still works this session
const MAX_SESSIONS = 20;

function sessionDir(root, sessionId) {
  const d = path.join(root, DIR, sessionId);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/**
 * Undoes one recorded change. Writing `before` back is only right for a
 * plain edit: a file the agent created has to be removed (not left behind
 * empty), a rename has to be moved back, and a multi_edit snapshot covers
 * several files under a summary label that is not a path at all.
 *
 * @param {string} root
 * @param {{path: string, before: string, created?: boolean, renameFrom?: string, renameTo?: string,
 *          files?: Array<{path: string, before: string, created?: boolean}>}} snap
 * @returns {string[]} workspace-relative paths restored
 */
function restoreSnapshot(root, snap) {
  const { safePath } = require('./tools.cjs');
  const { markAgentWrite } = require('./fileTracker.cjs');
  /** @param {{path: string, before: string, created?: boolean}} f */
  const restoreOne = ({ path: rel, before, created }) => {
    const full = safePath(root, rel);
    if (created) {
      if (fs.existsSync(full)) fs.unlinkSync(full);
    } else {
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, before ?? '');
    }
    markAgentWrite(root, rel);
    return rel;
  };
  if (Array.isArray(snap.files)) return snap.files.map(restoreOne);
  if (snap.renameFrom && snap.renameTo) {
    const from = safePath(root, snap.renameFrom);
    const to = safePath(root, snap.renameTo);
    if (fs.existsSync(to)) {
      fs.mkdirSync(path.dirname(from), { recursive: true });
      fs.renameSync(to, from);
    }
    return [snap.renameFrom];
  }
  return [restoreOne(snap)];
}

/**
 * Persists one file-change snapshot so it can be reverted after a reload.
 * @param {string} root
 * @param {string} sessionId
 * @param {string} callId       the tool call this snapshot belongs to
 * @param {{path: string, before: string, after?: string, created?: boolean, renameFrom?: string, renameTo?: string,
 *          files?: Array<{path: string, before: string, created?: boolean}>}} snapshot
 * @param {string} [turnId]     groups snapshots made during the same turn
 */
function saveSnapshot(root, sessionId, callId, snapshot, turnId) {
  if (!root || !snapshot || snapshot.before === undefined) return;
  const befores = snapshot.files ? snapshot.files.map((f) => f.before || '').join('') : snapshot.before || '';
  if (Buffer.byteLength(befores, 'utf8') > MAX_SNAPSHOT_BYTES) return;
  try {
    const file = path.join(sessionDir(root, sessionId), `${callId}.json`);
    const { path: p, before, created, renameFrom, renameTo, files } = snapshot;
    fs.writeFileSync(
      file,
      JSON.stringify({
        callId,
        turnId,
        path: p,
        before,
        created,
        renameFrom,
        renameTo,
        files: files?.map((f) => ({ path: f.path, before: f.before, created: f.created })),
        at: Date.now(),
      })
    );
  } catch {
    // Persistence is a convenience layer — never break a turn over it.
  }
}

/**
 * @returns {Array<{callId: string, turnId?: string, path: string, before: string, at: number, created?: boolean,
 *   renameFrom?: string, renameTo?: string, files?: Array<{path: string, before: string, created?: boolean}>}>}
 *   snapshots for a session, oldest first
 */
function loadSnapshots(root, sessionId) {
  if (!root) return [];
  const d = path.join(root, DIR, sessionId);
  if (!fs.existsSync(d)) return [];
  const out = [];
  for (const name of fs.readdirSync(d)) {
    if (!name.endsWith('.json')) continue;
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(d, name), 'utf8')));
    } catch {
      // ignore a corrupt snapshot rather than losing the rest
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

function deleteSnapshot(root, sessionId, callId) {
  try {
    const f = path.join(root, DIR, sessionId, `${callId}.json`);
    if (fs.existsSync(f)) fs.unlinkSync(f);
  } catch {
    // best-effort
  }
}

function clearSession(root, sessionId) {
  try {
    const d = path.join(root, DIR, sessionId);
    if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

// Keeps .cortex/snapshots from growing without bound across many chats.
function pruneOldSessions(root, keep = MAX_SESSIONS) {
  try {
    const base = path.join(root, DIR);
    if (!fs.existsSync(base)) return;
    const sessions = fs
      .readdirSync(base)
      .map((name) => ({ name, mtime: fs.statSync(path.join(base, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const stale of sessions.slice(keep)) {
      fs.rmSync(path.join(base, stale.name), { recursive: true, force: true });
    }
  } catch {
    // best-effort
  }
}

module.exports = { saveSnapshot, loadSnapshots, deleteSnapshot, clearSession, pruneOldSessions, restoreSnapshot };
