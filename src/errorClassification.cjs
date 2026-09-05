// Classifies provider failures so the loop can respond to them instead of
// surfacing a raw string.
//
// Every provider phrases the same failure differently, and some bury it
// several objects deep. Without this, a context-window overflow (recoverable
// by compacting and retrying) and an expired API key (not recoverable at all)
// both reach the user as equally unhelpful text, and neither triggers the
// action that would fix it.

'use strict';

const CONTEXT_PATTERNS = [
  /context length/i,
  /context window/i,
  /maximum context/i,
  /too many tokens/i,
  /prompt is too long/i,
  /reduce the length/i,
  /input length and `max_tokens`/i,
];
const RATE_LIMIT_PATTERNS = [/rate.?limit/i, /too many requests/i, /quota exceeded/i, /overloaded/i];
const AUTH_PATTERNS = [/unauthorized/i, /invalid api key/i, /authentication/i, /forbidden/i, /requires a subscription/i];
const MODEL_PATTERNS = [/model .* not found/i, /no such model/i, /pull the model/i, /try pulling it first/i];
const CONNECT_PATTERNS = [/could not reach/i, /ECONNREFUSED/i, /fetch failed/i, /socket hang up/i, /ENOTFOUND/i];
const TIMEOUT_PATTERNS = [/stopped responding/i, /timed out/i, /timeout/i];

// Providers nest the useful message under varying keys; walk a bounded depth
// rather than trusting any single shape.
function collectText(err, depth = 0) {
  if (depth > 4 || err == null) return '';
  if (typeof err === 'string') return err;
  if (typeof err !== 'object') return String(err);
  const parts = [];
  for (const key of ['message', 'error', 'detail', 'details', 'body', 'cause', 'statusText']) {
    if (err[key] !== undefined) parts.push(collectText(err[key], depth + 1));
  }
  if (parts.length === 0 && err.toString) parts.push(String(err));
  return parts.join(' ');
}

function statusOf(err) {
  if (!err || typeof err !== 'object') return undefined;
  const raw = err.status ?? err.statusCode ?? err.code;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * @param {unknown} err
 * @returns {{kind: 'context'|'rate-limit'|'auth'|'model'|'connect'|'timeout'|'unknown',
 *            retryable: boolean, recoverable: boolean, message: string, advice: string}}
 *   `recoverable` means the loop itself can do something about it (compact, back off);
 *   `retryable` means an identical retry could plausibly succeed.
 */
function classifyError(err) {
  const text = collectText(err);
  const status = statusOf(err);
  const match = (pats) => pats.some((re) => re.test(text));

  if (match(CONTEXT_PATTERNS) || status === 413) {
    return {
      kind: 'context',
      retryable: false,
      recoverable: true,
      message: text,
      advice: 'The conversation outgrew the model\'s context window. Summarizing it and retrying usually works — or lower cortex.contextBudgetTokens.',
    };
  }
  if (match(RATE_LIMIT_PATTERNS) || status === 429) {
    return { kind: 'rate-limit', retryable: true, recoverable: true, message: text, advice: 'Rate limited — backing off before retrying.' };
  }
  if (match(AUTH_PATTERNS) || status === 401 || status === 403 || status === 402) {
    return {
      kind: 'auth',
      retryable: false,
      recoverable: false,
      message: text,
      advice: 'Authentication or subscription problem. Check cortex.apiKey, or pick a model your account can use.',
    };
  }
  if (match(MODEL_PATTERNS) || status === 404) {
    return { kind: 'model', retryable: false, recoverable: false, message: text, advice: 'The model is not available. Pull it first (`ollama pull <model>`) or pick another with "Cortex: Select Model".' };
  }
  if (match(TIMEOUT_PATTERNS)) {
    return { kind: 'timeout', retryable: true, recoverable: false, message: text, advice: 'The model stopped responding. It may be loading or overloaded — try again, or switch to a smaller model.' };
  }
  if (match(CONNECT_PATTERNS)) {
    return { kind: 'connect', retryable: true, recoverable: false, message: text, advice: 'Could not reach the model server. Is "ollama serve" running?' };
  }
  if (status && status >= 500) {
    return { kind: 'connect', retryable: true, recoverable: false, message: text, advice: 'The model server returned an error. Retrying may help.' };
  }
  return { kind: 'unknown', retryable: false, recoverable: false, message: text, advice: '' };
}

module.exports = { classifyError };
