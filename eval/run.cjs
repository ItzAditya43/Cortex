#!/usr/bin/env node
// Benchmark runner for the Cortex agent loop.
//
// Answers the question the project previously had no way to answer: did that
// change make the agent better or worse? Runs every task in an isolated temp
// workspace against the real agent loop and a real model, grades by the
// resulting files, and prints a pass rate per model.
//
//   node eval/run.cjs --model qwen3.5:cloud
//   node eval/run.cjs --model a --model b        compare two models
//   node eval/run.cjs --tags edit --verbose      only edit tasks, show details
//   node eval/run.cjs --model X --json > run.json  machine-readable output
//
// Results are compared against eval/baseline.json when present, so a
// regression shows up as a diff rather than a number you have to remember.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { runTurn } = require('../src/agentLoop.cjs');
const { tasks } = require('./tasks.cjs');

function parseArgs(argv) {
  const opts = {
    models: [],
    host: process.env.CORTEX_HOST || 'http://localhost:11434',
    provider: process.env.CORTEX_PROVIDER || 'ollama',
    apiKey: process.env.CORTEX_API_KEY || '',
    maxSteps: 14,
    temperature: 0.1,
    tags: null,
    only: null,
    verbose: false,
    json: false,
    saveBaseline: false,
    timeoutMs: 180_000,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--model') opts.models.push(argv[++i]);
    else if (a === '--host') opts.host = argv[++i];
    else if (a === '--provider') opts.provider = argv[++i];
    else if (a === '--tags') opts.tags = argv[++i].split(',');
    else if (a === '--only') opts.only = argv[++i];
    else if (a === '--max-steps') opts.maxSteps = parseInt(argv[++i], 10);
    else if (a === '--timeout') opts.timeoutMs = parseInt(argv[++i], 10) * 1000;
    else if (a === '--verbose' || a === '-v') opts.verbose = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--save-baseline') opts.saveBaseline = true;
    else if (a === '--help' || a === '-h') {
      console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 17).join('\n').replace(/^\/\/ ?/gm, ''));
      process.exit(0);
    }
  }
  if (opts.models.length === 0) opts.models.push(process.env.CORTEX_MODEL || 'qwen2.5-coder:3b');
  return opts;
}

function makeWorkspace(task) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cortex-eval-${task.name}-`));
  for (const [rel, content] of Object.entries(task.files || {})) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

async function runTask(task, model, opts) {
  const dir = makeWorkspace(task);
  const started = Date.now();
  const toolCalls = [];
  let finalText = '';
  let error = null;

  try {
    await Promise.race([
      runTurn({
        history: [{ role: 'user', content: task.prompt }],
        root: dir,
        host: opts.host,
        provider: opts.provider,
        apiKey: opts.apiKey,
        model,
        temperature: opts.temperature,
        maxSteps: opts.maxSteps,
        memoryNotes: '',
        planMode: false,
        // Grading is about capability, not the approval UX, so everything is
        // approved; the sandbox stays off because tasks only touch their own
        // temp workspace.
        ctx: { host: opts.host, sandboxMode: 'danger-full-access' },
        onToken: () => {},
        onToolCall: (name, args) => toolCalls.push({ name, args }),
        requestApproval: async () => true,
        onToolResult: () => {},
        onFinal: (text) => {
          finalText = text;
        },
        onError: (msg) => {
          error = msg;
        },
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('task timed out')), opts.timeoutMs)),
    ]);
  } catch (err) {
    error = err.message;
  }

  let verdict;
  try {
    verdict = task.check(dir);
  } catch (err) {
    verdict = `check threw: ${err.message}`;
  }

  const passed = verdict === true;
  const result = {
    task: task.name,
    tags: task.tags,
    passed,
    reason: passed ? null : typeof verdict === 'string' ? verdict : 'check failed',
    error,
    steps: toolCalls.length,
    tools: toolCalls.map((c) => c.name),
    ms: Date.now() - started,
    finalText: finalText.slice(0, 300),
  };
  fs.rmSync(dir, { recursive: true, force: true });
  return result;
}

function selectTasks(opts) {
  let list = tasks;
  if (opts.only) list = list.filter((t) => t.name === opts.only);
  if (opts.tags) list = list.filter((t) => (t.tags || []).some((tag) => opts.tags.includes(tag)));
  return list;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const selected = selectTasks(opts);
  if (selected.length === 0) {
    console.error('No tasks matched.');
    process.exit(1);
  }

  const baselinePath = path.join(__dirname, 'baseline.json');
  const baseline = fs.existsSync(baselinePath) ? JSON.parse(fs.readFileSync(baselinePath, 'utf8')) : null;
  const report = { at: new Date().toISOString(), host: opts.host, models: {} };

  for (const model of opts.models) {
    if (!opts.json) console.log(`\n=== ${model} — ${selected.length} task(s) ===`);
    const results = [];
    for (const task of selected) {
      const r = await runTask(task, model, opts);
      results.push(r);
      if (!opts.json) {
        const mark = r.passed ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
        console.log(`  ${mark}  ${r.task.padEnd(28)} ${String(r.steps).padStart(2)} steps  ${(r.ms / 1000).toFixed(1)}s`);
        if (!r.passed) console.log(`        ↳ ${r.reason}${r.error ? ` (loop error: ${r.error})` : ''}`);
        if (opts.verbose) console.log(`        tools: ${r.tools.join(' → ') || '(none)'}`);
      }
    }
    const passed = results.filter((r) => r.passed).length;
    report.models[model] = { passed, total: results.length, rate: passed / results.length, results };
    if (!opts.json) {
      console.log(`  ---- ${passed}/${results.length} (${Math.round((passed / results.length) * 100)}%)`);
      const prev = baseline?.models?.[model];
      if (prev) {
        const delta = passed - prev.passed;
        const regressed = results.filter((r) => !r.passed && prev.results.find((p) => p.task === r.task)?.passed);
        console.log(
          `  vs baseline: ${delta >= 0 ? '+' : ''}${delta}` +
            (regressed.length ? `  \x1b[31mREGRESSED: ${regressed.map((r) => r.task).join(', ')}\x1b[0m` : '')
        );
      }
    }
  }

  if (opts.json) console.log(JSON.stringify(report, null, 2));
  if (opts.saveBaseline) {
    fs.writeFileSync(baselinePath, JSON.stringify(report, null, 2));
    if (!opts.json) console.log(`\nBaseline saved to ${path.relative(process.cwd(), baselinePath)}`);
  }

  // Non-zero exit on a regression makes this usable as a CI gate.
  const regressedAnywhere = baseline
    ? Object.entries(report.models).some(([m, r]) => baseline.models[m] && r.passed < baseline.models[m].passed)
    : false;
  process.exit(regressedAnywhere ? 1 : 0);
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
