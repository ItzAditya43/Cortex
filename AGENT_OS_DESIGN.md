# Agent OS — Complete System Design

> A Cline-style autonomous coding agent for VS Code

---

## Table of Contents
1. [Detailed Component Breakdown](#1-detailed-component-breakdown)
2. [FastAPI Route Design](#2-fastapi-route-design)
3. [SQLite Schema](#3-sqlite-schema)
4. [VS Code Extension Architecture](#4-vs-code-extension-architecture)
5. [Context Assembly Algorithm](#5-context-assembly-algorithm)
6. [Tool Execution Flow](#6-tool-execution-flow)
7. [MVP File/Folder Structure](#7-mvp-filefolder-structure)
8. [First 3 Things to Build](#8-first-3-things-to-build)

---

## 1. Detailed Component Breakdown

### 1.1 Extension Layer (TypeScript, runs in VS Code extension host)

#### `AgentController`
The central orchestrator running inside the extension host. Owns the lifecycle of a single agent session.

```
class AgentController {
  // State
  private agentState: 'idle' | 'thinking' | 'awaiting_approval' | 'executing' | 'error';
  private sessionId: string;
  private backendUrl: string;
  private abortController: AbortController;

  // Dependencies
  private contextAssembler: ContextAssembler;
  private approvalManager: ApprovalManager;
  private webviewMessenger: WebviewMessenger;
  private backendClient: BackendClient;

  // Methods
  async initialize(): Promise<void>
    // Creates session via POST /api/session
    // Restores project memory from .agent/memory.json
    // Triggers RAG indexing via POST /api/memory/index

  async handleUserMessage(text: string): Promise<void>
    // 1. Sets agentState = 'thinking'
    // 2. Sends {type: 'agent_thinking'} to webview
    // 3. Calls processMessage(text) internally
    // 4. Streams response tokens to webview
    // 5. Handles tool calls as they arrive

  private async processMessage(text: string): Promise<void>
    // Core agent loop (see section 6)

  async handleApprovalResponse(toolCallId: string, approved: boolean): Promise<void>
    // Called when user clicks approve/reject in webview
    // Resumes the tool execution promise

  async abort(): Promise<void>
    // Cancels current model call via AbortController
    // Resets agentState to 'idle'

  async shutdown(): Promise<void>
    // POST /api/session/{id}/shutdown
    // Saves conversation summary
}
```

#### `ContextAssembler`
Builds the hybrid context window from available sources. Runs inside the extension host to minimize backend round-trips for file content.

```
class ContextAssembler {
  // Dependencies
  private tokenCounter: TokenCounter;
  private fileReader: FileReader;
  private openTabsTracker: OpenTabsTracker;
  private backendClient: BackendClient;

  // Configuration
  private readonly BUDGETS = {
    systemPrompt: 500,
    projectMemory: 500,
    currentFile: 4000,
    openTabs: 1500,
    retrievedFiles: 3000,
    conversationSummary: 300,
    recentMessages: 2000,
    toolResults: 3000,
  };
  private readonly TOTAL_BUDGET = 8192;

  // Methods
  async assemble(userMessage: string): Promise<AssembledContext>
    // See section 5 for full algorithm

  private async getSystemPrompt(): Promise<string>
    // Returns base system prompt with tool definitions

  private async getProjectMemory(): Promise<string>
    // Reads .agent/memory.json, formats as text

  private async getCurrentFileContent(): Promise<string | null>
    // Gets active editor file content via VS Code API

  private async getOpenTabsContent(limit: number): Promise<FileContent[]>
    // Reads top N open tab files via VS Code API

  private async getRetrievedFiles(query: string): Promise<FileContent[]>
    // Calls POST /api/memory/retrieve with query
    // Returns top K file chunks

  private getRecentMessages(messages: Message[]): Message[]
    // Returns last 5-8 turns from session memory

  private async getConversationSummary(): Promise<string>
    // Reads from SQLite via GET /api/session/{id}/summary
}
```

#### `TokenCounter`
Estimates token counts using a fast heuristic (chars/4 for English-heavy code).

```
class TokenCounter {
  // Methods
  count(text: string): number
    // Returns Math.ceil(text.length / 4) as fast heuristic
    // Tuned empirically for code content

  countTokens(obj: Record<string, any>): number
    // Serializes to JSON string first, then counts

  truncateToBudget(text: string, budget: number): string
    // Truncates at token boundary (newline-aware)
    // Prefers breaking at sentence/line boundaries over mid-word
}
```

#### `ApprovalManager`
Implements the auto-approval rules and YOLO mode.

```
class ApprovalManager {
  private mode: 'normal' | 'yolo';
  private pendingApprovals: Map<string, PendingApproval>;

  // Methods
  setMode(mode: 'normal' | 'yolo'): void

  async checkApproval(toolCall: ToolCall): Promise<ApprovalResult>
    // Returns {requiresApproval: boolean, toolCallId: string}
    // normal mode: checks tool type and safety flag
    // yolo mode: always auto-approve

  async waitForApproval(toolCallId: string): Promise<boolean>
    // Blocks until user responds via webview
    // Returns true if approved, false if rejected

  async resolveApproval(toolCallId: string, approved: boolean): Promise<void>
    // Resolves the pending promise

  private isSafeCommand(command: string): boolean
    // Checks against safe command patterns:
    // - npm/pip/pnpm/bun test
    // - npm/pip/pnpm/bun run build
    // - npm/pip/pnpm/bun run lint
    // - python -m pytest
    // - go test
    // - cargo test
    // - npx tsc --noEmit
    // - make test, make build, make lint
    // - git status, git diff
    // - ls, cat, head, tail, grep, find
    // All other commands → not safe → requires approval
}
```

#### `WebviewMessenger`
Bidirectional communication with the React webview.

```
class WebviewMessenger {
  private panel: vscode.WebviewPanel;
  private messageHandlers: Map<string, Function>;

  // Methods
  send(type: string, payload?: any): void
    // Sends JSON message to webview
    // Examples:
    //   {type: 'agent_thinking', sessionId}
    //   {type: 'tool_call', toolCall}
    //   {type: 'token', text: '...'}
    //   {type: 'approval_request', toolCallId, toolName, params, diff}
    //   {type: 'error', message}

  onMessage(type: string, handler: Function): void
    // Registers handler for messages FROM webview
    // Examples:
    //   {type: 'user_message', text: '...'}
    //   {type: 'approval_response', toolCallId, approved}
    //   {type: 'abort'}
    //   {type: 'settings_update', ...}

  private handleIncoming(event: WebviewEvent): void
    // Routes message to registered handler
}
```

#### `BackendClient`
HTTP client to the FastAPI backend.

```
class BackendClient {
  private baseUrl: string;  // e.g. http://localhost:8080

  // Methods
  async createSession(): Promise<Session>
    // POST /api/session → {sessionId, createdAt}

  async *streamCompletion(context: AssembledContext): AsyncGenerator<TokenEvent | ToolCallEvent>
    // POST /api/completion/stream with SSE
    // Yields parsed events as they arrive

  async executeTool(sessionId: string, toolCall: ToolCall): Promise<ToolResult>
    // POST /api/tool/execute

  async getConversationSummary(sessionId: string): Promise<Summary>
    // GET /api/session/{id}/summary

  async indexProject(path: string): Promise<void>
    // POST /api/memory/index

  async retrieveChunks(query: string, topK: number): Promise<Chunk[]>
    // POST /api/memory/retrieve

  async updateProjectMemory(sessionId: string, memory: ProjectMemory): Promise<void>
    // PUT /api/session/{id}/project-memory

  async updateConversationSummary(sessionId: string, messages: Message[]): Promise<void>
    // POST /api/session/{id}/summarize
}
```

#### `OpenTabsTracker`
Listens to VS Code tab change events to track open editors.

```
class OpenTabsTracker {
  private openTabs: vscode.Tab[];

  constructor()
    // Subscribes to vscode.window.tabGroups.onDidChangeTabs

  getTopFiles(n: number): vscode.Uri[]
    // Returns the first n visible tab URIs
    // Sorted by recency of access
}
```

#### Extension Entry Point (`activate` / `deactivate`)

```
// activationEvents: ['onCommand:agentOS.start', 'onLanguage:markdown', '*']
export function activate(context: vscode.ExtensionContext) {
  1. Register command 'agentOS.start'
     → Creates WebviewPanel
     → Creates AgentController
     → Calls controller.initialize()
     → Returns panel

  2. Register command 'agentOS.ask'
     → Opens webview if not open
     → Pre-fills user message input

  3. Register command 'agentOS.toggleYolo'
     → Toggles ApprovalManager mode

  4. Listen to vscode.workspace.onDidSaveTextDocument
     → Triggers re-index via POST /api/memory/index

  5. Register disposable for cleanup
}
```

---

### 1.2 Backend Layer (Python, FastAPI)

#### `AgentRuntime`
The core runtime that manages message processing and tool execution on the backend side.

```
class AgentRuntime:
    # State
    session_id: str
    messages: list[Message]
    turn_count: int
    project_path: str

    # Dependencies
    model_gateway: ModelGateway
    tool_executor: ToolExecutor
    memory_service: MemoryService
    conversation_summarizer: ConversationSummarizer

    async def process_message(self, user_message: str) -> AsyncGenerator[AgentEvent, None]:
        """
        Core agent loop:
        1. Append user message to self.messages
        2. Build context via context assembly (done on extension side, sent via req)
        3. Call model_gateway.stream() with assembled context
        4. Parse streamed response for tool calls
        5. Yield ToolCallEvent objects
        6. Receive execution results (via execute_tool call)
        7. Append results to messages
        8. Call model again with results
        9. Continue until model signals <DONE>
        10. Update conversation summary every 6 turns
        """

    async def execute_tool(self, tool_call: ToolCall) -> ToolResult:
        return await self.tool_executor.execute(tool_call)

    async def summarize_conversation(self) -> str:
        return await self.conversation_summarizer.summarize(self.messages)
```

#### `ModelGateway`
Unified interface to all model providers via LiteLLM.

```
class ModelGateway:
    provider: ModelProvider
    config: ModelConfig

    def __init__(self, provider_name: str, config: dict):
        # provider_name: 'ollama' | 'openrouter' | 'gemini'
        match provider_name:
            case 'ollama':
                self.provider = OllamaProvider(config)
            case 'openrouter':
                self.provider = OpenRouterProvider(config)
            case 'gemini':
                self.provider = GeminiProvider(config)

    async def generate(self, prompt: str, options: GenerationOptions) -> GenerationResult:
        # Uses LiteLLM's completion() under the hood

    async def stream(self, prompt: str, options: GenerationOptions) -> AsyncIterator[str]:
        # Uses LiteLLM's acompletion(stream=True)
        # Parses SSE tokens
        # Detects tool calls from response XML/JSON

    def count_tokens(self, text: str) -> int:
        # Uses tiktoken if available
        # Falls back to len(text) // 4 heuristic
```

#### `OllamaProvider`

```
class OllamaProvider(ModelProvider):
    base_url: str = "http://localhost:11434"
    default_model: str = "codellama:7b"  # or qwen2.5-coder:7b

    async def generate(self, prompt, options):
        # POST {base_url}/api/generate
        # Body: {model, prompt, options, stream: false}

    async def stream(self, prompt, options):
        # POST {base_url}/api/generate
        # Body: {model, prompt, options, stream: true}
        # Parse NDJSON response
        # Yield 'response' field from each line

    def count_tokens(self, text):
        return len(text) // 4
```

#### `OpenRouterProvider`

```
class OpenRouterProvider(ModelProvider):
    api_key: str  # from env OPENROUTER_API_KEY
    base_url: str = "https://openrouter.ai/api/v1"
    default_model: str = "google/gemma-2-9b-it:free"  # free tier

    async def generate(self, prompt, options):
        # POST {base_url}/chat/completions
        # Headers: Authorization: Bearer {api_key}

    async def stream(self, prompt, options):
        # POST {base_url}/chat/completions with stream: true
        # Parse SSE, extract choices[0].delta.content

    def count_tokens(self, text):
        # Use tiktoken encoding for common models
```

#### `GeminiProvider`

```
class GeminiProvider(ModelProvider):
    api_key: str  # from env GEMINI_API_KEY
    base_url: str = "https://generativelanguage.googleapis.com/v1beta"
    default_model: str = "gemini-2.0-flash-exp"

    async def generate(self, prompt, options):
        # POST {base_url}/models/{model}:generateContent
        # Query: ?key={api_key}

    async def stream(self, prompt, options):
        # POST {base_url}/models/{model}:streamGenerateContent
        # Parse SSE, extract candidates[0].content.parts[0].text

    def count_tokens(self, text):
        # POST {base_url}/models/{model}:countTokens
```

#### `ToolExecutor`
Executes tools requested by the model. Runs on the backend for terminal/network tools, but delegates file tools to the extension host.

```
class ToolExecutor:
    session_id: str
    project_path: str
    extension_client: ExtensionClient  # HTTP client back to extension for file ops
    terminal_manager: TerminalManager

    async def execute(self, tool_call: ToolCall) -> ToolResult:
        match tool_call.name:
            case 'read_file':
                return await self._read_file(tool_call.params)
            case 'write_file':
                return await self._write_file(tool_call.params)
            case 'create_file':
                return await self._create_file(tool_call.params)
            case 'delete_file':
                return await self._delete_file(tool_call.params)
            case 'search_files':
                return await self._search_files(tool_call.params)
            case 'list_directory':
                return await self._list_directory(tool_call.params)
            case 'run_command':
                return await self._run_command(tool_call.params)
            case 'kill_process':
                return await self._kill_process(tool_call.params)
            case 'git_status':
                return await self._git_status()
            case 'git_diff':
                return await self._git_diff(tool_call.params)
            case 'git_commit':
                return await self._git_commit(tool_call.params)
            case _:
                raise UnknownToolError(tool_call.name)

    async def _read_file(self, params):
        # Delegate to extension via WS/HTTP
        # Returns {content, line_count, path}

    async def _write_file(self, params):
        # Delegate to extension
        # Returns {diff, path, success}

    async def _create_file(self, params):
        # Delegate to extension
        # Returns {path, success}

    async def _delete_file(self, params):
        # Delegate to extension
        # Returns {path, success}

    async def _search_files(self, params):
        # Can run locally via grep/rg
        # Returns list of {path, line, content, context}

    async def _list_directory(self, params):
        # Uses os.listdir + os.path.isdir
        # Returns tree structure

    async def _run_command(self, params):
        return await self.terminal_manager.run(
            command=params['command'],
            cwd=params.get('cwd', self.project_path),
            timeout=params.get('timeout', 30)
        )

    async def _kill_process(self, params):
        return await self.terminal_manager.kill(params['pid'])

    async def _git_status(self):
        # Runs 'git status --porcelain'
        # Returns parsed list of changed files

    async def _git_diff(self, params):
        # Runs 'git diff {file}'
        # Returns unified diff string

    async def _git_commit(self, params):
        # Runs 'git add -A && git commit -m "{message}"'
        # Returns {hash, message, files}
```

#### `TerminalManager`
Manages shell processes for command execution.

```
class TerminalManager:
    processes: dict[int, asyncio.subprocess.Process]
    next_pid: int

    async def run(self, command: str, cwd: str, timeout: int = 30) -> ToolResult:
        # Create subprocess with asyncio.create_subprocess_shell
        # Capture stdout + stderr
        # Enforce timeout
        # Return {stdout, stderr, exit_code, pid}
        # Store pid in self.processes for later kill

    async def kill(self, pid: int) -> dict:
        # Terminate process
        # Clean up from self.processes
        # Return {success, pid}
```

#### `MemoryService`
Manages all four memory layers.

```
class MemoryService:
    sqlite: SQLiteManager
    chroma: ChromaDBManager
    project_path: str

    async def get_session_summary(self, session_id: str) -> Summary | None:
        # SELECT from conversation_summaries WHERE session_id = ?

    async def update_session_summary(self, session_id: str, summary: Summary):
        # UPSERT into conversation_summaries

    async def get_project_memory(self) -> ProjectMemory:
        # Read .agent/memory.json from project root
        # Return default if file doesn't exist

    async def update_project_memory(self, memory: ProjectMemory):
        # Write .agent/memory.json

    async def index_project_files(self):
        # Walk project directory
        # For each file: chunk text, embed, store in ChromaDB
        # Skip: node_modules, .git, __pycache__, .venv, dist, build, .next

    async def index_file(self, file_path: str):
        # Re-index a single file (on save)
        # Delete existing chunks for this file
        # Re-chunk and embed

    async def retrieve_relevant_chunks(self, query: str, top_k: int = 3) -> list[Chunk]:
        # Embed query using sentence-transformers (all-MiniLM-L6-v2)
        # Query ChromaDB for top_k similar chunks
        # Return [{file_path, content, score, start_line, end_line}]
```

#### `SQLiteManager`
Connection management and query helpers.

```
class SQLiteManager:
    engine: create_async_engine
    session_maker: async_sessionmaker

    async def initialize(self, db_path: str):
        # Create engine
        # Run migrations (create tables)

    async def execute(self, query, params=None):
        # Execute raw SQL
        # Used for simple queries

    async def query(self, query, params=None) -> list[Row]:
        # Execute and return results

    async def close(self):
        # Dispose engine
```

#### `ChromaDBManager`
Wrapper around ChromaDB for vector storage.

```
class ChromaDBManager:
    client: chromadb.Client
    collection: chromadb.Collection
    embedder: SentenceTransformer

    async def initialize(self, persist_dir: str):
        # self.client = chromadb.PersistentClient(path=persist_dir)
        # self.collection = client.get_or_create_collection("project_files")
        # self.embedder = SentenceTransformer('all-MiniLM-L6-v2')
        # Sent to BackgroundTasks to avoid blocking startup

    async def add_chunks(self, chunks: list[Chunk]):
        # embed texts
        # collection.add(ids=..., embeddings=..., metadatas=..., documents=...)

    async def query(self, query_text: str, top_k: int) -> list[Chunk]:
        # embed query
        # collection.query(query_embeddings=..., n_results=top_k)
        # Return results with scores

    async def delete_file_chunks(self, file_path: str):
        # collection.delete(where={"file_path": file_path})

    async def delete_all(self):
        # collection.delete(where={})
```

#### `ConversationSummarizer`

```
class ConversationSummarizer:
    model_gateway: ModelGateway

    async def summarize(self, messages: list[Message]) -> str:
        # Build summarization prompt:
        #   "Summarize the following conversation concisely. "
        #   "Focus on: the task being worked on, decisions made, "
        #   "files modified, commands run, and current status.\n\n"
        #   "{conversation_text}"

        # Call model (use cheap model like Ollama local)
        # Return summary string (< 300 tokens)

    async def summarize_messages(self, messages: list[Message]) -> str:
        # Used for the rolling conversation summary (layer 2)
        # Takes last N messages + previous summary
        # Returns updated summary
```

---

### 1.3 Webview Layer (TypeScript/React)

#### `AgentChatPanel`
Root React component.

```
function AgentChatPanel() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [agentState, setAgentState] = useState<AgentState>('idle');
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null);
  const [settings, setSettings] = useState<Settings>(defaultSettings);

  // On mount:
  //   - Register VSCode API message listener
  //   - Send 'ready' event

  // Message types from extension:
  //   - agent_thinking → show thinking indicator
  //   - token → append to current assistant message
  //   - tool_call → show tool call in chat
  //   - tool_result → show result
  //   - approval_request → show approval dialog
  //   - error → show error badge
  //   - done → finalize message

  // Message types to extension:
  //   - user_message → new user input
  //   - approval_response → approve/reject
  //   - abort → cancel current generation
  //   - settings_update → change mode etc.

  return (
    <div className="agent-panel">
      <ChatHeader
        agentState={agentState}
        settings={settings}
        onSettingsChange={setSettings}
        onAbort={handleAbort}
      />
      <MessageList messages={messages} />
      {pendingApproval && (
        <ApprovalDialog
          toolCall={pendingApproval}
          onApprove={() => sendApproval(true)}
          onReject={() => sendApproval(false)}
        />
      )}
      <ChatInput onSubmit={handleSubmit} disabled={agentState === 'thinking'} />
    </div>
  );
}
```

#### Key React Components

| Component | Props | Purpose |
|-----------|-------|---------|
| `ChatHeader` | agentState, settings, onAbort | Status indicator, mode toggle, abort button |
| `MessageList` | messages[] | Scrollable message list with auto-scroll |
| `MessageBubble` | message | User or assistant message with syntax highlighting |
| `ToolCallCard` | toolCall, result | Collapsible card showing tool call + result |
| `DiffView` | oldContent, newContent | Side-by-side diff for file writes |
| `ApprovalDialog` | toolCall | Modal with approve/reject buttons + diff preview |
| `ChatInput` | onSubmit, disabled | Textarea + send button |
| `SettingsPanel` | settings, onChange | Provider selector, model selector, YOLO toggle |

---

## 2. FastAPI Route Design

### Base URL: `http://localhost:8080`

### 2.1 Session Management

#### `POST /api/session`
Create a new agent session.

```
Request:
{
  "project_path": "/home/user/project",   // required
  "provider": "ollama",                    // optional, default "ollama"
  "model": "codellama:7b",                 // optional, provider default
  "auto_index": true                       // optional, default true
}

Response (201):
{
  "session_id": "uuid-string",
  "created_at": "2026-06-04T19:00:00Z",
  "project_path": "/home/user/project",
  "project_memory": {
    "stack": {},
    "conventions": [],
    "important_files": [],
    "last_tasks": []
  }
}
```

#### `GET /api/session/{session_id}`
Get session status.

```
Response (200):
{
  "session_id": "uuid-string",
  "status": "active" | "idle",
  "turn_count": 7,
  "created_at": "...",
  "last_active": "..."
}
```

#### `DELETE /api/session/{session_id}`
Shutdown and save session.

```
Response (200):
{
  "session_id": "uuid-string",
  "summary_saved": true,
  "project_memory_saved": true,
  "turns": 7,
  "duration_seconds": 1245
}
```

#### `GET /api/session/{session_id}/summary`
Get conversation summary.

```
Response (200):
{
  "session_id": "uuid-string",
  "summary": "Working on adding user authentication...",
  "last_updated": "2026-06-04T19:30:00Z",
  "turn_count": 6
}
```

#### `POST /api/session/{session_id}/summarize`
Trigger conversation summarization.

```
Request:
{
  "messages": [
    {"role": "user", "content": "..."},
    {"role": "assistant", "content": "..."},
    ...
  ]
}

Response (200):
{
  "summary": "Working on adding user authentication. Created auth.py with login/logout routes. Ran pytest - all passing."
}
```

#### `PUT /api/session/{session_id}/project-memory`
Update project memory.

```
Request:
{
  "stack": {"frontend": "Next.js", "backend": "FastAPI"},
  "conventions": ["functional components", "snake_case for Python"],
  "important_files": ["src/index.ts", "backend/main.py"],
  "last_tasks": ["Add login route"]
}

Response (200):
{
  "saved": true
}
```

#### `GET /api/session/{session_id}/project-memory`
Get current project memory.

```
Response (200):
{
  "stack": {"frontend": "Next.js"},
  "conventions": ["functional components"],
  "important_files": ["src/index.ts"],
  "last_tasks": []
}
```

---

### 2.2 Completion

#### `POST /api/completion/stream`
Stream a model completion. This is the main agent loop entry point.

```
Request:
{
  "session_id": "uuid-string",
  "context": {
    "system_prompt": "...",
    "project_memory": "...",
    "current_file": {"path": "src/index.ts", "content": "..."},
    "open_tabs": [
      {"path": "src/app.ts", "content": "..."},
      {"path": "src/utils.ts", "content": "..."}
    ],
    "retrieved_files": [
      {"path": "src/auth.ts", "content": "...", "relevance_score": 0.92}
    ],
    "conversation_summary": "...",
    "recent_messages": [
      {"role": "user", "content": "..."},
      {"role": "assistant", "content": "..."}
    ],
    "tool_results": [
      {"tool_call_id": "...", "result": "..."}
    ]
  },
  "options": {
    "temperature": 0.2,
    "max_tokens": 4096,
    "stop": ["<DONE>"]
  }
}

Response: SSE stream

event: token
data: {"type": "token", "content": "Let me"}

event: token
data: {"type": "token", "content": " read the"}

event: tool_call
data: {
  "type": "tool_call",
  "id": "call_abc123",
  "tool": "read_file",
  "params": {"path": "src/index.ts"},
  "thought": "I need to check the current state of this file before proceeding."
}

event: done
data: {"type": "done", "reason": "stopped"}

event: error
data: {"type": "error", "message": "Model provider unavailable"}
```

---

### 2.3 Tool Execution

#### `POST /api/tool/execute`
Execute a tool (used when approval is granted).

```
Request:
{
  "session_id": "uuid-string",
  "tool_call": {
    "id": "call_abc123",
    "name": "run_command",
    "params": {
      "command": "npm run test",
      "cwd": "/home/user/project"
    }
  }
}

Response (200):
{
  "tool_call_id": "call_abc123",
  "result": {
    "stdout": "PASS tests/auth.test.ts\nPASS tests/api.test.ts",
    "stderr": "",
    "exit_code": 0,
    "pid": 12345
  }
}
```

#### `POST /api/tool/execute-batch`
Execute multiple independent tools in parallel.

```
Request:
{
  "session_id": "uuid-string",
  "tool_calls": [
    {"id": "call_1", "name": "read_file", "params": {"path": "src/a.ts"}},
    {"id": "call_2", "name": "read_file", "params": {"path": "src/b.ts"}}
  ]
}

Response (200):
{
  "results": [
    {"tool_call_id": "call_1", "result": {"content": "...", "line_count": 42}},
    {"tool_call_id": "call_2", "result": {"content": "...", "line_count": 100}}
  ]
}
```

---

### 2.4 Memory / RAG

#### `POST /api/memory/index`
Index (or re-index) the entire project.

```
Request:
{
  "project_path": "/home/user/project"
}

Response (202):  // Accepted — runs as background task
{
  "task_id": "task-uuid",
  "status": "indexing",
  "estimated_files": 150
}

// Later: GET /api/memory/index/{task_id}
Response (200):
{
  "task_id": "task-uuid",
  "status": "completed" | "running" | "failed",
  "files_indexed": 145,
  "total_chunks": 2340,
  "duration_seconds": 12.4
}
```

#### `POST /api/memory/index-file`
Index a single file (called on save).

```
Request:
{
  "project_path": "/home/user/project",
  "file_path": "src/auth.ts"
}

Response (200):
{
  "file_path": "src/auth.ts",
  "chunks": 8,
  "status": "indexed"
}
```

#### `POST /api/memory/retrieve`
Retrieve relevant file chunks for a query.

```
Request:
{
  "project_path": "/home/user/project",
  "query": "authentication login route implementation",
  "top_k": 3,
  "session_id": "uuid-string"  // optional, for personalization
}

Response (200):
{
  "query": "authentication login route implementation",
  "results": [
    {
      "file_path": "src/auth/login.ts",
      "content": "async function login(req, res) {\n  const { email, password } = req.body;\n  ...",
      "score": 0.89,
      "start_line": 12,
      "end_line": 45
    },
    {
      "file_path": "src/auth/middleware.ts",
      "content": "function authenticate(req, res, next) {\n  const token = req.headers.authorization;\n  ...",
      "score": 0.76,
      "start_line": 1,
      "end_line": 30
    },
    {
      "file_path": "src/db/users.ts",
      "content": "export async function findUserByEmail(email: string) {\n  ...",
      "score": 0.64,
      "start_line": 20,
      "end_line": 38
    }
  ]
}
```

---

### 2.5 Health & Configuration

#### `GET /api/health`
Health check + provider status.

```
Response (200):
{
  "status": "healthy",
  "providers": {
    "ollama": {"available": true, "model": "codellama:7b", "latency_ms": 45},
    "openrouter": {"available": true, "models_available": 12},
    "gemini": {"available": false, "error": "API key not configured"}
  },
  "memory": {
    "sqlite": "connected",
    "chromadb": "connected",
    "files_indexed": 2340
  },
  "version": "0.1.0"
}
```

#### `GET /api/config`
Get current backend configuration.

```
Response (200):
{
  "provider": "ollama",
  "model": "codellama:7b",
  "max_tokens": 4096,
  "temperature": 0.2,
  "auto_index": true,
  "chromadb_path": "/home/user/.agent/chromadb",
  "sqlite_path": "/home/user/.agent/agent.db"
}
```

---

## 3. SQLite Schema

### Database Location
- Linux/Mac: `~/.agent/agent.db`
- Windows: `%USERPROFILE%\.agent\agent.db`

### Tables

#### `sessions`
| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | TEXT | PK | UUID |
| project_path | TEXT | NOT NULL | Absolute path to workspace |
| provider | TEXT | NOT NULL DEFAULT 'ollama' | Model provider name |
| model | TEXT | NOT NULL | Model name |
| status | TEXT | NOT NULL DEFAULT 'active' | active, idle, closed |
| created_at | TIMESTAMP | NOT NULL DEFAULT CURRENT_TIMESTAMP | |
| last_active | TIMESTAMP | NOT NULL DEFAULT CURRENT_TIMESTAMP | |
| turn_count | INTEGER | NOT NULL DEFAULT 0 | |
| metadata | TEXT | | JSON blob for extra session data |

Indexes:
- `idx_sessions_project_path` ON sessions(project_path)
- `idx_sessions_status` ON sessions(status)
- `idx_sessions_last_active` ON sessions(last_active)

#### `messages`
| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | INTEGER | PK AUTOINCREMENT | |
| session_id | TEXT | NOT NULL FK → sessions(id) | |
| role | TEXT | NOT NULL | 'user', 'assistant', 'system', 'tool' |
| content | TEXT | NOT NULL | Message content |
| tool_call_id | TEXT | | ID if this is a tool result message |
| tool_name | TEXT | | Name of tool if applicable |
| token_count | INTEGER | | Approximate token count |
| created_at | TIMESTAMP | NOT NULL DEFAULT CURRENT_TIMESTAMP | |

Indexes:
- `idx_messages_session` ON messages(session_id)
- `idx_messages_created` ON messages(session_id, created_at)

#### `conversation_summaries`
| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| session_id | TEXT | PK FK → sessions(id) | One summary per session |
| summary | TEXT | NOT NULL | Rolling conversation summary |
| last_updated | TIMESTAMP | NOT NULL | |
| turn_count | INTEGER | NOT NULL | Turn count when last updated |
| model_used | TEXT | | Model that generated summary |

#### `project_memories`
| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| project_path | TEXT | PK | Absolute path to workspace |
| stack | TEXT | NOT NULL DEFAULT '{}' | JSON object |
| conventions | TEXT | NOT NULL DEFAULT '[]' | JSON array of strings |
| important_files | TEXT | NOT NULL DEFAULT '[]' | JSON array of paths |
| last_tasks | TEXT | NOT NULL DEFAULT '[]' | JSON array of task strings |
| updated_at | TIMESTAMP | NOT NULL DEFAULT CURRENT_TIMESTAMP | |

#### `tool_executions`
| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | INTEGER | PK AUTOINCREMENT | |
| session_id | TEXT | NOT NULL FK → sessions(id) | |
| tool_call_id | TEXT | NOT NULL | From model |
| tool_name | TEXT | NOT NULL | |
| params | TEXT | NOT NULL | JSON |
| result | TEXT | | JSON result |
| duration_ms | INTEGER | | Execution time |
| approved | INTEGER | | 0/1 whether required and got approval |
| created_at | TIMESTAMP | NOT NULL DEFAULT CURRENT_TIMESTAMP | |

Indexes:
- `idx_tool_executions_session` ON tool_executions(session_id)

#### `vector_index_metadata`
| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| project_path | TEXT | PK | |
| last_indexed | TIMESTAMP | | |
| total_files | INTEGER | | |
| total_chunks | INTEGER | | |
| index_version | INTEGER | DEFAULT 1 | For migration support |

### Migration Strategy
- Alembic for schema migrations
- Initial schema in migration `001_initial.py`
- Each migration auto-applied on backend startup via `alembic upgrade head`

---

## 4. VS Code Extension Architecture

### 4.1 Activation Events

```json
// package.json
{
  "activationEvents": [
    "onStartupFinished",
    "onCommand:agentOS.start",
    "onCommand:agentOS.ask",
    "onCommand:agentOS.toggleYolo"
  ],
  "contributes": {
    "commands": [
      {
        "command": "agentOS.start",
        "title": "Agent OS: Start Agent Session"
      },
      {
        "command": "agentOS.ask",
        "title": "Agent OS: Ask Agent"
      },
      {
        "command": "agentOS.toggleYolo",
        "title": "Agent OS: Toggle YOLO Mode"
      }
    ],
    "configuration": {
      "title": "Agent OS",
      "properties": {
        "agentOS.backendUrl": {
          "type": "string",
          "default": "http://localhost:8080",
          "description": "FastAPI backend URL"
        },
        "agentOS.provider": {
          "type": "string",
          "default": "ollama",
          "enum": ["ollama", "openrouter", "gemini"]
        },
        "agentOS.model": {
          "type": "string",
          "default": "",
          "description": "Model name override"
        },
        "agentOS.yoloMode": {
          "type": "boolean",
          "default": false
        },
        "agentOS.autoIndex": {
          "type": "boolean",
          "default": true
        }
      }
    }
  }
}
```

### 4.2 Webview Panel

```typescript
function createWebviewPanel(context: vscode.ExtensionContext): vscode.WebviewPanel {
  const panel = vscode.window.createWebviewPanel(
    'agentOS',                    // viewType
    'Agent OS',                   // title
    vscode.ViewColumn.Beside,     // show in right column
    {
      enableScripts: true,
      retainContextWhenHidden: true,     // preserve state
      localResourceRoots: [
        vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview')
      ]
    }
  );

  // Set HTML content from compiled React build
  const webviewPath = vscode.Uri.joinPath(
    context.extensionUri, 'dist', 'webview'
  );
  const html = renderWebviewHtml(webviewPath);
  panel.webview.html = html;

  return panel;
}

function renderWebviewHtml(webviewPath: vscode.Uri): string {
  // Build CSP-compliant HTML
  // Load index.html from dist/webview
  // Replace resource URIs with vscode.Uri scheme

  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'none';
                   style-src ${webviewPath} 'unsafe-inline';
                   script-src ${webviewPath} 'unsafe-inline';
                   font-src ${webviewPath};">
    <link rel="stylesheet" href="${webviewPath}/index.css">
  </head>
  <body>
    <div id="root"></div>
    <script src="${webviewPath}/index.js"></script>
  </body>
</html>`;
}
```

### 4.3 Message Protocol

Extension → Webview:
```
| Type | Payload | Description |
|------|---------|-------------|
| init | {sessionId, config} | Initialization on connect |
| agent_state | {state: 'thinking'\|'idle'\|'error'} | Status update |
| token | {content: string} | Streamed token chunk |
| tool_call | {id, name, params, thought} | Model requesting tool |
| tool_result | {toolCallId, result} | Tool execution output |
| approval_request | {toolCallId, toolName, params, diff?} | Ask user for approval |
| approval_resolved | {toolCallId, approved} | Result of approval |
| error | {message: string} | Error notification |
| done | {reason: string} | Agent finished turn |
| project_memory | {memory: ProjectMemory} | Current project memory |
| configuration | {config: AgentConfig} | Current configuration |
```

Webview → Extension:
```
| Type | Payload | Description |
|------|---------|-------------|
| ready | {} | Webview DOM loaded |
| user_message | {text: string} | User typed a message |
| approval_response | {toolCallId, approved} | User approved/rejected |
| abort | {} | User clicked stop |
| settings_update | {key, value} | User changed a setting |
| resend_last | {} | User wants to retry last message |
```

### 4.4 File Tool Delegation Architecture

**Important design decision:** File tools execute in the extension host (not the backend) because:
1. Backend may be on a different machine
2. Backend needs VS Code API for editor context
3. Backend needs workspace file access
4. Approval UI must happen in extension host

Architecture:
```
Webview (React)
  ↓ message (user_message)
Extension Host (AgentController)
  ↓ POST /api/completion/stream (context)
Backend (AgentRuntime)
  ↓ SSE stream (tool_call)  
Extension Host (AgentController)
  ↓ Execute tool locally (read_file, write_file, etc.)
  ↓ POST /api/tool/execute (for backend tools like run_command)
Backend (AgentRuntime)
  ↓ Stream continues with tool result
```

For file tools, the flow is:
1. Model requests `read_file`
2. Backend sends `tool_call` event via SSE
3. Extension host intercepts, executes `read_file` via VS Code API
4. Extension host calls `POST /api/tool/execute` on backend with the result
5. Backend appends result to context, continues model call

For terminal tools, the flow is simpler:
1. Model requests `run_command`
2. Backend receives `POST /api/tool/execute`
3. Backend executes via `TerminalManager`
4. Backend returns result, continues

---

## 5. Context Assembly Algorithm

### 5.1 Pseudocode

```
function assembleContext(userMessage, state):
    // State contains: messages[], fileContents{}, openTabs[], ragChunks[]
    
    // 1. Define priorities and budgets
    budgets = {
        systemPrompt:     500,
        projectMemory:    500,
        currentFile:     4000,
        openTabs:        1500,
        retrievedFiles:  3000,
        conversationSummary: 300,
        recentMessages:  2000,
        toolResults:     3000,
        userMessage:      500,
    }
    MAX_TOKENS = 8192  // configurable per model
    
    // 2. Build ordered sections (highest priority first for truncation)
    sections = [
        {name: 'systemPrompt',      content: getSystemPrompt(),           priority: 1},
        {name: 'userMessage',       content: userMessage,                 priority: 1},
        {name: 'projectMemory',     content: formatProjectMemory(...),    priority: 2},
        {name: 'conversationSummary', content: getConversationSummary(),  priority: 2},
        {name: 'currentFile',       content: getCurrentFile(),            priority: 3},
        {name: 'toolResults',       content: formatToolResults(state.toolResults), priority: 3},
        {name: 'recentMessages',    content: formatRecentMessages(state.messages),  priority: 4},
        {name: 'retrievedFiles',    content: formatRetrievedFiles(state.ragChunks), priority: 5},
        {name: 'openTabs',          content: formatOpenTabs(state.openTabs),        priority: 6},
    ]
    
    // 3. Calculate initial token counts
    for each section in sections:
        section.tokenCount = countTokens(section.content)
    
    totalTokens = sum(sections.tokenCount)
    
    // 4. If over budget, trim from lowest priority first
    if totalTokens > MAX_TOKENS:
        // Sort by priority descending (highest number = lowest priority)
        sortedSections = sort(sections, by: priority, order: descending)
        
        for each section in sortedSections:
            if totalTokens <= MAX_TOKENS:
                break
                
            excess = totalTokens - MAX_TOKENS
            
            // Try to truncate section to its budget
            targetTokens = min(budgets[section.name], section.tokenCount)
            trimmedTokens = section.tokenCount - targetTokens
            
            if trimmedTokens > 0:
                section.content = truncateToBudget(section.content, targetTokens)
                section.tokenCount = countTokens(section.content)
                totalTokens -= trimmedTokens
        
        // If still over budget, drop sections entirely (lowest priority first)
        for each section in sort(sections, by: priority, order: descending):
            if totalTokens <= MAX_TOKENS:
                break
            
            if section.name != 'systemPrompt' and section.name != 'userMessage':
                totalTokens -= section.tokenCount
                section.content = ''  // Mark as dropped
                section.dropped = true
    
    // 5. Assemble the final context string
    contextParts = []
    for each section in sections:
        if section.dropped:
            contextParts.append(`// [Section: ${section.name} - DROPPED due to token budget]\n`)
        else:
            label = getSectionLabel(section.name)
            contextParts.append(`${label}\n${section.content}\n`)
    
    return {
        text: contextParts.join('\n'),
        sections: sections,
        totalTokens: sum(sections.where(dropped == false).tokenCount),
        droppedSections: sections.where(dropped == true).map(name)
    }
```

### 5.2 Section Labels Template

```
System Prompt:
[system prompt content]

Project Memory:
[project memory content]

User's Current Message:
[user message content]

Conversation Summary:
[summary content]

Current File (src/index.ts):
[index.ts content]

Recent Tool Results:
[tool results]

Recent Messages:
[formatted conversation history]

Retrieved Files (RAG):
[file 1]
-------
[file 2]
-------
[file 3]

Open Tabs:
[tab 1 content]
-------
[tab 2 content]
```

### 5.3 Formatting Rules

- **Recent Messages**: Format as role-prefixed text. Only include last 8 turns.
  ```
  user: Can you add error handling to the login route?
  assistant: Let me check the current auth code.
  assistant (tool: read_file): backend/auth.py
  ...
  ```
- **Tool Results**: Format with tool name, params, and output. Truncate long outputs.
  ```
  [Tool: run_command]
  command: npm test
  stdout:
  PASS tests/auth.test.ts (3.2s)
  PASS tests/api.test.ts (1.8s)
  
  stderr: (empty)
  exit code: 0
  ```
- **Retrieved Files**: Include file path, relevance score, and content with line numbers.
  ```
  [RAG: backend/auth.py (score: 0.89, lines 12-45)]
  12 | async def login(req, res):
  13 |     const { email, password } = req.body;
  ...
  ```

---

## 6. Tool Execution Flow

### 6.1 Sequence Diagram (Text)

```
User                  Webview              Extension Host           Backend (FastAPI)         Model
 |                      |                      |                        |                     |
 |-- "Add login route"  |                      |                        |                     |
 |--------------------->|                      |                        |                     |
 |                      |-- user_message ------>|                        |                     |
 |                      |                      |                        |                     |
 |                      |                      |-- POST /completion/stream ->|                     |
 |                      |                      |  {context, options}    |                     |
 |                      |                      |                        |-- stream(prompt) ---->|
 |                      |                      |                        |<--- token stream -----|
 |                      |                      |                        |<--- token stream -----|
 |                      |<----- token ---------|<-- SSE: token ----------|                     |
 |                      |   "Let me read"      |                        |                     |
 |                      |<----- token ---------|<-- SSE: token ----------|                     |
 |                      |   " the auth file"   |                        |                     |
 |                      |                      |                        |<--- tool_call -------|
 |                      |                      |                        |   (read_file)       |
 |                      |                      |<-- SSE: tool_call -----|                     |
 |                      |                      |                        |                     |
 |                      |                      |-- Check approval:      |                     |
 |                      |                      |   read_file → auto     |                     |
 |                      |                      |                        |                     |
 |                      |                      |-- Execute read_file ---|                     |
 |                      |                      |   (VS Code API)        |                     |
 |                      |                      |                        |                     |
 |                      |                      |-- POST /tool/execute -->|                     |
 |                      |                      |   (result)             |                     |
 |                      |                      |                        |-- Append result ----|
 |                      |                      |                        |   to context        |
 |                      |                      |                        |                     |
 |                      |                      |                        |-- stream(continue) ->|
 |                      |                      |                        |<--- token stream ---|
 |                      |<----- token ---------|<-- SSE: token ---------|                     |
 |                      |   "I'll create it"   |                        |                     |
 |                      |                      |                        |<--- tool_call -------|
 |                      |                      |                        |   (write_file)      |
 |                      |                      |<-- SSE: tool_call -----|                     |
 |                      |                      |                        |                     |
 |                      |                      |-- Check approval:      |                     |
 |                      |                      |   write_file → needs   |                     |
 |                      |                      |   approval             |                     |
 |                      |                      |                        |                     |
 |                      |<-- approval_request -|                        |                     |
 |                      |   (show diff)        |                        |                     |
 |                      |                      |                        |                     |
 |                      |   [User sees diff]   |                        |                     |
 |                      |                      |                        |                     |
 | User clicks Approve  |                      |                        |                     |
 |<---------------------|                      |                        |                     |
 |  (in UI)             |                      |                        |                     |
 |                      |-- approval_response -|                        |                     |
 |                      |   (approved)         |                        |                     |
 |                      |                      |                        |                     |
 |                      |                      |-- Execute write_file --|                     |
 |                      |                      |   (VS Code API)        |                     |
 |                      |                      |                        |                     |
 |                      |                      |-- POST /tool/execute -->|                     |
 |                      |                      |   (result)             |                     |
 |                      |                      |                        |-- Append result ----|
 |                      |                      |                        |-- stream(continue) ->|
 |                      |                      |                        |<--- stream ---------|
 |                      |                      |                        |<--- done -----------|
 |                      |                      |                        |                     |
 |                      |<-- done -------------|<-- SSE: done ---------|                     |
 |                      |                      |                        |                     |
 |                      |-- Show complete      |                        |                     |
 | User sees result     |                      |                        |                     |
 |<---------------------|                      |                        |                     |
```

### 6.2 Detailed Execution Loop

```
PROCEDURE agentLoop(userMessage):
  state.messages.append({role: 'user', content: userMessage})
  
  WHILE True:
    // 1. Assemble context
    context = contextAssembler.assemble(userMessage, state)
    
    // 2. Stream model response
    stream = modelGateway.stream(context.text, {temperature: 0.2})
    
    accumulatedText = ""
    toolCalls = []
    
    FOR event IN stream:
      IF event.type == 'token':
        accumulatedText += event.content
        YIELD {type: 'token', content: event.content}
        
      ELSE IF event.type == 'tool_call':
        toolCalls.append(event.toolCall)
        
      ELSE IF event.type == 'done':
        BREAK
    
    // 3. Process tool calls
    IF toolCalls.isEmpty():
      // No tools → agent is done
      state.messages.append({role: 'assistant', content: accumulatedText})
      BREAK
    
    // 4. Execute each tool call
    FOR toolCall IN toolCalls:
      state.messages.append({
        role: 'assistant',
        content: accumulatedText,
        tool_calls: [toolCall]
      })
      
      // 4a. Check approval
      approval = approvalManager.checkApproval(toolCall)
      IF approval.requiresApproval:
        YIELD {type: 'approval_request', toolCallId: toolCall.id, ...}
        approved = approvalManager.waitForApproval(toolCall.id)
        IF NOT approved:
          result = {error: 'Rejected by user'}
          YIELD {type: 'tool_result', toolCallId: toolCall.id, result}
          state.messages.append({role: 'tool', tool_call_id: toolCall.id, content: 'REJECTED'})
          CONTINUE
      
      // 4b. Execute
      YIELD {type: 'tool_call', toolCall}
      result = toolExecutor.execute(toolCall)
      YIELD {type: 'tool_result', toolCallId: toolCall.id, result}
      
      // 4c. Append result to state
      state.messages.append({role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify(result)})
      state.toolResults.push({toolCallId: toolCall.id, result})
      
      // 4d. Auto-index if file was written
      IF toolCall.name IN ['write_file', 'create_file']:
        TRIGGER memoryService.indexFile(result.path)  // background
    
    // 5. Loop continues (goes back to context assembly with tool results)
    state.turnCount += 1
    
    // 6. Summarize every 6 turns
    IF state.turnCount % 6 == 0:
      summary = conversationSummarizer.summarize(state.messages)
      memoryService.updateSummary(state.sessionId, summary)
  
  // 7. Update project memory
  memoryService.updateProjectMemory(state.sessionId, extractProjectMemory(state))
  YIELD {type: 'done', reason: 'completed'}
```

---

## 7. MVP File/Folder Structure

```
agent-os/
├── package.json                    # Monorepo root (npm workspaces)
├── tsconfig.base.json              # Shared TS config
├── .gitignore
├── README.md
│
├── extension/                      # VS Code Extension (TypeScript)
│   ├── package.json                # VS Code extension manifest
│   ├── tsconfig.json
│   ├── jest.config.ts
│   ├── src/
│   │   ├── extension.ts            # activate/deactivate
│   │   ├── agent/
│   │   │   ├── AgentController.ts
│   │   │   ├── ContextAssembler.ts
│   │   │   ├── TokenCounter.ts
│   │   │   ├── ApprovalManager.ts
│   │   │   └── BackendClient.ts
│   │   ├── tools/
│   │   │   ├── FileToolExecutor.ts  # read_file, write_file, etc.
│   │   │   └── ToolRegistry.ts
│   │   ├── tracking/
│   │   │   ├── OpenTabsTracker.ts
│   │   │   └── ActiveFileTracker.ts
│   │   ├── webview/
│   │   │   └── WebviewMessenger.ts
│   │   └── utils/
│   │       ├── settings.ts
│   │       ├── logger.ts
│   │       └── paths.ts
│   └── __tests__/
│       ├── AgentController.test.ts
│       ├── ContextAssembler.test.ts
│       └── ApprovalManager.test.ts
│
├── webview/                        # React Chat UI
│   ├── package.json
│   ├── tsconfig.json
│   ├── vite.config.ts              # Vite for fast bundling
│   ├── index.html
│   ├── src/
│   │   ├── main.tsx
│   │   ├── App.tsx
│   │   ├── components/
│   │   │   ├── ChatHeader.tsx
│   │   │   ├── MessageList.tsx
│   │   │   ├── MessageBubble.tsx
│   │   │   ├── ToolCallCard.tsx
│   │   │   ├── DiffView.tsx
│   │   │   ├── ApprovalDialog.tsx
│   │   │   ├── ChatInput.tsx
│   │   │   ├── SettingsPanel.tsx
│   │   │   └── StatusIndicator.tsx
│   │   ├── hooks/
│   │   │   ├── useVSCodeAPI.ts
│   │   │   └── useMessages.ts
│   │   ├── types.ts
│   │   └── styles/
│   │       ├── global.css
│   │       ├── chat.css
│   │       └── diff.css
│   └── __tests__/
│       └── App.test.tsx
│
├── backend/                        # FastAPI Backend (Python)
│   ├── pyproject.toml              # Python project config (Poetry/PDM)
│   ├── alembic.ini
│   ├── alembic/
│   │   ├── env.py
│   │   └── versions/
│   │       └── 001_initial.py
│   ├── src/
│   │   ├── __init__.py
│   │   ├── main.py                 # FastAPI app creation
│   │   ├── config.py               # Settings via pydantic-settings
│   │   ├── router/
│   │   │   ├── __init__.py
│   │   │   ├── session.py          # Session endpoints
│   │   │   ├── completion.py       # /completion/stream
│   │   │   ├── tool.py             # /tool/execute
│   │   │   ├── memory.py           # /memory/index, /memory/retrieve
│   │   │   └── health.py           # /health, /config
│   │   ├── agent/
│   │   │   ├── __init__.py
│   │   │   ├── runtime.py          # AgentRuntime
│   │   │   └── models.py           # Pydantic models for agent types
│   │   ├── providers/
│   │   │   ├── __init__.py
│   │   │   ├── base.py             # ModelProvider abstract class
│   │   │   ├── ollama.py
│   │   │   ├── openrouter.py
│   │   │   ├── gemini.py
│   │   │   └── gateway.py          # ModelGateway
│   │   ├── tools/
│   │   │   ├── __init__.py
│   │   │   ├── executor.py         # ToolExecutor
│   │   │   ├── terminal.py         # TerminalManager
│   │   │   └── registry.py         # Tool definitions, schemas
│   │   ├── memory/
│   │   │   ├── __init__.py
│   │   │   ├── service.py          # MemoryService
│   │   │   ├── sqlite_manager.py   # SQLiteManager
│   │   │   ├── chroma_manager.py   # ChromaDBManager
│   │   │   ├── summarizer.py       # ConversationSummarizer
│   │   │   └── chunker.py          # Text chunking logic
│   │   └── db/
│   │       ├── __init__.py
│   │       ├── models.py           # SQLAlchemy ORM models
│   │       └── database.py         # Engine, session factory
│   └── tests/
│       ├── conftest.py
│       ├── test_runtime.py
│       ├── test_providers.py
│       ├── test_rag.py
│       └── test_tools.py
│
├── scripts/
│   ├── setup-dev.sh                # One-command dev environment setup
│   ├── bundle-extension.sh         # Build + package extension
│   └── run-backend.sh              # Start FastAPI dev server
│
└── .agent/                         # Project-level agent config (created at runtime)
    └── memory.json                 # Project memory file

// Shared type definitions (for extension ↔ webview communication)
// These live in extension/src/ or a shared package
```

### Key Dependencies

**extension/package.json:**
```json
{
  "dependencies": {
    "react": "^18.2",
    "react-dom": "^18.2"
  },
  "devDependencies": {
    "@types/vscode": "^1.85",
    "@vscode/test-electron": "^2.3",
    "typescript": "^5.3",
    "vite": "^5.0",
    "@vitejs/plugin-react": "^4.2",
    "vitest": "^1.2"
  }
}
```

**backend/pyproject.toml:**
```toml
[tool.poetry.dependencies]
python = "^3.11"
fastapi = "^0.109"
uvicorn = {extras = ["standard"], version = "^0.27"}
pydantic = "^2.5"
pydantic-settings = "^2.1"
sqlalchemy = "^2.0"
aiosqlite = "^0.20"
alembic = "^1.13"
chromadb = "^0.4"
sentence-transformers = "^2.2"
litellm = "^1.10"
httpx = "^0.26"
sse-starlette = "^1.8"

[tool.poetry.group.dev.dependencies]
pytest = "^8.0"
pytest-asyncio = "^0.23"
httpx = "^0.26"  # for TestClient
```

---

## 8. First 3 Things to Build

### Priority 1: Backend Core with Ollama Provider (3–4 days)

**What:**
- FastAPI app skeleton with health endpoint
- SQLite session management (create session, store/retrieve messages)
- Ollama model provider (`/api/generate` and `/api/chat` integration)
- Streaming endpoint `POST /api/completion/stream`
- Basic `AgentRuntime` that can receive a prompt, stream a response, and detect tool calls

**Why first:**
- Validates the hardest technical risk: can we reliably stream from Ollama and parse structured tool calls?
- Gives you a working "chat with code-aware model" without any extension complexity
- Everything else depends on having a working agent loop
- Ollama is free, local, and works offline — fastest path to "Hello World"

**Success criteria:**
- `curl -X POST localhost:8080/api/health` returns `{"status": "healthy"}`
- `curl -X POST localhost:8080/api/completion/stream -d '{"context": {...}, "options": {...}}'` streams tokens via SSE
- Model correctly outputs tool calls in the agreed format (XML or JSON)
- Session create/read works with SQLite persistence

**Files to build:**
```
backend/src/main.py        — FastAPI app, CORS middleware
backend/src/config.py      — Settings
backend/src/router/health.py
backend/src/router/completion.py
backend/src/router/session.py
backend/src/agent/runtime.py  — Basic: just stream, no tool loop yet
backend/src/agent/models.py   — Pydantic models
backend/src/providers/base.py
backend/src/providers/ollama.py
backend/src/providers/gateway.py
backend/src/db/models.py
backend/src/db/database.py
backend/alembic/versions/001_initial.py
backend/pyproject.toml
```

**Minimal test flow:**
```bash
# Terminal 1
cd backend && poetry run uvicorn src.main:app --reload --port 8080

# Terminal 2
curl -X POST http://localhost:8080/api/session \
  -H "Content-Type: application/json" \
  -d '{"project_path": "/tmp/test"}'

# Then
curl -X POST http://localhost:8080/api/completion/stream \
  -H "Content-Type: application/json" \
  -d '{
    "session_id": "<session from above>",
    "context": {
      "system_prompt": "You are a coding assistant.",
      "recent_messages": [{"role": "user", "content": "Write hello world in Python"}]
    },
    "options": {"temperature": 0.2}
  }'
# Should see SSE stream output
```

---

### Priority 2: VS Code Extension with Webview (3–4 days)

**What:**
- VS Code extension skeleton with activation
- Webview panel shown via command `agentOS.start`
- React chat UI with message list and input
- Extension ↔ webview message protocol (token streaming, user input)
- `BackendClient` connects to the FastAPI backend
- `AgentController` orchestrates: user message → backend stream → display tokens → handle tool calls

**Why second:**
- You need the UI to see what the agent is doing
- This validates the extension ↔ backend bridge, which is the core architectural complexity
- Once you have this, you can "chat with code" through the extension

**Success criteria:**
- `Cmd+Shift+P → Agent OS: Start Agent Session` opens webview panel
- Typing a message displays it in chat
- Response tokens stream into the chat in real-time
- Backend receives requests correctly from the extension
- Extension reads settings from `package.json`

**Files to build:**
```
extension/package.json
extension/tsconfig.json
extension/src/extension.ts
extension/src/agent/AgentController.ts
extension/src/agent/BackendClient.ts
extension/src/webview/WebviewMessenger.ts
extension/src/utils/settings.ts

webview/package.json
webview/vite.config.ts  
webview/index.html
webview/src/main.tsx
webview/src/App.tsx
webview/src/components/ChatHeader.tsx
webview/src/components/MessageList.tsx
webview/src/components/MessageBubble.tsx
webview/src/components/ChatInput.tsx
webview/src/hooks/useVSCodeAPI.ts
webview/src/types.ts
webview/src/styles/global.css
```

**Minimal test flow:**
```bash
# Terminal 1: Backend
cd backend && poetry run uvicorn src.main:app --reload --port 8080

# Terminal 2: Build webview
cd webview && npm run build    # outputs to extension/dist/webview/

# VS Code: F5 to launch extension debug host
# Then: Cmd+Shift+P → Agent OS: Start Agent Session
```

---

### Priority 3: Tool System + Approval UI (3–4 days)

**What:**
- File tools: `read_file`, `write_file`, `create_file`, `search_files`, `list_directory`
- Terminal tool: `run_command` with safe/destructive classification
- `ToolExecutor` on backend side (delegates file ops to extension, runs commands locally)
- `ApprovalManager` with auto-approve rules
- Approval dialog in webview with diff preview
- `ContextAssembler` that combines system prompt, current file, recent messages, tool results
- `AgentRuntime` full loop: model → tool call → execute → result → loop → done

**Why third:**
- This is where the agent becomes "useful" — it can actually read and edit code
- The approval UI is critical for safety (users need to see what the agent wants to change)
- Context assembly makes the model produce better results
- This completes the MVP core loop

**Success criteria:**
- Agent can read a file, understand it, and write changes
- `run_command` shows approval dialog for destructive commands, auto-runs safe ones
- Webview shows tool calls as collapsible cards with results
- Approval dialog shows diff for file writes
- Agent can loop: read → edit → test → fix → repeat (Level 3 autonomy)

**Files to build:**
```
extension/src/tools/FileToolExecutor.ts
extension/src/tools/ToolRegistry.ts
extension/src/agent/ContextAssembler.ts
extension/src/agent/TokenCounter.ts
extension/src/agent/ApprovalManager.ts
extension/src/tracking/OpenTabsTracker.ts
extension/src/tracking/ActiveFileTracker.ts

backend/src/router/tool.py
backend/src/tools/executor.py
backend/src/tools/terminal.py
backend/src/tools/registry.py

webview/src/components/ToolCallCard.tsx
webview/src/components/DiffView.tsx
webview/src/components/ApprovalDialog.tsx
webview/src/components/StatusIndicator.tsx
webview/src/styles/diff.css
```

**Minimal test flow:**
```
1. "Read the current file" → agent reads active tab, displays content
2. "Add a hello function to src/utils.ts" → agent creates, shows diff, asks approval
3. "Run the tests" → agent runs `npm test`, shows results (auto-approved)
4. "Fix the failing test" → agent reads test output, edits file, re-runs (the loop)
```

### Build Order Summary

| # | Component | Duration | Risk | Dependency |
|---|-----------|----------|------|------------|
| 1 | Backend + Ollama streaming | 3-4 days | High | None |
| 2 | Extension + Webview chat | 3-4 days | Medium | #1 |
| 3 | Tools + Approval + Context | 3-4 days | Medium | #1, #2 |

Total MVP: ~10-12 days full-time.

**After MVP:** Add OpenRouter provider (1 day), ChromaDB RAG (2 days), SQLite conversation summaries (1 day), Git tools (1 day), polish & bug fixes (2 days).

---

## Appendix A: Tool Call Parsing Format

The model outputs tool calls as XML-tagged blocks within its response text. The parser extracts these and sends them back for execution.

```
I need to check the current file.

<tool_call>
<tool_name>read_file</tool_name>
<parameters>
<path>src/index.ts</path>
</parameters>
</tool_call>

Now let me look at the test file.

<tool_call>
<tool_name>read_file</tool_name>
<parameters>
<path>src/__tests__/index.test.ts</path>
</parameters>
</tool_call>
```

Alternative: JSON format (more reliable with some models):
```
I need to check the current file.

<tool_call>
{"name": "read_file", "params": {"path": "src/index.ts"}}
</tool_call>
```

The `<tool_call>` tags are critical because:
- They separate tool requests from regular text
- Model sees them in system prompt examples
- Backend regex-parses them: `/<tool_call>([\s\S]*?)<\/tool_call>/g`
- Multiple tool calls can be batched in one response

## Appendix B: .agent/memory.json Format

```json
{
  "stack": {
    "frontend": "Next.js 14",
    "backend": "FastAPI 0.109",
    "database": "PostgreSQL 16",
    "testing": "pytest + vitest",
    "language": "TypeScript + Python"
  },
  "conventions": [
    "Functional components with hooks (no class components)",
    "Snake case for Python, camelCase for TypeScript",
    "Async/await for I/O operations",
    "Docstrings on all public Python functions",
    "TypeScript strict mode enabled"
  ],
  "important_files": [
    "src/app/page.tsx",
    "src/app/api/route.ts",
    "backend/main.py",
    "backend/src/router/api.py",
    "backend/src/db/models.py",
    "package.json",
    "backend/pyproject.toml",
    "docker-compose.yml"
  ],
  "last_tasks": [
    "Add user authentication with JWT tokens",
    "Create database schema for users table",
    "Set up Docker Compose for local dev"
  ],
  "ignored_paths": [
    "node_modules",
    ".next",
    "dist",
    "build",
    "__pycache__",
    ".venv",
    "venv",
    ".git",
    ".agent"
  ]
}