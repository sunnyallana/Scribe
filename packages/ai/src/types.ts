import type { AIProvider } from '@scribe/shared';

export interface AIMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

export interface AICompletionRequest {
  readonly messages: readonly AIMessage[];
  readonly model: string;
  /** Sampling temperature (0..2). Provider defaults if undefined. */
  readonly temperature?: number;
  /** Hard cap on tokens. */
  readonly maxTokens?: number;
  readonly abortSignal?: AbortSignal;
}

export interface AIAdapterConfig {
  readonly provider: AIProvider;
  readonly apiKey: string;
  readonly baseUrl?: string;
}

export interface AIAdapter {
  readonly provider: AIProvider;
  /** Streamed completion. Yields text chunks; consumer concatenates. */
  complete(req: AICompletionRequest): AsyncIterable<string>;
  /** Cheap reachability check — does a 1-token completion. */
  ping(model: string): Promise<{ ok: boolean; error?: string }>;
}
