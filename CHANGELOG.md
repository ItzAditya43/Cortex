# Changelog

All notable changes to Cortex are documented here.

## [0.2.0] — 2026-11-13

### Added
- **A redesigned chat panel ("Instrument").** The panel now reads like a
  control panel rather than a chat app: hairline rules, small-caps labels,
  status lamps, square corners and one signal colour (amber) on top of the
  active VS Code theme. A status strip sets mode, approvals and sandbox;
  each turn is a numbered strip with its total time; each tool call is one
  line with a lamp, a verb, its target, how long it took and its outcome
  (a command that exits non-zero shows its exit code); plans are a
  checklist with progress. The empty panel shows the workspace, branch,
  changed-file count and recent conversations to resume instead of a
  greeting. Approvals offer Approve, Reject, Always and Diff. A bar gauge
  shows context use; a status bar shows steps, tokens, files changed and
  time. One drawer holds History (searchable, grouped by day, with fork),
  Settings, Permissions and Memory, and `/` opens a command menu.
- **A real CLI: `cortex`.** The terminal agent is rebuilt around the same
  engine as the extension: streaming Markdown output, a line per tool call
  with its result, coloured diffs before every edit, and approvals you can
  answer with yes / no / always / "do this instead". Sessions are saved and
  resumable (`cortex -c`, `cortex -r`, `/resume`), `/undo` reverts a turn's
  file changes, and there are commands for the things you reach for
  mid-task: `/model`, `/plan`, `/compact`, `/diff`, `/status`, `/approvals`,
  `/init`, `/memory`, `/tools`. `@path` attaches files (Tab completes),
  `!cmd` runs a shell command into the conversation, Esc interrupts.
  One-shot mode (`cortex -p`, `cortex exec`, piped stdin, `--json`) keeps
  stdout for the answer so it can be scripted. The destructive-command
  safety floor now applies in the CLI too, including under `--auto-approve`.
- **Context sized to the model.** `cortex.contextBudgetTokens` defaults to
  automatic: about 8k tokens for small local models, 16k for larger local
  ones, up to 100k for hosted models — instead of 6k for everything.
- **Automatic compaction.** When a conversation approaches its budget the
  older part is summarized by the model (request, work done, findings, what
  remains) and the turn continues. `/compact` uses the same summarizer.
- **Several tool calls per response.** Edits and commands sent together now
  all run, in order, each with its own approval, diff and undo point; a
  failure or a declined call stops the ones after it and the model is told
  which were skipped. Previously only the first ran.
- **Function calling for OpenAI-compatible servers** (OpenAI, OpenRouter,
  Groq, LM Studio, vLLM, llama.cpp), with streamed tool calls, token usage
  and reasoning output. If a server or model rejects tools, Cortex falls
  back to the text protocol by itself.
- **New and sharper tools.** `glob` finds files by pattern. `read_file`
  takes `offset`/`limit` and says which lines it showed. `edit_file` takes
  `replace_all`. `search_code` uses ripgrep when installed (faster, honours
  `.gitignore`) and takes `glob`, `ignore_case` and `context`.
  `run_command` takes `timeout_seconds`.
- **Custom slash commands.** `.cortex/commands/<name>.md` (or
  `~/.cortex/commands/`) becomes `/<name>` in the CLI and the VS Code panel.
- **More rule files.** `CORTEX.md` and `CLAUDE.md` are read alongside
  `AGENTS.md` and `.cortexrules`; `~/.cortex/CORTEX.md` applies everywhere.

### Fixed
- **An ambiguous edit now says where.** "old_str matches 2 places" lists the
  matching lines with the line above each, so the model can single one out.
  On a 3B model this turned a 50-step failure (it rewrote both matches, broke
  a passing function, then edited the test) into a correct 6-step fix.
- **No approval prompt for an edit that cannot apply.** A snippet that is
  missing or ambiguous is reported straight back to the model instead of
  first asking you to approve a call that can only fail.
- **Writing a file back unchanged** is reported as "no change" — no prompt,
  no undo point — instead of looking like a successful edit the model then
  repeats.
- **`write_file` will not overwrite a file the agent has not read.** A model
  that rewrites a file from what it imagines is in it destroys the rest; it
  is told to read the file first.
