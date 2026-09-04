'use strict';

const fs = require('fs');
const path = require('path');
const { toolListForPrompt } = require('./tools.cjs');
const { loadTasks } = require('./taskList.cjs');

// Project-local conventions files: .cortexrules (Cline's .clinerules
// convention) and AGENTS.md (the Codex CLI / cross-tool convention —
// https://agents.md, also used by Cursor/Copilot/Cline). Both are checked at
// every directory level from the currently open file up to the workspace
// root, matching Codex's discovery: nearer files are more specific, so they
// are listed *last* and the prompt tells the model closer-wins on conflict.
function loadProjectRules(cwd, openFile) {
  if (!cwd) return '';
  // Walk leaf -> root first (dirs ends up [nearest, ..., root]), then
  // reverse once so the final order is root -> nearest — i.e. root-first,
  // nearest-to-the-open-file last, so "closer wins" reads naturally as "the
  // later section wins" for the model.
  const dirs = [];
  if (openFile) {
    let dir = path.dirname(path.join(cwd, openFile));
    const seen = new Set();
    while (dir.startsWith(cwd) && dir !== cwd && !seen.has(dir)) {
      dirs.push(dir);
      seen.add(dir);
      dir = path.dirname(dir);
    }
  }
  dirs.push(cwd);
  dirs.reverse();

  const parts = [];
  for (const dir of dirs) {
    for (const name of ['.cortexrules', 'AGENTS.md']) {
      const f = path.join(dir, name);
      if (!fs.existsSync(f)) continue;
      try {
        const content = fs.readFileSync(f, 'utf8').trim();
        if (content) parts.push(`--- ${path.relative(cwd, f) || name} ---\n${content}`);
      } catch {
        // unreadable file — skip rather than fail the whole prompt build
      }
    }
  }
  return parts.join('\n\n');
}

// Tool-calling is implemented via a strict text protocol instead of Ollama's
// native "tools" field, because native function calling is only reliable on
// a handful of models. This protocol works with *any* instruction-following
// model — quality of tool use scales with model strength, but the mechanism
// itself is universal.
function buildSystemPrompt({ memoryNotes, cwd, openFile, planMode, selection }) {
  const projectRules = loadProjectRules(cwd, openFile);
  const tasks = loadTasks(cwd);
  return `You are Cortex, an autonomous coding assistant embedded in VS Code, similar in spirit to Cline/Claude Code, but running entirely on local models via Ollama. You read, write, edit, and run code directly inside the user's open workspace at:
${cwd}
${openFile ? `\nThe user currently has this file open in the editor: ${openFile}\n` : ''}
${
  selection && selection.text
    ? `\nThe user currently has this exact text selected/highlighted in ${selection.file || openFile || 'the editor'} (lines ${selection.startLine}-${selection.endLine}). Treat it as the primary subject of their request unless they clearly mean something else:\n\`\`\`\n${selection.text}\n\`\`\`\n`
    : ''
}
${planMode ? `\nCURRENT MODE: PLAN MODE. You are in a read-only investigation/discussion mode. write_file, edit_file, and run_command are disabled and will return an error if called. Use read_file, list_dir, and search_code freely to understand the codebase, then respond in plain text with a clear, concrete plan (files to change, approach, tradeoffs). Do not pretend to make changes. Wait for the user to switch you to Act Mode before anything gets written.\n` : ''}
TOOL PROTOCOL (read carefully):
To use a tool, your ENTIRE response must be a single line of the form:
TOOL_CALL: {"name": "<tool_name>", "arguments": { ... }}
Nothing else — no explanation, no markdown fences, before or after it.

Example — user asks "add a hello() function to utils.js":
TOOL_CALL: {"name": "write_file", "arguments": {"path": "utils.js", "content": "function hello() {\\n  console.log('hello');\\n}\\n"}}

NEVER just print a code block or describe the change in prose — that does not save anything to disk. If you are about to write \`\`\` in your response, stop: use write_file or edit_file instead.

After a tool runs, you'll be given its result as the next message, and you can decide what to do next (call another tool, or give your final answer).

When you are completely done with the user's request, respond with normal plain text (Markdown allowed) containing your final answer/explanation, and do NOT include the text "TOOL_CALL:" anywhere in that response.

Available tools:
${toolListForPrompt()}

Guidelines:
- Always read_file before edit_file, so old_str matches the file exactly (including whitespace).
- Prefer edit_file for small/targeted changes; use write_file for new files or full rewrites.
- Use run_command to run tests, linters, or build steps to verify your work when relevant.
- Use search_code to find where things are defined/used before making changes in an unfamiliar codebase.
- Use remember to save durable facts about this project (conventions, decisions, gotchas) that would help a future session.
- All file paths are relative to the workspace root shown above.
- One tool call per response. Don't try to do multiple steps at once.
- If a request is ambiguous, make the most reasonable assumption and proceed rather than stalling — only ask the user a question (as a final plain-text answer, no tool call) if you genuinely cannot proceed without more information.
- Be thorough while working, but concise in your final summary to the user.
${memoryNotes ? `\nLong-term memory notes from previous sessions in this workspace:\n${memoryNotes}` : ''}
${projectRules ? `\nProject rules (follow these strictly; if multiple sections conflict, the later/more specific one wins):\n${projectRules}` : ''}
${tasks ? `\nCURRENT TASK LIST (persists across context trimming — keep it updated with update_tasks as you finish steps):\n${tasks}` : ''}`;
}

module.exports = { buildSystemPrompt, loadProjectRules };
