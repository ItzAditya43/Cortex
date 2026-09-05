# Smoke test — before publishing

Automated tests cover module logic and now activation (`test/activation.test.cjs`
mocks the `vscode` API and runs the real `activate()`), but a handful of
features can only be proven by a real Extension Development Host. Those are
listed here, roughly in order of "most likely to be broken".

**How to run:** open this folder in VS Code, press `F5`. A second VS Code
window opens with Cortex loaded. Open a *different* real project in it —
testing Cortex on Cortex works, but a project with a language server
installed (TypeScript, Python, Rust) exercises far more.

Set `cortex.model` to something capable first. Check the Output panel
("Cortex" channel) whenever something looks wrong.

---

## 0. It starts at all
- [ ] Cortex icon appears in the Activity Bar; clicking it shows the chat
- [ ] No error notification on launch (a warning about Ollama being
      unreachable is expected and correct if it isn't running)
- [ ] Status bar shows `Ollama: <model>`

## 1. The basic loop
- [ ] Ask: *"list the files here"* → tool card appears with a clean header,
      **not** raw `TOOL_CALL: {...}` JSON text
- [ ] Ask it to create a file → approval prompt appears with a diff
- [ ] Approve → file is actually created on disk
- [ ] **The chat panel scrolls** (send enough messages to overflow)

## 2. Live diff in the editor  *(new, unverified)*
- [ ] After an approved edit, a diff opens automatically in the main editor area
- [ ] It reuses **one** tab across several edits instead of spawning many
- [ ] Focus stays in the chat input — the diff must not steal your cursor

## 3. Language-server intelligence  *(new, unverified — the differentiator)*
Use a project with a working language server.
- [ ] Ask: *"where is `<someFunction>` defined?"* → result says
      `(via language server)`, not a grep dump
- [ ] Ask: *"find all references to `<someFunction>`"* → same, and the
      results are real references, not every string match
- [ ] Deliberately break a file (bad import / type error), then ask Cortex to
      edit that file → the tool result should include
      `PROBLEMS reported by the language server`
- [ ] Ask: *"what problems are in this project?"* → `diagnostics` returns the
      same list as the Problems panel

## 4. Terminal  *(new, unverified)*
- [ ] Ask it to run `ls` → a **visible** terminal named "Cortex" appears and
      you can watch the command run
- [ ] Output comes back into the chat
- [ ] Set `cortex.sandboxMode` to `workspace-write` → commands should run
      sandboxed via the hidden path instead (Linux + `bwrap` only)

## 5. Parallel reads  *(verified against a fake server only)*
- [ ] Ask: *"read package.json, README.md and .gitignore"* → several tool
      cards appear at once rather than one per turn
- [ ] Check the Output channel for
      `running N read-only tool calls in parallel`

## 6. Checkpoints and rewind  *(new, unverified)*
- [ ] After an edit, a `checkpoint · N file changes` marker appears with a
      **Rewind here** button
- [ ] Make two more edits, click Rewind on the first → files revert **and**
      the conversation truncates to that point
- [ ] **Reload the window** (`Developer: Reload Window`), reopen the session
      from History → the Revert buttons still work
      *(this is the one that used to be impossible — checkpoints were memory-only)*

## 7. Slash commands
- [ ] `/help` lists the commands
- [ ] `/init` writes a sensible `.cortexrules`
- [ ] `/compact` summarizes a long conversation and keeps working afterwards
- [ ] Paste a path like `/home/you/file.txt` as a message → it goes to the
      model, **not** treated as an unknown command

## 8. Selection context
- [ ] Highlight code, right-click → **Add Selection to Cortex** stages a
      `file:line` reference in the composer
- [ ] Highlight code → **Explain Selection with Cortex** answers about *that*
      code specifically
- [ ] Highlight a function and ask *"what does this do?"* without mentioning
      it by name — it should know

## 9. Safety  *(important — verify before shipping)*
- [ ] Set `cortex.approvalPolicy` to `never` **and** `cortex.autoApprove` true
- [ ] Ask it to run `rm -rf /tmp/some-test-dir` → **it must still ask you.**
      If it runs without asking, stop and report it
- [ ] A harmless command (`git status`) should still auto-run

## 10. Image input  *(new, unverified — needs a vision model)*
- [ ] Set `cortex.model` to a vision model (e.g. `qwen2.5vl:3b`)
- [ ] Click 📎, attach a screenshot, ask what's in it
- [ ] Thumbnail appears in the composer and in the sent message

## 11. Stats
- [ ] After a turn, the composer row shows calls / seconds / tokens / `% ctx`
- [ ] `% ctx` grows over a long conversation

---

## If something fails

Grab the **Output → Cortex** channel contents and the **Help → Toggle
Developer Tools → Console** output for webview errors. Those two together
identify almost anything on this list.

Known-unverified going in: sections 2, 3, 4, 6, 10 have only been tested
outside a real extension host (they were confirmed to *degrade gracefully*,
not to work). Expect the first bugs there.
