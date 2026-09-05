// Scores the models you actually have installed, on your actual machine.
//
// Cline and Continue both run evals — internally, against hosted models, and
// they publish a recommendation. That doesn't answer the question a local
// user actually has: "of the six models already on this laptop, which one
// should I point this at?" Published numbers can't answer it, because the
// exact quantisation, the RAM, and the GPU are all yours.
//
// So the benchmark ships as a feature rather than as project infrastructure:
// pick some installed models, run the real agent loop over a handful of real
// tasks in a scratch workspace, and get a ranked table with timings.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { runTurn } = require('./agentLoop.cjs');

// A deliberately small, fast set — this runs interactively while someone
// waits, so it has to finish in minutes, not hours. Each task is graded on
// the resulting files, never on what the model claimed it did.
const TASKS = [
  {
    name: 'create a file',
    files: {},
    prompt: 'Create greet.js containing a function greet(name) that returns "Hello, " followed by the name.',
    check: (d) => {
      const s = read(d, 'greet.js');
      return !!s && /greet/.test(s) && /Hello/.test(s);
    },
  },
  {
    name: 'edit one line',
    files: { 'cfg.js': 'module.exports = {\n  port: 3000,\n  host: "localhost",\n};\n' },
    prompt: 'In cfg.js change the port to 8080. Change nothing else.',
    check: (d) => {
      const s = read(d, 'cfg.js');
      return !!s && /port:\s*8080/.test(s) && /localhost/.test(s);
    },
  },
  {
    name: 'edit without breaking indentation',
    files: { 'deep.js': 'class A {\n  run() {\n    if (true) {\n      return 1;\n    }\n  }\n}\n' },
    prompt: 'In deep.js make run() return 42 instead of 1.',
    check: (d) => {
      const s = read(d, 'deep.js');
      return !!s && /^ {6}return 42;/m.test(s);
    },
  },
  {
    name: 'find, then fix',
    files: {
      'src/util.js': 'function slugify(s) {\n  return s.toLowerCase();\n}\nmodule.exports = { slugify };\n',
      'src/noise.js': 'const x = 1;\n',
    },
    prompt: 'Find the slugify function in this project and make it also replace spaces with hyphens.',
    check: (d) => {
      const s = read(d, 'src/util.js');
      return !!s && /replace|split/.test(s) && /-/.test(s);
    },
  },
  {
    name: 'leave correct code alone',
    files: { 'ok.js': 'const PORT = 8080;\nmodule.exports = { PORT };\n' },
    prompt: 'Check whether ok.js sets PORT to 8080. If it already does, change nothing and just say so.',
    needsAnswer: true,
    check: (d) => read(d, 'ok.js') === 'const PORT = 8080;\nmodule.exports = { PORT };\n',
  },
];

function read(dir, rel) {
  try {
    return fs.readFileSync(path.join(dir, rel), 'utf8');
  } catch {
    return null;
  }
}

function makeWorkspace(task) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-bench-'));
  for (const [rel, content] of Object.entries(task.files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

// Infrastructure trouble is not the model being bad at coding, and scoring it
// as such would rank a stalled model below a genuinely worse one.
const INFRA = /timed out|stopped responding|could not reach|ECONNREFUSED|API error 5\d\d|API error 402|subscription/i;

async function runOne(task, cfg, timeoutMs) {
  const dir = makeWorkspace(task);
  const started = Date.now();
  let answer = '';
  let error = null;
  try {
    await Promise.race([
      runTurn({
        history: [{ role: 'user', content: task.prompt }],
        root: dir,
        host: cfg.host,
        provider: cfg.provider || 'ollama',
        apiKey: cfg.apiKey,
        model: cfg.model,
        temperature: 0.1,
        maxSteps: 12,
        memoryNotes: '',
        planMode: false,
        ctx: { host: cfg.host, sandboxMode: 'danger-full-access' },
        onToken: () => {},
        onToolCall: () => {},
        requestApproval: async () => true,
        onToolResult: () => {},
        onFinal: (t) => {
          answer = t || '';
        },
        onError: (m) => {
          error = m;
        },
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('task timed out')), timeoutMs)),
    ]);
  } catch (err) {
    error = err.message;
  }

  let passed = false;
  try {
    passed = task.check(dir) === true;
  } catch {
    passed = false;
  }
  if (passed && task.needsAnswer && !answer.trim()) passed = false;
  fs.rmSync(dir, { recursive: true, force: true });
  return { task: task.name, passed, infra: !passed && !!error && INFRA.test(error), ms: Date.now() - started, error };
}

/**
 * @param {string[]} models
 * @param {{host:string, provider?:string, apiKey?:string, taskTimeoutMs?:number}} cfg
 * @param {(p: {model:string, task:string, index:number, total:number}) => void} [onProgress]
 * @returns {Promise<Array<{model, passed, scored, rate, avgMs, results}>>} ranked best first
 */
async function benchmarkModels(models, cfg, onProgress) {
  const rows = [];
  let index = 0;
  const total = models.length * TASKS.length;

  for (const model of models) {
    const results = [];
    for (const task of TASKS) {
      index++;
      onProgress?.({ model, task: task.name, index, total });
      results.push(await runOne(task, { ...cfg, model }, cfg.taskTimeoutMs || 120_000));
    }
    const infra = results.filter((r) => r.infra).length;
    const scored = results.length - infra;
    const passed = results.filter((r) => r.passed).length;
    const completed = results.filter((r) => !r.infra);
    rows.push({
      model,
      passed,
      scored,
      infra,
      rate: scored > 0 ? passed / scored : 0,
      avgMs: completed.length ? Math.round(completed.reduce((a, r) => a + r.ms, 0) / completed.length) : 0,
      results,
    });
  }

  // Rank by correctness, then speed — a model that ties on score but answers
  // twice as fast is the better default.
  return rows.sort((a, b) => b.rate - a.rate || a.avgMs - b.avgMs);
}

module.exports = { benchmarkModels, TASKS };
