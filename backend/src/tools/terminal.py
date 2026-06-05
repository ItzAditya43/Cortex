"""TerminalManager - manages shell processes for command execution."""

from __future__ import annotations

import asyncio
import time
from typing import Any


class TerminalManager:
    """Manages shell process lifecycle."""

    def __init__(self):
        self._processes: dict[int, asyncio.subprocess.Process] = {}
        self._next_pid: int = 1000

    async def run(
        self,
        command: str,
        cwd: str = "",
        timeout: int = 30,
    ) -> dict[str, Any]:
        """Run a command and capture output."""
        pid = self._next_pid
        self._next_pid += 1

        start_time = time.time()

        try:
            proc = await asyncio.create_subprocess_shell(
                command,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=cwd or None,
            )

            self._processes[pid] = proc

            try:
                stdout_bytes, stderr_bytes = await asyncio.wait_for(
                    proc.communicate(), timeout=timeout
                )
            except asyncio.TimeoutError:
                proc.kill()
                await proc.wait()
                return {
                    "stdout": "",
                    "stderr": f"Command timed out after {timeout}s",
                    "exit_code": -1,
                    "pid": pid,
                    "duration_ms": (time.time() - start_time) * 1000,
                }

            duration_ms = (time.time() - start_time) * 1000

            return {
                "stdout": stdout_bytes.decode("utf-8", errors="replace"),
                "stderr": stderr_bytes.decode("utf-8", errors="replace"),
                "exit_code": proc.returncode or 0,
                "pid": pid,
                "duration_ms": duration_ms,
            }

        except Exception as e:
            return {
                "stdout": "",
                "stderr": str(e),
                "exit_code": -1,
                "pid": pid,
                "duration_ms": (time.time() - start_time) * 1000,
            }
        finally:
            self._processes.pop(pid, None)

    async def kill(self, pid: int) -> dict[str, Any]:
        """Kill a running process."""
        proc = self._processes.get(pid)
        if proc is None:
            return {"success": False, "error": f"No process with PID {pid}"}

        try:
            proc.kill()
            await proc.wait()
            self._processes.pop(pid, None)
            return {"success": True, "pid": pid}
        except Exception as e:
            return {"success": False, "error": str(e)}

    @property
    def active_pids(self) -> list[int]:
        return list(self._processes.keys())