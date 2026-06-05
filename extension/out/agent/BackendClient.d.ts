/**
 * BackendClient - HTTP client to the FastAPI backend.
 * Handles session management, completion streaming, tool execution, and RAG.
 */
export interface SessionResponse {
    session_id: string;
    created_at: string;
    project_path: string;
    project_memory: {
        stack: Record<string, string>;
        conventions: string[];
        important_files: string[];
        last_tasks: string[];
    };
}
export interface AgentEvent {
    type: 'token' | 'tool_call' | 'tool_result' | 'approval_request' | 'error' | 'done';
    [key: string]: any;
}
export declare class BackendClient {
    private baseUrl;
    constructor(baseUrl?: string);
    createSession(projectPath: string, provider?: string, model?: string, autoIndex?: boolean): Promise<SessionResponse>;
    getSessionStatus(sessionId: string): Promise<any>;
    shutdownSession(sessionId: string): Promise<any>;
    streamCompletion(sessionId: string, context: any, options?: any): AsyncGenerator<AgentEvent>;
    executeTool(sessionId: string, toolCall: any): Promise<any>;
    executeToolBatch(sessionId: string, toolCalls: any[]): Promise<any>;
    getConversationSummary(sessionId: string): Promise<any>;
    getProjectMemory(sessionId: string): Promise<any>;
    updateProjectMemory(sessionId: string, memory: any): Promise<void>;
    indexProject(projectPath: string): Promise<any>;
    indexFile(projectPath: string, filePath: string): Promise<void>;
    retrieveChunks(projectPath: string, query: string, topK?: number): Promise<any>;
    healthCheck(): Promise<any>;
    getConfig(): Promise<any>;
}
//# sourceMappingURL=BackendClient.d.ts.map