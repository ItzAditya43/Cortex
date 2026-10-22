# Cortex

**The coding agent that uses your language server.**

Cortex is a VS Code agent that reads, writes, and runs your code — and unlike
CLI agents, it can ask the editor what your code actually *means*. Real
go-to-definition and find-references instead of grep guesses. Real compiler
and linter errors fed back after every edit, in milliseconds, instead of
waiting on a test run. That's the difference between an agent that thinks it
fixed something and one that knows.

It runs on [Ollama](https://ollama.com) — local models on your own machine
with no API keys or per-token bills, or Ollama's cloud models when you want
more capability. Your code never leaves your machine unless you choose a
cloud model.

![Sidebar chat, autonomous tool use, diff previews before every file change](media/icon.png)

## Why this instead of Cline/Continue?

| | Cortex |
|---|---|
| **Language-server aware** | `find_symbol` / `find_references` use VS Code's real symbol providers; a `diagnostics` tool surfaces actual compiler errors, and they're fed back automatically after every edit |
| **Measured, not vibes** | A [benchmark suite](#benchmarks) grades the agent on the files it produces. Changes are proven, not guessed |
| **Safe by construction** | Destructive commands (`rm -rf`, `curl \| sh`, `sudo`, force-push, credential reads) can never be auto-approved by *any* policy — because file contents reaching the model are untrusted input |
| **Fast where it counts** | Read-only tool calls run in parallel — a three-file read costs two model round-trips, not four |
| **Yours** | Local-first, MIT, no account, no telemetry |

## Benchmarks

```bash
npm run eval -- --model qwen2.5-coder:7b          # score one model
npm run eval -- --model a --model b               # compare two
npm run eval -- --save-baseline                   # pin a baseline
```

Every task builds a throwaway workspace, gives the agent one prompt, and
grades the **resulting files** — an agent that describes a correct patch but
never writes it scores zero. Runs exit non-zero on a regression, so this
works as a CI gate.

## Features

- **Sidebar chat** — a dedicated "Cortex" view in the Activity Bar.
- **Autonomous tool use** — the agent reads, writes, and edits files, searches
  your codebase, and runs shell commands in a plan → act → observe loop,
  entirely driven by your local model.
- **Diff previews before every write/edit** — inline diff in the chat, plus a
  one-click "Open Diff Editor" for the full VS Code diff view, before you
  approve anything.
- **Human-in-the-loop approval** — mutating actions (`write_file`, `edit_file`,
  `run_command`) require explicit Approve/Reject in the chat, unless you turn
  on auto-approve — globally, or per action type (see below).
- **Plan / Act mode** — flip to **Plan** to have Cortex investigate and
  propose an approach in plain text with all file-writing/command-running
  tools disabled, no accidental changes; flip to **Act** when you're ready
  for it to execute.
- **One-click revert (checkpoints)** — every successful file write/edit gets
  a "↩ Revert this change" button that restores the exact previous contents,
  no git required.
- **Chat history** — every chat is saved and titled automatically; reopen,
  resume, or delete past chats from the 🕘 History panel.
- **Per-action auto-approve** — the ⚙ panel lets you trust specific tools
  (e.g. always allow `read`-adjacent edits, always ask before `run_command`)
  without flipping the global auto-approve switch.
- **Markdown-rendered responses** — headings, lists, bold/italic, and syntax-
  highlighted-style code fences render properly instead of raw text.
- **Streaming responses** — tokens appear as the model generates them.
- **Model-agnostic** — works with any chat-capable model you've pulled into
  Ollama (`qwen2.5-coder`, `devstral`, `deepseek-coder-v2`, `llama3.1`, ...).
  Pick one from a live-populated Quick Pick, or type a name manually.
- **Per-workspace memory** — durable notes (`remember` tool) and session
  history are stored in a `.cortex/` folder inside your workspace and
  are picked back up automatically next time you open it.
- **Zero required dependencies** — the extension itself has no runtime npm
  dependencies; it talks to Ollama's local HTTP API directly.

## Architecture

Cortex is deliberately split into a **vscode-free core** and a **thin VS Code
host layer**, so the actual agent logic is unit-testable without spinning up
an editor:

| Layer | Files | Depends on `vscode`? |
|---|---|---|
| Core | `agentLoop.cjs`, `ollamaClient.cjs`, `tools.cjs`, `memory.cjs`, `systemPrompt.cjs`, `contextManager.cjs`, `permissions.cjs`, `checkpoints.cjs`, `lineDiff.cjs`, `sandbox.cjs` | No |
| Host | `extension.cjs`, `chatViewProvider.cjs`, `terminal.cjs`, `lsp.cjs`, `logger.cjs` | Yes |
| Webview | `media/render.js` (pure, unit-tested), `media/main.js`, `media/main.css` | — |

Notable pieces:
- **`contextManager.cjs`** — replaces naive "keep the last N messages" history
  truncation with a rough token-budget trim (chars/4 heuristic, no tokenizer
  dependency): it fills as much recent history as fits, and if anything had
  to be dropped, tells the model explicitly rather than leaving a silent gap.
  Tunable via `cortex.contextBudgetTokens`.
- **`permissions.cjs`** — the tool-approval policy (global auto-approve vs.
  per-tool allowlist) lives in one pure, tested function instead of being
  re-derived inline at each call site.
- **`logger.cjs`** — structured diagnostics to a "Cortex" Output Channel
  (**Cortex: Show Logs** command), covering every model request, tool call,
  and error, without pulling `vscode` into the core modules — they take a
  plain `(message: string) => void` callback instead.
- **Resilience** — `ollamaClient.cjs` retries once on transient connection
  failures before surfacing an error.
- **Static type-checking** — `npm run typecheck` runs `tsc --noEmit` with
  `checkJs` over the core + host modules (via JSDoc annotations, no build
  step, no `.ts` files needed), catching type mismatches at commit time
  instead of at runtime in the extension host.

## Requirements

- VS Code 1.85+
- [Ollama](https://ollama.com) installed and running (`ollama serve`, or just
  open the Ollama desktop app)
- At least one model pulled, e.g.:
  ```bash
  ollama pull qwen2.5-coder
  ```

## Getting started

1. Install the extension (see [Build & install locally](#build--install-locally)
   below, or from the Marketplace once published).
2. Open a folder/workspace in VS Code.
3. Click the Cortex icon in the Activity Bar.
4. Pick your model with the model-select button in the view's title bar (or
   set `cortex.model` in Settings).
5. Type a request — e.g. *"add input validation to the signup form"* — and
   press Enter.

The agent will narrate its plan, call tools as needed (you'll see a card for
each one, with a diff to review for file changes), and ask for your approval
before it touches anything, unless auto-approve is on.

## Settings

| Setting | Default | Description |
|---|---|---|
| `cortex.host` | `http://localhost:11434` | Ollama server URL |
| `cortex.model` | `qwen2.5-coder:3b` | Model to use (click the model name under the chat box to switch) |
| `cortex.approvalPolicy` | `untrusted` | `untrusted` asks before every change, `on-request` auto-approves sandboxed changes, `never` never asks |
| `cortex.autoApprove` | `false` | Skip confirmation for file writes/edits/commands (dangerous commands still ask) |
| `cortex.contextBudgetTokens` | `6000` | How much conversation is sent per step |
| `cortex.numCtx` | `0` (auto) | Context window Ollama loads the model with; auto = budget + room for the reply, min 8192 |
| `cortex.temperature` | `0.2` | Sampling temperature |
| `cortex.maxSteps` | `25` | Max tool-call steps per request |

Everything else (fast/escalation models, sandboxing, MCP servers, profiles,
schedules) is under **Settings → Extensions → Cortex**.

## Commands

- **Cortex: New Chat** — clear the current session
- **Cortex: Select Model** — pick from models available on your Ollama server
- **Cortex: Open Chat** — focus the sidebar view
- **Cortex: Toggle Auto-Approve** — flip the auto-approve setting

## Tools available to the agent

| Tool | Approval required? | Purpose |
|---|---|---|
| `read_file` | no | read one or several files with line numbers |
| `list_dir` | no | list a directory (non-recursive) |
| `search_code` | no | extended-regex search across the workspace (falls back to literal text) |
| `find_symbol` / `find_references` | no | definitions and usages, via the language server when available |
| `diagnostics` | no | the editor's real compiler/linter errors |
| `edit_file` / `multi_edit` | yes (diff shown) | replace exact snippets, in one file or atomically across several |
| `write_file` | yes (diff shown) | create a file or overwrite one fully |
| `delete_file` / `rename_file` | yes | delete or move a file |
| `run_command` | yes | run a shell command in the workspace root (Stop kills it) |
| `run_background` | yes | start a dev server / watcher and poll its output |
| `git_status` / `git_diff` / `git_commit` | commit only | inspect and commit changes |
| `save_plan`, `remember`, `read_url`, `delegate_task` | no | plan tracking, memory, web fetch, sub-agents |

Tools that can't work in the current setup (no webhook configured, no code
index built, no language server) are left out of the model's prompt.

All file paths are sandboxed to the current workspace root — tools refuse to
read/write outside of it.

## How memory works

- **Session:** each turn is appended to `.cortex/history-<session>.json`
  so a chat keeps context. "New Chat" starts a fresh session.
- **Long-term:** the agent calls `remember` to jot durable facts (conventions,
  decisions, gotchas) into `.cortex/MEMORY.md`. These are injected into
  every system prompt from then on, across VS Code restarts, until you edit
  that file yourself. `.cortex/` is gitignored by default.

## Which models work well

Tool-calling is implemented via prompting (a `TOOL_CALL: {...}` line the
model must emit) rather than Ollama's native function calling, so it works
with **any** instruct-tuned model — quality of tool use scales with how good
the model is at instruction-following and code.

- **Recommended:** `qwen2.5-coder`, `devstral`, `deepseek-coder-v2`
- **Also solid:** `llama3.1`, `mistral-nemo`, `codestral`
- **Works, more mistakes:** smaller/older general models

## Build & install locally

```bash
git clone <this repo>
cd cortex
npm install
npm test               # run the unit tests (includes the chat panel, via jsdom)
npm run typecheck       # static type-check via tsc --noEmit (checkJs)
npm run package         # produces cortex-<version>.vsix
```

Then in VS Code: **Extensions view → `...` menu → Install from VSIX...** and
pick the generated file. Or from the terminal:

```bash
code --install-extension cortex-0.1.0.vsix
```

To iterate on the extension itself, open this folder in VS Code and press
**F5** ("Run Extension") to launch an Extension Development Host with it
loaded.

## Publishing to the VS Code Marketplace

This repo is publish-ready but publishing itself requires *your own*
Marketplace publisher identity (a one-time, human step this project can't do
for you):

1. Create a publisher at https://marketplace.visualstudio.com/manage —
   note the publisher id.
2. Make sure `"publisher"` in [package.json](package.json) matches that id
   (currently `ItzAditya43`).
3. Create an Azure DevOps Personal Access Token with **Marketplace: Manage**
   scope, per https://code.visualstudio.com/api/working-with-extensions/publishing-extension#get-a-personal-access-token
4. `npx vsce login <publisher-id>` and paste the token, then:
   ```bash
   npm run publish
   ```
   (or `vsce publish patch|minor|major` to bump the version at the same time).

## Known limitations

- Tool-calling is prompt-based (a `TOOL_CALL:` line), not Ollama's native
  function calling — it works with any model, but small models (≤3B) still
  make mistakes on multi-file tasks. A 7B+ coder model or a cloud model is
  noticeably more reliable.
- Only read-only tool calls run in parallel; every change is applied one at
  a time so each gets its own approval, diff and undo point.
- A resumed chat replays tool calls as collapsed cards with their results,
  but not the original diffs.
- Revert covers file changes made through Cortex's tools (edits, writes,
  creates, deletes, renames) — not side effects of shell commands.
- `run_command` uses the integrated terminal when shell integration is
  available, otherwise a background process; either way it's capped at
  120s — use `run_background` for servers and watchers.
- Long sessions on small context windows get trimmed (oldest steps first,
  the original request is always kept); `/compact` or "New Chat" helps.

## License

MIT — see [LICENSE](LICENSE).
