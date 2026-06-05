import * as vscode from 'vscode';
import * as fs from 'fs';
import { AgentController } from './agent/AgentController';
import { ApprovalManager } from './agent/ApprovalManager';
import { BackendClient } from './agent/BackendClient';
import { WebviewMessenger } from './webview/WebviewMessenger';
import { settings } from './utils/settings';

let activeController: AgentController | undefined;
let activePanel: vscode.WebviewPanel | undefined;

export function activate(context: vscode.ExtensionContext) {
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
        const current = config.get<boolean>('yoloMode', false);
        config.update('yoloMode', !current, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(
            `Agent OS: YOLO mode ${!current ? 'enabled' : 'disabled'}`
        );
    });

    // Listen for file saves to trigger re-indexing
    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument(async (doc) => {
            if (activeController && doc.uri.scheme === 'file') {
                const workspaceFolder = vscode.workspace.getWorkspaceFolder(doc.uri);
                if (workspaceFolder) {
                    const relativePath = vscode.workspace.asRelativePath(doc.uri);
                    try {
                        await activeController.backendClient.indexFile(
                            workspaceFolder.uri.fsPath,
                            relativePath
                        );
                    } catch (e) {
                        // Silently fail for indexing
                    }
                }
            }
        })
    );

    context.subscriptions.push(startCommand, askCommand, toggleYoloCommand);
    console.log('Agent OS extension activated.');
}

async function startSession(context: vscode.ExtensionContext) {
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

    activePanel = vscode.window.createWebviewPanel(
        'agentOS',
        'Agent OS',
        vscode.ViewColumn.Beside,
        {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [
                vscode.Uri.joinPath(context.extensionUri, 'out', 'webview')
            ],
        }
    );

    // Set webview HTML
    activePanel.webview.html = getWebviewHtml(activePanel.webview, context);

    // Create the backend client
    const backendUrl = settings.backendUrl;
    const backendClient = new BackendClient(backendUrl);

    // Create approval manager
    const approvalManager = new ApprovalManager();
    approvalManager.setMode(settings.yoloMode ? 'yolo' : 'normal');

    // Create webview messenger
    const messenger = new WebviewMessenger(activePanel);

    // Create agent controller
    activeController = new AgentController(
        workspaceFolder.uri.fsPath,
        backendClient,
        approvalManager,
        messenger,
        settings.provider,
        settings.model
    );

    // Initialize the session — gracefully handle backend being offline
    try {
        await activeController.initialize(settings.autoIndex);
    } catch (e: any) {
        console.warn('Agent OS: Backend initialization failed:', e.message);
        messenger.send('error', {
            message: `Backend unavailable: ${e.message}. Click reconnect to try again.`,
        });
        messenger.send('agent_state', { state: 'error' });
    }

    // Handle panel disposal
    activePanel.onDidDispose(() => {
        activeController?.shutdown().catch(() => {});
        activePanel = undefined;
        activeController = undefined;
    });

    // Listen for config changes
    vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('agentOS')) {
            const config = vscode.workspace.getConfiguration('agentOS');
            approvalManager.setMode(
                config.get<boolean>('yoloMode', false) ? 'yolo' : 'normal'
            );
        }
    });
}

function getWebviewHtml(webview: vscode.Webview, context: vscode.ExtensionContext): string {
    const webviewPath = vscode.Uri.joinPath(context.extensionUri, 'out', 'webview');
    const indexHtmlPath = vscode.Uri.joinPath(webviewPath, 'index.html');

    // Read the Vite-generated index.html
    let html: string;
    try {
        html = fs.readFileSync(indexHtmlPath.fsPath, 'utf-8');
    } catch {
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
    html = html.replace(
        /((?:src|href)=")(?:\.\/|\/)?(assets\/[^"]+)(")/g,
        (_match, prefix: string, assetPath: string, suffix: string) => {
            const assetUri = webview.asWebviewUri(
                vscode.Uri.joinPath(webviewPath, assetPath)
            );
            return `${prefix}${assetUri}${suffix}`;
        }
    );

    // Replace CSP with webview-compatible CSP using ${webview.cspSource}
    html = html.replace(
        /<meta http-equiv="Content-Security-Policy"[^>]*>/,
        `<meta http-equiv="Content-Security-Policy"
              content="default-src 'none';
                       style-src ${webview.cspSource} 'unsafe-inline';
                       script-src ${webview.cspSource};
                       font-src ${webview.cspSource};">`
    );

    return html;
}

export function deactivate() {
    activeController?.shutdown().catch(() => {});
    activePanel?.dispose();
    activeController = undefined;
    activePanel = undefined;
}