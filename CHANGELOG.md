# Changelog

All notable changes to Cortex are documented here.

## [Unreleased]

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
