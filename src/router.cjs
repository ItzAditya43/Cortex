// Speculative model routing: use a small/fast model for read-only
// investigation steps (list_dir, search_code, read_file, ...) and only pay
// for the bigger/smarter model once the turn actually needs to produce code
// (a mutating tool call, or — since we can't know in advance whether a step
// with no prior tool calls will just be a direct answer — the very first
// step of a turn, which is treated as "might need real reasoning").
//
// This is pure upside when a fast local model is configured: reads/greps
// are usually the majority of an agent's tool calls, and routing them to a
// 1-3B model instead of e.g. a 14B one is close to free speed. If no
// fastModel is configured, pickModel always returns the main model — zero
// behavior change for existing setups.

'use strict';

/**
 * @param {object} opts
 * @param {string} opts.model                the configured "smart" model
 * @param {string} [opts.fastModel]           optional smaller/faster model for investigation steps
 * @param {boolean} opts.usedMutatingTool     whether a mutating tool has already been called this turn
 * @param {boolean} opts.isFirstStep          whether this is the first model call of the turn
 * @returns {string}
 */
function pickModel({ model, fastModel, usedMutatingTool, isFirstStep }) {
  if (!fastModel || fastModel === model) return model;
  if (usedMutatingTool) return model;
  if (isFirstStep) return model; // first step may go straight to a final answer requiring real reasoning
  return fastModel;
}

module.exports = { pickModel };
