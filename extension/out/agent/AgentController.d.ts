/**
 * AgentController - The central orchestrator running inside the extension host.
 * Manages the lifecycle of a single agent session.
 */
import { BackendClient } from './BackendClient';
import { ApprovalManager } from './ApprovalManager';
import { WebviewMessenger } from '../webview/WebviewMessenger';
export type AgentState = 'idle' | 'thinking' | 'awaiting_approval' | 'executing' | 'error';
export declare class AgentController {
    readonly backendClient: BackendClient;
    sessionId: string;
    projectPath: string;
    private agentState;
    private approvalManager;
    private messenger;
    private provider;
    private model;
    private abortController;
    private pendingToolCalls;
    constructor(projectPath: string, backendClient: BackendClient, approvalManager: ApprovalManager, messenger: WebviewMessenger, provider?: string, model?: string);
    private setupMessaging;
    initialize(autoIndex?: boolean): Promise<void>;
    reconnect(): Promise<void>;
    handleUserMessage(text: string): Promise<void>;
    private processMessage;
    private buildContext;
    handleApprovalResponse(toolCallId: string, approved: boolean): void;
    abort(): void;
    shutdown(): Promise<void>;
}
//# sourceMappingURL=AgentController.d.ts.map