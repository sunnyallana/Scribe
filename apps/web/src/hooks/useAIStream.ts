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

  const run = useCallback(async (input: AICompleteInput): Promise<void> => {
    cancel();
    const abort = new AbortController();
    abortRef.current = abort;
    setState({ text: '', streaming: true, error: null });
    try {
      const { data: { session } } = await supabase.auth.getSession();
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
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') {
            setState({ text: accumulated, streaming: false, error: null });
            return;
          }
          try {
            const json = JSON.parse(payload) as { text?: string; error?: string };
            if (json.error !== undefined) {
              setState({ text: accumulated, streaming: false, error: json.error });
              return;
            }
            if (json.text !== undefined) {
              accumulated += json.text;
              setState({ text: accumulated, streaming: true, error: null });
            }
          } catch (err) {
            // SSE stream contained a non-JSON `data:` line. Recoverable
            // — we just skip it and keep reading subsequent lines —
            // but log so a malformed upstream becomes visible.
            log.api('ai/complete SSE line parse failed', err, { payload });
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
  }, [cancel]);

  return { ...state, run, cancel, reset };
}
