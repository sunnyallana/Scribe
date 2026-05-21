import { createOpenAIAdapter } from './openai.js';

import type { AIAdapter } from '../types.js';

export interface LMStudioAdapterOptions {
  /** Default http://localhost:1234/v1 */
  readonly baseUrl?: string;
}

/**
 * LM Studio's local server is OpenAI-compatible. We just point the OpenAI
 * adapter at its endpoint with a dummy api key (LM Studio ignores it).
 */
export function createLMStudioAdapter(opts: LMStudioAdapterOptions = {}): AIAdapter {
  return {
    ...createOpenAIAdapter({
      apiKey: 'lm-studio',
      baseUrl: opts.baseUrl ?? 'http://localhost:1234/v1',
      provider: 'openai-compatible',
    }),
    provider: 'lmstudio',
  };
}
