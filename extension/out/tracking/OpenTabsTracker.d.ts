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
export declare class OpenTabsTracker {
    private tabOrder;
    private disposables;
    constructor();
    private subscribeToTabChanges;
    private updateTabOrder;
    private bringToTop;
    /**
     * Get the top N most recently accessed files.
     */
    getTopFiles(n?: number): TabInfo[];
    /**
     * Get all open files.
     */
    getAllOpenFiles(): TabInfo[];
    /**
     * Clean up disposables.
     */
    dispose(): void;
}
//# sourceMappingURL=OpenTabsTracker.d.ts.map