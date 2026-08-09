// Persistent memory for the agent, scoped to the current workspace folder.
//
// - history.json : recent conversation turns (short-term / session memory),
//                   keyed per chat session id so multiple chats don't collide.
// - MEMORY.md     : durable notes the agent chooses to keep across sessions.

'use strict';

const fs = require('fs');
const path = require('path');

const DIR = '.cortex';
const MEMORY_FILE = 'MEMORY.md';

function dir(root) {
  return path.join(root, DIR);
}

function ensureDir(root) {
  const d = dir(root);
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  const gitignore = path.join(d, '.gitignore');
  if (!fs.existsSync(gitignore)) fs.writeFileSync(gitignore, '*\n');
  return d;
}

function historyFile(root, sessionId) {
  return path.join(ensureDir(root), `history-${sessionId}.json`);
}

function loadHistory(root, sessionId) {
  const f = historyFile(root, sessionId);
  if (!fs.existsSync(f)) return [];
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return [];
  }
}

function saveHistory(root, sessionId, history) {
  const trimmed = history.slice(-200);
  fs.writeFileSync(historyFile(root, sessionId), JSON.stringify(trimmed, null, 2));
}

function resetHistory(root, sessionId) {
  const f = historyFile(root, sessionId);
  if (fs.existsSync(f)) fs.unlinkSync(f);
}

function sessionsIndexFile(root) {
  return path.join(ensureDir(root), 'sessions.json');
}

function loadSessionsIndex(root) {
  const f = sessionsIndexFile(root);
  if (!fs.existsSync(f)) return {};
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return {};
  }
}

function saveSessionsIndex(root, index) {
  fs.writeFileSync(sessionsIndexFile(root), JSON.stringify(index, null, 2));
}

// Update (or create) a session's entry in the index — called after each turn
// so the History list has a title (from the first user message) and a
// recency-sortable timestamp.
function touchSession(root, sessionId, history) {
  const index = loadSessionsIndex(root);
  const firstUser = history.find((m) => m.role === 'user');
  const title = firstUser ? firstUser.content.trim().slice(0, 80) : 'New chat';
  index[sessionId] = { title, updatedAt: new Date().toISOString() };
  saveSessionsIndex(root, index);
}

function listSessions(root) {
  const index = loadSessionsIndex(root);
  return Object.entries(index)
    .map(([id, meta]) => ({ id, ...meta }))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

function deleteSession(root, sessionId) {
  resetHistory(root, sessionId);
  const index = loadSessionsIndex(root);
  delete index[sessionId];
  saveSessionsIndex(root, index);
}

function loadMemoryNotes(root) {
  const f = path.join(ensureDir(root), MEMORY_FILE);
  if (!fs.existsSync(f)) return '';
  return fs.readFileSync(f, 'utf8').trim();
}

function appendMemoryNote(root, note) {
  const f = path.join(ensureDir(root), MEMORY_FILE);
  const stamp = new Date().toISOString();
  fs.appendFileSync(f, `- [${stamp}] ${note}\n`);
}

// Overwrites MEMORY.md wholesale — used by the Memory panel so the user can
// read and hand-edit exactly what the agent will see in future turns.
function setMemoryNotes(root, content) {
  const f = path.join(ensureDir(root), MEMORY_FILE);
  fs.writeFileSync(f, content ?? '');
}

module.exports = {
  loadHistory,
  saveHistory,
  resetHistory,
  loadMemoryNotes,
  appendMemoryNote,
  setMemoryNotes,
  touchSession,
  listSessions,
  deleteSession,
};
