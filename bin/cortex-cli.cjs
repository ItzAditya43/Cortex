#!/usr/bin/env node
// Headless CLI for Cortex — runs the same agent loop used by the VS Code
// extension, but from a terminal with zero VS Code dependency. Two modes:
//   cortex-cli                      interactive REPL in the current directory
//   cortex-cli -p "prompt" [--json] one-shot run, exits after the final answer
// The --json flag makes it suitable for CI: prints one JSON object per line
// (tool calls, tool results, final answer) instead of human-readable text.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { runTurn } = require('../src/agentLoop.cjs');
const { loadMemoryNotes } = require('../src/memory.cjs');
const { reviewAction } = require('../src/approveForMe.cjs');
const { applyProfile } = require('../src/profiles.cjs');

// User-level (~/.cortex/config.json) then project-level (.cortex/config.json)
// JSON config, mirroring the VS Code settings surface — project overrides
// user. Shape: { host, model, fastModel, provider, apiKey, temperature,
// maxSteps, contextBudgetTokens, sandboxMode, sandboxAllowNetwork,
// approveForMe, autoApprove, profiles: {name: {...overrides}} }. Entirely
// optional; the CLI works fine with just env vars/flags if no file exists.
function loadConfigFile(root) {
  const merged = {};
  for (const f of [path.join(os.homedir(), '.cortex', 'config.json'), path.join(root, '.cortex', 'config.json')]) {
    if (!fs.existsSync(f)) continue;
    try {
      Object.assign(merged, JSON.parse(fs.readFileSync(f, 'utf8')));
    } catch (err) {
      console.error(`warning: could not parse ${f}: ${err.message}`);
    }
  }
  return merged;
}

