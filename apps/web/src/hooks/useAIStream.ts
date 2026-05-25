import { type AICompleteInput } from '@scribe/shared';
import { useCallback, useRef, useState } from 'react';

import { log } from '../lib/debug';
import { API_URL, supabase } from '../lib/supabase';

export interface AIStreamState {
  readonly text: string;
  readonly streaming: boolean;
  readonly error: string | null;
}

export interface AIStreamHandle extends AIStreamState {
  run: (input: AICompleteInput) => Promise<void>;
  cancel: () => void;
  reset: () => void;
}

/** Pure decoder for a single SSE line emitted by `/api/ai/complete`.
 *  Extracted from the hook body so the parsing rules can be unit-tested
 *  without spinning up a fetch + ReadableStream pipeline. Returns
 *  `'skip'` for anything that isn't a recognisable event so the caller
 *  can keep reading without special-casing. */
export type SSEEvent =
  | { kind: 'text'; text: string }
  | { kind: 'done' }
  | { kind: 'error'; error: string }
  | { kind: 'skip' };

export function parseSSELine(line: string): SSEEvent {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) return { kind: 'skip' };
  const payload = trimmed.slice(5).trim();
  if (payload === '[DONE]') return { kind: 'done' };
  try {
    const json = JSON.parse(payload) as { text?: string; error?: string };
    if (json.error !== undefined) return { kind: 'error', error: json.error };
    if (json.text !== undefined) return { kind: 'text', text: json.text };
    return { kind: 'skip' };
  } catch {
    // Malformed JSON in a `data:` line — recoverable; the streaming
    // caller skips it and keeps reading subsequent lines.
    return { kind: 'skip' };
  }
}

/**
 * Posts to /api/ai/complete and parses the SSE stream, accumulating text.
 * One-shot per call — start fresh by calling `reset()` first if needed.
 */
export function useAIStream(): AIStreamHandle {
  const [state, setState] = useState<AIStreamState>({ text: '', streaming: false, error: null });
  const abortRef = useRef<AbortController | null>(null);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setState((s) => ({ ...s, streaming: false }));
  }, []);

  const reset = useCallback(() => {
    cancel();
    setState({ text: '', streaming: false, error: null });
  }, [cancel]);

  const run = useCallback(
    async (input: AICompleteInput): Promise<void> => {
      cancel();
      const abort = new AbortController();
      abortRef.current = abort;
      setState({ text: '', streaming: true, error: null });
      try {
        const {
          data: { session },
        } = await supabase.auth.getSession();
        const token = session?.access_token ?? '';
        const resp = await fetch(`${API_URL}/api/ai/complete`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(input),
          signal: abort.signal,
        });
        if (!resp.ok || resp.body === null) {
          let errMsg = `HTTP ${resp.status.toString()}`;
          try {
            const body = (await resp.json()) as { message?: string };
            if (body.message !== undefined) errMsg = body.message;
          } catch (err) {
            // Server returned a non-JSON error body (e.g. plaintext
            // from a proxy / gateway). Fall back to the HTTP-status
            // string already in `errMsg`; surface the parse failure
            // for diagnostics.
            log.api('ai/complete error-body parse failed', err);
          }
          setState({ text: '', streaming: false, error: errMsg });
          return;
        }

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let accumulated = '';
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let nl;
          while ((nl = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 1);
            const event = parseSSELine(line);
            if (event.kind === 'done') {
              setState({ text: accumulated, streaming: false, error: null });
              return;
            }
            if (event.kind === 'error') {
              setState({ text: accumulated, streaming: false, error: event.error });
              return;
            }
            if (event.kind === 'text') {
              accumulated += event.text;
              setState({ text: accumulated, streaming: true, error: null });
            }
            // event.kind === 'skip' — non-data line, malformed JSON,
            // or a data line without a `text` / `error` field. Surface
            // malformed-JSON cases for diagnostics but keep reading.
            if (event.kind === 'skip' && line.trim().startsWith('data:')) {
              log.api('ai/complete SSE line skipped', { line });
            }
          }
        }
        setState({ text: accumulated, streaming: false, error: null });
      } catch (e) {
        if (e instanceof Error && e.name === 'AbortError') {
          return;
        }
        setState({ text: '', streaming: false, error: e instanceof Error ? e.message : String(e) });
      } finally {
        abortRef.current = null;
      }
    },
    [cancel],
  );

  return { ...state, run, cancel, reset };
}
