"use strict";
/**
 * BackendClient - HTTP client to the FastAPI backend.
 * Handles session management, completion streaming, tool execution, and RAG.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.BackendClient = void 0;
class BackendClient {
    baseUrl;
    constructor(baseUrl = 'http://localhost:8080') {
        this.baseUrl = baseUrl.replace(/\/+$/, '');
    }
    async createSession(projectPath, provider = 'ollama', model = '', autoIndex = true) {
        const resp = await fetch(`${this.baseUrl}/api/session`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                project_path: projectPath,
                provider,
                model,
                auto_index: autoIndex,
            }),
        });
        if (!resp.ok) {
            const error = await resp.text();
            throw new Error(`Failed to create session: ${error}`);
        }
        return (await resp.json());
    }
    async getSessionStatus(sessionId) {
        const resp = await fetch(`${this.baseUrl}/api/session/${sessionId}`);
        if (!resp.ok)
            throw new Error('Session not found');
        return resp.json();
    }
    async shutdownSession(sessionId) {
        const resp = await fetch(`${this.baseUrl}/api/session/${sessionId}`, {
            method: 'DELETE',
        });
        return resp.json();
    }
    async *streamCompletion(sessionId, context, options = {}) {
        const resp = await fetch(`${this.baseUrl}/api/completion/stream`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                session_id: sessionId,
                context,
                options,
            }),
        });
        if (!resp.ok) {
            yield { type: 'error', message: `HTTP ${resp.status}: ${resp.statusText}` };
            return;
        }
        const reader = resp.body?.getReader();
        if (!reader) {
            yield { type: 'error', message: 'No response body' };
            return;
        }
        const decoder = new TextDecoder();
        let buffer = '';
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done)
                    break;
                buffer += decoder.decode(value, { stream: true });
                // Parse SSE events
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';
                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        try {
                            const data = JSON.parse(line.slice(6));
                            yield data;
                        }
                        catch (e) {
                            // Skip malformed events
                        }
                    }
                }
            }
        }
        finally {
            reader.releaseLock();
        }
    }
    async executeTool(sessionId, toolCall) {
        const resp = await fetch(`${this.baseUrl}/api/tool/execute`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                session_id: sessionId,
                tool_call: toolCall,
            }),
        });
        if (!resp.ok) {
            const error = await resp.text();
            return { tool_call_id: toolCall.id, result: { error } };
        }
        return resp.json();
    }
    async executeToolBatch(sessionId, toolCalls) {
        const resp = await fetch(`${this.baseUrl}/api/tool/execute-batch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                session_id: sessionId,
                tool_calls: toolCalls,
            }),
        });
        if (!resp.ok) {
            return { results: toolCalls.map(tc => ({
                    tool_call_id: tc.id,
                    result: { error: 'Batch execution failed' },
                })) };
        }
        return resp.json();
    }
    async getConversationSummary(sessionId) {
        const resp = await fetch(`${this.baseUrl}/api/session/${sessionId}/summary`);
        if (!resp.ok)
            return null;
        return resp.json();
    }
    async getProjectMemory(sessionId) {
        const resp = await fetch(`${this.baseUrl}/api/session/${sessionId}/project-memory`);
        if (!resp.ok)
            return null;
        return resp.json();
    }
    async updateProjectMemory(sessionId, memory) {
        await fetch(`${this.baseUrl}/api/session/${sessionId}/project-memory`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(memory),
        });
    }
    async indexProject(projectPath) {
        const resp = await fetch(`${this.baseUrl}/api/memory/index`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ project_path: projectPath }),
        });
        return resp.json();
    }
    async indexFile(projectPath, filePath) {
        await fetch(`${this.baseUrl}/api/memory/index-file`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ project_path: projectPath, file_path: filePath }),
        });
    }
    async retrieveChunks(projectPath, query, topK = 3) {
        const resp = await fetch(`${this.baseUrl}/api/memory/retrieve`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ project_path: projectPath, query, top_k: topK }),
        });
        if (!resp.ok)
            return { results: [] };
        return resp.json();
    }
    async healthCheck() {
        const resp = await fetch(`${this.baseUrl}/api/health`);
        return resp.json();
    }
    async getConfig() {
        const resp = await fetch(`${this.baseUrl}/api/config`);
        return resp.json();
    }
}
exports.BackendClient = BackendClient;
//# sourceMappingURL=BackendClient.js.map