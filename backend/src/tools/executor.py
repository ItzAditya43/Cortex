"""ToolExecutor - executes tools requested by the model."""

from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Any

from src.tools.terminal import TerminalManager
from src.tools.registry import is_safe_command


class ToolExecutor:
    """Executes tool calls. File ops and terminal ops run on the backend."""

    def __init__(self, project_path: str, session_id: str = ""):
        self.project_path = project_path
        self.session_id = session_id
        self.terminal = TerminalManager()

    async def execute(self, tool_name: str, params: dict[str, Any]) -> dict[str, Any]:
        """Execute a tool and return the result."""
        executor = self._get_executor(tool_name)
        if executor is None:
            return {"error": f"Unknown tool: {tool_name}"}
        return await executor(params)

    def _get_executor(self, name: str):
        mapping = {
            "read_file": self._read_file,
            "write_file": self._write_file,
            "create_file": self._create_file,
            "delete_file": self._delete_file,
            "search_files": self._search_files,
            "list_directory": self._list_directory,
            "run_command": self._run_command,
            "kill_process": self._kill_process,
            "git_status": self._git_status,
            "git_diff": self._git_diff,
            "git_commit": self._git_commit,
        }
        return mapping.get(name)

    def _resolve_path(self, path: str) -> Path:
        """Resolve a relative path against project root."""
        p = Path(path)
        if p.is_absolute():
            return p
        return Path(self.project_path) / path

    def _compute_diff(self, old: str, new: str, path: str) -> str:
        """Simple unified diff computation."""
        old_lines = old.splitlines(keepends=True)
        new_lines = new.splitlines(keepends=True)
        diff_lines = []
        diff_lines.append(f"--- a/{path}")
        diff_lines.append(f"+++ b/{path}")

        import difflib
        for line in difflib.unified_diff(old_lines, new_lines, fromfile=f"a/{path}", tofile=f"b/{path}", n=3):
            diff_lines.append(line.rstrip("\n"))

        return "\n".join(diff_lines)

    async def _read_file(self, params: dict) -> dict[str, Any]:
        path = self._resolve_path(params.get("path", ""))
        try:
            if not path.exists():
                return {"error": f"File not found: {path}"}
            content = path.read_text(encoding="utf-8", errors="replace")
            return {
                "content": content,
                "line_count": len(content.splitlines()),
                "path": str(path),
            }
        except Exception as e:
            return {"error": str(e)}

    async def _write_file(self, params: dict) -> dict[str, Any]:
        path = self._resolve_path(params.get("path", ""))
        content = params.get("content", "")
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            old_content = path.read_text(encoding="utf-8", errors="replace") if path.exists() else ""
            path.write_text(content, encoding="utf-8")
            return {
                "path": str(path),
                "success": True,
                "diff": self._compute_diff(old_content, content, str(path)),
            }
        except Exception as e:
            return {"error": str(e)}

    async def _create_file(self, params: dict) -> dict[str, Any]:
        path = self._resolve_path(params.get("path", ""))
        content = params.get("content", "")
        try:
            if path.exists():
                return {"error": f"File already exists: {path}", "path": str(path), "success": False}
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding="utf-8")
            return {"path": str(path), "success": True}
        except Exception as e:
            return {"error": str(e)}

    async def _delete_file(self, params: dict) -> dict[str, Any]:
        path = self._resolve_path(params.get("path", ""))
        try:
            if not path.exists():
                return {"error": f"File not found: {path}"}
            path.unlink()
            return {"path": str(path), "success": True}
        except Exception as e:
            return {"error": str(e)}

    async def _search_files(self, params: dict) -> dict[str, Any]:
        query = params.get("query", "")
        directory = params.get("directory", ".")
        search_dir = self._resolve_path(directory)
        try:
            result = subprocess.run(
                ["grep", "-rn", "--include=*.py", "--include=*.ts", "--include=*.tsx",
                 "--include=*.js", "--include=*.jsx", "--include=*.json",
                 "--include=*.toml", "--include=*.yaml", "--include=*.yml",
                 "--include=*.md", "--include=*.css", "--include=*.html",
                 "-l", query, str(search_dir)],
                capture_output=True, text=True, timeout=10,
            )
            matching_files = result.stdout.strip().split("\n") if result.stdout.strip() else []
            matching_files = [f for f in matching_files if f][:20]
            return {"matches": matching_files, "count": len(matching_files), "query": query}
        except subprocess.TimeoutExpired:
            return {"matches": [], "count": 0, "query": query, "error": "Search timed out"}
        except FileNotFoundError:
            # grep not available, fallback to Python search
            matches = []
            for ext in ["*.py", "*.ts", "*.tsx", "*.js", "*.jsx", "*.json", "*.md", "*.toml", "*.yaml", "*.yml", "*.css", "*.html"]:
                for f in search_dir.rglob(ext):
                    try:
                        if query in f.read_text(encoding="utf-8", errors="replace"):
                            matches.append(str(f.relative_to(Path(self.project_path))))
                            if len(matches) >= 20:
                                break
                    except (OSError, UnicodeDecodeError):
                        continue
                if len(matches) >= 20:
                    break
            return {"matches": matches, "count": len(matches), "query": query}

    async def _list_directory(self, params: dict) -> dict[str, Any]:
        path = self._resolve_path(params.get("path", "."))
        recursive = params.get("recursive", False)
        try:
            if not path.exists() or not path.is_dir():
                return {"error": f"Directory not found: {path}"}

            if recursive:
                tree = []
                for f in sorted(path.rglob("*")):
                    tree.append({
                        "path": str(f.relative_to(Path(self.project_path))),
                        "type": "directory" if f.is_dir() else "file",
                        "size": f.stat().st_size if f.is_file() else 0,
                    })
                return {"tree": tree, "count": len(tree), "path": str(path)}
            else:
                entries = sorted(path.iterdir())
                tree = []
                for e in entries:
                    tree.append({
                        "name": e.name,
                        "type": "directory" if e.is_dir() else "file",
                        "size": e.stat().st_size if e.is_file() else 0,
                    })
                return {"tree": tree, "count": len(tree), "path": str(path)}
        except Exception as e:
            return {"error": str(e)}

    async def _run_command(self, params: dict) -> dict[str, Any]:
        command = params.get("command", "")
        cwd = params.get("cwd", self.project_path)
        timeout = params.get("timeout", 30)
        safe = is_safe_command(command)
        return await self.terminal.run(command, cwd=cwd, timeout=timeout)

    async def _kill_process(self, params: dict) -> dict[str, Any]:
        pid = params.get("pid", 0)
        return await self.terminal.kill(pid)

    async def _git_status(self, params: dict | None = None) -> dict[str, Any]:
        try:
            result = subprocess.run(
                ["git", "status", "--porcelain"],
                capture_output=True, text=True, timeout=10,
                cwd=self.project_path,
            )
            lines = [line for line in result.stdout.split("\n") if line.strip()]
            return {"files": lines, "count": len(lines), "clean": len(lines) == 0}
        except Exception as e:
            return {"error": str(e)}

    async def _git_diff(self, params: dict) -> dict[str, Any]:
        file_path = params.get("file", "")
        try:
            cmd = ["git", "diff"]
            if file_path:
                cmd.append(file_path)
            result = subprocess.run(
                cmd, capture_output=True, text=True, timeout=10,
                cwd=self.project_path,
            )
            return {"diff": result.stdout, "file": file_path or "all"}
        except Exception as e:
            return {"error": str(e)}

    async def _git_commit(self, params: dict) -> dict[str, Any]:
        message = params.get("message", "")
        if not message:
            return {"error": "Commit message is required"}
        try:
            subprocess.run(
                ["git", "add", "-A"],
                capture_output=True, text=True, timeout=10,
                cwd=self.project_path,
            )
            result = subprocess.run(
                ["git", "commit", "-m", message],
                capture_output=True, text=True, timeout=10,
                cwd=self.project_path,
            )
            return {
                "success": result.returncode == 0,
                "hash": result.stdout.strip() if result.returncode == 0 else "",
                "message": message,
                "output": result.stdout + result.stderr,
            }
        except Exception as e:
            return {"error": str(e)}