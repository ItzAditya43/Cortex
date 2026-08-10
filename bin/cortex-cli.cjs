#!/usr/bin/env node
// Headless CLI for Cortex — runs the same agent loop used by the VS Code
// extension, but from a terminal with zero VS Code dependency. Two modes:
//   cortex-cli                      interactive REPL in the current directory
//   cortex-cli -p "prompt" [--json] one-shot run, exits after the final answer
// The --json flag makes it suitable for CI: prints one JSON object per line
// (tool calls, tool results, final answer) instead of human-readable text.

'use strict';

const path = require('path');
const readline = require('readline');
const { runTurn } = require('../src/agentLoop.cjs');
const { loadMemoryNotes } = require('../src/memory.cjs');

function parseArgs(argv) {
  const opts = {
    root: process.cwd(),
    host: process.env.CORTEX_HOST || 'http://localhost:11434',
    provider: process.env.CORTEX_PROVIDER || 'ollama',
    apiKey: process.env.CORTEX_API_KEY || '',
    model: process.env.CORTEX_MODEL || 'qwen2.5-coder:3b',
    temperature: 0.2,
    maxSteps: 25,
    contextBudgetTokens: 6000,
    autoApprove: false,
    json: false,
    prompt: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-p' || a === '--prompt') opts.prompt = argv[++i];
    else if (a === '--model') opts.model = argv[++i];
    else if (a === '--host') opts.host = argv[++i];
    else if (a === '--provider') opts.provider = argv[++i];
    else if (a === '--api-key') opts.apiKey = argv[++i];
    else if (a === '--auto-approve') opts.autoApprove = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--max-steps') opts.maxSteps = parseInt(argv[++i], 10);
    else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    }
  }
  return opts;
}

function printHelp() {
  console.log(`cortex-cli — headless Cortex agent

Usage:
  cortex-cli                             interactive REPL in this directory
  cortex-cli -p "<prompt>" [flags]       one-shot run, exits when done

Flags:
  --model <name>        model to use (default: qwen2.5-coder:3b, or $CORTEX_MODEL)
  --host <url>          provider host (default: http://localhost:11434, or $CORTEX_HOST)
  --provider <name>     "ollama" or "openai-compatible" (default: ollama, or $CORTEX_PROVIDER)
  --api-key <key>       API key for openai-compatible providers (or $CORTEX_API_KEY)
  --auto-approve        run mutating tools without confirmation (needed for CI/unattended use)
  --max-steps <n>       max tool-call steps per turn (default: 25)
  --json                emit one JSON object per line instead of human-readable output
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
      temperature: opts.temperature,
      maxSteps: opts.maxSteps,
      contextBudgetTokens: opts.contextBudgetTokens,
      memoryNotes: loadMemoryNotes(opts.root),
      planMode: false,
      onToken: () => {},
      onToolCall: (name, args) => emit(opts, { type: 'toolCall', name, args }, `> ${name}(${JSON.stringify(args)})`),
      requestApproval: async (name, args) => {
        if (opts.autoApprove) return true;
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
