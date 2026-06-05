"use strict";
/**
 * AgentController - The central orchestrator running inside the extension host.
 * Manages the lifecycle of a single agent session.
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
exports.AgentController = void 0;
const vscode = __importStar(require("vscode"));
class AgentController {
    backendClient;
    sessionId = '';
    projectPath;
    agentState = 'idle';
    approvalManager;
    messenger;
    provider;
    model;
    abortController = null;
    pendingToolCalls = new Map();
    constructor(projectPath, backendClient, approvalManager, messenger, provider = 'ollama', model = '') {
        this.projectPath = projectPath;
        this.backendClient = backendClient;
        this.approvalManager = approvalManager;
        this.messenger = messenger;
        this.provider = provider;
        this.model = model;
        this.setupMessaging();
    }
    setupMessaging() {
        this.messenger.onMessage('user_message', (data) => {
            this.handleUserMessage(data.text);
        });
        this.messenger.onMessage('approval_response', (data) => {
            this.handleApprovalResponse(data.toolCallId, data.approved);
        });
        this.messenger.onMessage('abort', () => {
            this.abort();
        });
        this.messenger.onMessage('retry_connect', () => {
            this.reconnect();
        });
        this.messenger.onMessage('settings_update', (data) => {
            if (data.key === 'yoloMode') {
                this.approvalManager.setMode(data.value ? 'yolo' : 'normal');
            }
        });
    }
    async initialize(autoIndex = true) {
        try {
            this.messenger.send('agent_state', { state: 'thinking' });
            const session = await this.backendClient.createSession(this.projectPath, this.provider, this.model, autoIndex);
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
        }
        catch (error) {
            this.agentState = 'error';
            this.messenger.send('error', { message: error.message });
            throw error;
        }
    }
    async reconnect() {
        if (this.agentState === 'thinking') {
            return;
        }
        try {
            await this.initialize(true);
        }
        catch (e) {
            // initialize() already sent error + set state
        }
    }
    async handleUserMessage(text) {
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
        }
        catch (error) {
            if (error.name !== 'AbortError') {
                this.messenger.send('error', { message: error.message });
                this.agentState = 'error';
                this.messenger.send('agent_state', { state: 'error' });
            }
        }
        finally {
            this.abortController = null;
        }
    }
    async processMessage(userMessage) {
        // Build context for the model
        const context = await this.buildContext(userMessage);
        // Stream the completion
        const eventStream = this.backendClient.streamCompletion(this.sessionId, context);
        let toolCallsToExecute = [];
        let accumulatedText = '';
        try {
            for await (const event of eventStream) {
                if (this.abortController?.signal.aborted)
                    break;
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
                        const approvalResult = toolCall
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
        }
        catch (error) {
            if (!this.abortController?.signal.aborted) {
                throw error;
            }
        }
        this.agentState = 'idle';
        this.messenger.send('agent_state', { state: 'idle' });
    }
    async buildContext(userMessage) {
        const sections = [];
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
        }
        catch (e) {
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
        }
        catch (e) {
            // Silently fail
        }
        // Try RAG retrieval
        try {
            const rag = await this.backendClient.retrieveChunks(this.projectPath, userMessage, 3);
            if (rag?.results?.length > 0) {
                const ragText = rag.results.map((r) => `[${r.file_path}] (score: ${r.score.toFixed(2)})\n${r.content}`).join('\n---\n');
                sections.push({
                    name: 'retrievedFiles',
                    content: ragText,
                    priority: 5,
                    token_count: Math.ceil(ragText.length / 4),
                });
            }
        }
        catch (e) {
            // Silently fail
        }
        return { sections, text: '', total_tokens: 0, dropped_sections: [] };
    }
    handleApprovalResponse(toolCallId, approved) {
        this.approvalManager.resolveApproval(toolCallId, approved);
    }
    abort() {
        this.abortController?.abort();
        this.agentState = 'idle';
        this.messenger.send('agent_state', { state: 'idle' });
    }
    async shutdown() {
        try {
            await this.backendClient.shutdownSession(this.sessionId);
        }
        catch (e) {
            // Ignore errors during shutdown
        }
    }
}
exports.AgentController = AgentController;
//# sourceMappingURL=AgentController.js.map