// Retrieval-based memory: instead of dumping every saved note into every
// system prompt (which burns context and buries what's actually relevant),
// embed each note once via Ollama's /api/embeddings and, per turn, inject
// only the notes whose embedding is closest to the current user message.
//
// Best-effort throughout: embedding is an extra local model call, so any
// failure (model doesn't support embeddings, Ollama unreachable) just falls
// back to returning all notes untouched — never blocks the agent loop.

'use strict';

const fs = require('fs');
const path = require('path');

const DIR = '.cortex';
const EMBED_FILE = 'embeddings.json';
const EMBED_MODEL_DEFAULT = 'nomic-embed-text';

function embedFile(root) {
  const d = path.join(root, DIR);
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  return path.join(d, EMBED_FILE);
}

function loadEmbeddings(root) {
  const f = embedFile(root);
  if (!fs.existsSync(f)) return [];
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return [];
  }
}

function saveEmbeddings(root, entries) {
  fs.writeFileSync(embedFile(root), JSON.stringify(entries, null, 2));
}

async function embed({ host, model = EMBED_MODEL_DEFAULT, text }) {
  const res = await fetch(`${host}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt: text }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`embeddings HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data.embedding)) throw new Error('no embedding in response');
  return data.embedding;
}

// Called after a note is appended to MEMORY.md — embeds it and appends to
// the parallel embeddings store. Never throws; logs are the caller's job.
async function indexNote(root, host, note) {
  try {
    const vector = await embed({ host, text: note });
    const entries = loadEmbeddings(root);
    entries.push({ note, vector });
    saveEmbeddings(root, entries);
  } catch {
    // Embedding model unavailable — the note still lives in MEMORY.md as
    // plain text and will just be included verbatim as a fallback.
  }
}

function cosineSim(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Returns the top-K most relevant notes for the given query, or null if
// semantic retrieval isn't available (no index yet / embedding failed) —
// callers should fall back to the full flat MEMORY.md text in that case.
async function retrieveRelevantNotes(root, host, query, topK = 8) {
  const entries = loadEmbeddings(root);
  if (entries.length === 0) return null;
  let queryVector;
  try {
    queryVector = await embed({ host, text: query });
  } catch {
    return null;
  }
  const scored = entries
    .map((e) => ({ note: e.note, score: cosineSim(queryVector, e.vector) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
  return scored.map((s) => s.note).join('\n');
}

module.exports = { indexNote, retrieveRelevantNotes, loadEmbeddings };
