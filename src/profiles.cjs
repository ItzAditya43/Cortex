// Named config presets, matching Codex CLI's profiles (--profile fast/careful/auto):
// a profile is a partial override applied on top of the base settings, so a
// user can flip between e.g. "fast" (small model, on-request approval) and
// "careful" (main model, untrusted approval, read-only sandbox) without
// hand-editing settings every time.

'use strict';

const OVERRIDABLE_KEYS = [
  'host',
  'provider',
  'apiKey',
  'model',
  'fastModel',
  'temperature',
  'maxSteps',
  'contextBudgetTokens',
  'approvalPolicy',
  'sandboxMode',
  'sandboxAllowNetwork',
  'approveForMe',
  'autoApprove',
];

/**
 * @param {object} baseCfg              full resolved settings before profile overrides
 * @param {object} profiles             map of profileName -> partial settings (from cortex.profiles)
 * @param {string} [activeProfile]      name of the profile to apply, if any
 * @returns {object} baseCfg with the active profile's keys overlaid (unknown/misspelled keys are ignored)
 */
function applyProfile(baseCfg, profiles, activeProfile) {
  if (!activeProfile || !profiles || typeof profiles !== 'object') return baseCfg;
  const overrides = profiles[activeProfile];
  if (!overrides || typeof overrides !== 'object') return baseCfg;
  const merged = { ...baseCfg };
  for (const key of OVERRIDABLE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(overrides, key)) merged[key] = overrides[key];
  }
  return merged;
}

module.exports = { applyProfile, OVERRIDABLE_KEYS };
