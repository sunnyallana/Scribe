// HTTP-contract tests for the AI adapter layer.
//
// We don't run real network calls — `fetch` is stubbed and we inspect
// the URL / headers / body each adapter generates. The point is to
// pin down the wire format for every supported provider so a refactor
// (or a vendor changing their schema) trips a test rather than failing
// in production with a 400.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAnthropicAdapter } from './adapters/anthropic.js';
import { createGeminiAdapter } from './adapters/gemini.js';
import { createOpenAIAdapter } from './adapters/openai.js';
import { createAIAdapter } from './factory.js';
import { iterEventStream, safeJson } from './stream.js';

import type { AIMessage } from './types.js';

// ── helpers ────────────────────────────────────────────────────────────

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown; // parsed JSON
}

function stubFetch(responseBody = 'data: [DONE]\n'): CapturedRequest {
  // Default response: an SSE stream that immediately terminates. The
  // adapter's `complete()` async iterator consumes it without yielding
  // any chunks — perfect for testing request shapes without mocking the
  // full conversation flow.
  const captured: CapturedRequest = {
    url: '',
    method: '',
    headers: {},
    body: null,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      captured.url = url;
      captured.method = init?.method ?? 'GET';
      const h = init?.headers as Record<string, string> | undefined;
      captured.headers = { ...h };
      captured.body =
        typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : init?.body;
      return new Response(responseBody, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }),
  );
  return captured;
}

