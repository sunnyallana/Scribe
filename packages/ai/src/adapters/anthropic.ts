import { iterEventStream, safeJson } from '../stream.js';

import type { AIAdapter, AIMessage, AICompletionRequest } from '../types.js';

interface AnthropicDelta {
  readonly type?: string;
  readonly delta?: { readonly type?: string; readonly text?: string };
}

export interface AnthropicAdapterOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
}

function splitSystem(messages: readonly AIMessage[]): {
  readonly system: string | undefined;
  readonly chat: readonly { readonly role: 'user' | 'assistant'; readonly content: string }[];
} {
  let system: string | undefined;
  const chat: { role: 'user' | 'assistant'; content: string }[] = [];
  for (const m of messages) {
    if (m.role === 'system') {
      system = system === undefined ? m.content : `${system}\n\n${m.content}`;
    } else {
      chat.push({ role: m.role, content: m.content });
    }
  }
  return { system, chat };
}

export function createAnthropicAdapter(opts: AnthropicAdapterOptions): AIAdapter {
  const base = (opts.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '');

  async function* complete(req: AICompletionRequest): AsyncIterable<string> {
    const { system, chat } = splitSystem(req.messages);
    const body = {
      model: req.model,
      max_tokens: req.maxTokens ?? 2048,
      messages: chat,
      stream: true,
      ...(system !== undefined ? { system } : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    };
    const resp = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': opts.apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      ...(req.abortSignal !== undefined ? { signal: req.abortSignal } : {}),
    });
    if (!resp.ok) {
      throw new Error(`Anthropic HTTP ${resp.status}: ${await resp.text()}`);
    }
    for await (const payload of iterEventStream(resp, 'sse')) {
      const event = safeJson(payload) as AnthropicDelta | null;
      if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        const text = event.delta.text;
        if (typeof text === 'string' && text !== '') yield text;
      }
    }
  }

  async function ping(model: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const resp = await fetch(`${base}/v1/messages`, {
        method: 'POST',
        headers: {
          'x-api-key': opts.apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }],
        }),
      });
      if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}: ${await resp.text()}` };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  return { provider: 'anthropic', complete, ping };
}
