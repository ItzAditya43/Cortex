// Connects to configured MCP servers (cortex.mcpServers setting) at
// extension activation and registers each of their tools into the shared
// tool registry, prefixed "mcp_<server>_<tool>" so names can't collide with
// built-ins or other servers.

'use strict';

const { connectMcpServer, connectMcpHttpServer } = require('./mcpClient.cjs');
const { registerExternalTool, unregisterExternalTool } = require('./tools.cjs');

let activeServers = []; // [{name, close, toolNames: string[]}]

/**
 * @param {Array<{name: string, command?: string, args?: string[], env?: object, url?: string, headers?: object}>} serverConfigs
 *   Each entry is either a stdio server (command [+ args/env]) or an HTTP server (url [+ headers]).
 * @param {(message: string) => void} [logFn]
 */
async function startMcpServers(serverConfigs, logFn) {
  await stopMcpServers();
  if (!Array.isArray(serverConfigs) || serverConfigs.length === 0) return;

  for (const cfg of serverConfigs) {
    if (!cfg.name || (!cfg.command && !cfg.url)) continue;
    try {
      const { tools: mcpTools, callTool, close } = await (cfg.url ? connectMcpHttpServer(cfg) : connectMcpServer(cfg));
      const toolNames = [];
      for (const t of mcpTools) {
        const localName = `mcp_${cfg.name}_${t.name}`.replace(/[^a-zA-Z0-9_]/g, '_');
        registerExternalTool(localName, {
          description: `[MCP:${cfg.name}] ${t.description || t.name}`,
          confirm: true, // external/third-party tools default to requiring approval
          run: async (args) => {
            try {
              return await callTool(t.name, args);
            } catch (err) {
              return `ERROR from MCP server "${cfg.name}": ${err.message}`;
            }
          },
        });
        toolNames.push(localName);
      }
      activeServers.push({ name: cfg.name, close, toolNames });
      logFn?.(`MCP: connected "${cfg.name}" (${toolNames.length} tool(s))`);
    } catch (err) {
      logFn?.(`MCP: failed to connect "${cfg.name}": ${err.message}`);
    }
  }
}

async function stopMcpServers() {
  for (const server of activeServers) {
    for (const name of server.toolNames) unregisterExternalTool(name);
    try {
      server.close();
    } catch {
      // best-effort teardown
    }
  }
  activeServers = [];
}

module.exports = { startMcpServers, stopMcpServers };
