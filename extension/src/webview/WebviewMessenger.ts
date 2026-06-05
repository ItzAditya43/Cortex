/**
 * WebviewMessenger - Bidirectional communication with the React webview.
 * Handles all messages between the extension host and the webview UI.
 */

import * as vscode from 'vscode';

type MessageHandler = (data: any) => void;

export class WebviewMessenger {
    private panel: vscode.WebviewPanel;
    private messageHandlers: Map<string, MessageHandler> = new Map();
    private disposables: vscode.Disposable[] = [];

    constructor(panel: vscode.WebviewPanel) {
        this.panel = panel;

        // Listen for messages from the webview
        const disposable = this.panel.webview.onDidReceiveMessage(
            (message: { type: string; payload?: any }) => {
                const handler = this.messageHandlers.get(message.type);
                if (handler) {
                    handler(message.payload || message);
                }
            }
        );

        this.disposables.push(disposable);
    }

    /**
     * Send a message to the webview.
     */
    send(type: string, payload?: any): void {
        try {
            this.panel.webview.postMessage({ type, ...payload });
        } catch (e) {
            console.error(`Failed to send message type=${type}:`, e);
        }
    }

    /**
     * Register a handler for messages from the webview.
     */
    onMessage(type: string, handler: MessageHandler): void {
        this.messageHandlers.set(type, handler);
    }

    /**
     * Remove a message handler.
     */
    offMessage(type: string): void {
        this.messageHandlers.delete(type);
    }

    /**
     * Clean up all disposables.
     */
    dispose(): void {
        this.disposables.forEach(d => d.dispose());
        this.disposables = [];
        this.messageHandlers.clear();
    }
}