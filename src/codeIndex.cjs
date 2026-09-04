// Semantic code search.
//
// grep/search_code only finds what you can already name exactly. "where do
// we handle auth failures" matches nothing unless those words are literally
// in the source. Embedding the codebase and searching by meaning is what
// makes an agent effective on a repo it hasn't memorised.
//
// Reuses the same Ollama /api/embeddings path as semanticMemory.cjs, so
// there's no new dependency and no new model to install beyond the embed
// model already used for memory.

'use strict';

const fs = require('fs');
const path = require('path');

const INDEX_FILE = path.join('.cortex', 'code-index.json');
const EMBED_MODEL_DEFAULT = 'nomic-embed-text';
const CHUNK_LINES = 60;
const CHUNK_OVERLAP = 10;
const MAX_FILE_BYTES = 400 * 1024;
const SKIP_DIRS = new Set(['node_modules', '.git', '.cortex', 'dist', 'build', 'out', 'vendor', '__pycache__', '.venv']);
const CODE_EXT = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.cjs', '.mjs', '.py', '.rb', '.go', '.rs', '.java', '.kt', '.c', '.h',
  '.cpp', '.hpp', '.cs', '.php', '.swift', '.scala', '.sh', '.sql', '.vue', '.svelte', '.md',
]);

function indexPath(root) {
  const f = path.join(root, INDEX_FILE);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  return f;
}

function walk(dir, root, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.cortexrules') continue;
    if (SKIP_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, root, out);
    else if (CODE_EXT.has(path.extname(e.name))) {
      try {
        if (fs.statSync(full).size <= MAX_FILE_BYTES) out.push(path.relative(root, full));
      } catch {
        // unreadable — skip
      }
    }
  }
  return out;
}

// Overlapping line windows: a function split across a boundary still has one
// chunk containing enough of it to match.
function chunkFile(root, relPath) {
  let text;
  try {
    text = fs.readFileSync(path.join(root, relPath), 'utf8');
  } catch {
    return [];
  }
  const lines = text.split('\n');
  const chunks = [];
  for (let start = 0; start < lines.length; start += CHUNK_LINES - CHUNK_OVERLAP) {
    const slice = lines.slice(start, start + CHUNK_LINES);
    if (slice.join('').trim() === '') continue;
    chunks.push({ path: relPath, startLine: start + 1, endLine: Math.min(start + CHUNK_LINES, lines.length), text: slice.join('\n') });
    if (start + CHUNK_LINES >= lines.length) break;
  }
  return chunks;
}

async function embed(host, model, text) {
  const res = await fetch(`${host}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt: text }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`embeddings HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data.embedding)) throw new Error('no embedding returned');
  return data.embedding;
}

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

function loadIndex(root) {
  try {
    return JSON.parse(fs.readFileSync(indexPath(root), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Builds/refreshes the index. Files whose mtime is unchanged since the last
 * build keep their existing vectors, so re-indexing a large repo after a few
 * edits costs a few embeds rather than thousands.
 * @param {(done: number, total: number) => void} [onProgress]
 */
async function buildIndex(root, { host, model = EMBED_MODEL_DEFAULT, onProgress } = {}) {
  const files = walk(root, root);
  const previous = loadIndex(root);
  const oldByKey = new Map((previous?.chunks || []).map((c) => [`${c.path}:${c.startLine}`, c]));
  const oldMtimes = previous?.mtimes || {};

  const mtimes = {};
  const chunks = [];
  let embedded = 0;
  let reused = 0;

  for (const rel of files) {
    let mtime = 0;
    try {
      mtime = fs.statSync(path.join(root, rel)).mtimeMs;
    } catch {
      continue;
    }
    mtimes[rel] = mtime;
    const unchanged = oldMtimes[rel] === mtime;

    for (const chunk of chunkFile(root, rel)) {
      const key = `${chunk.path}:${chunk.startLine}`;
      const cached = unchanged ? oldByKey.get(key) : null;
      if (cached?.vector) {
        chunks.push(cached);
        reused++;
        continue;
      }
      try {
        chunk.vector = await embed(host, model, `${rel}\n${chunk.text}`);
        chunks.push(chunk);
        embedded++;
      } catch (err) {
        // A failed embed shouldn't abort the whole build — but a failure on
        // the very first chunk means the model/host is wrong, so stop rather
        // than grinding through thousands of doomed requests.
        if (embedded === 0 && reused === 0) throw err;
      }
      onProgress?.(embedded + reused, chunks.length);
    }
  }

  const index = { model, builtAt: Date.now(), mtimes, chunks };
  fs.writeFileSync(indexPath(root), JSON.stringify(index));
  return { files: files.length, chunks: chunks.length, embedded, reused };
}

/**
 * @returns {Promise<Array<{path, startLine, endLine, text, score}>>}
 */
async function search(root, query, { host, model = EMBED_MODEL_DEFAULT, topK = 8 } = {}) {
  const index = loadIndex(root);
  if (!index || !index.chunks?.length) return null;
  const qv = await embed(host, index.model || model, query);
  return index.chunks
    .filter((c) => c.vector)
    .map((c) => ({ ...c, score: cosine(qv, c.vector) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map(({ vector, ...rest }) => rest);
}

function indexStats(root) {
  const index = loadIndex(root);
  if (!index) return null;
  return { chunks: index.chunks?.length || 0, files: Object.keys(index.mtimes || {}).length, builtAt: index.builtAt };
}

module.exports = { buildIndex, search, indexStats };
