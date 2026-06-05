/** Shared types for the webview React app. */

export type AgentState = 'idle' | 'thinking' | 'awaiting_approval' | 'executing' | 'error';

export interface Message {
    id: string;
    role: 'user' | 'assistant' | 'system' | 'tool';
    content: string;
    timestamp: Date;
    toolCalls?: ToolCall[];
    toolCallId?: string;
    toolName?: string;
}

export interface ToolCall {
    id: string;
    tool: string;
    params: any;
    thought?: string;
    result?: any;
    requiresApproval?: boolean;
}

export interface PendingApproval {
    toolCallId: string;
    toolName: string;
    params: any;
    reason?: string;
}

export interface Settings {
    yoloMode: boolean;
}