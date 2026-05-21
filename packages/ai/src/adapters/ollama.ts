import { iterEventStream, safeJson } from '../stream.js';

import type { AIAdapter, AICompletionRequest } from '../types.js';

interface OllamaChunk {
  readonly message?: { readonly content?: string };
  readonly done?: boolean;
}

export interface OllamaAdapterOptions {
  /** e.g. http://localhost:11434 */
  readonly baseUrl: string;
}

export function createOllamaAdapter(opts: OllamaAdapterOptions): AIAdapter {
  const base = opts.baseUrl.replace(/\/$/, '');

  async function* complete(req: AICompletionRequest): AsyncIterable<string> {
    const resp = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: req.model,
        messages: req.messages,
        stream: true,
        options: {
          ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
          ...(req.maxTokens !== undefined ? { num_predict: req.maxTokens } : {}),
        },
      }),
      ...(req.abortSignal !== undefined ? { signal: req.abortSignal } : {}),
    });
    if (!resp.ok) {
      throw new Error(`Ollama HTTP ${resp.status}: ${await resp.text()}`);
    }
    for await (const line of iterEventStream(resp, 'ndjson')) {
      const chunk = safeJson(line) as OllamaChunk | null;
      const text = chunk?.message?.content;
      if (typeof text === 'string' && text !== '') yield text;
      if (chunk?.done === true) return;
    }
  }

  async function ping(model: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const tags = await fetch(`${base}/api/tags`);
      if (!tags.ok) return { ok: false, error: `HTTP ${tags.status}` };
      // Optionally verify model exists in /api/tags response.
      const body = (await tags.json()) as { readonly models?: readonly { readonly name?: string }[] };
      const has = (body.models ?? []).some((m) => m.name === model || m.name?.startsWith(`${model}:`));
      if (!has) return { ok: false, error: `Model ${model} not pulled (run: ollama pull ${model})` };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  return { provider: 'ollama', complete, ping };
}
