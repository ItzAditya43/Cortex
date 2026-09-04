// Language-server-backed code intelligence.
//
// This is the capability a VS Code extension has that a CLI agent
// fundamentally doesn't: the editor already runs a language server for the
// project, which knows types, imports and scopes. Grep guesses; this knows.
// Two things come out of it:
//
//   - definitions/references that are actually correct (right symbol, not
//     every string that happens to match the name)
//   - real compiler/linter diagnostics after an edit, in milliseconds,
//     without running the test suite
//
// `vscode` is required lazily and defensively so the rest of the codebase —
// the CLI, the scheduler, the unit tests — keeps working outside the
// extension host, where the module simply doesn't exist.

'use strict';

const path = require('path');

let vscodeApi;
function vscode() {
  if (vscodeApi !== undefined) return vscodeApi;
  try {
    vscodeApi = require('vscode');
  } catch {
    vscodeApi = null; // not running inside the extension host
  }
  return vscodeApi;
}

function available() {
  return !!vscode();
}

function toRelative(root, uri) {
  return path.relative(root, uri.fsPath) || uri.fsPath;
}

// Language servers activate lazily per file; asking before the server is
// ready returns empty results that look like "no matches" rather than "not
// ready yet". Opening the document forces activation first.
async function openDoc(v, absPath) {
  return v.workspace.openTextDocument(v.Uri.file(absPath));
}

/**
 * Real go-to-definition for a symbol name, via the workspace symbol provider.
 * @returns {Promise<string|null>} formatted results, or null if LSP is unavailable
 */
async function findDefinitions(root, name) {
  const v = vscode();
  if (!v) return null;
  const symbols = await v.commands.executeCommand('vscode.executeWorkspaceSymbolProvider', name);
  if (!Array.isArray(symbols) || symbols.length === 0) return null;
  const exact = symbols.filter((s) => s.name === name);
  const chosen = (exact.length ? exact : symbols).slice(0, 25);
  const KIND = v.SymbolKind;
  const kindName = (k) => Object.keys(KIND).find((key) => KIND[key] === k) || 'Symbol';
  return chosen
    .map((s) => {
      const loc = s.location;
      return `${toRelative(root, loc.uri)}:${loc.range.start.line + 1}  ${kindName(s.kind)} ${s.name}${
        s.containerName ? ` (in ${s.containerName})` : ''
      }`;
    })
    .join('\n');
}

/**
 * Real find-all-references: resolves the symbol at its definition, then asks
 * the language server who actually references *that* symbol — as opposed to
 * grep, which also matches unrelated identifiers and strings with the same name.
 * @returns {Promise<string|null>}
 */
async function findReferences(root, name) {
  const v = vscode();
  if (!v) return null;
  const symbols = await v.commands.executeCommand('vscode.executeWorkspaceSymbolProvider', name);
  const target = (Array.isArray(symbols) ? symbols : []).find((s) => s.name === name);
  if (!target) return null;

  await openDoc(v, target.location.uri.fsPath);
  const refs = await v.commands.executeCommand(
    'vscode.executeReferenceProvider',
    target.location.uri,
    target.location.range.start
  );
  if (!Array.isArray(refs) || refs.length === 0) return null;

  const lines = [];
  for (const ref of refs.slice(0, 100)) {
    let text = '';
    try {
      const doc = await v.workspace.openTextDocument(ref.uri);
      text = doc.lineAt(ref.range.start.line).text.trim();
    } catch {
      // file may be unreadable/binary — the location alone is still useful
    }
    lines.push(`${toRelative(root, ref.uri)}:${ref.range.start.line + 1}  ${text}`);
  }
  return `${refs.length} reference(s):\n${lines.join('\n')}`;
}

const SEVERITY = ['Error', 'Warning', 'Info', 'Hint'];

/**
 * Current compiler/linter diagnostics, optionally for one file.
 * @param {string} root
 * @param {string} [relPath]
 * @param {{errorsOnly?: boolean}} [opts]
 * @returns {string|null} null when LSP is unavailable
 */
function getDiagnostics(root, relPath, opts = {}) {
  const v = vscode();
  if (!v) return null;
  const entries = relPath
    ? [[v.Uri.file(path.resolve(root, relPath)), v.languages.getDiagnostics(v.Uri.file(path.resolve(root, relPath)))]]
    : v.languages.getDiagnostics();

  const out = [];
  for (const [uri, diags] of entries) {
    for (const d of diags) {
      if (opts.errorsOnly && d.severity !== v.DiagnosticSeverity.Error) continue;
      out.push(
        `${toRelative(root, uri)}:${d.range.start.line + 1}:${d.range.start.character + 1}  ` +
          `${SEVERITY[d.severity] || 'Info'}: ${d.message}${d.source ? ` [${d.source}]` : ''}`
      );
    }
  }
  return out.length ? out.join('\n') : '';
}

/**
 * Diagnostics for a file the agent just edited. Language servers re-analyse
 * asynchronously, so this waits briefly for the results to settle rather
 * than reporting the pre-edit state.
 * @returns {Promise<string|null>} errors only, or null/'' when there are none
 */
async function getDiagnosticsAfterEdit(root, relPath, waitMs = 1200) {
  const v = vscode();
  if (!v) return null;
  try {
    await openDoc(v, path.resolve(root, relPath));
  } catch {
    return null; // not a file the editor can open (binary, deleted, etc.)
  }
  await new Promise((r) => setTimeout(r, waitMs));
  return getDiagnostics(root, relPath, { errorsOnly: true });
}

module.exports = { available, findDefinitions, findReferences, getDiagnostics, getDiagnosticsAfterEdit };
