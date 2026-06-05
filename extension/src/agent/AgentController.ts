/**
 * AgentController - The central orchestrator running inside the extension host.
 * Manages the lifecycle of a single agent session.
 */

import * as vscode from 'vscode';
import { BackendClient, AgentEvent, SessionResponse } from './BackendClient';
import { ApprovalManager, ApprovalResult } from './ApprovalManager';
import { WebviewMessenger } from '../webview/WebviewMessenger';

export type AgentState = 'idle' | 'thinking' | 'awaiting_approval' | 'executing' | 'error';

export class AgentController {
    public readonly backendClient: BackendClient;
    public sessionId: string = '';
    public projectPath: string;

    private agentState: AgentState = 'idle';
    private approvalManager: ApprovalManager;
    private messenger: WebviewMessenger;
    private provider: string;
    private model: string;
    private abortController: AbortController | null = null;
    private pendingToolCalls: Map<string, any> = new Map();

    constructor(
        projectPath: string,
        backendClient: BackendClient,
        approvalManager: ApprovalManager,
        messenger: WebviewMessenger,
        provider: string = 'ollama',
        model: string = ''
    ) {
        this.projectPath = projectPath;
        this.backendClient = backendClient;
        this.approvalManager = approvalManager;
        this.messenger = messenger;
        this.provider = provider;
        this.model = model;

        this.setupMessaging();
    }

    private setupMessaging(): void {
        this.messenger.onMessage('user_message', (data: { text: string }) => {
            this.handleUserMessage(data.text);
        });

        this.messenger.onMessage('approval_response', (data: { toolCallId: string; approved: boolean }) => {
            this.handleApprovalResponse(data.toolCallId, data.approved);
        });

        this.messenger.onMessage('abort', () => {
            this.abort();
        });

        this.messenger.onMessage('retry_connect', () => {
            this.reconnect();
        });

        this.messenger.onMessage('settings_update', (data: { key: string; value: any }) => {
            if (data.key === 'yoloMode') {
                this.approvalManager.setMode(data.value ? 'yolo' : 'normal');
            }
        });
    }

    async initialize(autoIndex: boolean = true): Promise<void> {
        try {
            this.messenger.send('agent_state', { state: 'thinking' });

            const session = await this.backendClient.createSession(
                this.projectPath,
                this.provider,
                this.model,
                autoIndex
            );

            this.sessionId = session.session_id;

            this.messenger.send('init', {
                sessionId: session.session_id,
                config: {
                    projectPath: this.projectPath,
                    provider: this.provider,
                    model: this.model,
                },
            });

            this.messenger.send('project_memory', { memory: session.project_memory });
            this.messenger.send('agent_state', { state: 'idle' });
        } catch (error: any) {
            this.agentState = 'error';
            this.messenger.send('error', { message: error.message });
            throw error;
        }
    }

    async reconnect(): Promise<void> {
        if (this.agentState === 'thinking') { return; }
        try {
            await this.initialize(true);
        } catch (e: any) {
            // initialize() already sent error + set state
        }
    }

    async handleUserMessage(text: string): Promise<void> {
        if (this.agentState === 'thinking') {
            this.messenger.send('error', { message: 'Agent is already processing a message. Please wait.' });
            return;
        }

        if (!this.sessionId) {
            this.messenger.send('error', { message: 'No active session. Click reconnect to try again.' });
            return;
        }

        this.agentState = 'thinking';
        this.messenger.send('agent_state', { state: 'thinking' });
        this.abortController = new AbortController();

        try {
            await this.processMessage(text);
        } catch (error: any) {
            if (error.name !== 'AbortError') {
                this.messenger.send('error', { message: error.message });
                this.agentState = 'error';
                this.messenger.send('agent_state', { state: 'error' });
            }
        } finally {
            this.abortController = null;
        }
    }

