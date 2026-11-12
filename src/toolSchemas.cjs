// JSON Schemas for the built-in tools, used when a model is driven through
// Ollama's native tool calling instead of the TOOL_CALL text protocol.
//
// The text protocol describes arguments inline in each tool's description
// ("Arguments: {...}"); native calling needs them as real schemas, and the
// inline part is stripped from the description so it isn't said twice.

'use strict';

const str = (description) => ({ type: 'string', description });
const obj = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required });

const SCHEMAS = {
  write_file: obj({ path: str('Workspace-relative path'), content: str('The complete new file contents') }),
  edit_file: obj({
    path: str('Workspace-relative path'),
    old_str: str('Exact text currently in the file, unique within it — copy it from read_file output'),
    new_str: str('Replacement text'),
    replace_all: { type: 'boolean', description: 'Replace every occurrence of old_str instead of requiring it to be unique' },
  }, ['path', 'old_str', 'new_str']),
  multi_edit: obj({
    edits: {
      type: 'array',
      description: 'Edits applied atomically, in order; several may target the same file',
      items: obj({ path: str('Workspace-relative path'), old_str: str('Exact, unique text to replace'), new_str: str('Replacement text') }),
    },
  }),
  list_dir: obj({ path: str('Directory, workspace-relative ("." for the root)') }, []),
  search_code: obj(
    {
      pattern: str('Regular expression (or plain text)'),
      path: str('Directory or file to search, default "."'),
      glob: str('Only search files matching this glob, e.g. "*.ts" or "src/**/*.py"'),
      ignore_case: { type: 'boolean', description: 'Case-insensitive match' },
      context: { type: 'number', description: 'Lines of context to show around each match (0-10)' },
    },
    ['pattern']
  ),
  glob: obj({ pattern: str('Glob such as "**/*.test.ts" or "*.md"'), path: str('Directory to search under, default "."') }, ['pattern']),
  find_symbol: obj({ name: str('Exact identifier'), path: str('Directory to search, default "."') }, ['name']),
  find_references: obj({ name: str('Exact identifier'), path: str('Directory to search, default "."') }, ['name']),
  semantic_search: obj({ query: str('What the code does, in words'), topK: { type: 'number', description: 'How many results, default 8' } }, ['query']),
  diagnostics: obj({ path: str('One file; omit for the whole workspace') }, []),
  delete_file: obj({ path: str('Workspace-relative path of a file') }),
  rename_file: obj({ from: str('Current workspace-relative path'), to: str('New workspace-relative path') }),
  run_command: obj({ command: str('Shell command, run in the workspace root'), timeout_seconds: { type: 'number', description: 'Kill the command after this many seconds (default 120)' } }, ['command']),
  run_background: obj({ command: str('Long-running shell command (server, watcher)') }),
  read_background_output: obj({ id: str('Id returned by run_background') }),
  stop_background_process: obj({ id: str('Id returned by run_background') }),
  git_status: obj({}, []),
  git_diff: obj({ path: str('Limit to one path'), staged: { type: 'boolean', description: 'Show staged changes instead' } }, []),
  git_commit: obj(
    { message: str('Commit message describing the actual change'), paths: { type: 'array', items: { type: 'string' }, description: 'Paths to stage; omit for all changes' } },
    ['message']
  ),
  save_plan: obj({ steps: str('One step per line; prefix finished steps with [x]') }),
  remember: obj({ note: str('A short durable fact about this project') }),
  read_url: obj({ url: str('http(s) URL') }),
  delegate_task: obj({ task: str('A self-contained sub-task description') }),
  notify_webhook: obj({ message: str('Short status message') }),
};

/** Drops the inline "Arguments: {...}" part of a text-protocol description. */
function nativeDescription(description) {
  return String(description || '').replace(/\s*Arguments:\s*[\s\S]*$/, '').trim();
}

/**
 * @param {string} name
 * @param {{description: string, schema?: object}} tool
 */
function apiToolFor(name, tool) {
  return {
    type: 'function',
    function: {
      name,
      description: nativeDescription(tool.description),
      parameters: tool.schema || SCHEMAS[name] || { type: 'object', properties: {} },
    },
  };
}

module.exports = { SCHEMAS, apiToolFor, nativeDescription };