- **`cortex -p` no longer hangs** when started by another program that
  leaves stdin open (CI runners, scripts); only a real pipe is read to the end.
- **Tool calls with single-quoted strings** (`"old_str": '"1.0.0"'`), which
  small models produce and then resend unchanged until the step budget runs
  out, are repaired. A bare array of edits is accepted as `multi_edit`
  arguments.
- **The loop breaker no longer blocks a legitimate re-check.** Searching
  again after an edit is a new question; only repeats with nothing changed
  in between count. A model that ignores the warning is stopped after six
  identical calls instead of burning every remaining step.

- **Unrequested commits are refused.** `git_commit`, `git commit` and
  `git push` only run when the conversation asked for a commit or push;
  small models otherwise commit their own work even under a rule not to.
- **Stuck models stop early with a reason**: six malformed tool calls in a
  row, or a run of plan/notes updates with no work in between, end the turn
  instead of using up every step.

### Changed
- The system prompt for capable models now spells out a working method
  (understand, change, verify, report) and tells the model its platform,
  branch and date. Small models on the text protocol keep the short prompt.
- `cortex.maxSteps` defaults to 50 (was 25), and running out of steps says
  how to continue instead of suggesting a new chat.
- Declining an approval can carry a reason, which is passed to the model.
- Rate-limit retries back off exponentially (2s, 4s, 8s).

### Added (late October 2026)
- **Native tool calling.** Models that support Ollama's tools API get real
  tool schemas instead of a hand-written TOOL_CALL protocol (shorter prompt,
  no JSON escaping by hand). `cortex.toolCalling: auto` uses it for
  tool-capable models of 7B+ — measured: gemma4:31b-cloud and
  gpt-oss:120b-cloud pass 12/12 natively, while qwen2.5-coder:3b drops from
  8/12 to 5/12, so small models stay on the text protocol. A call a model
  writes as JSON text instead is still recognised. History is stored in one
  format either way, so checkpoints, rewind and replay are unaffected.
- **`@file` mentions** in the composer, with a fuzzy file picker (arrow keys,
  Enter/Tab). Mentioned files are attached to the message; the CLI accepts
  them too.
- **Retry and Edit** on the last message, rolling back the conversation and
  that turn's file changes first.

### Fixed (October 2026)
- **Approved actions now show their result.** With the default "ask me"
  approval, the output of an approved command, the edit confirmation and the
  Revert button never appeared — the leftover approval row made the card
  ignore its own result.
- **Stop really stops.** Pressing Stop while an approval was open left the
  card live, and clicking Approve afterwards still ran the action. Stop now
  cancels open approvals, and the loop re-checks for cancellation after
  every approval. Stop also kills a running shell command.
- **Commands no longer freeze VS Code.** `run_command` and the search tools
  used `execSync`, blocking the whole extension host (streaming, Stop, other
  extensions) for up to a minute.
- **Ollama no longer silently truncates prompts.** Cortex never sent
  `num_ctx`, so Ollama used its own default (4096 on small GPUs) while Cortex
  budgeted ~8k tokens; the start of the prompt — the tool instructions — was
  cut. The window is now sized from the budget (`cortex.numCtx` overrides),
  and a single oversized tool result is clipped to fit instead of sent whole.
- **New Chat no longer deletes the previous chat.** It used to erase the old
  conversation from disk, so History listed chats that opened empty. Only
  `/clear` discards. Switching chats mid-turn no longer writes the running
  turn into the wrong conversation.
- **Revert works for every kind of change.** Reverting a created file left an
  empty file behind, reverting a rename wrote a file named `a -> b`, and
  reverting a `multi_edit` wrote a file named `2 file(s)`.
- **`multi_edit` with several edits to one file** kept only the last edit.
- **Diffs are real diffs.** The chat paired line N with line N, so inserting
  one line showed the whole file as rewritten. Changes are now aligned and
  shown as hunks with context, and only the hunks are sent to the panel.
