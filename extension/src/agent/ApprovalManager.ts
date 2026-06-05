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

const SAFE_COMMAND_PREFIXES = [
    'npm test',
    'npm run test',
    'npm run build',
    'npm run lint',
    'pip test',
    'python -m pytest',
    'pytest',
    'go test',
    'cargo test',
    'npx tsc --noEmit',
    'make test',
    'make build',
    'make lint',
    'git status',
    'git diff',
    'ls ',
    'cat ',
    'head ',
    'tail ',
    'grep ',
    'find ',
    'which ',
];

const ALWAYS_APPROVE = new Set([
    'read_file',
    'list_directory',
    'search_files',
    'git_status',
    'git_diff',
]);

const ALWAYS_REQUIRE = new Set([
    'delete_file',
    'git_commit',
]);

export class ApprovalManager {
    private mode: ApprovalMode = 'normal';
    private pendingApprovals: Map<string, PendingApproval> = new Map();

    setMode(mode: ApprovalMode): void {
        this.mode = mode;
    }

    getMode(): ApprovalMode {
        return this.mode;
    }

    checkApproval(toolCall: { name: string; params?: any; id: string }): ApprovalResult {
        if (this.mode === 'yolo') {
            return { requiresApproval: false, toolCallId: toolCall.id, reason: 'yolo' };
        }

        const name = toolCall.name;
        const params = toolCall.params || {};

        if (ALWAYS_APPROVE.has(name)) {
            return { requiresApproval: false, toolCallId: toolCall.id };
        }

        if (ALWAYS_REQUIRE.has(name)) {
            return { requiresApproval: true, toolCallId: toolCall.id, reason: `${name} is destructive` };
        }

        if (name === 'run_command') {
            const command = (params.command || '').trim();
            const isSafe = SAFE_COMMAND_PREFIXES.some(prefix => command.startsWith(prefix));
            return {
                requiresApproval: !isSafe,
                toolCallId: toolCall.id,
                reason: isSafe ? undefined : 'Command not recognized as safe',
            };
        }

        if (name === 'write_file' || name === 'create_file') {
            return {
                requiresApproval: true,
                toolCallId: toolCall.id,
                reason: 'File modification requires your approval',
            };
        }

        // Default: require approval for unknown tools
        return { requiresApproval: true, toolCallId: toolCall.id, reason: 'Unknown tool' };
    }

    async waitForApproval(toolCallId: string): Promise<boolean> {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pendingApprovals.delete(toolCallId);
                resolve(false); // Timeout = reject
            }, 300000); // 5 minute timeout

            this.pendingApprovals.set(toolCallId, {
                toolCallId,
                toolName: '',
                params: {},
                resolve: (approved: boolean) => {
                    clearTimeout(timeout);
                    this.pendingApprovals.delete(toolCallId);
                    resolve(approved);
                },
                reject: (error: Error) => {
                    clearTimeout(timeout);
                    this.pendingApprovals.delete(toolCallId);
                    reject(error);
                },
            });
        });
    }

    resolveApproval(toolCallId: string, approved: boolean): void {
        const pending = this.pendingApprovals.get(toolCallId);
        if (pending) {
            pending.resolve(approved);
        }
    }

    getPendingCount(): number {
        return this.pendingApprovals.size;
    }

    hasPending(toolCallId: string): boolean {
        return this.pendingApprovals.has(toolCallId);
    }
}