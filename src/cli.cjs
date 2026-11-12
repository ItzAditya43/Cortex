// The Cortex command-line agent: the same agent loop the VS Code extension
// runs, driven from a terminal with no VS Code dependency.
//
//   cortex                         interactive session in the current directory
//   cortex "fix the failing test"  interactive, starting with that request
//   cortex -p "prompt"             one-shot: prints the answer and exits
//   cortex exec "prompt"           same as -p (Codex-style)
//   git diff | cortex -p "review"  piped input is appended to the prompt
//   cortex -c                      continue the most recent session here
//
// Sessions, checkpoints, memory, project rules and custom commands live in
// the same .cortex/ folder the extension uses, so the two share history.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const { execFileSync, spawnSync } = require('child_process');

const { runTurn } = require('./agentLoop.cjs');
const { tools, isToolAvailable, stopAllBackground } = require('./tools.cjs');
const { expandMentions, workspaceFiles, stripAttachments } = require('./mentions.cjs');
const memory = require('./memory.cjs');
const { reviewAction } = require('./approveForMe.cjs');
const { applyProfile } = require('./profiles.cjs');
const { shouldAutoApprove } = require('./permissions.cjs');
const { classifyCommand } = require('./dangerousCommands.cjs');
const { saveSnapshot, loadSnapshots, deleteSnapshot, restoreSnapshot, pruneOldSessions } = require('./checkpoints.cjs');
const { compactHistory } = require('./compactor.cjs');
const { resolveContextBudget, historyTokens } = require('./contextManager.cjs');
const { listModels } = require('./provider.cjs');
const { generateProjectRules } = require('./initRules.cjs');
const { listCustomCommands, expandCustomCommand } = require('./slashCommands.cjs');
const { startMcpServers, stopMcpServers } = require('./mcpManager.cjs');
const { clearTasks } = require('./taskList.cjs');
const ui = require('./cliUi.cjs');

const { c } = ui;
const VERSION = (() => {
  try {
    return require('../package.json').version;
  } catch {
    return '0.0.0';
  }
})();

const USER_DIR = path.join(os.homedir(), '.cortex');
const USER_CONFIG = path.join(USER_DIR, 'config.json');
const HISTORY_FILE = path.join(USER_DIR, 'cli_history');

// ---------------------------------------------------------------- config

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(c.yellow(`warning: could not parse ${file}: ${err.message}`));
    return {};
  }
}

// User-level (~/.cortex/config.json) then project-level (.cortex/config.json)
// — project overrides user. Same keys as the VS Code settings, without the
// "cortex." prefix. Entirely optional.
function loadConfigFile(root) {
  return { ...readJson(USER_CONFIG), ...readJson(path.join(root, '.cortex', 'config.json')) };
}

