"use strict";
/**
 * WebviewMessenger - Bidirectional communication with the React webview.
 * Handles all messages between the extension host and the webview UI.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.WebviewMessenger = void 0;
class WebviewMessenger {
    panel;
    messageHandlers = new Map();
    disposables = [];
    constructor(panel) {
        this.panel = panel;
        // Listen for messages from the webview
        const disposable = this.panel.webview.onDidReceiveMessage((message) => {
            const handler = this.messageHandlers.get(message.type);
            if (handler) {
                handler(message.payload || message);
            }
        });
        this.disposables.push(disposable);
    }
    /**
     * Send a message to the webview.
     */
    send(type, payload) {
        try {
            this.panel.webview.postMessage({ type, ...payload });
        }
        catch (e) {
            console.error(`Failed to send message type=${type}:`, e);
        }
    }
    /**
     * Register a handler for messages from the webview.
     */
    onMessage(type, handler) {
        this.messageHandlers.set(type, handler);
    }
    /**
     * Remove a message handler.
     */
    offMessage(type) {
        this.messageHandlers.delete(type);
    }
    /**
     * Clean up all disposables.
     */
    dispose() {
        this.disposables.forEach(d => d.dispose());
        this.disposables = [];
        this.messageHandlers.clear();
    }
}
exports.WebviewMessenger = WebviewMessenger;
//# sourceMappingURL=WebviewMessenger.js.map