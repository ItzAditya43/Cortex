"""Text chunking logic for RAG indexing."""

from __future__ import annotations

import re


class TextChunker:
    """Chunks text files into overlapping segments for vector indexing."""

    def __init__(
        self,
        chunk_size: int = 512,
        chunk_overlap: int = 64,
        min_chunk_size: int = 50,
    ):
        self.chunk_size = chunk_size
        self.chunk_overlap = chunk_overlap
        self.min_chunk_size = min_chunk_size

    def chunk_text(self, text: str, file_path: str = "") -> list[dict]:
        """Split text into chunks with metadata.

        Returns list of {file_path, content, start_line, end_line}
        """
        if not text or len(text.strip()) < self.min_chunk_size:
            return [{"file_path": file_path, "content": text, "start_line": 1, "end_line": len(text.splitlines())}]

        lines = text.splitlines()
        chunks = []
        current_chunk: list[str] = []
        current_size = 0
        start_line = 1
        line_number = 1

        for line in lines:
            line_len = len(line) + 1  # +1 for newline
            if current_size + line_len > self.chunk_size and current_chunk:
                # Save current chunk
                chunk_text = "\n".join(current_chunk)
                chunks.append({
                    "file_path": file_path,
                    "content": chunk_text,
                    "start_line": start_line,
                    "end_line": line_number - 1,
                })
                # Start new chunk with overlap
                overlap_lines = self._get_overlap_lines(current_chunk, self.chunk_overlap)
                current_chunk = overlap_lines
                current_size = sum(len(l) + 1 for l in overlap_lines)
                start_line = line_number - len(overlap_lines)

            current_chunk.append(line)
            current_size += line_len
            line_number += 1

        # Don't forget the last chunk
        if current_chunk and current_size > self.min_chunk_size:
            chunk_text = "\n".join(current_chunk)
            chunks.append({
                "file_path": file_path,
                "content": chunk_text,
                "start_line": start_line,
                "end_line": line_number - 1,
            })

        return chunks

    def _get_overlap_lines(self, lines: list[str], overlap_chars: int) -> list[str]:
        """Get trailing lines that provide ~overlap_chars of overlap."""
        overlap_lines: list[str] = []
        size = 0
        for line in reversed(lines):
            line_len = len(line) + 1
            if size + line_len > overlap_chars and overlap_lines:
                break
            overlap_lines.insert(0, line)
            size += line_len
        return overlap_lines or lines[-1:] if lines else []

    def should_skip_file(self, file_path: str, ignored_patterns: list[str] | None = None) -> bool:
        """Check if a file should be skipped during indexing."""
        ignored = ignored_patterns or [
            "node_modules", ".git", "__pycache__", ".venv", "venv",
            "dist", "build", ".next", ".agent", ".vscode",
            "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
            ".pyc", ".pyo", ".pyd", ".so", ".dll", ".dylib",
            ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico",
            ".ttf", ".otf", ".woff", ".woff2", ".eot",
            ".mp4", ".avi", ".mov", ".mkv", ".flv",
            ".mp3", ".wav", ".flac", ".ogg",
            ".zip", ".tar", ".gz", ".rar", ".7z",
            ".pdf", ".doc", ".docx", ".xls",
        ]

        fp = file_path.lower()
        for pattern in ignored:
            if pattern.startswith("."):
                if fp.endswith(pattern):
                    return True
            elif pattern in fp.split("/") or pattern in fp.split("\\"):
                return True
        return False