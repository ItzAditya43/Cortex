// Single source of truth for "does this tool call need human approval?".
// Kept as a pure function (no vscode dependency) so the approval policy is
// directly unit-testable and isn't duplicated/re-derived inline wherever a
// decision is needed.

'use strict';

/**
 * @param {string} toolName
 * @param {{autoApprove?: boolean, autoApproveTools?: string[]}} policy
 * @returns {boolean} true if the tool may run without asking the user
 */
function shouldAutoApprove(toolName, policy) {
  if (!policy) return false;
  if (policy.autoApprove) return true;
  return Array.isArray(policy.autoApproveTools) && policy.autoApproveTools.includes(toolName);
}

module.exports = { shouldAutoApprove };
