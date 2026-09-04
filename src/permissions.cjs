// Single source of truth for "does this tool call need human approval?".
// Kept as a pure function (no vscode dependency) so the approval policy is
// directly unit-testable and isn't duplicated/re-derived inline wherever a
// decision is needed.

'use strict';

const { classifyCommand } = require('./dangerousCommands.cjs');

// Legacy names (this project's own first pass, and Codex CLI's pre-0.147
// suggest/auto-edit/full-auto model, since removed upstream in favor of the
// two-axis approvalPolicy + sandboxMode split below) still map onto the
// current policy so existing user settings keep working.
const LEGACY_APPROVAL_ALIASES = { suggest: 'untrusted', 'auto-edit': 'on-request', 'full-auto': 'never' };

function normalizeApprovalPolicy(p) {
  return LEGACY_APPROVAL_ALIASES[p] || p || 'untrusted';
}

/**
 * @param {string} toolName
 * @param {{
 *   autoApprove?: boolean,
 *   autoApproveTools?: string[],
 *   autoApproveCommands?: string[],
 *   commandArg?: string,
 *   approvalPolicy?: 'untrusted'|'on-request'|'never'|'suggest'|'auto-edit'|'full-auto',
 *   sandboxMode?: 'read-only'|'workspace-write'|'danger-full-access',
 *   toolKind?: 'edit'|'command'|'other',
 * }} policy
 * @returns {boolean} true if the tool may run without asking the user
 */
function shouldAutoApprove(toolName, policy) {
  if (!policy) return false;

  // Safety floor, checked before every other rule including autoApprove and
  // approvalPolicy 'never'. Tool output (file contents, fetched pages, MCP
  // results) is attacker-controllable text that reaches the model, so a
  // destructive command must never be reachable without a human in the
  // loop — no policy, profile, or allowlist can opt out of this.
  if (policy.commandArg) {
    const { dangerous } = classifyCommand(policy.commandArg);
    if (dangerous) return false;
  }

  if (policy.autoApprove) return true;

  // Two independent axes, matching current Codex CLI:
  //   approvalPolicy — when does a human get asked at all
  //     untrusted  — always ask before a mutating tool (safest, the default)
  //     on-request — auto-approve mutations that are contained by the active
  //                  sandbox (workspace-write file edits, sandboxed commands);
  //                  still ask for anything the sandbox can't constrain
  //     never      — never ask (equivalent to autoApprove: true)
  //   sandboxMode — how much containment a mutating tool actually runs under
  //     read-only          — no mutations allowed at all, regardless of approval
  //     workspace-write     — file edits + sandboxed shell commands, contained to the workspace
  //     danger-full-access  — no containment; "on-request" can't treat this as safe
  const approvalPolicy = normalizeApprovalPolicy(policy.approvalPolicy);
  if (approvalPolicy === 'never') return true;
  if (approvalPolicy === 'on-request') {
    const sandboxMode = policy.sandboxMode || 'danger-full-access';
    if (sandboxMode === 'workspace-write' && (policy.toolKind === 'edit' || policy.toolKind === 'command')) return true;
  }

  if (Array.isArray(policy.autoApproveTools) && policy.autoApproveTools.includes(toolName)) return true;
  // Finer-grained than whole-tool auto-approve: for run_command specifically,
  // let the user allowlist safe command prefixes (e.g. "npm test", "git status")
  // without blanket-trusting every shell command the model wants to run.
  if (toolName === 'run_command' && typeof policy.commandArg === 'string' && Array.isArray(policy.autoApproveCommands)) {
    const cmd = policy.commandArg.trim();
    return policy.autoApproveCommands.some((prefix) => prefix && cmd.startsWith(prefix.trim()));
  }
  return false;
}

module.exports = { shouldAutoApprove, normalizeApprovalPolicy };
