"""Tool definitions and schemas."""

from __future__ import annotations

TOOL_DEFINITIONS = [
    {
        "name": "read_file",
        "description": "Read the contents of a file. Use this when you need to examine source code or configuration files.",
        "parameters": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Path to the file, relative to workspace root"},
            },
            "required": ["path"],
        },
        "requires_approval": False,
    },
    {
        "name": "write_file",
        "description": "Write content to a file. Creates or overwrites the file with the given content. Shows a diff preview for approval.",
        "parameters": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Path to the file, relative to workspace root"},
                "content": {"type": "string", "description": "Full content to write to the file"},
            },
            "required": ["path", "content"],
        },
        "requires_approval": True,
    },
    {
        "name": "create_file",
        "description": "Create a new file at the specified path with the given content.",
        "parameters": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Path for the new file, relative to workspace root"},
                "content": {"type": "string", "description": "Content for the new file"},
            },
            "required": ["path", "content"],
        },
        "requires_approval": True,
    },
    {
        "name": "delete_file",
        "description": "Permanently delete a file. Requires explicit user approval.",
        "parameters": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Path to the file to delete"},
            },
            "required": ["path"],
        },
        "requires_approval": True,
    },
    {
        "name": "search_files",
        "description": "Search for files matching a query using regex or keyword search. Returns ranked matches with context.",
        "parameters": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Search query (regex or keyword)"},
                "directory": {"type": "string", "description": "Directory to search in, relative to workspace root"},
            },
            "required": ["query"],
        },
        "requires_approval": False,
    },
    {
        "name": "list_directory",
        "description": "List files and directories in a path. Shows a tree structure.",
        "parameters": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Directory path, relative to workspace root"},
                "recursive": {"type": "boolean", "description": "Whether to list recursively"},
            },
            "required": ["path"],
        },
        "requires_approval": False,
    },
    {
        "name": "run_command",
        "description": "Execute a command in the terminal. Safe commands (test, build, lint) are auto-approved. Other commands require approval.",
        "parameters": {
            "type": "object",
            "properties": {
                "command": {"type": "string", "description": "Command to execute"},
                "cwd": {"type": "string", "description": "Working directory, defaults to workspace root"},
                "timeout": {"type": "integer", "description": "Timeout in seconds", "default": 30},
            },
            "required": ["command"],
        },
        "requires_approval": None,  # Dynamic: checked at runtime
    },
    {
        "name": "kill_process",
        "description": "Kill a running process by PID.",
        "parameters": {
            "type": "object",
            "properties": {
                "pid": {"type": "integer", "description": "Process ID to kill"},
            },
            "required": ["pid"],
        },
        "requires_approval": True,
    },
    {
        "name": "git_status",
        "description": "Show git status (changed files, staged files).",
        "parameters": {
            "type": "object",
            "properties": {},
            "required": [],
        },
        "requires_approval": False,
    },
    {
        "name": "git_diff",
        "description": "Show git diff for working tree or a specific file.",
        "parameters": {
            "type": "object",
            "properties": {
                "file": {"type": "string", "description": "Optional file to get diff for"},
            },
            "required": [],
        },
        "requires_approval": False,
    },
    {
        "name": "git_commit",
        "description": "Stage all changes and create a git commit.",
        "parameters": {
            "type": "object",
            "properties": {
                "message": {"type": "string", "description": "Commit message"},
            },
            "required": ["message"],
        },
        "requires_approval": True,
    },
]


SAFE_COMMAND_PREFIXES = [
    "npm test",
    "npm run test",
    "npm run build",
    "npm run lint",
    "pip test",
    "python -m pytest",
    "pytest",
    "go test",
    "cargo test",
    "npx tsc --noEmit",
    "make test",
    "make build",
    "make lint",
    "git status",
    "git diff",
    "ls",
    "cat",
    "head",
    "tail",
    "grep",
    "find",
    "which",
]


def is_safe_command(command: str) -> bool:
    """Check if a command is safe by matching against known safe prefixes."""
    cmd_trimmed = command.strip()
    for prefix in SAFE_COMMAND_PREFIXES:
        if cmd_trimmed.startswith(prefix):
            return True
    return False