async function drain(iter: AsyncIterable<unknown>): Promise<void> {
  // Just walk the iterator to completion so the adapter's fetch fires.
  for await (const _ of iter) {
    /* discard */
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── stream.ts ──────────────────────────────────────────────────────────

describe('safeJson', () => {
  it('parses valid JSON', () => {
    expect(safeJson('{"a":1}')).toEqual({ a: 1 });
    expect(safeJson('"hello"')).toBe('hello');
    expect(safeJson('[1,2,3]')).toEqual([1, 2, 3]);
  });

  it('returns null for garbage instead of throwing', () => {
    expect(safeJson('not json {')).toBeNull();
    expect(safeJson('')).toBeNull();
    expect(safeJson('undefined')).toBeNull();
  });
});

describe('iterEventStream · sse mode', () => {
  function sseResponse(text: string): Response {
    return new Response(text);
  }

  it('yields the JSON payload of each data: line', async () => {
    const resp = sseResponse('data: {"a":1}\ndata: {"b":2}\n');
    const out: string[] = [];
    for await (const line of iterEventStream(resp, 'sse')) out.push(line);
    expect(out).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('terminates at the [DONE] sentinel', async () => {
    const resp = sseResponse('data: {"a":1}\ndata: [DONE]\ndata: {"b":2}\n');
    const out: string[] = [];
    for await (const line of iterEventStream(resp, 'sse')) out.push(line);
    // The frame after [DONE] is dropped — the iterator returns.
    expect(out).toEqual(['{"a":1}']);
  });

  it('skips comments and non-data event-type lines', async () => {
    const resp = sseResponse(': heartbeat\nevent: ping\ndata: {"keep":true}\n');
    const out: string[] = [];
    for await (const line of iterEventStream(resp, 'sse')) out.push(line);
    expect(out).toEqual(['{"keep":true}']);
  });

  it('flushes the trailing chunk when the stream ends without a newline', async () => {
    // Real servers don't always terminate the final frame with `\n`.
    // The iterator must still yield it instead of losing the last
    // token.
    const resp = sseResponse('data: {"tail":1}');
    const out: string[] = [];
    for await (const line of iterEventStream(resp, 'sse')) out.push(line);
    expect(out).toEqual(['{"tail":1}']);
  });
});

describe('iterEventStream · ndjson mode', () => {
  it('yields each non-empty line verbatim', async () => {
    // Ollama returns plain JSON-per-line (NDJSON), no `data:` prefix.
    const resp = new Response('{"chunk":1}\n{"chunk":2}\n\n{"chunk":3}\n');
    const out: string[] = [];
    for await (const line of iterEventStream(resp, 'ndjson')) out.push(line);
    expect(out).toEqual(['{"chunk":1}', '{"chunk":2}', '{"chunk":3}']);
  });
});

// ── factory.ts ─────────────────────────────────────────────────────────

describe('createAIAdapter', () => {
  it('returns an openai adapter for `openai` provider', () => {
    const a = createAIAdapter({ provider: 'openai', apiKey: 'sk' });
    expect(a.provider).toBe('openai');
    expect(typeof a.complete).toBe('function');
    expect(typeof a.ping).toBe('function');
  });

  it('throws when openai-compatible is missing baseUrl', () => {
    // The whole point of `openai-compatible` is BYO endpoint — silently
    // falling back to api.openai.com would be a footgun.
    expect(() => createAIAdapter({ provider: 'openai-compatible', apiKey: 'sk' })).toThrow(
      /requires baseUrl/,
    );
  });

  it('throws when ollama is missing baseUrl', () => {
    expect(() => createAIAdapter({ provider: 'ollama', apiKey: 'unused' })).toThrow(
      /requires baseUrl/,
    );
  });

  it('lmstudio without baseUrl is allowed (defaults to localhost)', () => {
    // LM Studio installs ship with a built-in local endpoint; the
    // adapter's default baseUrl points at it. No throw.
    const a = createAIAdapter({ provider: 'lmstudio', apiKey: 'unused' });
    expect(a.provider).toBe('lmstudio');
  });

  it('passes baseUrl through to anthropic and gemini', () => {
    expect(() =>
      createAIAdapter({ provider: 'anthropic', apiKey: 'sk', baseUrl: 'https://proxy' }),
    ).not.toThrow();
    expect(() =>
      createAIAdapter({ provider: 'gemini', apiKey: 'sk', baseUrl: 'https://proxy' }),
    ).not.toThrow();
  });
});

// ── OpenAI adapter wire format ─────────────────────────────────────────

describe('createOpenAIAdapter · complete()', () => {
  const messages: AIMessage[] = [
    { role: 'system', content: 'be helpful' },
    { role: 'user', content: 'hi' },
  ];

  it('POSTs to {baseUrl}/chat/completions with the canonical OpenAI shape', async () => {
    const captured = stubFetch();
    const adapter = createOpenAIAdapter({ apiKey: 'sk-test' });
    await drain(
      adapter.complete({ model: 'gpt-4o-mini', messages, temperature: 0.5, maxTokens: 128 }),
    );

    expect(captured.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(captured.method).toBe('POST');
    expect(captured.headers.Authorization).toBe('Bearer sk-test');
    expect(captured.headers['Content-Type']).toBe('application/json');

    const body = captured.body as Record<string, unknown>;
    expect(body.model).toBe('gpt-4o-mini');
    expect(body.stream).toBe(true);
    expect(body.temperature).toBe(0.5);
    expect(body.max_tokens).toBe(128);
    expect(body.messages).toEqual(messages);
  });

  it('omits temperature and max_tokens when undefined (uses OpenAI defaults)', async () => {
    const captured = stubFetch();
    const adapter = createOpenAIAdapter({ apiKey: 'sk' });
    await drain(adapter.complete({ model: 'gpt-4o', messages }));
    const body = captured.body as Record<string, unknown>;
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('max_tokens');
  });

  it('strips trailing slash from baseUrl override', async () => {
    const captured = stubFetch();
    const adapter = createOpenAIAdapter({
      apiKey: 'sk',
      baseUrl: 'http://localhost:11434/v1/',
    });
    await drain(adapter.complete({ model: 'llama3', messages }));
    expect(captured.url).toBe('http://localhost:11434/v1/chat/completions');
  });
});

// ── Anthropic adapter wire format ──────────────────────────────────────

describe('createAnthropicAdapter · complete()', () => {
  const messages: AIMessage[] = [
    { role: 'system', content: 'be concise' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
    { role: 'user', content: 'thanks' },
  ];

  it('POSTs to /v1/messages with x-api-key + anthropic-version headers', async () => {
    const captured = stubFetch();
    const adapter = createAnthropicAdapter({ apiKey: 'sk-ant' });
    await drain(adapter.complete({ model: 'claude-sonnet-4-6', messages }));

    expect(captured.url).toBe('https://api.anthropic.com/v1/messages');
    expect(captured.headers['x-api-key']).toBe('sk-ant');
    expect(captured.headers['anthropic-version']).toBe('2023-06-01');
    // Authorization MUST NOT be set — Anthropic uses x-api-key only.
    expect(captured.headers.Authorization).toBeUndefined();
  });

  it('lifts the system prompt to a top-level `system` field', async () => {
    const captured = stubFetch();
    const adapter = createAnthropicAdapter({ apiKey: 'sk-ant' });
    await drain(adapter.complete({ model: 'claude-sonnet-4-6', messages }));
    const body = captured.body as Record<string, unknown>;
    expect(body.system).toBe('be concise');
    // The system message is removed from the `messages` array, leaving
    // only user/assistant turns.
    expect(body.messages).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: 'thanks' },
    ]);
  });

  it('concatenates multiple system messages with a blank-line separator', async () => {
    const captured = stubFetch();
    const adapter = createAnthropicAdapter({ apiKey: 'sk-ant' });
    await drain(
      adapter.complete({
        model: 'claude-sonnet-4-6',
        messages: [
          { role: 'system', content: 'one' },
          { role: 'system', content: 'two' },
          { role: 'user', content: 'q' },
        ],
      }),
    );
    const body = captured.body as Record<string, unknown>;
    // Both system fragments survive — the second isn't lost the way it
    // would be on the Rust adapter (which is last-wins). Pin this so
    // someone trying to "align" the two implementations notices the
    // intentional divergence.
    expect(body.system).toBe('one\n\ntwo');
  });

  it('defaults max_tokens to 2048 (anthropic requires the field)', async () => {
    const captured = stubFetch();
    const adapter = createAnthropicAdapter({ apiKey: 'sk-ant' });
    await drain(adapter.complete({ model: 'claude-sonnet-4-6', messages }));
    const body = captured.body as Record<string, unknown>;
    expect(body.max_tokens).toBe(2048);
  });

  it('honours an explicit maxTokens override', async () => {
    const captured = stubFetch();
    const adapter = createAnthropicAdapter({ apiKey: 'sk-ant' });
    await drain(adapter.complete({ model: 'claude-sonnet-4-6', messages, maxTokens: 512 }));
    expect((captured.body as { max_tokens: number }).max_tokens).toBe(512);
  });

  it('marks stream:true so the SSE iterator gets data', async () => {
    const captured = stubFetch();
    const adapter = createAnthropicAdapter({ apiKey: 'sk-ant' });
    await drain(adapter.complete({ model: 'claude-sonnet-4-6', messages }));
    expect((captured.body as { stream: boolean }).stream).toBe(true);
  });
});

// ── Gemini adapter wire format ─────────────────────────────────────────

describe('createGeminiAdapter · complete()', () => {
  const messages: AIMessage[] = [
    { role: 'system', content: 'be terse' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
  ];

  it('POSTs to streamGenerateContent with the model + api key in the URL', async () => {
    const captured = stubFetch();
    const adapter = createGeminiAdapter({ apiKey: 'ga-test' });
    await drain(adapter.complete({ model: 'gemini-1.5-pro', messages }));

    // Gemini's auth is a query-string key, not a header. Plus model in
    // the path (URL-encoded), `alt=sse` for the parseable stream.
    expect(captured.url).toMatch(/^https:\/\/generativelanguage\.googleapis\.com\//);
    expect(captured.url).toContain('/v1beta/models/gemini-1.5-pro:streamGenerateContent');
    expect(captured.url).toContain('alt=sse');
    expect(captured.url).toContain('key=ga-test');
  });

  it('URL-encodes the model name and api key', async () => {
    // A model with a `:` or `/` in the name would break the URL — and a
    // user passing an API key with `=` or `&` would corrupt the query
    // string. The adapter encodes both via encodeURIComponent.
    const captured = stubFetch();
    const adapter = createGeminiAdapter({ apiKey: 'a=b&c' });
    await drain(adapter.complete({ model: 'gemini-pro/0125', messages: [] }));
    expect(captured.url).toContain('gemini-pro%2F0125');
    expect(captured.url).toContain('key=a%3Db%26c');
  });

  it('lifts system into systemInstruction.parts[0].text', async () => {
    const captured = stubFetch();
    const adapter = createGeminiAdapter({ apiKey: 'ga' });
    await drain(adapter.complete({ model: 'gemini-1.5-pro', messages }));
    const body = captured.body as Record<string, unknown>;
    expect(body.systemInstruction).toEqual({ parts: [{ text: 'be terse' }] });
  });

  it('maps assistant messages to role "model" and wraps text in parts arrays', async () => {
    const captured = stubFetch();
    const adapter = createGeminiAdapter({ apiKey: 'ga' });
    await drain(adapter.complete({ model: 'gemini-1.5-pro', messages }));
    const body = captured.body as Record<string, unknown>;
    expect(body.contents).toEqual([
      { role: 'user', parts: [{ text: 'hi' }] },
      { role: 'model', parts: [{ text: 'hello' }] },
    ]);
  });

  it('omits systemInstruction when no system message is present', async () => {
    const captured = stubFetch();
    const adapter = createGeminiAdapter({ apiKey: 'ga' });
    await drain(
      adapter.complete({
        model: 'gemini-1.5-pro',
        messages: [{ role: 'user', content: 'q' }],
      }),
    );
    const body = captured.body as Record<string, unknown>;
    expect(body).not.toHaveProperty('systemInstruction');
  });

  it('uses maxOutputTokens (camelCase) and not max_tokens', async () => {
    // Google's API expects camelCase; the snake_case form would be
    // silently ignored and the model would use its own (much larger)
    // default.
    const captured = stubFetch();
    const adapter = createGeminiAdapter({ apiKey: 'ga' });
    await drain(adapter.complete({ model: 'gemini-1.5-pro', messages, maxTokens: 256 }));
    const body = captured.body as { generationConfig: Record<string, unknown> };
    expect(body.generationConfig.maxOutputTokens).toBe(256);
    expect(body.generationConfig).not.toHaveProperty('max_tokens');
  });
});