function saveUserConfig(patch) {
  try {
    fs.mkdirSync(USER_DIR, { recursive: true });
    fs.writeFileSync(USER_CONFIG, `${JSON.stringify({ ...readJson(USER_CONFIG), ...patch }, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

const HELP = `cortex ${VERSION} — a coding agent for your terminal

Usage:
  cortex [prompt]                 interactive session (optionally starting with a request)
  cortex -p "<prompt>"            one-shot: print the answer and exit   (alias: cortex exec "<prompt>")
  <command> | cortex -p "..."     piped input is appended to the prompt
  cortex -c                       continue the most recent session in this directory
  cortex -r [id]                  resume a session (pick from a list when no id is given)

Model:
  -m, --model <name>              model to use                          ($CORTEX_MODEL)
      --fast-model <name>         smaller model for read-only investigation steps
      --escalate-model <name>     stronger model to switch to after repeated failures
      --provider <name>           ollama | openai-compatible            ($CORTEX_PROVIDER)
      --host <url>                server URL                            ($CORTEX_HOST)
      --api-key <key>             key for openai-compatible servers     ($CORTEX_API_KEY)
      --tool-calling <mode>       auto | native | text
      --context-budget <tokens>   conversation tokens per request (default: sized to the model)
      --max-steps <n>             model round-trips allowed per request (default 50)

Permissions:
      --plan                      start in plan mode (read-only: investigate and propose)
  -y, --auto-approve              don't ask before edits and commands (dangerous commands still ask)
      --approval-policy <p>       untrusted | on-request | never
      --sandbox <mode>            read-only | workspace-write | danger-full-access
      --sandbox-allow-network     allow network inside the workspace-write sandbox
      --approve-for-me            let a model review pending approvals before asking you

Output:
      --json                      one JSON event per line (for scripts and CI)
  -q, --quiet                     with -p: print only the final answer

Other:
  -C, --cwd <dir>                 work in this directory
      --profile <name>            apply a preset from the "profiles" key of the config file
      --test-command <cmd>        run after a turn that changed files; failures go back to the model
      --no-session                don't save this conversation
  -v, --version                   print the version
  -h, --help                      show this help

Config: ~/.cortex/config.json, then ./.cortex/config.json (project wins). Keys match the flags in
camelCase (model, provider, host, apiKey, approvalPolicy, sandboxMode, autoApproveCommands,
mcpServers, profiles, ...). Inside a session, type /help for commands.
`;

/**
 * @param {string[]} argv
 * @param {{env?: Record<string, string|undefined>, cwd?: string}} [io]
 */
function parseArgs(argv, { env = process.env, cwd = process.cwd() } = {}) {
  // --cwd has to be known before the config file can be found.
  let root = cwd;
  for (let i = 0; i < argv.length; i++) {
    if ((argv[i] === '-C' || argv[i] === '--cwd') && argv[i + 1]) root = path.resolve(cwd, argv[i + 1]);
  }
  const fileCfg = loadConfigFile(root);
  const provider = env.CORTEX_PROVIDER || fileCfg.provider || 'ollama';

  const opts = {
    root,
    host: env.CORTEX_HOST || fileCfg.host || (provider === 'openai-compatible' ? 'https://api.openai.com' : 'http://localhost:11434'),
    provider,
    apiKey: env.CORTEX_API_KEY || fileCfg.apiKey || (provider === 'openai-compatible' ? env.OPENAI_API_KEY || '' : ''),
    model: env.CORTEX_MODEL || fileCfg.model || 'qwen2.5-coder:3b',
    fastModel: env.CORTEX_FAST_MODEL || fileCfg.fastModel || '',
    escalateModel: fileCfg.escalateModel || '',
    testCommand: fileCfg.testCommand || '',
    temperature: fileCfg.temperature ?? 0.2,
    maxSteps: fileCfg.maxSteps ?? 50,
    contextBudgetTokens: fileCfg.contextBudgetTokens ?? 0,
    numCtx: fileCfg.numCtx ?? 0,
    toolCalling: fileCfg.toolCalling || 'auto',
    autoApprove: !!fileCfg.autoApprove,
    approvalPolicy: fileCfg.approvalPolicy || 'untrusted',
    autoApproveCommands: Array.isArray(fileCfg.autoApproveCommands) ? fileCfg.autoApproveCommands : [],
    sandboxMode: fileCfg.sandboxMode || 'danger-full-access',
    sandboxAllowNetwork: !!fileCfg.sandboxAllowNetwork,
    approveForMe: !!fileCfg.approveForMe,
    webhookUrl: fileCfg.webhookUrl || '',
    mcpServers: Array.isArray(fileCfg.mcpServers) ? fileCfg.mcpServers : [],
    json: false,
    quiet: false,
    prompt: null, // one-shot prompt
    initialPrompt: null, // first message of an interactive session
    planMode: false,
    continueLast: false,
    resume: null, // session id, or true to pick
    noSession: false,
    profile: fileCfg.activeProfile || '',
    help: false,
    version: false,
  };

  const positional = [];
  const need = (i, flag) => {
    if (argv[i + 1] === undefined) throw new Error(`${flag} needs a value`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-p' || a === '--prompt' || a === '--print') {
      // -p with no text is allowed when the prompt comes from stdin
      if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('-')) opts.prompt = argv[++i];
      else opts.prompt = opts.prompt ?? '';
    } else if (a === '-m' || a === '--model') opts.model = need(i++, a);
    else if (a === '--fast-model') opts.fastModel = need(i++, a);
    else if (a === '--escalate-model') opts.escalateModel = need(i++, a);
    else if (a === '--host') opts.host = need(i++, a);
    else if (a === '--provider') opts.provider = need(i++, a);
    else if (a === '--api-key') opts.apiKey = need(i++, a);
    else if (a === '-y' || a === '--auto-approve' || a === '--yolo') opts.autoApprove = true;
    else if (a === '--approval-policy') opts.approvalPolicy = need(i++, a);
    else if (a === '--sandbox') opts.sandboxMode = need(i++, a);
    else if (a === '--sandbox-allow-network') opts.sandboxAllowNetwork = true;
    else if (a === '--approve-for-me') opts.approveForMe = true;
    else if (a === '--profile') opts.profile = need(i++, a);
    else if (a === '--json') opts.json = true;
    else if (a === '-q' || a === '--quiet') opts.quiet = true;
    else if (a === '--max-steps') opts.maxSteps = parseInt(need(i++, a), 10) || opts.maxSteps;
    else if (a === '--context-budget') opts.contextBudgetTokens = parseInt(need(i++, a), 10) || 0;
    else if (a === '--tool-calling') opts.toolCalling = need(i++, a);
    else if (a === '--test-command') opts.testCommand = need(i++, a);
    else if (a === '--plan') opts.planMode = true;
    else if (a === '-c' || a === '--continue') opts.continueLast = true;
    else if (a === '-r' || a === '--resume') {
      if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('-')) opts.resume = argv[++i];
      else opts.resume = true;
    } else if (a === '--no-session') opts.noSession = true;
    else if (a === '-C' || a === '--cwd') i++;
    else if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '-v' || a === '--version') opts.version = true;
    else if (a === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    } else if (a.startsWith('-') && a.length > 1) throw new Error(`unknown option ${a} (see cortex --help)`);
    else positional.push(a);
  }

  if (positional[0] === 'exec') {
    positional.shift();
    opts.prompt = [opts.prompt, positional.join(' ')].filter(Boolean).join(' ');
  } else if (positional.length) {
    if (opts.prompt !== null) opts.prompt = [opts.prompt, positional.join(' ')].filter(Boolean).join(' ');
    else opts.initialPrompt = positional.join(' ');
  }
  // A provider chosen on the command line changes which default host makes sense.
  if (opts.provider === 'openai-compatible' && !env.CORTEX_HOST && !fileCfg.host && !argv.includes('--host')) opts.host = 'https://api.openai.com';
  if (opts.provider === 'openai-compatible' && !opts.apiKey) opts.apiKey = env.OPENAI_API_KEY || '';

  const profiles = fileCfg.profiles || {};
  if (opts.profile && !profiles[opts.profile]) {
    console.error(c.yellow(`warning: profile "${opts.profile}" not found in ~/.cortex/config.json or ./.cortex/config.json`));
  }
  return opts.profile ? applyProfile(opts, profiles, opts.profile) : opts;
}

// --------------------------------------------------------------- session

class Session {
  constructor(opts) {
    this.opts = opts;
    this.root = opts.root;
    this.id = crypto.randomUUID().slice(0, 8);
    this.history = [];
    this.turns = []; // {id, historyStart, callIds, compacted}
    this.snapshots = new Map(); // callId -> snapshot
    this.planMode = !!opts.planMode;
    this.allowTools = new Set(); // approved "always" this session
    this.allowCommands = []; // command prefixes approved "always" this session
    this.usage = { promptTokens: 0, completionTokens: 0, lastPromptTokens: 0, budget: 0, requests: 0 };
    this.persist = !opts.noSession;
  }

  save() {
    if (!this.persist || !this.history.length) return;
    try {
      memory.saveHistory(this.root, this.id, this.history);
      memory.touchSession(this.root, this.id, this.history);
    } catch {
      // a read-only directory must not break the session itself
    }
  }

  load(id) {
    const history = memory.loadHistory(this.root, id);
    if (!history.length) return false;
    this.id = id;
    this.history = history;
    this.turns = [];
    this.snapshots.clear();
    return true;
  }

  reset() {
    this.id = crypto.randomUUID().slice(0, 8);
    this.history = [];
    this.turns = [];
    this.snapshots.clear();
    this.usage.lastPromptTokens = 0;
  }
}

// ------------------------------------------------------------- one turn

function chatOpts(opts) {
  return { host: opts.host, provider: opts.provider, apiKey: opts.apiKey, model: opts.model };
}

// "npm test -- --watch" -> "npm test"; "ls -la" -> "ls". The prefix an
// "always allow" answer trusts for the rest of the session.
function commandPrefix(command) {
  const words = String(command || '').trim().split(/\s+/);
  if (!words[0]) return '';
  const withSub = ['npm', 'pnpm', 'yarn', 'bun', 'git', 'cargo', 'go', 'docker', 'kubectl', 'make', 'npx', 'python', 'python3', 'pip', 'node', 'deno', 'dotnet', 'gradle', 'mvn'];
  if (withSub.includes(words[0]) && words[1] && !words[1].startsWith('-')) {
    return words[1] === 'run' && words[2] ? words.slice(0, 3).join(' ') : words.slice(0, 2).join(' ');
  }
  return words[0];
}

// A prefix match must not let "npm test && rm -rf ~" ride in on "npm test".
function chainsCommands(command) {
  return /[;&|`\n]|\$\(/.test(String(command || ''));
}

/**
 * Runs one user message through the agent loop, rendering as it goes.
 * @param {Session} session
 * @param {string} text  the message as typed
 * @param {{ask?: (q: string, signal?: AbortSignal) => Promise<string|null>, signal?: AbortSignal, interactive?: boolean}} io
 * @returns {Promise<{ok: boolean, final: string|null, error: string|null, cancelled: boolean}>}
 */
async function runMessage(session, text, { ask, signal, interactive = false } = {}) {
  const { opts, root, history } = session;
  const json = opts.json;
  const human = !json;
  // One-shot mode keeps stdout for the answer alone, so it can be piped.
  const progress = (s) => {
    if (!human) return;
    if (interactive) process.stdout.write(s);
    else if (!opts.quiet) process.stderr.write(s);
  };
  const emit = (obj) => {
    if (json) process.stdout.write(`${JSON.stringify(obj)}\n`);
  };

  const mentioned = expandMentions(text, root);
  if (mentioned.attached.length) progress(c.gray(`  ⎿ attached ${mentioned.attached.join(', ')}\n`));
  if (mentioned.missing.length) progress(c.yellow(`  ⎿ not found, not attached: ${mentioned.missing.join(', ')}\n`));

  const turn = { id: crypto.randomUUID().slice(0, 8), historyStart: history.length, callIds: [], compacted: false };
  session.turns.push(turn);
  history.push({ role: 'user', content: mentioned.content });

  const spinner = ui.makeSpinner();
  const spin = (label) => {
    if (interactive && human) spinner.start(label);
  };
  const md = interactive && human ? ui.makeMarkdownStream((s) => (spinner.stop(), process.stdout.write(s))) : null;
  const startedAt = Date.now();
  const calls = new Map(); // callId -> {name, args, title, diffShown}
  let lastCallId = null;
  let steps = 0;
  let final = null;
  let error = null;
  let streamedFinal = false;
  let subDepth = 0;

  const printCall = (name, args, indent = '') => {
    const { label, detail } = ui.toolTitle(name, args);
    progress(`${indent}${c.cyan('●')} ${c.bold(label)}${detail ? c.gray('(') + detail + c.gray(')') : ''}\n`);
    return `${label}${detail ? `(${detail})` : ''}`;
  };
  const printResult = (name, result, isError, /** @type {{title?: string, indent?: string}} */ { title, indent = '' } = {}) => {
    const lines = ui.summarizeResult(name, result, isError);
    lines.forEach((line, i) => {
      const lead = i === 0 ? `${indent}  ⎿ ${title ? `${title}: ` : ''}` : `${indent}    `;
      progress(`${c.gray(lead)}${isError ? c.red(line) : c.gray(line)}\n`);
    });
  };

  try {
    await runTurn({
      history,
      root,
      host: opts.host,
      provider: opts.provider,
      apiKey: opts.apiKey,
      model: opts.model,
      fastModel: opts.fastModel,
      escalateModel: opts.escalateModel,
      testCommand: opts.testCommand,
      temperature: opts.temperature,
      maxSteps: opts.maxSteps,
      contextBudgetTokens: opts.contextBudgetTokens,
      numCtx: opts.numCtx,
      toolCalling: opts.toolCalling,
      memoryNotes: memory.loadMemoryNotes(root),
      planMode: session.planMode,
      signal,
      ctx: {
        host: opts.host,
        sandboxMode: opts.sandboxMode,
        sandboxAllowNetwork: opts.sandboxAllowNetwork,
        webhookUrl: opts.webhookUrl,
        delegateConfig: {
          host: opts.host,
          provider: opts.provider,
          apiKey: opts.apiKey,
          model: opts.model,
          fastModel: opts.fastModel,
          temperature: opts.temperature,
          maxSteps: opts.maxSteps,
          contextBudgetTokens: opts.contextBudgetTokens,
          toolCalling: opts.toolCalling,
        },
        onSubTaskEvent: (kind, payload) => {
          spinner.stop();
          if (kind === 'toolCall') {
            subDepth = 1;
            emit({ type: 'subTaskCall', ...payload });
            printCall(payload.name, payload.args, '    ');
          } else emit({ type: 'subTaskResult', isError: payload.isError });
          spin('Sub-agent working');
        },
      },
      onContext: ({ budgetTokens }) => {
        session.usage.budget = budgetTokens;
      },
      onCompact: ({ summarized }) => {
        for (const t of session.turns) t.compacted = true;
        emit({ type: 'compacted', summarized });
      },
      onStep: (n) => {
        steps = n;
        md?.end();
        spin(n === 1 ? 'Thinking' : 'Working');
      },
      onToken: (t) => md?.token(t),
      onThinking: () => {
        if (spinner.active) return;
        spin('Thinking');
      },
      onUsage: (u) => {
        session.usage.promptTokens += u.promptTokens;
        session.usage.completionTokens += u.completionTokens;
        session.usage.lastPromptTokens = u.promptTokens;
        session.usage.requests++;
        if (u.contextBudget) session.usage.budget = u.contextBudget;
      },
      onRecovery: (kind, message) => {
        spinner.stop();
        emit({ type: 'notice', kind, message });
        progress(c.yellow(`  ⎿ ${message}\n`));
        spin('Working');
      },
      onTestRun: (command, result, failed) => {
        spinner.stop();
        emit({ type: 'testRun', command, failed });
        progress(`${c.cyan('●')} ${c.bold('Test')}${c.gray('(')}${command}${c.gray(')')}\n${c.gray('  ⎿ ')}${failed ? c.red('failed — sent back to the model') : c.green('passed')}\n`);
        spin('Working');
      },
      onToolCall: (name, args, callId) => {
        spinner.stop();
        md?.end();
        subDepth = 0;
        emit({ type: 'toolCall', name, args, id: callId });
        const title = printCall(name, args);
        calls.set(callId, { name, args, title, diffShown: false });
        lastCallId = callId;
        spin(tools[name]?.kind === 'command' ? 'Running' : 'Working');
      },
      requestApproval: async (name, args, callId) => {
        const tool = tools[name];
        const command = tool?.kind === 'command' ? args.command : undefined;
        const risk = command ? classifyCommand(command) : { dangerous: false };
        const sessionAllowsCommand =
          !!command && !risk.dangerous && !chainsCommands(command) && session.allowCommands.some((p) => command.trim() === p || command.trim().startsWith(`${p} `));
        if (
          sessionAllowsCommand ||
          shouldAutoApprove(name, {
            autoApprove: opts.autoApprove,
            autoApproveTools: [...session.allowTools],
            autoApproveCommands: chainsCommands(command) ? [] : opts.autoApproveCommands,
            commandArg: command,
            approvalPolicy: opts.approvalPolicy,
            sandboxMode: opts.sandboxMode,
            toolKind: tool?.kind,
          })
        ) {
          return true;
        }
        spinner.stop();
        if (opts.approveForMe && !risk.dangerous) {
          spin('Reviewing');
          const review = await reviewAction({ host: opts.host, provider: opts.provider, apiKey: opts.apiKey, model: opts.fastModel || opts.model }, name, args, text);
          spinner.stop();
          emit({ type: 'autoReview', name, safe: review.safe, reason: review.reason });
          progress(c.gray(`  ⎿ auto-review: ${review.safe ? 'safe' : 'needs you'} — ${review.reason}\n`));
          if (review.safe) return true;
        }
        if (!interactive || !ask) {
          const why = risk.dangerous ? `"${risk.why}" commands always need a person to approve them` : 'pass --auto-approve to allow changes when running unattended';
          emit({ type: 'declined', name, reason: why });
          progress(c.yellow(`  ⎿ not run: ${why}\n`));
          return { approved: false, feedback: `not approved, and nobody is present to approve it in this run — do not retry it; finish what you can without it and say what you could not do` };
        }

        // Show exactly what would happen before asking.
        const info = calls.get(callId);
        if (tool?.preview) {
          try {
            const p = tool.preview(args, root);
            if (p?.error) process.stdout.write(c.red(`    ${p.error}\n`));
            else if (p?.files) {
              for (const f of p.files) {
                const d = ui.renderDiff(f.before, f.after);
                process.stdout.write(`${c.gray(`    ${f.path}  `)}${c.green(`+${d.add}`)} ${c.red(`-${d.del}`)}\n${d.text}\n`);
              }
              if (info) info.diffShown = true;
            } else if (p && p.renameFrom) {
              // the title already says "from → to"
            } else if (p) {
              const d = ui.renderDiff(p.before, p.after);
              process.stdout.write(`${c.gray(`    ${p.created ? 'new file' : p.path}  `)}${c.green(`+${d.add}`)} ${c.red(`-${d.del}`)}\n${d.text ? `${d.text}\n` : ''}`);
              if (info) info.diffShown = true;
            }
          } catch {
            // the preview is a courtesy; the question still gets asked
          }
        } else if (command && (command.includes('\n') || command.length > ui.width() - 20)) {
          // the title line already shows a short command in full
          process.stdout.write(`${command.split('\n').map((l) => `    ${c.bold(l)}`).join('\n')}\n`);
        } else if (!tool?.kind) {
          process.stdout.write(c.gray(`    ${ui.short(JSON.stringify(args), 400)}\n`));
        }
        if (risk.dangerous) process.stdout.write(c.red(`    ⚠ ${risk.why} — this kind of command is never auto-approved\n`));

        const prefix = command && !chainsCommands(command) ? commandPrefix(command) : '';
        const always = risk.dangerous
          ? ''
          : tool?.kind === 'edit'
            ? ` · ${c.bold('a')} always allow edits`
            : command
              ? prefix
                ? ` · ${c.bold('a')} always allow "${prefix}"`
                : ''
              : ` · ${c.bold('a')} always allow ${name}`;
        const answer = await ask(`  ${c.yellow('Allow?')} ${c.bold('y')} yes · ${c.bold('n')} no${always} · or say what to do instead\n  ${c.yellow('›')} `, signal);
        if (answer === null) return false; // interrupted
        const a = answer.trim();
        if (/^(y|yes)$/i.test(a)) return true;
        if (/^(a|always)$/i.test(a) && always) {
          if (tool?.kind === 'edit') for (const [n, t] of Object.entries(tools)) if (t.kind === 'edit') session.allowTools.add(n);
          if (command && prefix) session.allowCommands.push(prefix);
          if (!tool?.kind) session.allowTools.add(name);
          return true;
        }
        if (!a || /^(n|no)$/i.test(a)) return false;
        return { approved: false, feedback: a };
      },
      onToolResult: (result, isError, callId, snapshot) => {
        spinner.stop();
        const info = callId ? calls.get(callId) : null;
        emit({ type: 'toolResult', id: callId, name: info?.name, result, isError });
        if (subDepth && !info) return; // a sub-agent's result; its call line is enough
        if (snapshot && callId) {
          session.snapshots.set(callId, snapshot);
          turn.callIds.push(callId);
          if (session.persist) saveSnapshot(root, session.id, callId, snapshot, turn.id);
        }
        const title = info && callId !== lastCallId ? info.title : undefined;
        if (snapshot && !isError && !snapshot.renameFrom) {
          const files = snapshot.files || [snapshot];
          let add = 0;
          let del = 0;
          const diffs = files.map((f) => {
            const d = ui.renderDiff(f.before, f.after, { maxLines: 40 });
            add += d.add;
            del += d.del;
            return files.length > 1 ? `${c.gray(`    ${f.path}`)}\n${d.text}` : d.text;
          });
          const verb = snapshot.created ? 'Created' : info?.name === 'delete_file' ? 'Deleted' : 'Updated';
          progress(`${c.gray(`  ⎿ ${title ? `${title}: ` : ''}${verb} `)}${c.green(`+${add}`)} ${c.red(`-${del}`)}${/matched \w+-insensitive/.test(result) ? c.gray(' (whitespace-tolerant match)') : ''}\n`);
          if (!info?.diffShown && info?.name !== 'delete_file') progress(`${diffs.filter(Boolean).join('\n')}\n`);
          const warn = String(result).match(/SYNTAX WARNING:[^\n]*/);
          if (warn) progress(c.yellow(`    ${warn[0]}\n`));
        } else if (info) {
          printResult(info.name, result, isError, { title });
        } else {
          printResult('', result, isError);
        }
        spin('Working');
      },
      onFinal: (finalText, n) => {
        spinner.stop();
        steps = n;
        final = finalText;
        streamedFinal = md ? md.end() : false;
      },
      onError: (message) => {
        spinner.stop();
        md?.end();
        error = message;
      },
    });
  } catch (err) {
    spinner.stop();
    md?.end();
    error = err.message;
  }
  spinner.stop();
  md?.end();

  const cancelled = !!signal?.aborted;
  session.save();
  if (session.persist) pruneOldSessions(root);

  const elapsedMs = Date.now() - startedAt;
  if (json) {
    if (cancelled) emit({ type: 'cancelled' });
    else if (error) emit({ type: 'error', message: error });
    else emit({ type: 'final', text: final ?? '', steps, elapsedMs, sessionId: session.id, usage: { promptTokens: session.usage.promptTokens, completionTokens: session.usage.completionTokens } });
  } else {
    if (final !== null && !streamedFinal) process.stdout.write(interactive ? ui.renderMarkdown(final) : `${final}\n`);
    if (error) process.stderr.write(`${c.red(`✖ ${error}`)}\n`);
    if (cancelled) progress(c.yellow('  ⎿ interrupted — tell Cortex what to do differently\n'));
    if (interactive) process.stdout.write(`${c.gray(statusLine(session, { steps, elapsedMs }))}\n\n`);
  }
  return { ok: final !== null && !error && !cancelled, final, error, cancelled };
}

/** @param {Session} session @param {{steps?: number, elapsedMs?: number}} [turn] */
function statusLine(session, { steps, elapsedMs } = {}) {
  const u = session.usage;
  const parts = [session.opts.model];
  if (u.lastPromptTokens && u.budget) parts.push(`${ui.fmtTokens(u.lastPromptTokens)}/${ui.fmtTokens(u.budget)} context (${Math.min(100, Math.round((u.lastPromptTokens / u.budget) * 100))}%)`);
  else if (u.budget) parts.push(`~${ui.fmtTokens(historyTokens(session.history))}/${ui.fmtTokens(u.budget)} context`);
  if (steps) parts.push(`${steps} step${steps === 1 ? '' : 's'}`);
  if (elapsedMs) parts.push(elapsedMs >= 60_000 ? `${Math.floor(elapsedMs / 60_000)}m ${Math.round((elapsedMs % 60_000) / 1000)}s` : `${(elapsedMs / 1000).toFixed(1)}s`);
  if (session.planMode) parts.push('plan mode');
  return `  ${parts.join(' · ')}`;
}

// ------------------------------------------------------- slash commands

const BUILTINS = [
  ['help', 'show commands'],
  ['clear', 'start a new conversation (the old one stays in /resume)'],
  ['compact', 'summarize the conversation so far to free up context'],
  ['model', 'show or switch the model: /model [name]'],
  ['plan', 'toggle plan mode (read-only: investigate and propose, change nothing)'],
  ['approvals', 'show or set when Cortex asks: /approvals [untrusted|on-request|never]'],
  ['undo', "revert the file changes of the last turn and drop it from the conversation"],
  ['diff', 'show uncommitted changes (git diff)'],
  ['status', 'model, context use, session and permission settings'],
  ['resume', 'continue an earlier conversation from this directory'],
  ['init', 'scan the project and write .cortexrules with its conventions'],
  ['memory', 'show the notes Cortex keeps about this project'],
  ['tools', 'list the tools available to the agent'],
  ['exit', 'quit (also /quit, Ctrl+D)'],
];

function colorizeDiff(text) {
  return text
    .split('\n')
    .map((l) => (/^\+(?!\+\+)/.test(l) ? c.green(l) : /^-(?!--)/.test(l) ? c.red(l) : /^@@/.test(l) ? c.cyan(l) : /^(diff|index|\+\+\+|---)/.test(l) ? c.bold(l) : l))
    .join('\n');
}

/**
 * @param {Session} session
 * @param {string} line
 * @param {{ask: (q: string, signal?: AbortSignal) => Promise<string|null>}} io
 * @returns {Promise<{handled: boolean, exit?: boolean, send?: string}>}
 */
async function handleSlash(session, line, { ask }) {
  const m = line.trim().match(/^\/([\w-]+)(?:\s+([\s\S]*))?$/);
  if (!m) return { handled: false };
  const cmd = m[1].toLowerCase();
  const arg = (m[2] || '').trim();
  const { opts, root } = session;
  const say = (s = '') => process.stdout.write(`${s}\n`);

  switch (cmd) {
    case 'help':
    case '?': {
      say(c.bold('Commands'));
      for (const [name, desc] of BUILTINS) say(`  ${c.cyan(`/${name}`.padEnd(12))} ${desc}`);
      const custom = listCustomCommands(root);
      if (custom.length) {
        say(c.bold('\nYour commands') + c.gray('  (.cortex/commands/*.md)'));
        for (const cc of custom) say(`  ${c.cyan(`/${cc.name}`.padEnd(12))} ${cc.description}`);
      }
      say(c.bold('\nInput'));
      say(`  ${c.cyan('@path'.padEnd(12))} attach a file or folder to your message (Tab completes)`);
      say(`  ${c.cyan('!command'.padEnd(12))} run a shell command yourself; its output joins the conversation`);
      say(`  ${c.cyan('\\'.padEnd(12))} at the end of a line continues it on the next`);
      say(`  ${c.cyan('Esc / Ctrl+C'.padEnd(12))} interrupt a running turn · Ctrl+C twice or Ctrl+D to quit\n`);
      return { handled: true };
    }
    case 'exit':
    case 'quit':
      return { handled: true, exit: true };
    case 'clear':
    case 'new':
      session.save();
      session.reset();
      clearTasks(root);
      say(c.gray('  Started a new conversation.\n'));
      return { handled: true };
    case 'compact': {
      if (session.history.length < 3) {
        say(c.gray('  Nothing to compact yet.\n'));
        return { handled: true };
      }
      const before = historyTokens(session.history);
      const spinner = ui.makeSpinner();
      spinner.start('Summarizing');
      const budgetTokens = session.usage.budget || (await resolveContextBudget({ ...chatOpts(opts), configured: opts.contextBudgetTokens }));
      const res = await compactHistory({ history: session.history, chatOpts: chatOpts(opts), budgetTokens, keepTail: false }).catch((err) => ({ ok: false, summarized: 0, reason: err.message }));
      spinner.stop();
      if (!res.ok) say(c.red(`  Could not compact: ${res.reason}\n`));
      else {
        for (const t of session.turns) t.compacted = true;
        session.usage.lastPromptTokens = 0;
        session.save();
        say(c.gray(`  Compacted ${res.summarized} messages: ~${ui.fmtTokens(before)} → ~${ui.fmtTokens(historyTokens(session.history))} tokens.\n`));
      }
      return { handled: true };
    }
    case 'model': {
      let pick = arg;
      if (!pick) {
        let models;
        try {
          models = await listModels(chatOpts(opts));
        } catch (err) {
          say(c.red(`  ${err.message}\n`));
          return { handled: true };
        }
        models = models.filter((x) => !/embed/i.test(x.name));
        if (!models.length) {
          say(c.yellow('  No models found. Pull one first, e.g. `ollama pull qwen2.5-coder:7b`.\n'));
          return { handled: true };
        }
        models.forEach((x, i) => say(`  ${c.gray(String(i + 1).padStart(2))}  ${x.name === opts.model ? c.green(`${x.name}  ← current`) : x.name}${x.size ? c.gray(`  ${(x.size / 1e9).toFixed(1)} GB`) : ''}`));
        const answer = await ask(`  ${c.yellow('Model number or name')} ${c.gray('(Enter to keep the current one)')} › `);
        const a = (answer || '').trim();
        if (!a) return { handled: true };
        pick = /^\d+$/.test(a) && models[Number(a) - 1] ? models[Number(a) - 1].name : a;
      }
      opts.model = pick;
      session.usage.budget = 0;
      session.usage.lastPromptTokens = 0;
      const saved = saveUserConfig({ model: pick });
      say(c.gray(`  Model set to ${c.bold(pick)}${saved ? ' (saved as your default in ~/.cortex/config.json)' : ''}.\n`));
      return { handled: true };
    }
    case 'plan':
    case 'act':
      session.planMode = cmd === 'plan' ? (arg === 'off' ? false : arg === 'on' ? true : !session.planMode) : false;
      say(c.gray(session.planMode ? '  Plan mode on — Cortex will investigate and propose, and change nothing. /plan again to switch back.\n' : '  Plan mode off — Cortex can make changes.\n'));
      return { handled: true };
    case 'approvals':
    case 'permissions': {
      if (arg && ['untrusted', 'on-request', 'never'].includes(arg)) {
        opts.approvalPolicy = arg;
        opts.autoApprove = false;
      } else if (arg) {
        say(c.red('  Use one of: untrusted, on-request, never\n'));
        return { handled: true };
      }
      say(`  approval policy  ${c.bold(opts.autoApprove ? 'never (auto-approve)' : opts.approvalPolicy)}`);
      say(`  sandbox          ${c.bold(opts.sandboxMode)}`);
      if (session.allowTools.size || session.allowCommands.length) {
        say(`  allowed this session: ${[...(session.allowTools.size ? ['file edits'] : []), ...session.allowCommands.map((p) => `"${p}"`)].join(', ')}`);
      }
      say(c.gray('  untrusted: ask before every change · on-request: ask only for what the sandbox cannot contain · never: do not ask\n  Destructive commands (rm -rf, sudo, force-push, ...) always ask.\n'));
      return { handled: true };
    }
    case 'undo': {
      const turn = session.turns.pop();
      let snaps = turn ? turn.callIds.map((id) => ({ callId: id, ...session.snapshots.get(id) })) : [];
      if (!snaps.length && session.persist) {
        const all = loadSnapshots(root, session.id);
        const lastTurn = all.length ? all[all.length - 1].turnId : null;
        snaps = all.filter((s) => s.turnId === lastTurn);
      }
      const restored = new Set();
      for (const snap of [...snaps].reverse()) {
        try {
          for (const p of restoreSnapshot(root, snap)) restored.add(p);
        } catch (err) {
          say(c.red(`  Could not restore ${snap.path}: ${err.message}`));
        }
        session.snapshots.delete(snap.callId);
        deleteSnapshot(root, session.id, snap.callId);
      }
      if (turn && !turn.compacted) session.history.length = Math.min(session.history.length, turn.historyStart);
      else if (restored.size) session.history.push({ role: 'user', content: `(I undid the file changes from your previous turn: ${[...restored].join(', ')}. Those files are back to how they were.)` });
      session.save();
      if (!turn && !restored.size) say(c.gray('  Nothing to undo.\n'));
      else say(c.gray(`  Undid the last turn${restored.size ? ` — restored ${[...restored].join(', ')}` : ' (it changed no files)'}.\n`));
      return { handled: true };
    }
    case 'diff': {
      try {
        const out = execFileSync('git', ['diff', ...(arg ? ['--', arg] : [])], { cwd: root, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
        const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' }).trim();
        say(out.trim() ? colorizeDiff(out.trimEnd()) : c.gray('  No changes to tracked files.'));
        if (untracked) say(c.gray(`\n  Untracked: ${untracked.split('\n').join(', ')}`));
        say();
      } catch (err) {
        say(c.red(`  git diff failed: ${String(err.stderr || err.message).trim()}\n`));
      }
      return { handled: true };
    }
    case 'status': {
      const u = session.usage;
      const budget = u.budget || (await resolveContextBudget({ ...chatOpts(opts), configured: opts.contextBudgetTokens }).catch(() => 0));
      say(`  ${c.gray('version   ')} ${VERSION}`);
      say(`  ${c.gray('model     ')} ${c.bold(opts.model)} ${c.gray(`(${opts.provider} · ${opts.host})`)}`);
      if (opts.fastModel) say(`  ${c.gray('fast model')} ${opts.fastModel}`);
      say(`  ${c.gray('directory ')} ${ui.tildify(root)}`);
      say(`  ${c.gray('session   ')} ${session.id} ${c.gray(`· ${session.history.length} messages${session.persist ? '' : ' · not saved'}`)}`);
      say(`  ${c.gray('context   ')} ~${ui.fmtTokens(u.lastPromptTokens || historyTokens(session.history))} of ${ui.fmtTokens(budget)} tokens`);
      say(`  ${c.gray('tokens    ')} ${ui.fmtTokens(u.promptTokens)} in · ${ui.fmtTokens(u.completionTokens)} out · ${u.requests} request${u.requests === 1 ? '' : 's'}`);
      say(`  ${c.gray('mode      ')} ${session.planMode ? 'plan (read-only)' : 'act'} ${c.gray(`· approvals: ${opts.autoApprove ? 'never' : opts.approvalPolicy} · sandbox: ${opts.sandboxMode}`)}\n`);
      return { handled: true };
    }
    case 'resume':
    case 'sessions': {
      const sessions = memory.listSessions(root).filter((s) => s.id !== session.id);
      if (!sessions.length) {
        say(c.gray('  No earlier conversations in this directory.\n'));
        return { handled: true };
      }
      let target = arg;
      if (!target) {
        sessions.slice(0, 15).forEach((s, i) => say(`  ${c.gray(String(i + 1).padStart(2))}  ${ui.short(s.title, 60)} ${c.gray(`· ${timeAgo(s.updatedAt)}`)}`));
        const answer = await ask(`  ${c.yellow('Resume which?')} ${c.gray('(number, Enter to cancel)')} › `);
        const a = (answer || '').trim();
        if (!a) return { handled: true };
        target = sessions[Number(a) - 1]?.id || a;
      }
      session.save();
      if (!session.load(target)) say(c.red(`  No saved conversation "${target}".\n`));
      else {
        say(c.gray(`  Resumed "${ui.short(memory.listSessions(root).find((s) => s.id === target)?.title || target, 60)}" (${session.history.length} messages).`));
        printRecap(session);
      }
      return { handled: true };
    }
    case 'init': {
      try {
        const rules = generateProjectRules(root);
        fs.writeFileSync(path.join(root, '.cortexrules'), rules);
        say(c.gray(`  Wrote .cortexrules (${rules.split('\n').length} lines) — Cortex reads it at the start of every turn. Edit it to add your own conventions.\n`));
      } catch (err) {
        say(c.red(`  /init failed: ${err.message}\n`));
      }
      return { handled: true };
    }
    case 'memory': {
      const notes = memory.loadMemoryNotes(root);
      say(notes ? notes : c.gray('  No notes yet. Cortex saves durable facts about the project here as it works (.cortex/MEMORY.md).'));
      say();
      return { handled: true };
    }
    case 'tools': {
      const names = Object.keys(tools).filter((n) => isToolAvailable(n, root, { host: opts.host, webhookUrl: opts.webhookUrl, delegateConfig: {} }));
      for (const n of names) say(`  ${c.cyan(n.padEnd(24))} ${c.gray(ui.short(tools[n].description.replace(/\s*Arguments:[\s\S]*$/, ''), ui.width() - 30))}`);
      say();
      return { handled: true };
    }
    default: {
      const custom = expandCustomCommand(line, root);
      if (custom) return { handled: true, send: custom.prompt };
      // "/usr/bin/..." or "/etc/hosts" is a path someone is asking about, not a command.
      if (line.trim().slice(1).includes('/')) return { handled: false };
      say(c.red(`  Unknown command /${cmd}. Type /help to see what is available.\n`));
      return { handled: true };
    }
  }
}

function timeAgo(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} d ago`;
}

function printRecap(session) {
  const real = session.history.filter((m) => !(m.role === 'user' && String(m.content).startsWith('TOOL_RESULT')));
  const lastUser = [...real].reverse().find((m) => m.role === 'user');
  const lastAssistant = [...real].reverse().find((m) => m.role === 'assistant' && !String(m.content).includes('TOOL_CALL:'));
  if (lastUser) process.stdout.write(`${c.gray('  you: ')}${ui.short(stripAttachments(lastUser.content), ui.width() - 10)}\n`);
  if (lastAssistant) process.stdout.write(`${c.gray('  cortex: ')}${ui.short(lastAssistant.content, ui.width() * 2)}\n`);
  process.stdout.write('\n');
}

// ---------------------------------------------------------- interactive

function loadInputHistory() {
  try {
    return fs.readFileSync(HISTORY_FILE, 'utf8').split('\n').filter(Boolean).slice(-500).reverse();
  } catch {
    return [];
  }
}

function completer(session) {
  return (line) => {
    if (/^\/[\w-]*$/.test(line)) {
      const names = [...BUILTINS.map(([n]) => n), ...listCustomCommands(session.root).map((x) => x.name)].map((n) => `/${n}`);
      const hits = names.filter((n) => n.startsWith(line));
      return [hits.length ? hits : names, line];
    }
    const at = line.match(/(?:^|\s)@([^\s@]*)$/);
    if (at) {
      const partial = at[1];
      const files = workspaceFiles(session.root);
      const lower = partial.toLowerCase();
      let hits = files.filter((f) => f.toLowerCase().startsWith(lower));
      if (!hits.length) hits = files.filter((f) => f.toLowerCase().includes(lower));
      return [hits.slice(0, 40).map((f) => `@${f}`), `@${partial}`];
    }
    return [[], line];
  };
}

async function preflight(session) {
  const { opts } = session;
  try {
    const models = await listModels(chatOpts(opts));
    const names = models.map((x) => x.name);
    if (opts.provider !== 'openai-compatible' && names.length && !names.includes(opts.model) && !names.includes(`${opts.model}:latest`)) {
      process.stdout.write(c.yellow(`  The model "${opts.model}" is not installed. Type /model to pick one of the ${names.length} you have, or run: ollama pull ${opts.model}\n\n`));
    } else if (!names.length && opts.provider !== 'openai-compatible') {
      process.stdout.write(c.yellow('  Ollama is running but has no models. Pull one first, e.g.: ollama pull qwen2.5-coder:7b\n\n'));
    }
  } catch (err) {
    const hint =
      opts.provider === 'openai-compatible'
        ? `Check --host${opts.apiKey ? '' : ' and set an API key (--api-key or $CORTEX_API_KEY)'}.`
        : 'Start it with `ollama serve` (install from https://ollama.com), or use --provider openai-compatible --host <url>.';
    process.stdout.write(c.yellow(`  Could not reach the model server at ${opts.host}. ${hint}\n  ${c.gray(err.message)}\n\n`));
  }
}

async function interactive(session) {
  const { opts, root } = session;
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: !!process.stdout.isTTY,
    history: loadInputHistory(),
    historySize: 500,
    removeHistoryDuplicates: true,
    completer: completer(session),
  });
  rl.on('history', (h) => {
    try {
      fs.mkdirSync(USER_DIR, { recursive: true });
      fs.writeFileSync(HISTORY_FILE, `${[...h].reverse().join('\n')}\n`);
    } catch {
      // history is a convenience
    }
  });

  let running = null; // AbortController of the turn in progress
  let lastSigint = 0;
  let closed = false;
  let pendingInput = null; // resolver waiting for the next message

  const interrupt = () => {
    if (running && !running.signal.aborted) running.abort();
  };
  rl.on('SIGINT', () => {
    if (running) return interrupt();
    if (rl.line) {
      // clear what was typed rather than quitting on the first press
      rl.write(null, { ctrl: true, name: 'u' });
      return;
    }
    if (Date.now() - lastSigint < 2000) return rl.close();
    lastSigint = Date.now();
    process.stdout.write(`\n${c.gray('  Press Ctrl+C again to exit.')}\n`);
    rl.prompt();
  });
  process.stdin.on('keypress', (_s, key) => {
    if (key && key.name === 'escape' && running) interrupt();
  });
  rl.on('close', () => {
    closed = true;
    interrupt();
    if (pendingInput) pendingInput(null);
  });

  /** One question, cancellable: resolves null if the turn is interrupted or input ends. */
  const ask = (question, signal) =>
    new Promise((resolve) => {
      if (closed || signal?.aborted) return resolve(null);
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        signal?.removeEventListener('abort', onAbort);
        rl.off('close', onClose);
        resolve(v);
      };
      const onAbort = () => {
        process.stdout.write('\n');
        finish(null);
      };
      const onClose = () => finish(null);
      signal?.addEventListener('abort', onAbort);
      rl.once('close', onClose);
      rl.question(question, signal ? { signal } : {}, (answer) => finish(answer));
    });

  // Reads the next message. Lines that arrive together (a paste) are joined
  // into one message instead of being sent one by one; a trailing backslash
  // continues the message on the next line.
  const nextMessage = () =>
    new Promise((resolve) => {
      if (closed) return resolve(null);
      const lines = [];
      let timer = null;
      const promptStr = session.planMode ? `${c.magenta('plan')} ${c.cyan('›')} ` : `${c.cyan('›')} `;
      const finish = (value) => {
        clearTimeout(timer);
        rl.off('line', onLine);
        pendingInput = null;
        resolve(value);
      };
      const settle = () => {
        if (rl.line && lines.length > 1) return; // the rest of a paste is still being typed in
        const last = lines[lines.length - 1];
        if (last.endsWith('\\')) {
          lines[lines.length - 1] = last.slice(0, -1);
          rl.setPrompt(c.gray('… '));
          rl.prompt();
          return;
        }
        finish(lines.join('\n'));
      };
      const onLine = (line) => {
        lines.push(line);
        clearTimeout(timer);
        timer = setTimeout(settle, 30);
      };
      pendingInput = finish;
      rl.on('line', onLine);
      rl.setPrompt(promptStr);
      rl.prompt();
    });

  const send = async (text) => {
    running = new AbortController();
    try {
      await runMessage(session, text, { ask, signal: running.signal, interactive: true });
    } finally {
      running = null;
    }
  };

  process.stdout.write(`\n ${c.cyan('◆')} ${c.bold('Cortex')} ${c.gray(`v${VERSION}`)}\n`);
  process.stdout.write(`   ${c.gray('model')}  ${opts.model} ${c.gray(`(${opts.provider})`)}\n   ${c.gray('cwd')}    ${ui.tildify(root)}\n`);
  process.stdout.write(`   ${c.gray('/help for commands · @file to attach · !cmd to run a shell command · Esc to interrupt')}\n\n`);
  await preflight(session);
  if (session.history.length) {
    process.stdout.write(c.gray(`  Continuing your last conversation (${session.history.length} messages). /clear starts fresh.\n`));
    printRecap(session);
  }

  let first = opts.initialPrompt;
  while (!closed) {
    let line;
    if (first) {
      line = first;
      first = null;
      process.stdout.write(`${c.cyan('›')} ${line}\n`);
    } else line = await nextMessage();
    if (line === null) break;
    const text = line.trim();
    if (!text) continue;

    if (text.startsWith('!')) {
      const command = text.slice(1).trim();
      if (!command) continue;
      const res = spawnSync(command, { cwd: root, shell: true, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
      const out = `${res.stdout || ''}${res.stderr || ''}`.trimEnd();
      process.stdout.write(`${out ? `${out}\n` : ''}${res.status ? c.red(`  exit code ${res.status}\n`) : ''}\n`);
      // Part of the conversation, so "why did that fail?" has something to refer to.
      session.history.push({ role: 'user', content: `I ran this shell command myself:\n$ ${command}\n${out.slice(-8000) || '(no output)'}${res.status ? `\n(exit code ${res.status})` : ''}` });
      session.history.push({ role: 'assistant', content: 'Noted.' });
      continue;
    }

    if (text.startsWith('/')) {
      const res = await handleSlash(session, text, { ask });
      if (res.exit) break;
      if (res.send) {
        await send(res.send);
        continue;
      }
      if (res.handled) continue;
    }
    await send(text);
  }

  if (!closed) rl.close();
  session.save();
  if (session.persist && session.history.length) process.stdout.write(c.gray(`\n  Session saved. Resume it with: cortex -c\n`));
}

// ------------------------------------------------------------------ main

// Reads piped input. A real shell pipe or redirected file is read to the
// end. Anything else that merely isn't a terminal — the open, silent stdin a
// CI runner or a parent process leaves behind — is only waited on briefly,
// so `cortex -p "..."` started from a script never hangs on input that will
// not come. With no prompt on the command line stdin is the only source, so
// it is always read to the end.
function readStdin({ required }) {
  return new Promise((resolve) => {
    let patient = required;
    if (!patient) {
      try {
        const st = fs.fstatSync(0);
        patient = st.isFIFO() || st.isFile();
      } catch {
        patient = false;
      }
    }
    let data = '';
    let timer = null;
    const finish = () => {
      clearTimeout(timer);
      process.stdin.removeAllListeners('data');
      process.stdin.removeAllListeners('end');
      process.stdin.removeAllListeners('error');
      process.stdin.pause();
      if (typeof process.stdin.unref === 'function') process.stdin.unref();
      resolve(data);
    };
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => {
      data += d;
      clearTimeout(timer); // something is being sent: wait for all of it
    });
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
    if (!patient) timer = setTimeout(finish, 300);
  });
}

async function main(argv = process.argv.slice(2)) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    console.error(c.red(`cortex: ${err.message}`));
    return 2;
  }
  if (opts.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (opts.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (!fs.existsSync(opts.root) || !fs.statSync(opts.root).isDirectory()) {
    console.error(c.red(`cortex: ${opts.root} is not a directory`));
    return 2;
  }

  // Piped input: the prompt itself, or extra context for -p "prompt".
  if (!process.stdin.isTTY && (opts.prompt !== null || !opts.initialPrompt)) {
    const piped = (await readStdin({ required: opts.prompt === null })).trim();
    if (piped) opts.prompt = opts.prompt ? `${opts.prompt}\n\n<stdin>\n${piped}\n</stdin>` : piped;
    else if (opts.prompt === null) {
      console.error(c.red('cortex: no prompt given and nothing on stdin (see cortex --help)'));
      return 2;
    }
  }
  if (opts.prompt === '') {
    console.error(c.red('cortex: -p needs a prompt'));
    return 2;
  }

  const session = new Session(opts);
  if (opts.resume && opts.resume !== true) {
    if (!session.load(opts.resume)) {
      console.error(c.red(`cortex: no saved session "${opts.resume}" in ${opts.root}`));
      return 2;
    }
  } else if (opts.continueLast || opts.resume === true) {
    const sessions = memory.listSessions(opts.root);
    if (sessions.length) session.load(sessions[0].id);
    else if (!opts.json) process.stderr.write(c.gray('No earlier session here — starting a new one.\n'));
  }

  if (opts.mcpServers.length) {
    await startMcpServers(opts.mcpServers, (m) => {
      if (!opts.json && !opts.quiet) process.stderr.write(c.gray(`${m}\n`));
    });
  }

  let code = 0;
  try {
    if (opts.prompt !== null) {
      const controller = new AbortController();
      process.once('SIGINT', () => controller.abort());
      const res = await runMessage(session, opts.prompt, { signal: controller.signal, interactive: false });
      code = res.cancelled ? 130 : res.ok ? 0 : 1;
    } else {
      await interactive(session);
    }
  } finally {
    stopAllBackground();
    await stopMcpServers().catch(() => {});
  }
  return code;
}

module.exports = { main, parseArgs, Session, runMessage, handleSlash, commandPrefix, chainsCommands, HELP, VERSION };
