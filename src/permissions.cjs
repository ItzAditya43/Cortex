// Single source of truth for "does this tool call need human approval?".
// Kept as a pure function (no vscode dependency) so the approval policy is
// directly unit-testable and isn't duplicated/re-derived inline wherever a
// decision is needed.

'use strict';

/**
 * @param {string} toolName
 * @param {{autoApprove?: boolean, autoApproveTools?: string[], autoApproveCommands?: string[], commandArg?: string}} policy
 * @returns {boolean} true if the tool may run without asking the user
 */
function shouldAutoApprove(toolName, policy) {
  if (!policy) return false;
  if (policy.autoApprove) return true;
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
