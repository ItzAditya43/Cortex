"use strict";
/**
 * OpenTabsTracker - Listens to VS Code tab change events to track open editors.
 */
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
exports.OpenTabsTracker = void 0;
const vscode = __importStar(require("vscode"));
class OpenTabsTracker {
    tabOrder = [];
    disposables = [];
    constructor() {
        this.subscribeToTabChanges();
    }
    subscribeToTabChanges() {
        // Listen for tab changes
        const disposable = vscode.window.tabGroups.onDidChangeTabs((e) => {
            this.updateTabOrder();
        });
        this.disposables.push(disposable);
        // Initial update
        this.updateTabOrder();
        // Also listen for editor focus changes
        const editorDisposable = vscode.window.onDidChangeActiveTextEditor(() => {
            this.bringToTop(vscode.window.activeTextEditor?.document.uri);
        });
        this.disposables.push(editorDisposable);
    }
    updateTabOrder() {
        const tabs = vscode.window.tabGroups.all
            .flatMap(group => group.tabs)
            .filter(tab => tab.input instanceof vscode.TabInputText);
        const newOrder = [];
        for (const tab of tabs) {
            if (tab.input instanceof vscode.TabInputText) {
                const uri = tab.input.uri;
                const existing = this.tabOrder.find(t => t.uri.fsPath === uri.fsPath);
                if (existing) {
                    newOrder.push(existing);
                }
                else {
                    newOrder.push({
                        uri,
                        fileName: uri.path.split('/').pop() || uri.path,
                        relativePath: vscode.workspace.asRelativePath(uri),
                        lastAccessed: new Date(),
                    });
                }
            }
        }
        this.tabOrder = newOrder;
    }
    bringToTop(uri) {
        if (!uri)
            return;
        const index = this.tabOrder.findIndex(t => t.uri.fsPath === uri.fsPath);
        if (index >= 0) {
            const [item] = this.tabOrder.splice(index, 1);
            item.lastAccessed = new Date();
            this.tabOrder.unshift(item);
        }
    }
    /**
     * Get the top N most recently accessed files.
     */
    getTopFiles(n = 3) {
        return this.tabOrder.slice(0, n);
    }
    /**
     * Get all open files.
     */
    getAllOpenFiles() {
        return [...this.tabOrder];
    }
    /**
     * Clean up disposables.
     */
    dispose() {
        this.disposables.forEach(d => d.dispose());
        this.disposables = [];
        this.tabOrder = [];
    }
}
exports.OpenTabsTracker = OpenTabsTracker;
//# sourceMappingURL=OpenTabsTracker.js.map