// Pre-diff self-verification: before a write_file/edit_file diff is shown
// for approval, run a cheap, language-appropriate syntax check on the
// proposed "after" content. Local models are weaker than Claude/GPT at
// one-shot correct edits, so catching a syntax error here — before the user
// spends time reviewing the diff, and before it's fed back to the model as
// a plain string — closes that gap cheaply. Best-effort: unsupported
// extensions or missing toolchains (no python3, no node) just skip silently.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

function checkJs(content) {
  const tmp = path.join(os.tmpdir(), `cortex-verify-${Date.now()}-${Math.random().toString(36).slice(2)}.js`);
  fs.writeFileSync(tmp, content);
  try {
    execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe', timeout: 5000 });
    return { ok: true };
  } catch (err) {
    return { ok: false, message: String(err.stderr || err.message).slice(0, 500) };
  } finally {
    fs.unlinkSync(tmp);
  }
}

function checkJson(content) {
  try {
    JSON.parse(content);
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

function checkPython(content) {
  const tmp = path.join(os.tmpdir(), `cortex-verify-${Date.now()}-${Math.random().toString(36).slice(2)}.py`);
  fs.writeFileSync(tmp, content);
  try {
    execFileSync('python3', ['-m', 'py_compile', tmp], { stdio: 'pipe', timeout: 5000 });
    return { ok: true };
  } catch (err) {
    if (err.code === 'ENOENT') return null; // python3 not installed — skip, don't report ok:false
    return { ok: false, message: String(err.stderr || err.message).slice(0, 500) };
  } finally {
    fs.unlinkSync(tmp);
    const pyc = tmp + 'c';
    if (fs.existsSync(pyc)) fs.unlinkSync(pyc);
  }
}

const CHECKERS = {
  '.js': checkJs,
  '.cjs': checkJs,
  '.mjs': checkJs,
  '.json': checkJson,
  '.py': checkPython,
};

/**
 * @param {string} filePath  relative or absolute path, only the extension is used
 * @param {string} content   proposed file content ("after")
 * @returns {{ok: boolean, message?: string}|null}  null = no checker for this file type
 */
function verifySyntax(filePath, content) {
  const ext = path.extname(filePath).toLowerCase();
  const checker = CHECKERS[ext];
  if (!checker) return null;
  try {
    return checker(content);
  } catch {
    return null; // toolchain unavailable or crashed — never block the flow over this
  }
}

module.exports = { verifySyntax };