function parseArgs(argv) {
  const root = process.cwd();
  const fileCfg = loadConfigFile(root);

  const opts = {
    root,
    host: process.env.CORTEX_HOST || fileCfg.host || 'http://localhost:11434',
    provider: process.env.CORTEX_PROVIDER || fileCfg.provider || 'ollama',
    apiKey: process.env.CORTEX_API_KEY || fileCfg.apiKey || '',
    model: process.env.CORTEX_MODEL || fileCfg.model || 'qwen2.5-coder:3b',
    fastModel: process.env.CORTEX_FAST_MODEL || fileCfg.fastModel || '',
    temperature: fileCfg.temperature ?? 0.2,
    maxSteps: fileCfg.maxSteps ?? 25,
    contextBudgetTokens: fileCfg.contextBudgetTokens ?? 6000,
    autoApprove: !!fileCfg.autoApprove,
    sandboxMode: fileCfg.sandboxMode || 'danger-full-access',
    sandboxAllowNetwork: !!fileCfg.sandboxAllowNetwork,
    approveForMe: !!fileCfg.approveForMe,
    json: false,
    prompt: null,
    profile: '',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-p' || a === '--prompt') opts.prompt = argv[++i];
    else if (a === '--model') opts.model = argv[++i];
    else if (a === '--fast-model') opts.fastModel = argv[++i];
    else if (a === '--host') opts.host = argv[++i];
    else if (a === '--provider') opts.provider = argv[++i];
    else if (a === '--api-key') opts.apiKey = argv[++i];
    else if (a === '--auto-approve') opts.autoApprove = true;
    else if (a === '--sandbox') opts.sandboxMode = argv[++i]; // read-only | workspace-write | danger-full-access
    else if (a === '--sandbox-allow-network') opts.sandboxAllowNetwork = true;
    else if (a === '--approve-for-me') opts.approveForMe = true;
    else if (a === '--profile') opts.profile = argv[++i];
    else if (a === '--json') opts.json = true;
    else if (a === '--max-steps') opts.maxSteps = parseInt(argv[++i], 10);
    else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  const finalOpts = opts.profile ? applyProfile(opts, fileCfg.profiles || {}, opts.profile) : opts;
  if (opts.profile && finalOpts === opts && !(fileCfg.profiles || {})[opts.profile]) {
    console.error(`warning: profile "${opts.profile}" not found in config (checked ~/.cortex/config.json and ./.cortex/config.json)`);
  }
  return finalOpts;
}

function printHelp() {
  console.log(`cortex-cli — headless Cortex agent

Usage:
  cortex-cli                             interactive REPL in this directory
  cortex-cli -p "<prompt>" [flags]       one-shot run, exits when done

Flags:
  --model <name>            model to use (default: qwen2.5-coder:3b, or $CORTEX_MODEL)
  --fast-model <name>       optional smaller model for read-only investigation steps (or $CORTEX_FAST_MODEL)
  --host <url>              provider host (default: http://localhost:11434, or $CORTEX_HOST)
  --provider <name>         "ollama" or "openai-compatible" (default: ollama, or $CORTEX_PROVIDER)
  --api-key <key>           API key for openai-compatible providers (or $CORTEX_API_KEY)
  --auto-approve            run mutating tools without confirmation (needed for CI/unattended use)
  --sandbox <mode>          read-only | workspace-write | danger-full-access (default: danger-full-access)
  --sandbox-allow-network   allow network access inside the sandbox (only with --sandbox workspace-write)
  --approve-for-me          auto-review pending approvals with a model call instead of asking interactively
  --profile <name>          apply a named preset from the "profiles" key in .cortex/config.json (project) or ~/.cortex/config.json (user)
  --max-steps <n>           max tool-call steps per turn (default: 25)
  --json                    emit one JSON object per line instead of human-readable output

Config file (optional, both fully optional): ~/.cortex/config.json then ./.cortex/config.json (project overrides user).
Same keys as the flags above (host, model, fastModel, provider, apiKey, temperature, maxSteps,
contextBudgetTokens, sandboxMode, sandboxAllowNetwork, approveForMe, autoApprove), plus "profiles":
{ "fast": { "model": "llama3.2:1b", "sandboxMode": "workspace-write" } }
`);
}

function emit(opts, obj, humanLine) {
  if (opts.json) console.log(JSON.stringify(obj));
  else if (humanLine) console.log(humanLine);
}

async function runOnce(opts, text, history) {
  return new Promise((resolve) => {
    runTurn({
      history,
      root: opts.root,
      host: opts.host,
      provider: opts.provider,
      apiKey: opts.apiKey,
      model: opts.model,
      fastModel: opts.fastModel,
      temperature: opts.temperature,
      maxSteps: opts.maxSteps,
      contextBudgetTokens: opts.contextBudgetTokens,
      memoryNotes: loadMemoryNotes(opts.root),
      planMode: false,
      ctx: { host: opts.host, sandboxMode: opts.sandboxMode, sandboxAllowNetwork: opts.sandboxAllowNetwork },
      onToken: () => {},
      onToolCall: (name, args) => emit(opts, { type: 'toolCall', name, args }, `> ${name}(${JSON.stringify(args)})`),
      requestApproval: async (name, args) => {
        if (opts.autoApprove) return true;
        if (opts.approveForMe) {
          const review = await reviewAction(
            { host: opts.host, provider: opts.provider, apiKey: opts.apiKey, model: opts.fastModel || opts.model },
            name,
            args,
            text
          );
          emit(opts, { type: 'autoReview', name, safe: review.safe, reason: review.reason }, `  ~ auto-review: ${review.safe ? 'SAFE' : 'needs human'} — ${review.reason}`);
          if (review.safe) return true;
        }
        if (!opts.json) {
          const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
          const answer = await new Promise((res) => rl.question(`Approve ${name}(${JSON.stringify(args)})? [y/N] `, res));
          rl.close();
          return /^y/i.test(answer);
        }
        return false; // no interactive approval in --json/CI mode; use --auto-approve instead
      },
      onToolResult: (result, isError) =>
        emit(opts, { type: 'toolResult', result, isError }, isError ? `  ! ${result}` : `  = ${result.slice(0, 200)}`),
      onFinal: (finalText) => {
        emit(opts, { type: 'final', text: finalText }, finalText);
        resolve();
      },
      onError: (message) => {
        emit(opts, { type: 'error', message }, `Error: ${message}`);
        resolve();
      },
    });
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.prompt) {
    const history = [{ role: 'user', content: opts.prompt }];
    await runOnce(opts, opts.prompt, history);
    return;
  }

  console.log(`Cortex CLI — ${opts.model} via ${opts.host} (${opts.provider}). Working dir: ${opts.root}`);
  console.log('Type a request, or Ctrl+C to exit.\n');
  const history = [];
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });
  rl.prompt();
  rl.on('line', async (line) => {
    if (!line.trim()) {
      rl.prompt();
      return;
    }
    history.push({ role: 'user', content: line });
    await runOnce(opts, line, history);
    rl.prompt();
  });
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
