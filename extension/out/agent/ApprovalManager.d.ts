/**
 * ApprovalManager - Implements auto-approval rules and YOLO mode.
 * Matches the design doc: auto-approve read/list/search/safe commands, require approval for writes/deletes.
 */
export type ApprovalMode = 'normal' | 'yolo';
export interface ApprovalResult {
    requiresApproval: boolean;
    toolCallId: string;
    reason?: string;
}
export interface PendingApproval {
    toolCallId: string;
    toolName: string;
    params: any;
    resolve: (approved: boolean) => void;
    reject: (error: Error) => void;
}
export declare class ApprovalManager {
    private mode;
    private pendingApprovals;
    setMode(mode: ApprovalMode): void;
    getMode(): ApprovalMode;
    checkApproval(toolCall: {
        name: string;
        params?: any;
        id: string;
    }): ApprovalResult;
    waitForApproval(toolCallId: string): Promise<boolean>;
    resolveApproval(toolCallId: string, approved: boolean): void;
    getPendingCount(): number;
    hasPending(toolCallId: string): boolean;
}
//# sourceMappingURL=ApprovalManager.d.ts.map