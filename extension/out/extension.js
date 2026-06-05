"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const fs = __importStar(require("fs"));
const AgentController_1 = require("./agent/AgentController");
const ApprovalManager_1 = require("./agent/ApprovalManager");
const BackendClient_1 = require("./agent/BackendClient");
const WebviewMessenger_1 = require("./webview/WebviewMessenger");
const settings_1 = require("./utils/settings");
let activeController;
let activePanel;
function activate(context) {
    console.log('Agent OS extension activating...');
    // Register commands
    const startCommand = vscode.commands.registerCommand('agentOS.start', () => {
        startSession(context);
    });
    const askCommand = vscode.commands.registerCommand('agentOS.ask', () => {
        if (!activePanel) {
            startSession(context);
        }
        // Focus the input
        if (activePanel) {
            activePanel.reveal(vscode.ViewColumn.Beside);
        }
    });
    const toggleYoloCommand = vscode.commands.registerCommand('agentOS.toggleYolo', () => {
        const config = vscode.workspace.getConfiguration('agentOS');
        const current = config.get('yoloMode', false);
        config.update('yoloMode', !current, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(`Agent OS: YOLO mode ${!current ? 'enabled' : 'disabled'}`);
    });
    // Listen for file saves to trigger re-indexing
    context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(async (doc) => {
        if (activeController && doc.uri.scheme === 'file') {
            const workspaceFolder = vscode.workspace.getWorkspaceFolder(doc.uri);
            if (workspaceFolder) {
                const relativePath = vscode.workspace.asRelativePath(doc.uri);
                try {
                    await activeController.backendClient.indexFile(workspaceFolder.uri.fsPath, relativePath);
                }
                catch (e) {
                    // Silently fail for indexing
                }
            }
        }
    }));
    context.subscriptions.push(startCommand, askCommand, toggleYoloCommand);
    console.log('Agent OS extension activated.');
}
async function startSession(context) {
    // Check for open workspace
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
        vscode.window.showErrorMessage('Agent OS requires an open workspace folder.');
        return;
    }
    // Create or reveal panel
    if (activePanel) {
        activePanel.reveal(vscode.ViewColumn.Beside);
        return;
    }
    activePanel = vscode.window.createWebviewPanel('agentOS', 'Agent OS', vscode.ViewColumn.Beside, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
            vscode.Uri.joinPath(context.extensionUri, 'out', 'webview')
        ],
    });
    // Set webview HTML
    activePanel.webview.html = getWebviewHtml(activePanel.webview, context);
    // Create the backend client
    const backendUrl = settings_1.settings.backendUrl;
    const backendClient = new BackendClient_1.BackendClient(backendUrl);
    // Create approval manager
    const approvalManager = new ApprovalManager_1.ApprovalManager();
    approvalManager.setMode(settings_1.settings.yoloMode ? 'yolo' : 'normal');
    // Create webview messenger
    const messenger = new WebviewMessenger_1.WebviewMessenger(activePanel);
    // Create agent controller
    activeController = new AgentController_1.AgentController(workspaceFolder.uri.fsPath, backendClient, approvalManager, messenger, settings_1.settings.provider, settings_1.settings.model);
    // Initialize the session — gracefully handle backend being offline
    try {
        await activeController.initialize(settings_1.settings.autoIndex);
    }
    catch (e) {
        console.warn('Agent OS: Backend initialization failed:', e.message);
        messenger.send('error', {
            message: `Backend unavailable: ${e.message}. Click reconnect to try again.`,
        });
        messenger.send('agent_state', { state: 'error' });
    }
    // Handle panel disposal
    activePanel.onDidDispose(() => {
        activeController?.shutdown().catch(() => { });
        activePanel = undefined;
        activeController = undefined;
    });
    // Listen for config changes
    vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('agentOS')) {
            const config = vscode.workspace.getConfiguration('agentOS');
            approvalManager.setMode(config.get('yoloMode', false) ? 'yolo' : 'normal');
        }
    });
}
function getWebviewHtml(webview, context) {
    const webviewPath = vscode.Uri.joinPath(context.extensionUri, 'out', 'webview');
    const indexHtmlPath = vscode.Uri.joinPath(webviewPath, 'index.html');
    // Read the Vite-generated index.html
    let html;
    try {
        html = fs.readFileSync(indexHtmlPath.fsPath, 'utf-8');
    }
    catch {
        // Fallback if index.html is missing
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'none';
                   style-src ${webview.cspSource} 'unsafe-inline';
                   script-src ${webview.cspSource} 'unsafe-inline';
                   font-src ${webview.cspSource};">
    <title>Agent OS</title>
</head>
<body>
    <div id="root"></div>
    <p>Webview assets not found. Run: npm run build:webview</p>
</body>
</html>`;
    }
    // Rewrite asset URLs to use webview.asWebviewUri()
    // Handles absolute (/assets/...), relative (./assets/...), and bare (assets/...) paths
    html = html.replace(/((?:src|href)=")(?:\.\/|\/)?(assets\/[^"]+)(")/g, (_match, prefix, assetPath, suffix) => {
        const assetUri = webview.asWebviewUri(vscode.Uri.joinPath(webviewPath, assetPath));
        return `${prefix}${assetUri}${suffix}`;
    });
    // Replace CSP with webview-compatible CSP using ${webview.cspSource}
    html = html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, `<meta http-equiv="Content-Security-Policy"
              content="default-src 'none';
                       style-src ${webview.cspSource} 'unsafe-inline';
                       script-src ${webview.cspSource};
                       font-src ${webview.cspSource};">`);
    return html;
}
function deactivate() {
    activeController?.shutdown().catch(() => { });
    activePanel?.dispose();
    activeController = undefined;
    activePanel = undefined;
}
//# sourceMappingURL=extension.js.map