# Cortex

A **local, private coding agent for VS Code** — like Cline, but powered entirely
by models running in [Ollama](https://ollama.com) on your own machine. No API
keys, no accounts, no cloud calls, no per-token bills. Everything (chat,
tool-calling, and your code) stays on your machine.

![Sidebar chat, autonomous tool use, diff previews before every file change](media/icon.png)

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
| Core | `agentLoop.cjs`, `ollamaClient.cjs`, `tools.cjs`, `memory.cjs`, `systemPrompt.cjs`, `contextManager.cjs`, `permissions.cjs` | No |
| Host | `extension.cjs`, `chatViewProvider.cjs`, `logger.cjs` | Yes |

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
| `cortex.model` | `qwen2.5-coder` | Model to use |
| `cortex.autoApprove` | `false` | Skip confirmation for file writes/edits/commands |
| `cortex.temperature` | `0.2` | Sampling temperature |
| `cortex.maxSteps` | `25` | Max tool-call steps per request |

## Commands

- **Cortex: New Chat** — clear the current session
- **Cortex: Select Model** — pick from models available on your Ollama server
- **Cortex: Open Chat** — focus the sidebar view
- **Cortex: Toggle Auto-Approve** — flip the auto-approve setting

## Tools available to the agent

| Tool | Approval required? | Purpose |
|---|---|---|
| `read_file` | no | read a file with line numbers |
| `list_dir` | no | list a directory (non-recursive) |
| `search_code` | no | grep-style search across the workspace |
| `write_file` | yes (diff shown) | create a file or overwrite one fully |
| `edit_file` | yes (diff shown) | replace one exact, unique snippet of text |
| `run_command` | yes | run a shell command in the workspace root |
| `remember` | no | append a durable note to long-term memory |

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
npm test               # run the unit tests
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
2. Set `"publisher"` in [package.json](package.json) to that id (it currently
   says `cortex` as a placeholder).
3. Create an Azure DevOps Personal Access Token with **Marketplace: Manage**
   scope, per https://code.visualstudio.com/api/working-with-extensions/publishing-extension#get-a-personal-access-token
4. `npx vsce login <publisher-id>` and paste the token, then:
   ```bash
   npm run publish
   ```
   (or `vsce publish patch|minor|major` to bump the version at the same time).

## Known limitations

- Tool-calling is prompt-based (one call per model turn), not Ollama's native
  function calling — most reliable with the "coder" family of models.
- No parallel tool calls; the agent always executes one step at a time.
- Resuming a past chat from History replays a simplified transcript (tool
  calls collapse to one-line notes rather than full diff cards) — the
  underlying context sent to the model is exact, only the on-screen replay
  is summarized.
- Revert restores a file's exact previous contents; it isn't a full git-style
  checkpoint of the whole workspace, and only covers `write_file`/`edit_file`
  (not `run_command` side effects).
- `run_command` executes synchronously via a child process, not VS Code's
  integrated terminal, and is capped at 60s.
- Local models have small context windows; tool results are truncated to
  ~8000 chars and history capped at the last 200 messages, but very long
  sessions on small-context models may still benefit from "New Chat".

## License

MIT — see [LICENSE](LICENSE).
