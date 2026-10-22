// Parses TOOL_CALL: {...} lines out of a model reply — the text protocol the
// agent's history is stored in, whichever way the model was actually driven.

'use strict';

// Pull a TOOL_CALL: {...} instruction out of a model response.
//
// String-aware (braces inside quoted strings don't affect depth counting)
// and self-repairing: smaller/weaker local models frequently emit raw
// literal newlines/tabs inside JSON string values instead of escaping them
// as \n / \t, which would otherwise make JSON.parse throw. We fix those up
// on the fly instead of giving up.
function parseToolCall(text) {
  const marker = 'TOOL_CALL:';
  const idx = text.indexOf(marker);
  if (idx === -1) return { attempted: false };

  const after = text.slice(idx + marker.length);
  const start = after.indexOf('{');
  if (start === -1) {
    return { attempted: true, ok: false, error: 'no JSON object found after TOOL_CALL:', raw: after };
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;
  let sanitized = '';

  for (let i = start; i < after.length; i++) {
    const ch = after[i];
    if (inString) {
      if (escaped) {
        sanitized += ch;
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        // Code in a string value often carries regex escapes the model did
        // not double: "\s+", "\d", "\.". Those are illegal in JSON, so the
        // whole call failed to parse and the model resent it unchanged until
        // the step budget ran out. A backslash that doesn't start a valid
        // JSON escape is a literal backslash — keep it as one.
        const next = after[i + 1];
        const validEscape =
          next !== undefined && ('"\\/bfnrt'.includes(next) || (next === 'u' && /^[0-9a-fA-F]{4}$/.test(after.slice(i + 2, i + 6))));
        sanitized += validEscape ? ch : '\\\\';
        escaped = validEscape;
        continue;
      }
      if (ch === '"') {
        sanitized += ch;
        inString = false;
        continue;
      }
      if (ch === '\n') {
        sanitized += '\\n';
        continue;
      }
      if (ch === '\r') {
        sanitized += '\\r';
        continue;
      }
      if (ch === '\t') {
        sanitized += '\\t';
        continue;
      }
      sanitized += ch;
      continue;
    }
    if (ch === '"') {
      inString = true;
      sanitized += ch;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    sanitized += ch;
    if (depth === 0) {
      end = i;
      break;
    }
  }

  if (end === -1) {
    return { attempted: true, ok: false, error: 'unterminated JSON object (missing closing brace)', raw: after.slice(start) };
  }

  try {
    return { attempted: true, ok: true, data: JSON.parse(sanitized) };
  } catch (err) {
    return { attempted: true, ok: false, error: err.message, raw: sanitized };
  }
}

// Parses EVERY TOOL_CALL in a response, not just the first.
//
// One call per round-trip means reading five files costs five full model
// round-trips. Letting the model emit several read-only calls at once and
// running them together collapses that into one, which is the single
// biggest latency win available here and costs no quality — strong models
// batch reads naturally when told they can.
//
// Mutating calls are deliberately NOT batched: each one needs its own
// approval, diff and checkpoint, and later edits in a batch could be built
// on assumptions invalidated by earlier ones.
function parseToolCalls(text) {
  const calls = [];
  let rest = text;
  while (true) {
    const parsed = parseToolCall(rest);
    if (!parsed.attempted) break;
    calls.push(parsed);
    if (!parsed.ok) break; // stop at the first malformed one so the model gets a clear error
    // advance past this call's closing brace to look for the next one
    const idx = rest.indexOf('TOOL_CALL:');
    const nextSearchFrom = idx + 'TOOL_CALL:'.length;
    const following = rest.slice(nextSearchFrom);
    const nextIdx = following.indexOf('TOOL_CALL:');
    if (nextIdx === -1) break;
    rest = following.slice(nextIdx);
    if (calls.length >= 8) break; // sanity cap
  }
  return calls;
}

module.exports = { parseToolCall, parseToolCalls };
