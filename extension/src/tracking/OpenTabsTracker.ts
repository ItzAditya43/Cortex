/**
 * OpenTabsTracker - Listens to VS Code tab change events to track open editors.
 */

import * as vscode from 'vscode';

export interface TabInfo {
    uri: vscode.Uri;
    fileName: string;
    relativePath: string;
    lastAccessed: Date;
}

export class OpenTabsTracker {
    private tabOrder: TabInfo[] = [];
    private disposables: vscode.Disposable[] = [];

    constructor() {
        this.subscribeToTabChanges();
    }

    private subscribeToTabChanges(): void {
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

    private updateTabOrder(): void {
        const tabs = vscode.window.tabGroups.all
            .flatMap(group => group.tabs)
            .filter(tab => tab.input instanceof vscode.TabInputText);

        const newOrder: TabInfo[] = [];

        for (const tab of tabs) {
            if (tab.input instanceof vscode.TabInputText) {
                const uri = tab.input.uri;
                const existing = this.tabOrder.find(t => t.uri.fsPath === uri.fsPath);

                if (existing) {
                    newOrder.push(existing);
                } else {
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

    private bringToTop(uri: vscode.Uri | undefined): void {
        if (!uri) return;

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
    getTopFiles(n: number = 3): TabInfo[] {
        return this.tabOrder.slice(0, n);
    }

    /**
     * Get all open files.
     */
    getAllOpenFiles(): TabInfo[] {
        return [...this.tabOrder];
    }

    /**
     * Clean up disposables.
     */
    dispose(): void {
        this.disposables.forEach(d => d.dispose());
        this.disposables = [];
        this.tabOrder = [];
    }
}