import { createAnthropicAdapter } from './adapters/anthropic.js';
import { createGeminiAdapter } from './adapters/gemini.js';
import { createLMStudioAdapter } from './adapters/lmstudio.js';
import { createOllamaAdapter } from './adapters/ollama.js';
import { createOpenAIAdapter } from './adapters/openai.js';

import type { AIAdapter, AIAdapterConfig } from './types.js';

export function createAIAdapter(config: AIAdapterConfig): AIAdapter {
  switch (config.provider) {
    case 'openai':
      return createOpenAIAdapter({
        apiKey: config.apiKey,
        ...(config.baseUrl !== undefined ? { baseUrl: config.baseUrl } : {}),
        provider: 'openai',
      });
    case 'openai-compatible':
      if (config.baseUrl === undefined) {
        throw new Error('openai-compatible provider requires baseUrl');
      }
      return createOpenAIAdapter({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        provider: 'openai-compatible',
      });
    case 'anthropic':
      return createAnthropicAdapter({
        apiKey: config.apiKey,
        ...(config.baseUrl !== undefined ? { baseUrl: config.baseUrl } : {}),
      });
    case 'gemini':
      return createGeminiAdapter({
        apiKey: config.apiKey,
        ...(config.baseUrl !== undefined ? { baseUrl: config.baseUrl } : {}),
      });
    case 'ollama':
      if (config.baseUrl === undefined) {
        throw new Error('ollama provider requires baseUrl');
      }
      return createOllamaAdapter({ baseUrl: config.baseUrl });
    case 'lmstudio':
      return createLMStudioAdapter(config.baseUrl !== undefined ? { baseUrl: config.baseUrl } : {});
  }
}
