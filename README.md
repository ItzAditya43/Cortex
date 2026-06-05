# Agent OS

An autonomous coding agent for VS Code. Cline-style agent that can read, write, run, observe, and fix code — all from within your editor.

```
┌─────────────────────────────────────────────────┐
│  VS Code Extension (TypeScript)                 │
│  └─ Webview Panel (React chat UI)               │
│  └─ Extension Host                              │
│       └─ AgentController                        │
│            ├─ ContextAssembler                  │
│            ├─ ApprovalManager                   │
│            └─ BackendClient ──→ HTTP ──→        │
└─────────────────────────────────────────────────┘
                                              │
                                              ▼
┌─────────────────────────────────────────────────┐
│  FastAPI Backend (Python) :8080                  │
│  └─ AgentRuntime                                 │
│       ├─ ModelGateway (Ollama/OpenRouter/Gemini) │
│       ├─ ToolExecutor                            │
│       └─ MemoryService                           │
│            ├─ SQLite (summaries, project memory)  │
│            └─ ChromaDB (vector index)             │
└─────────────────────────────────────────────────┘
```

---

## Quick Start (5 minutes)

### Prerequisites

- **Python 3.11+**
- **Node.js 18+**
- **VS Code**
- **Ollama** (for local models) — [install from ollama.ai](https://ollama.ai)

### Step 1: Install Dependencies

```bash
# From the project root:

# Python backend
cd backend
pip install fastapi uvicorn pydantic pydantic-settings sqlalchemy aiosqlite chromadb httpx sse-starlette litellm
# or: poetry install
cd ..

# Webview (React UI)
cd webview && npm install && cd ..

# VS Code Extension
cd extension && npm install && cd ..
```

### Step 2: Pull an Ollama Model

```bash
# Start Ollama (in a separate terminal)
ollama serve

# Pull a code model
ollama pull codellama:7b
# Or try a smaller one: ollama pull qwen2.5-coder:7b
# Or tiny for testing: ollama pull llama3.2:1b
```

### Step 3: Start the Backend

```bash
cd backend
python -m uvicorn src.main:app --reload --port 8080
```

The backend starts on `http://localhost:8080`. Verify it's working:

```bash
curl http://localhost:8080/api/health
# → {"status":"healthy","providers":{"ollama":{...}},"version":"0.1.0"}
```

### Step 4: Build the Webview

```bash
cd webview
npm run build
```

This compiles the React chat UI and places it at `extension/out/webview/`.

### Step 5: Launch the Extension in VS Code

```bash
# From the project root
code .

# In VS Code: Press F5
# This opens a new Extension Development Host window
```

### Step 6: Start a Session

In the new VS Code window:

1. **Open a project folder** (File → Open Folder)
2. **Ctrl+Shift+P** → run `Agent OS: Start Agent Session`
3. The chat panel opens on the right side
4. Type a message like _"Read the current file and explain it to me"_

---

## Architecture Overview

### Three-Layer Architecture

| Layer | Language | Location | Role |
|-------|----------|----------|------|
| **Extension** | TypeScript | `extension/` | VS Code integration, file access, approval UI |
| **Webview** | TypeScript/React | `webview/` | Chat interface with streaming, tool calls, approval dialogs |
| **Backend** | Python/FastAPI | `backend/` | Model inference, tool execution, RAG, memory |

### Communication Flow

```
User types message
       ↓
Webview (React) ──postMessage──→ Extension Host (AgentController)
                                        ↓ HTTP POST /api/completion/stream
                                   Backend (AgentRuntime)
                                        ↓ SSE stream
                                   Backend streams tokens + tool calls
                                        ↓
                                   Extension executes file tools locally
                                   Backend executes terminal tools remotely
                                        ↓
                                   Results streamed back to webview
```

### Tool System

| Tool | Auto-Approved? | Description |
|------|---------------|-------------|
| `read_file` | ✅ Yes | Read file contents |
| `write_file` | ❌ Requires approval | Write content to file (shows diff) |
| `create_file` | ❌ Requires approval | Create new file |
| `delete_file` | ❌ Requires approval | Delete file (destructive) |
| `search_files` | ✅ Yes | Search codebase with regex |
| `list_directory` | ✅ Yes | List directory contents |
| `run_command` | ⚠️ Safe commands only | Run shell commands |
| `git_status` | ✅ Yes | Git status |
| `git_diff` | ✅ Yes | Git diff |
| `git_commit` | ❌ Requires approval | Create git commit |

**Safe commands** (auto-approved): `npm test`, `npm run build`, `pytest`, `git status`, `ls`, `cat`, `grep`, etc.

### Memory System

Four memory layers, referenced automatically in every agent turn:

1. **Session Memory** — In-memory message array (wiped on close)
2. **Conversation Summary** — Rolling summary updated every 6 turns, stored in SQLite
3. **Project Memory** — Per-project config in `.agent/memory.json`
4. **Vector Memory (RAG)** — ChromaDB index of project files, queried per turn

---

## API Endpoints

Once the backend is running, full API docs are at: **http://localhost:8080/docs**

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/health` | Health check + provider status |
| `GET` | `/api/config` | Current backend configuration |
| `POST` | `/api/session` | Create new agent session |
| `GET` | `/api/session/{id}` | Get session status |
| `DELETE` | `/api/session/{id}` | Shutdown session |
| `GET` | `/api/session/{id}/summary` | Get conversation summary |
| `GET` | `/api/session/{id}/project-memory` | Get project memory |
| `PUT` | `/api/session/{id}/project-memory` | Update project memory |
| `POST` | `/api/completion/stream` | **Main agent loop** — SSE stream |
| `POST` | `/api/tool/execute` | Execute a tool |
| `POST` | `/api/tool/execute-batch` | Execute tools in parallel |
| `POST` | `/api/memory/index` | Index entire project |
| `POST` | `/api/memory/index-file` | Index single file |
| `POST` | `/api/memory/retrieve` | RAG retrieval |

### Testing the Agent Loop with curl

```bash
# 1. Create a session
SESSION=$(curl -s -X POST http://localhost:8080/api/session \
  -H "Content-Type: application/json" \
  -d '{"project_path": "/tmp/test"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['session_id'])")

echo "Session: $SESSION"

# 2. Send a message (SSE stream)
curl -N -X POST http://localhost:8080/api/completion/stream \
  -H "Content-Type: application/json" \
  -d "{
    \"session_id\": \"$SESSION\",
    \"context\": {
      \"sections\": [
        {\"name\": \"systemPrompt\", \"content\": \"You are a coding assistant.\", \"priority\": 1, \"token_count\": 5},
        {\"name\": \"userMessage\", \"content\": \"Write hello world in Python\", \"priority\": 1, \"token_count\": 5}
      ],
      \"text\": \"\",
      \"total_tokens\": 0,
      \"dropped_sections\": []
    },
    \"options\": {\"temperature\": 0.2}
  }"

# You'll see SSE events: data: {"type":"token","content":"..."} ...
```

---

## Project Structure

```
agent-os/
├── backend/                    # FastAPI Backend (Python)
│   ├── src/
│   │   ├── main.py             # App entry, CORS, router registration
│   │   ├── config.py           # Settings via pydantic-settings
│   │   ├── agent/
│   │   │   ├── runtime.py      # Core agent loop
│   │   │   └── models.py       # All Pydantic schemas
│   │   ├── providers/
│   │   │   ├── base.py         # Abstract ModelProvider
│   │   │   ├── ollama.py       # Ollama streaming + tool call parsing
│   │   │   └── gateway.py      # Provider dispatch
│   │   ├── tools/
│   │   │   ├── executor.py     # 11 tool implementations
│   │   │   ├── registry.py     # Tool definitions + safe commands
│   │   │   └── terminal.py     # Subprocess management
│   │   ├── memory/
│   │   │   ├── service.py      # 4-layer memory coordinator
│   │   │   ├── chroma_manager.py
│   │   │   ├── chunker.py      # Text chunking for RAG
│   │   │   └── summarizer.py   # Conversation summarization
│   │   ├── db/
│   │   │   ├── models.py       # SQLAlchemy ORM (6 tables)
│   │   │   └── database.py     # Async engine
│   │   └── router/
│   │       ├── health.py       # /api/health, /api/config
│   │       ├── session.py      # Session CRUD
│   │       ├── completion.py   # SSE streaming
│   │       ├── tool.py         # Tool execution
│   │       └── memory.py       # RAG index/retrieve
│   └── pyproject.toml
│
├── extension/                  # VS Code Extension (TypeScript)
│   ├── package.json            # Commands, settings, activation
│   ├── tsconfig.json
│   ├── src/
│   │   ├── extension.ts        # Activate/deactivate, command registration
│   │   ├── agent/
│   │   │   ├── AgentController.ts    # Orchestrator
│   │   │   ├── ApprovalManager.ts    # Auto-approve rules, YOLO mode
│   │   │   └── BackendClient.ts      # HTTP client (12 methods)
│   │   ├── webview/
│   │   │   └── WebviewMessenger.ts   # Bidirectional VS Code ↔ React
│   │   └── tracking/
│   │       └── OpenTabsTracker.ts    # Tab order tracking
│   └── out/                    # Compiled output
│
├── webview/                    # React Chat UI
│   ├── vite.config.ts
│   ├── src/
│   │   ├── App.tsx             # Root component
│   │   ├── main.tsx            # ReactDOM entry
│   │   ├── components/
│   │   │   ├── ChatHeader.tsx       # Status + abort
│   │   │   ├── MessageList.tsx      # Scrollable conversation
│   │   │   ├── MessageBubble.tsx    # User/assistant/tool messages
│   │   │   ├── ChatInput.tsx        # Auto-resize textarea
│   │   │   └── ApprovalDialog.tsx   # Approve/reject modal
│   │   ├── hooks/
│   │   │   ├── useVSCodeAPI.ts      # acquireVsCodeApi wrapper
│   │   │   └── useMessages.ts       # Message state
│   │   └── styles/
│   │       └── global.css           # Dark theme (VS Code native)
│   └── index.html
│
├── scripts/
│   └── setup-dev.sh            # One-command setup
├── README.md
├── AGENT_OS_DESIGN.md          # Full architecture document
└── .agent/
    └── memory.json             # Project memory (auto-generated)
```

---

## Configuration

### VS Code Settings (`settings.json`)

```json
{
  "agentOS.backendUrl": "http://localhost:8080",
  "agentOS.provider": "ollama",
  "agentOS.model": "codellama:7b",
  "agentOS.yoloMode": false,
  "agentOS.autoIndex": true
}
```

### Backend Environment Variables

Set these as environment variables or in a `.env` file in `backend/`:

```bash
# File: backend/.env
AGENT_OS_PROVIDER=ollama
AGENT_OS_MODEL=codellama:7b
AGENT_OS_TEMPERATURE=0.2
AGENT_OS_MAX_TOKENS=4096
AGENT_OS_OLLAMA_BASE_URL=http://localhost:11434

# For cloud fallback:
# AGENT_OS_OPENROUTER_API_KEY=sk-...
# AGENT_OS_GEMINI_API_KEY=...
```

---

## Development Workflow

```bash
# Terminal 1: Backend
cd backend && uvicorn src.main:app --reload --port 8080

# Terminal 2: Webview dev server (for hot reload)
cd webview && npm run dev
# Opens on port 3000

# Terminal 3: Extension
# In VS Code, press F5 to launch Extension Dev Host
```

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `Module not found` after install | Run `npm install` in both `extension/` and `webview/` |
| Backend won't start | Check Python 3.11+, install deps: `pip install -e .` in `backend/` |
| Ollama connection refused | Run `ollama serve` first, verify at `http://localhost:11434` |
| Extension shows blank webview | Build webview first: `cd webview && npm run build` |
| `@types/vscode` not found | Run `npm install` in `extension/` (the VSCE package includes types) |
| Port 8080 already in use | Change port in `backend/.env` and VS Code settings `agentOS.backendUrl` |