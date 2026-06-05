#!/bin/bash
# Agent OS - One-command dev environment setup
# Run from the project root: bash scripts/setup-dev.sh

set -e

echo "================================================"
echo "  Agent OS - Development Environment Setup"
echo "================================================"
echo ""

# Check prerequisites
echo "[1/5] Checking prerequisites..."

check_command() {
    if ! command -v "$1" &> /dev/null; then
        echo "  ❌ $1 is not installed. Please install it first."
        exit 1
    fi
    echo "  ✅ $1 found"
}

check_command python3
check_command node
check_command npm
check_command git

# Python version
PY_VERSION=$(python3 --version 2>&1 | awk '{print $2}')
echo "  Python version: $PY_VERSION"

# Node version
NODE_VERSION=$(node --version 2>&1)
echo "  Node version: $NODE_VERSION"

echo ""

# Setup Python backend
echo "[2/5] Setting up Python backend..."
cd backend

if command -v poetry &> /dev/null; then
    echo "  Using Poetry for dependency management"
    poetry install
    echo "  ✅ Backend dependencies installed via Poetry"
elif command -v pip &> /dev/null; then
    echo "  Using pip for dependency management"
    # Create virtual environment (required on Arch Linux / PEP 668 systems)
    if [ ! -d ".venv" ]; then
        python3 -m venv .venv
        echo "  ✅ Created virtual environment in .venv/"
    fi
    source .venv/bin/activate
    pip install -e ".[dev]"
    echo "  ✅ Backend dependencies installed via pip into .venv/"
    echo "  ℹ️  Activate with: source backend/.venv/bin/activate"
else
    echo "  ⚠️  Neither poetry nor pip found. Please install dependencies manually."
fi

cd ..
echo ""

# Setup webview
echo "[3/5] Setting up webview (React UI)..."
cd webview
npm install 2>/dev/null || echo "  ⚠️  npm install had warnings - may need manual setup"
echo "  ✅ Webview dependencies installed"
cd ..
echo ""

# Setup extension
echo "[4/5] Setting up VS Code extension..."
cd extension
npm install 2>/dev/null || echo "  ⚠️  npm install had warnings - may need manual setup"
echo "  ✅ Extension dependencies installed"
cd ..
echo ""

# Create .agent directory for project memory
echo "[5/5] Creating project memory directory..."
mkdir -p .agent
cat > .agent/memory.json << 'EOF'
{
  "stack": {
    "frontend": "VS Code Extension (TypeScript + React)",
    "backend": "FastAPI (Python)",
    "database": "SQLite + ChromaDB",
    "models": "Ollama"
  },
  "conventions": [
    "TypeScript for extension/webview, Python for backend",
    "Async/await for I/O operations",
    "Pydantic models for API schemas",
    "SSE streaming for completion endpoint"
  ],
  "important_files": [
    "backend/src/main.py",
    "backend/src/agent/runtime.py",
    "backend/src/providers/ollama.py",
    "extension/src/extension.ts",
    "extension/src/agent/AgentController.ts",
    "webview/src/App.tsx"
  ],
  "last_tasks": []
}
EOF
echo "  ✅ Project memory initialized"
echo ""

echo "================================================"
echo "  Setup Complete!"
echo "================================================"
echo ""
echo "Next steps:"
echo "  1. Make sure Ollama is running:"
echo "     $ ollama serve"
echo ""
echo "  2. Pull a model:"
echo "     $ ollama pull codellama:7b"
echo ""
echo "  3. Activate the Python virtual environment and start the backend:"
echo "     $ cd backend"
echo "     $ source .venv/bin/activate"
echo "     $ uvicorn src.main:app --reload --port 8080"
echo ""
echo "  4. Build the webview (in a separate terminal):"
echo "     $ cd webview && npm run build"
echo ""
echo "  5. Open VS Code and run the extension:"
echo "     $ code . && press F5"
echo ""
echo "  6. In the new VS Code window, press Ctrl+Shift+P and run:"
echo "     Agent OS: Start Agent Session"
echo ""
echo "Happy coding! 🤖"