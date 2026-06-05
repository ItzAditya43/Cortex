/**
 * WebviewMessenger - Bidirectional communication with the React webview.
 * Handles all messages between the extension host and the webview UI.
 */
import * as vscode from 'vscode';
type MessageHandler = (data: any) => void;
export declare class WebviewMessenger {
    private panel;
    private messageHandlers;
    private disposables;
    constructor(panel: vscode.WebviewPanel);
    /**
     * Send a message to the webview.
     */
    send(type: string, payload?: any): void;
    /**
     * Register a handler for messages from the webview.
     */
    onMessage(type: string, handler: MessageHandler): void;
    /**
     * Remove a message handler.
     */
    offMessage(type: string): void;
    /**
     * Clean up all disposables.
     */
    dispose(): void;
}
export {};
//# sourceMappingURL=WebviewMessenger.d.ts.map