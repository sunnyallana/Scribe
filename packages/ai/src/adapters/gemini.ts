import { iterEventStream, safeJson } from '../stream.js';

import type { AIAdapter, AIMessage, AICompletionRequest } from '../types.js';

interface GeminiCandidate {
  readonly content?: { readonly parts?: readonly { readonly text?: string }[] };
}

interface GeminiResponse {
  readonly candidates?: readonly GeminiCandidate[];
}

export interface GeminiAdapterOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
}

function toGeminiContents(messages: readonly AIMessage[]): {
  readonly systemInstruction?: { readonly parts: readonly { readonly text: string }[] };
  readonly contents: readonly {
    readonly role: 'user' | 'model';
    readonly parts: readonly { readonly text: string }[];
  }[];
} {
  let systemText = '';
  const contents: {
    role: 'user' | 'model';
    parts: { text: string }[];
  }[] = [];
  for (const m of messages) {
    if (m.role === 'system') {
      systemText = systemText === '' ? m.content : `${systemText}\n\n${m.content}`;
    } else {
      contents.push({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      });
    }
  }
  return {
    ...(systemText !== '' ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
    contents,
  };
}

export function createGeminiAdapter(opts: GeminiAdapterOptions): AIAdapter {
  const base = (opts.baseUrl ?? 'https://generativelanguage.googleapis.com').replace(/\/$/, '');

  async function* complete(req: AICompletionRequest): AsyncIterable<string> {
    const payload = {
      ...toGeminiContents(req.messages),
      generationConfig: {
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        ...(req.maxTokens !== undefined ? { maxOutputTokens: req.maxTokens } : {}),
      },
    };
    const url = `${base}/v1beta/models/${encodeURIComponent(req.model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(opts.apiKey)}`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      ...(req.abortSignal !== undefined ? { signal: req.abortSignal } : {}),
    });
    if (!resp.ok) {
      throw new Error(`Gemini HTTP ${resp.status}: ${await resp.text()}`);
    }
    for await (const data of iterEventStream(resp, 'sse')) {
      const event = safeJson(data) as GeminiResponse | null;
      const parts = event?.candidates?.[0]?.content?.parts;
      if (parts === undefined) continue;
      for (const p of parts) {
        if (typeof p.text === 'string' && p.text !== '') yield p.text;
      }
    }
  }

  async function ping(model: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const url = `${base}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(opts.apiKey)}`;
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
          generationConfig: { maxOutputTokens: 1 },
        }),
      });
      if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}: ${await resp.text()}` };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  return { provider: 'gemini', complete, ping };
}
