"""ChromaDBManager - wrapper around ChromaDB for vector storage."""

from __future__ import annotations

import os
import uuid
from typing import Any


class ChromaDBManager:
    """Manages ChromaDB vector index for RAG."""

    def __init__(self, persist_dir: str = ""):
        self.persist_dir = persist_dir
        self._client = None
        self._collection = None
        self._embedder = None
        self._initialized = False

    async def initialize(self):
        """Initialize ChromaDB client and collection (lazy)."""
        if self._initialized:
            return

        os.makedirs(self.persist_dir, exist_ok=True)

        import chromadb
        self._client = chromadb.PersistentClient(path=self.persist_dir)
        self._collection = self._client.get_or_create_collection(
            name="project_files",
            metadata={"hnsw:space": "cosine"},
        )

        try:
            from sentence_transformers import SentenceTransformer
            self._embedder = SentenceTransformer("all-MiniLM-L6-v2")
        except ImportError:
            self._embedder = None

        self._initialized = True

    async def add_chunks(self, chunks: list[dict[str, Any]]):
        """Add chunks to the vector index."""
        if not chunks or self._collection is None:
            return

        texts = [c["content"] for c in chunks]
        metadatas = [
            {
                "file_path": c.get("file_path", ""),
                "start_line": c.get("start_line", 0),
                "end_line": c.get("end_line", 0),
            }
            for c in chunks
        ]
        ids = [f"chunk_{uuid.uuid4().hex[:16]}" for _ in chunks]

        if self._embedder is not None:
            embeddings = self._embedder.encode(texts, show_progress_bar=False).tolist()
            self._collection.add(
                ids=ids,
                embeddings=embeddings,
                metadatas=metadatas,
                documents=texts,
            )
        else:
            # Without embedder, use ChromaDB's default all-MiniLM-L6-v2 via onnx
            self._collection.add(
                ids=ids,
                metadatas=metadatas,
                documents=texts,
            )

    async def query(self, query_text: str, top_k: int = 3) -> list[dict[str, Any]]:
        """Query the vector index for similar chunks."""
        if self._collection is None:
            return []

        if self._embedder is not None:
            query_embedding = self._embedder.encode([query_text], show_progress_bar=False).tolist()
            results = self._collection.query(
                query_embeddings=query_embedding,
                n_results=min(top_k, 20),
            )
        else:
            results = self._collection.query(
                query_texts=[query_text],
                n_results=min(top_k, 20),
            )

        output = []
        if results and results.get("ids") and results["ids"][0]:
            for i in range(len(results["ids"][0])):
                meta = results.get("metadatas", [{}])[0][i] if results.get("metadatas") else {}
                output.append({
                    "file_path": meta.get("file_path", ""),
                    "content": (results.get("documents", [[]])[0][i] if results.get("documents") else ""),
                    "score": float(1 - (results.get("distances", [[0]])[0][i] if results.get("distances") else [0])[0]),
                    "start_line": meta.get("start_line", 0),
                    "end_line": meta.get("end_line", 0),
                })

        return sorted(output, key=lambda x: x["score"], reverse=True)

    async def delete_file_chunks(self, file_path: str):
        """Delete all chunks for a specific file."""
        if self._collection is None:
            return
        self._collection.delete(where={"file_path": file_path})

    async def delete_all(self):
        """Delete all chunks."""
        if self._collection is None:
            return
        self._collection.delete(where={})

    @property
    def is_ready(self) -> bool:
        return self._initialized