import { iterEventStream, safeJson } from '../stream.js';

import type { AIAdapter, AICompletionRequest } from '../types.js';

interface OpenAIDelta {
  readonly choices?: readonly {
    readonly delta?: { readonly content?: string };
  }[];
}

export interface OpenAIAdapterOptions {
  readonly apiKey: string;
  /** Default https://api.openai.com/v1 */
  readonly baseUrl?: string;
  readonly provider?: 'openai' | 'openai-compatible';
}

export function createOpenAIAdapter(opts: OpenAIAdapterOptions): AIAdapter {
  const base = (opts.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
  const provider = opts.provider ?? 'openai';

  async function* complete(req: AICompletionRequest): AsyncIterable<string> {
    const body = {
      model: req.model,
      messages: req.messages,
      stream: true,
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
    };
    const resp = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      ...(req.abortSignal !== undefined ? { signal: req.abortSignal } : {}),
    });
    if (!resp.ok) {
      throw new Error(`OpenAI HTTP ${resp.status}: ${await resp.text()}`);
    }
    for await (const payload of iterEventStream(resp, 'sse')) {
      const event = safeJson(payload) as OpenAIDelta | null;
      const text = event?.choices?.[0]?.delta?.content;
      if (typeof text === 'string' && text !== '') yield text;
    }
  }

  async function ping(model: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const resp = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${opts.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
        }),
      });
      if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}: ${await resp.text()}` };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  return { provider, complete, ping };
}
