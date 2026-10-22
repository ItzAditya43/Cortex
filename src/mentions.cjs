// @-mentions: "@src/app.js" in a message attaches that file's contents, so
// the model starts with the code the user is pointing at instead of
// spending a round-trip (or a wrong guess) finding it.
//
// The attachment is appended to the stored user message after a marker, so
// the model sees it on every later step, and the panel can still show the
// message exactly as the user typed it.

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ATTACH_MARKER = '\n\n<attached_files>\n';
const MAX_FILES = 8;
const MAX_TOTAL_CHARS = 60_000;

let fileCache = { root: null, at: 0, files: [] };

/**
 * Workspace files for the mention menu. Uses `git ls-files` when the workspace is
 * a repository (fast, and respects .gitignore), otherwise a bounded walk.
 * @param {string} root
 * @returns {string[]}
 */
function workspaceFiles(root) {
  if (fileCache.root === root && Date.now() - fileCache.at < 10_000) return fileCache.files;
  let files;
  try {
    const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    });
    files = out.split('\n').filter(Boolean).slice(0, 20_000);
  } catch {
    const { listFiles } = require('./tools.cjs');
    files = listFiles(root, 20_000);
  }
  files = files.filter((f) => !f.startsWith('.cortex/'));
  fileCache = { root, at: Date.now(), files };
  return files;
}

/**
 * @param {string} text the message as typed
 * @param {string} root
 * @returns {{content: string, attached: string[], missing: string[]}}
 */
function expandMentions(text, root) {
  const { tools, safePath } = require('./tools.cjs');
  const wanted = [];
  for (const m of String(text || '').matchAll(/(?:^|\s)@([^\s@]+)/g)) {
    const rel = m[1].replace(/[.,;:!?)\]]+$/, ''); // "look at @a.js." — trailing punctuation isn't part of the path
    if (!wanted.includes(rel)) wanted.push(rel);
  }
  const attached = [];
  const missing = [];
  const blocks = [];
  let total = 0;
  for (const rel of wanted.slice(0, MAX_FILES)) {
    let full;
    try {
      full = safePath(root, rel);
    } catch {
      missing.push(rel);
      continue;
    }
    if (!fs.existsSync(full)) {
      missing.push(rel);
      continue;
    }
    const isDir = fs.statSync(full).isDirectory();
    let body = isDir ? tools.list_dir.run({ path: rel }, root) : tools.read_file.run({ path: rel }, root);
    if (total + body.length > MAX_TOTAL_CHARS) body = `${body.slice(0, Math.max(0, MAX_TOTAL_CHARS - total))}\n...[truncated — read_file it for the rest]`;
    total += body.length;
    blocks.push(`<file path="${rel.split(path.sep).join('/')}"${isDir ? ' type="directory"' : ''}>\n${body}\n</file>`);
    attached.push(rel);
    if (total >= MAX_TOTAL_CHARS) break;
  }
  if (!blocks.length) return { content: text, attached, missing };
  return { content: `${text}${ATTACH_MARKER}${blocks.join('\n')}\n</attached_files>`, attached, missing };
}

/** The message as the user typed it, without attachments. */
function stripAttachments(content) {
  const s = String(content || '');
  const idx = s.indexOf(ATTACH_MARKER);
  return idx === -1 ? s : s.slice(0, idx);
}

module.exports = { workspaceFiles, expandMentions, stripAttachments, ATTACH_MARKER };
