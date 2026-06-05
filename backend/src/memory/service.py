"""MemoryService - manages all four memory layers."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.db.models import ProjectMemory as ProjectMemoryDB
from src.db.models import VectorIndexMetadata


class MemoryService:
    """Coordinates session, project, and vector memory."""

    def __init__(self, session: AsyncSession):
        self.session = session
        self._chroma = None  # Lazy init

    @property
    async def chroma(self):
        if self._chroma is None:
            from src.memory.chroma_manager import ChromaDBManager
            from src.config import settings
            self._chroma = ChromaDBManager(persist_dir=settings.resolved_chromadb_path)
            await self._chroma.initialize()
        return self._chroma

    # ── Project Memory ──

    async def get_project_memory(self, project_path: str) -> dict[str, Any]:
        """Read project memory from DB, falling back to .agent/memory.json."""
        # Try DB first
        result = await self.session.execute(
            select(ProjectMemoryDB).where(ProjectMemoryDB.project_path == project_path)
        )
        row = result.scalar_one_or_none()
        if row:
            return {
                "stack": row.stack or {},
                "conventions": row.conventions or [],
                "important_files": row.important_files or [],
                "last_tasks": row.last_tasks or [],
            }

        # Fallback to file
        memory_file = Path(project_path) / ".agent" / "memory.json"
        if memory_file.exists():
            try:
                with open(memory_file) as f:
                    data = json.load(f)
                return {
                    "stack": data.get("stack", {}),
                    "conventions": data.get("conventions", []),
                    "important_files": data.get("important_files", []),
                    "last_tasks": data.get("last_tasks", []),
                }
            except (json.JSONDecodeError, OSError):
                pass

        return {"stack": {}, "conventions": [], "important_files": [], "last_tasks": []}

    async def update_project_memory(self, project_path: str, memory: dict[str, Any]) -> None:
        """Save project memory to both DB and .agent/memory.json."""
        # DB
        result = await self.session.execute(
            select(ProjectMemoryDB).where(ProjectMemoryDB.project_path == project_path)
        )
        row = result.scalar_one_or_none()
        if row:
            row.stack = memory.get("stack", {})
            row.conventions = memory.get("conventions", [])
            row.important_files = memory.get("important_files", [])
            row.last_tasks = memory.get("last_tasks", [])
        else:
            self.session.add(ProjectMemoryDB(
                project_path=project_path,
                stack=memory.get("stack", {}),
                conventions=memory.get("conventions", []),
                important_files=memory.get("important_files", []),
                last_tasks=memory.get("last_tasks", []),
            ))
        await self.session.commit()

        # File
        memory_dir = Path(project_path) / ".agent"
        memory_dir.mkdir(parents=True, exist_ok=True)
        with open(memory_dir / "memory.json", "w") as f:
            json.dump(memory, f, indent=2)

    # ── RAG Indexing ──

    async def index_project_files(self, project_path: str) -> dict[str, Any]:
        """Walk project directory and index all files into ChromaDB."""
        from src.memory.chunker import TextChunker

        chunker = TextChunker()
        project = Path(project_path)
        all_chunks = []
        file_count = 0

        for root, dirs, files in os.walk(project):
            # Modify dirs in-place to skip ignored directories
            dirs[:] = [d for d in dirs if not d.startswith(".") and d not in {
                "node_modules", ".git", "__pycache__", ".venv", "venv",
                "dist", "build", ".next", ".agent",
            }]

            for file in files:
                file_path = Path(root) / file
                rel_path = str(file_path.relative_to(project))

                if chunker.should_skip_file(rel_path):
                    continue

                try:
                    text = file_path.read_text(encoding="utf-8", errors="replace")
                except (OSError, UnicodeDecodeError):
                    continue

                chunks = chunker.chunk_text(text, rel_path)
                all_chunks.extend(chunks)
                file_count += 1

                # Batch insert to avoid memory issues
                if len(all_chunks) >= 200:
                    chroma_instance = await self.chroma
                    await chroma_instance.add_chunks(all_chunks)
                    all_chunks = []

        # Insert remaining chunks
        if all_chunks:
            chroma_instance = await self.chroma
            await chroma_instance.add_chunks(all_chunks)

        # Update metadata
        result = await self.session.execute(
            select(VectorIndexMetadata).where(VectorIndexMetadata.project_path == project_path)
        )
        row = result.scalar_one_or_none()
        from datetime import datetime, timezone
        if row:
            row.last_indexed = datetime.now(timezone.utc)
            row.total_files = file_count
            row.total_chunks = file_count  # Approximate
        else:
            self.session.add(VectorIndexMetadata(
                project_path=project_path,
                last_indexed=datetime.now(timezone.utc),
                total_files=file_count,
                total_chunks=file_count,
                index_version=1,
            ))
        await self.session.commit()

        return {"files_indexed": file_count, "total_chunks": len(all_chunks)}

    async def index_file(self, project_path: str, file_path: str) -> dict[str, Any]:
        """Re-index a single file after it's been saved."""
        from src.memory.chunker import TextChunker

        chunker = TextChunker()
        full_path = Path(project_path) / file_path

        if not full_path.exists() or chunker.should_skip_file(file_path):
            return {"file_path": file_path, "chunks": 0, "status": "skipped"}

        try:
            text = full_path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            return {"file_path": file_path, "chunks": 0, "status": "error"}

        chunks = chunker.chunk_text(text, file_path)
        chroma_instance = await self.chroma

        # Delete existing chunks for this file
        await chroma_instance.delete_file_chunks(file_path)

        # Add new chunks
        if chunks:
            await chroma_instance.add_chunks(chunks)

        return {"file_path": file_path, "chunks": len(chunks), "status": "indexed"}

    async def retrieve_relevant_chunks(
        self, project_path: str, query: str, top_k: int = 3
    ) -> list[dict[str, Any]]:
        """Retrieve top-K relevant file chunks for a query."""
        try:
            chroma_instance = await self.chroma
            return await chroma_instance.query(query, top_k)
        except Exception:
            return []