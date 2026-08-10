// Dispatches to the active model provider's client. Ollama remains the
// default (local, no API key), but "openai-compatible" lets the same agent
// loop talk to OpenAI, OpenRouter, LM Studio, vLLM, or anything else that
// speaks the OpenAI /v1/chat/completions shape.

'use strict';

const ollama = require('./ollamaClient.cjs');
const openaiCompatible = require('./openaiClient.cjs');

function clientFor(provider) {
  return provider === 'openai-compatible' ? openaiCompatible : ollama;
}

async function chat(opts) {
  return clientFor(opts.provider).chat(opts);
}

async function listModels(opts) {
  return clientFor(opts.provider).listModels(opts);
}

module.exports = { chat, listModels };
