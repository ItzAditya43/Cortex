## Pick a model that can use tools

Agent work needs a model that follows a tool-calling protocol. Good starting points:

| Model | Size | Notes |
|---|---|---|
| `qwen2.5-coder:7b` | ~4.7 GB | Best balance for most machines |
| `qwen2.5-coder:3b` | ~2 GB | Works on modest hardware |
| `nomic-embed-text` | ~275 MB | Optional — enables semantic code search |

**Cortex can test this for you.** Run *Cortex: Probe Model Capabilities* to
check whether your model supports native tool calling, or
*Cortex: Benchmark My Models* to score the models you already have.
