// Single source of truth for "does this tool call need human approval?".
// Kept as a pure function (no vscode dependency) so the approval policy is
// directly unit-testable and isn't duplicated/re-derived inline wherever a
// decision is needed.

'use strict';

/**
 * @param {string} toolName
 * @param {{
 *   autoApprove?: boolean,
 *   autoApproveTools?: string[],
 *   autoApproveCommands?: string[],
 *   commandArg?: string,
 *   approvalPolicy?: 'suggest'|'auto-edit'|'full-auto',
 *   toolKind?: 'edit'|'command'|'other',
 * }} policy
 * @returns {boolean} true if the tool may run without asking the user
 */
function shouldAutoApprove(toolName, policy) {
  if (!policy) return false;
  if (policy.autoApprove) return true;

  // Three-tier policy mirroring Codex CLI's suggest/auto-edit/full-auto:
  //   suggest    — confirm every mutating tool (the default / safest)
  //   auto-edit  — file edits run without confirmation, shell commands still ask
  //   full-auto  — nothing asks (equivalent to autoApprove: true)
  if (policy.approvalPolicy === 'full-auto') return true;
  if (policy.approvalPolicy === 'auto-edit' && policy.toolKind === 'edit') return true;

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

module.exports = { shouldAutoApprove };