    private async processMessage(userMessage: string): Promise<void> {
        // Build context for the model
        const context = await this.buildContext(userMessage);

        // Stream the completion
        const eventStream = this.backendClient.streamCompletion(
            this.sessionId,
            context
        );

        let toolCallsToExecute: any[] = [];
        let accumulatedText = '';

        try {
            for await (const event of eventStream) {
                if (this.abortController?.signal.aborted) break;

                switch (event.type) {
                    case 'token':
                        accumulatedText += event.content;
                        this.messenger.send('token', { content: event.content });
                        break;

                    case 'tool_call':
                        toolCallsToExecute.push(event);
                        this.pendingToolCalls.set(event.id, event);
                        this.messenger.send('tool_call', event);
                        break;

                    case 'tool_result':
                        this.messenger.send('tool_result', {
                            toolCallId: event.tool_call_id,
                            result: event.result,
                        });
                        break;

                    case 'approval_request':
                        this.agentState = 'awaiting_approval';
                        this.messenger.send('agent_state', { state: 'awaiting_approval' });

                        // Check local approval rules
                        const toolCall = this.pendingToolCalls.get(event.tool_call_id);
                        const approvalResult: ApprovalResult = toolCall
                            ? this.approvalManager.checkApproval({
                                name: event.tool_name,
                                params: event.params,
                                id: event.tool_call_id,
                              })
                            : { requiresApproval: true, toolCallId: event.tool_call_id, reason: 'Unknown tool call' };

                        if (approvalResult.requiresApproval) {
                            this.messenger.send('approval_request', {
                                toolCallId: event.tool_call_id,
                                toolName: event.tool_name,
                                params: event.params,
                                reason: approvalResult.reason,
                            });

                            const approved = await this.approvalManager.waitForApproval(event.tool_call_id);
                            this.messenger.send('approval_resolved', {
                                toolCallId: event.tool_call_id,
                                approved,
                            });

                            if (!approved) {
                                // Send rejection result to backend via tool execute endpoint
                                await this.backendClient.executeTool(this.sessionId, {
                                    id: event.tool_call_id,
                                    name: event.tool_name,
                                    params: event.params,
                                });
                            }
                        }

                        this.agentState = 'executing';
                        this.messenger.send('agent_state', { state: 'executing' });
                        break;

                    case 'error':
                        this.messenger.send('error', { message: event.message });
                        break;

                    case 'done':
                        this.messenger.send('done', {
                            reason: event.reason || 'completed',
                            turnCount: event.turn_count,
                        });
                        break;
                }
            }
        } catch (error: any) {
            if (!this.abortController?.signal.aborted) {
                throw error;
            }
        }

        this.agentState = 'idle';
        this.messenger.send('agent_state', { state: 'idle' });
    }

    private async buildContext(userMessage: string): Promise<any> {
        const sections: any[] = [];

        // System prompt
        sections.push({
            name: 'systemPrompt',
            content: 'You are Agent OS, an autonomous coding assistant. You can read and write files, run commands, and search the codebase. When you need to use a tool, output it in <tool_call> tags.',
            priority: 1,
            token_count: 50,
        });

        // User message
        sections.push({
            name: 'userMessage',
            content: userMessage,
            priority: 1,
            token_count: Math.ceil(userMessage.length / 4),
        });

        // Current file if available
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            const doc = editor.document;
            const relativePath = vscode.workspace.asRelativePath(doc.uri);
            sections.push({
                name: 'currentFile',
                content: `File: ${relativePath}\n\`\`\`\n${doc.getText()}\n\`\`\``,
                priority: 3,
                token_count: Math.ceil(doc.getText().length / 4),
            });
        }

        // Get project memory
        try {
            const pm = await this.backendClient.getProjectMemory(this.sessionId);
            if (pm && pm.stack) {
                sections.push({
                    name: 'projectMemory',
                    content: `Project Stack: ${JSON.stringify(pm.stack, null, 2)}`,
                    priority: 2,
                    token_count: 50,
                });
            }
        } catch (e) {
            // Silently fail
        }

        // Get conversation summary
        try {
            const summary = await this.backendClient.getConversationSummary(this.sessionId);
            if (summary) {
                sections.push({
                    name: 'conversationSummary',
                    content: summary.summary || '',
                    priority: 2,
                    token_count: Math.ceil((summary.summary || '').length / 4),
                });
            }
        } catch (e) {
            // Silently fail
        }

        // Try RAG retrieval
        try {
            const rag = await this.backendClient.retrieveChunks(this.projectPath, userMessage, 3);
            if (rag?.results?.length > 0) {
                const ragText = rag.results.map((r: any) =>
                    `[${r.file_path}] (score: ${r.score.toFixed(2)})\n${r.content}`
                ).join('\n---\n');
                sections.push({
                    name: 'retrievedFiles',
                    content: ragText,
                    priority: 5,
                    token_count: Math.ceil(ragText.length / 4),
                });
            }
        } catch (e) {
            // Silently fail
        }

        return { sections, text: '', total_tokens: 0, dropped_sections: [] };
    }

    handleApprovalResponse(toolCallId: string, approved: boolean): void {
        this.approvalManager.resolveApproval(toolCallId, approved);
    }

    abort(): void {
        this.abortController?.abort();
        this.agentState = 'idle';
        this.messenger.send('agent_state', { state: 'idle' });
    }

    async shutdown(): Promise<void> {
        try {
            await this.backendClient.shutdownSession(this.sessionId);
        } catch (e) {
            // Ignore errors during shutdown
        }
    }
}