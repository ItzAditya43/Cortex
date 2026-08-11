// Cron-based recurring automations (cortex.schedules setting), e.g. a daily
// "summarize open TODOs" or "check for outdated dependencies" run without
// the user opening the chat panel. Ticks once a minute and runs any
// schedule whose 5-field cron expression matches the current minute.
//
// No npm cron dependency — a minimal matcher is enough for the standard
// "* * * * *" (minute hour day month weekday) syntax and keeps the
// extension's dependency footprint at zero beyond what's already vendored.

'use strict';

const { runTurn } = require('./agentLoop.cjs');

let intervalHandle = null;
let lastRunMinuteKey = null;

function parseField(field, min, max) {
  if (field === '*') return null; // null = "matches anything"
  const values = new Set();
  for (const part of field.split(',')) {
    const stepMatch = part.match(/^(\*|\d+-\d+|\d+)\/(\d+)$/);
    if (stepMatch) {
      const [, range, stepStr] = stepMatch;
      const step = parseInt(stepStr, 10);
      const [lo, hi] = range === '*' ? [min, max] : range.split('-').map(Number);
      for (let v = lo; v <= hi; v += step) values.add(v);
      continue;
    }
    const rangeMatch = part.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const [, lo, hi] = rangeMatch;
      for (let v = Number(lo); v <= Number(hi); v++) values.add(v);
      continue;
    }
    if (/^\d+$/.test(part)) values.add(Number(part));
  }
  return values;
}

function cronMatches(cronExpr, date) {
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [minF, hourF, domF, monF, dowF] = parts;
  const minute = parseField(minF, 0, 59);
  const hour = parseField(hourF, 0, 23);
  const dom = parseField(domF, 1, 31);
  const month = parseField(monF, 1, 12);
  const dow = parseField(dowF, 0, 6);

  if (minute && !minute.has(date.getMinutes())) return false;
  if (hour && !hour.has(date.getHours())) return false;
  if (dom && !dom.has(date.getDate())) return false;
  if (month && !month.has(date.getMonth() + 1)) return false;
  if (dow && !dow.has(date.getDay())) return false;
  return true;
}

async function runSchedule(schedule, { root, runConfig, onResult, onError, logFn }) {
  const history = [{ role: 'user', content: schedule.prompt }];
  let finalText = null;
  let errorText = null;
  try {
    await runTurn({
      history,
      root,
      host: runConfig.host,
      provider: runConfig.provider,
      apiKey: runConfig.apiKey,
      model: runConfig.model,
      fastModel: runConfig.fastModel,
      temperature: runConfig.temperature,
      maxSteps: runConfig.maxSteps,
      contextBudgetTokens: runConfig.contextBudgetTokens,
      memoryNotes: '',
      // Unattended runs default to read-only (Plan Mode) unless the schedule
      // explicitly opts into autoApprove — nobody's watching to click approve.
      planMode: !schedule.autoApprove,
      onLog: logFn,
      onToken: () => {},
      onToolCall: () => {},
      requestApproval: async () => !!schedule.autoApprove,
      onToolResult: () => {},
      onFinal: (text) => {
        finalText = text;
      },
      onError: (msg) => {
        errorText = msg;
      },
    });
  } catch (err) {
    errorText = err.message;
  }
  if (errorText) onError?.(schedule, errorText);
  else onResult?.(schedule, finalText || '(no output)');
}

/**
 * @param {object} opts
 * @param {() => Array<{name:string, cron:string, prompt:string, autoApprove?:boolean}>} opts.getSchedules
 * @param {() => object} opts.getRunConfig
 * @param {() => string|undefined} opts.getRoot
 * @param {(schedule, text: string) => void} opts.onResult
 * @param {(schedule, message: string) => void} opts.onError
 * @param {(message: string) => void} [opts.logFn]
 */
function startScheduler(opts) {
  stopScheduler();
  intervalHandle = setInterval(() => {
    const now = new Date();
    const minuteKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;
    if (minuteKey === lastRunMinuteKey) return; // guard against sub-minute interval drift firing twice
    lastRunMinuteKey = minuteKey;

    const root = opts.getRoot();
    if (!root) return;
    const schedules = opts.getSchedules() || [];
    for (const schedule of schedules) {
      if (!schedule.cron || !schedule.prompt) continue;
      if (!cronMatches(schedule.cron, now)) continue;
      opts.logFn?.(`schedule "${schedule.name || schedule.cron}" firing`);
      runSchedule(schedule, { root, runConfig: opts.getRunConfig(), onResult: opts.onResult, onError: opts.onError, logFn: opts.logFn });
    }
  }, 60_000);
}

function stopScheduler() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

module.exports = { startScheduler, stopScheduler, cronMatches };
