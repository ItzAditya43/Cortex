# Changelog

All notable changes to Cortex are documented here.

## [Unreleased]

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
