## Everything runs on your machine

Cortex has no server, no account, and no telemetry. It talks to
[Ollama](https://ollama.com) over `http://localhost:11434`.

```
curl -fsSL https://ollama.com/install.sh | sh
ollama serve
```

Nothing leaves your machine unless you pick one of Ollama's cloud models.
