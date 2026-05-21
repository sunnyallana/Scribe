import { lookupForward, parseSyncTeX, type SyncTeXIndex, type SyncTeXPosition } from '@scribe/compiler-client';
import { useEffect, useRef, useState } from 'react';

interface SyncTeXState {
  readonly index: SyncTeXIndex | null;
  readonly error: string | null;
  readonly loading: boolean;
}

async function decompressGzip(blob: Blob): Promise<string> {
  // DecompressionStream is supported in evergreen browsers.
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('Browser lacks DecompressionStream — SyncTeX disabled.');
  }
  const ds = new DecompressionStream('gzip');
  const decompressed = blob.stream().pipeThrough(ds);
  const text = await new Response(decompressed).text();
  return text;
}

/**
 * Fetches and parses the .synctex.gz artifact for the latest compile job.
 * Re-parses whenever the URL changes (one URL per job).
 */
export function useSyncTeX(synctexUrl: string | null): SyncTeXState {
  const [state, setState] = useState<SyncTeXState>({ index: null, error: null, loading: false });
  const lastUrlRef = useRef<string | null>(null);

  useEffect(() => {
    if (synctexUrl === null) {
      lastUrlRef.current = null;
      setState({ index: null, error: null, loading: false });
      return;
    }
    if (lastUrlRef.current === synctexUrl) return;
    lastUrlRef.current = synctexUrl;

    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null }));
    void (async () => {
      try {
        const response = await fetch(synctexUrl);
        if (!response.ok) throw new Error(`SyncTeX fetch failed: ${response.status.toString()}`);
        const blob = await response.blob();
        const text = await decompressGzip(blob);
        const index = parseSyncTeX(text);
        if (cancelled) return;
        setState({ index, error: null, loading: false });
      } catch (err) {
        if (!cancelled) {
          setState({
            index: null,
            error: err instanceof Error ? err.message : 'unknown error',
            loading: false,
          });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [synctexUrl]);

  return state;
}

export function lookup(
  index: SyncTeXIndex | null,
  filename: string,
  line: number,
): SyncTeXPosition | null {
  if (index === null) return null;
  return lookupForward(index, filename, line);
}
