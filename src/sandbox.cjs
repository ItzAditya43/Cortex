// Best-effort OS-level sandboxing for run_command/run_background, in the
// spirit of Codex CLI's seatbelt/landlock sandbox: the rest of the
// filesystem is mounted read-only and network access is cut off by default,
// so a command the model runs can't wander outside the workspace or exfiltrate
// data, even if cortex.autoApprove is on. Linux-only (uses bubblewrap);
// on other platforms or when bwrap isn't installed, commands run unsandboxed
// and callers are told so via `available: false`.

'use strict';

const { execSync } = require('child_process');

let bwrapAvailable = null;

function checkBwrap() {
  if (bwrapAvailable !== null) return bwrapAvailable;
  if (process.platform !== 'linux') {
    bwrapAvailable = false;
    return false;
  }
  try {
    execSync('which bwrap', { stdio: 'ignore' });
    bwrapAvailable = true;
  } catch {
    bwrapAvailable = false;
  }
  return bwrapAvailable;
}

/**
 * Wraps a shell command to run inside a bubblewrap sandbox: workspace root
 * is the only writable path, rest of the filesystem is read-only, and
 * network is disabled unless allowNetwork is set.
 *
 * @param {string} command
 * @param {string} root
 * @param {{allowNetwork?: boolean}} [opts]
 * @returns {{command: string, sandboxed: boolean}}
 */
function wrapCommand(command, root, opts = {}) {
  if (!checkBwrap()) return { command, sandboxed: false };
  // bwrap's argv handles quoting of the inner command via a separate exec
  // (bash -c <command>); we shell-quote the whole invocation once here since
  // it's handed to execSync/spawn(..., {shell: true}).
  // Mount order matters to bwrap: later binds win over earlier ones at an
  // overlapping path. --tmpfs /tmp must come before the workspace bind, or a
  // workspace root that happens to live under /tmp (as scratch/test dirs
  // often do) gets silently hidden by the fresh empty tmpfs mounted on top
  // of it.
  const quoted = [
    'bwrap',
    '--ro-bind', '/', '/',
    '--dev', '/dev',
    '--proc', '/proc',
    '--tmpfs', '/tmp',
    '--bind', JSON.stringify(root), JSON.stringify(root),
    '--unshare-pid',
    '--unshare-ipc',
    '--unshare-uts',
    '--die-with-parent',
    ...(opts.allowNetwork ? [] : ['--unshare-net']),
    '--chdir', JSON.stringify(root),
    '--',
    'bash', '-c', JSON.stringify(command),
  ].join(' ');
  return { command: quoted, sandboxed: true };
}

module.exports = { wrapCommand, checkBwrap };