- **Raw `TOOL_CALL` JSON no longer streams into the chat** (often a whole
  file's contents); a "Preparing write_file…" line shows instead.
- **Small models get unstuck.** Invalid regexes in `search_code` fall back to
  a literal search instead of erroring forever; "file not found" lists the
  files that probably were meant; an `edit_file` miss shows the closest real
  text to copy; tools that can't work are left out of the prompt.
- The unit test suite took 92s because of a leaked 90s timer in the Ollama
  client; it now takes a few seconds. `npm run typecheck` passes again.

### Added (October 2026)
- A visible "Thinking… / Running read_file… 12s" line whenever the agent is
  working, and the reasoning of thinking models (gpt-oss, qwen3, gemma4) in a
  collapsible block — previously the panel sat blank.
- Readable tool cards (one-line argument summary, ✓/✗ status, successful
  reads collapsed), copy buttons on code blocks, markdown tables and quotes,
  click-the-model-name to switch models, paste an image into the composer,
  Esc to stop.
- Resumed chats replay tool calls as cards with their results.
- The CLI streams its answers, Ctrl+C cancels the running request instead of
  exiting, and approval prompts no longer garble input.

### Security (October 2026)
- **Command injection in read-only tools.** `search_code`, `find_symbol`,
  `find_references` and `git_diff` run without approval, and put
  model-supplied text in shell double quotes, where `$(...)` still runs — a
  prompt-injected file could execute commands without ever asking. Arguments
  are now single-quoted or passed without a shell.
- **Sandbox escape.** The bubblewrap wrapper double-quoted the command, so
  `$(...)` ran on the host before the sandbox started — and `on-request`
  auto-approves sandboxed commands.

### Added
- **Benchmark suite** (`npm run eval`) — 12 tasks that grade the agent on the
  files it actually produces, not on what it claims to have done. Supports
  comparing models side by side and fails on regressions against a saved
  baseline, so changes can be measured instead of guessed at.
- **Language-server intelligence** — `find_symbol` / `find_references` use the
  real workspace symbol and reference providers, and a `diagnostics` tool
  exposes the editor's actual compiler/linter errors. After every edit those
  diagnostics are fed back to the model automatically.
- **Parallel tool calls** — several read-only calls in one response now run
  concurrently, cutting a three-file read from four model round-trips to two.
- **Semantic code search** — `semantic_search` finds code by meaning rather
  than exact text, backed by an incremental on-disk index
  (`Cortex: Build Code Index`).
- **Real terminal execution** — shell commands run in VS Code's visible
  integrated terminal, falling back to a child process when shell
  integration is unavailable.
- **Rewind to checkpoint** — restore files *and* the conversation to any
  earlier turn.
- **Git tools** — `git_status`, `git_diff`, `git_commit`.
- **Persistent checkpoints** — undo history survives a window reload.
- **Stale-file detection** — warns when a file changed outside Cortex since
  the agent last read it, without mistaking the agent's own writes for
  external edits.
- **Durable task list** — `update_tasks` keeps a checklist that survives
  context trimming and `/compact`.
- **Multi-file atomic edits** (`multi_edit`), image input, session stats with
  real token counts, and a startup connectivity check.

### Fixed
- **The agent no longer forgets the task.** Once tool output filled the
  context budget, the first user message — the actual request — was the first
  thing dropped. It is now anchored, and truncation removes the middle.
- **Edits no longer fail on whitespace.** `edit_file` required a byte-exact
  snippet, so trailing spaces, tabs-vs-spaces or CRLF broke it. It now falls
  back through whitespace- and indentation-insensitive matching, still
  requiring a unique match so it can never rewrite the wrong region.
- **Tool calls render as cards, not raw JSON.** The streamed `TOOL_CALL: {...}`
  text was left in the transcript alongside the real result, making working
  actions look like nothing had happened.
- **Chat panel scrolls.** A missing `min-height: 0` made the message list grow
  instead of scrolling.
- **Stalled generations time out** after 90s instead of hanging forever.

### Security
- **Dangerous commands always require a human.** `rm -rf`, `curl | sh`,
  `sudo`, force-pushes and credential reads can no longer be auto-approved by
  any policy, profile or allowlist — file contents and web pages reach the
  model as text, so tool output is treated as untrusted input.

## [0.1.0]

Initial release: chat and agent modes over local Ollama models, plan/act
modes, diff review with per-change undo, approval policies, sandboxing,
MCP support, project rules (`.cortexrules` / `AGENTS.md`), persistent
memory, and a headless CLI.
