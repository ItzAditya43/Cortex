// Minimal MCP (Model Context Protocol) client over stdio — no SDK
// dependency, just the JSON-RPC 2.0 handshake MCP servers speak over
// newline-delimited stdin/stdout. Enough to discover a server's tools and
// call them; not a full client (no resources/prompts/sampling support).

'use strict';

const { spawn } = require('child_process');

/**
 * @param {{command: string, args?: string[], env?: object}} config
 * @returns {Promise<{tools: Array, callTool: (name: string, args: object) => Promise<string>, close: () => void}>}
 */
function connectMcpServer(config) {
  return new Promise((resolve, reject) => {
    const proc = spawn(config.command, config.args || [], {
      env: { ...process.env, ...(config.env || {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let buf = '';
    let nextId = 1;
    const pending = new Map(); // id -> {resolve, reject}
    let settledInit = false;

    const timeout = setTimeout(() => {
      if (!settledInit) {
        proc.kill();
        reject(new Error(`MCP server "${config.command}" did not respond to initialize within 10s`));
      }
    }, 10_000);

    proc.on('error', (err) => {
      if (!settledInit) {
        clearTimeout(timeout);
        reject(new Error(`failed to start MCP server "${config.command}": ${err.message}`));
      }
    });

    proc.stderr.on('data', () => {
      // MCP servers commonly log diagnostics to stderr; not surfaced here to
      // avoid noise, but the process staying alive is what matters.
    });

    proc.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id !== undefined && pending.has(msg.id)) {
          const { resolve: res, reject: rej } = pending.get(msg.id);
          pending.delete(msg.id);
          if (msg.error) rej(new Error(msg.error.message || 'MCP error'));
          else res(msg.result);
        }
      }
    });

    function send(method, params) {
      const id = nextId++;
      const req = { jsonrpc: '2.0', id, method, params: params || {} };
      return new Promise((res, rej) => {
        pending.set(id, { resolve: res, reject: rej });
        proc.stdin.write(JSON.stringify(req) + '\n');
      });
    }

    function notify(method, params) {
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params: params || {} }) + '\n');
    }

    send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'cortex', version: '0.1.0' },
    })
      .then(async () => {
        notify('notifications/initialized');
        const result = await send('tools/list');
        settledInit = true;
        clearTimeout(timeout);
        resolve({
          tools: result?.tools || [],
          callTool: async (name, args) => {
            const r = await send('tools/call', { name, arguments: args || {} });
            const parts = r?.content || [];
            return parts.map((p) => (p.type === 'text' ? p.text : JSON.stringify(p))).join('\n') || '(no output)';
          },
          close: () => proc.kill(),
        });
      })
      .catch((err) => {
        if (!settledInit) {
          clearTimeout(timeout);
          proc.kill();
          reject(err);
        }
      });
  });
}

module.exports = { connectMcpServer };
