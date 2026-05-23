import {
  type CompileJob,
  type CompileJobId,
  type CompileJobStatus,
  type CompileLogEntryDTO,
  compileLogStreamMessageSchema,
  type ProjectId,
} from '@scribe/shared';
import { useCallback, useEffect, useRef, useState } from 'react';

import { api, ApiError } from '../lib/api';
import { log } from '../lib/debug';
import { API_URL, supabase } from '../lib/supabase';

export interface CompileSessionState {
  readonly status: CompileJobStatus | 'idle';
  readonly job: CompileJob | null;
  readonly entries: readonly CompileLogEntryDTO[];
  readonly pdfUrl: string | null;
  readonly synctexUrl: string | null;
  readonly errorMessage: string | null;
  readonly compiling: boolean;
  readonly compile: (mainFile?: string) => Promise<void>;
}

interface InternalState {
  status: CompileJobStatus | 'idle';
  job: CompileJob | null;
  entries: CompileLogEntryDTO[];
  pdfUrl: string | null;
  synctexUrl: string | null;
  errorMessage: string | null;
}

const INITIAL: InternalState = {
  status: 'idle',
  job: null,
  entries: [],
  pdfUrl: null,
  synctexUrl: null,
  errorMessage: null,
};

function wsUrlFromApi(apiUrl: string): string {
  const u = new URL(apiUrl);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  return u.toString().replace(/\/$/, '');
}

export function useCompileSession(projectId: ProjectId | null): CompileSessionState {
  const [state, setState] = useState<InternalState>(INITIAL);
  const socketRef = useRef<WebSocket | null>(null);

  const cleanupSocket = useCallback(() => {
    if (socketRef.current !== null) {
      socketRef.current.close();
      socketRef.current = null;
    }
  }, []);

  useEffect(() => cleanupSocket, [cleanupSocket]);

  // On project mount, recover the LAST compile so the user comes
  // back to a populated PDF + log instead of an empty "no compile
  // yet" pane. We pull the most recent job from the server, seed
  // the state from its row (status, entries, error_message), then
  // resolve the artifact URLs — all of that is cheap (one list
  // call + one signed-URL call). If the most recent job is still
  // in-flight, we just hold the snapshot we have; the user can
  // recompile to take over the stream.
  useEffect(() => {
    if (projectId === null) {
      setState(INITIAL);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const jobs = await api.compiles.list(projectId);
        if (cancelled || jobs.length === 0) return;
        const latest = jobs[0];
        if (latest === undefined) return;
        setState((s) => ({
          ...s,
          job: latest,
          status: latest.status,
          entries: latest.entries ?? [],
          errorMessage: latest.errorMessage ?? null,
        }));
        // Only ask for artifact URLs when the job actually
        // produced one (a failed compile leaves pdf_key null,
        // so no signing call is necessary or useful).
        if (latest.pdfKey !== null) {
          void refreshArtifactUrlsRef.current(latest.id);
        }
      } catch (err) {
        log.compile.warn('failed to restore last compile', err);
      }
    })();
    return () => { cancelled = true; };
  }, [projectId]);

  // Forward-ref so the bootstrap effect above can call the
  // memoised `refreshArtifactUrls` without listing it as a dep
  // (its identity depends on `setState`, which would loop).
  const refreshArtifactUrlsRef = useRef<(jobId: CompileJobId) => Promise<void>>(
    async () => { /* set below */ },
  );

  const refreshArtifactUrls = useCallback(async (jobId: CompileJobId) => {
    try {
      // PDF is on the critical path of the worker — it's uploaded
      // synchronously, so by the time we see `Completed` the signed
      // URL is definitely available.
      const pdfResult = await api.compiles
        .artifactUrl(jobId, 'pdf')
        .then((res) => ({ ok: true as const, url: res.url }))
        .catch((err: unknown) => ({ ok: false as const, err }));
      if (pdfResult.ok) {
        setState((s) => ({ ...s, pdfUrl: pdfResult.url }));
      } else {
        log.compile.warn('artifact-url fetch failed (pdf)', pdfResult.err);
      }

      // Synctex is in a background tokio task — it lands a few
      // hundred ms after the PDF. Wait a short beat before the first
      // fetch so the bg upload finishes first: that turns "404 +
      // retry-after-750ms" into "one successful 200" in the common
      // case, removing the red "Failed to load resource" line from
      // the browser console.
      const trySynctex = (delay: number) => {
        window.setTimeout(() => {
          void api.compiles
            .artifactUrl(jobId, 'synctex')
            .then((res) => { setState((s) => ({ ...s, synctexUrl: res.url })); })
            .catch((err: unknown) => {
              if (err instanceof ApiError && err.status === 404) {
                // Still racing; retry once more, then give up
                // silently (synctex is non-critical).
                if (delay < 1500) {
                  trySynctex(delay * 2);
                }
              } else {
                log.compile.warn('artifact-url fetch failed (synctex)', err);
              }
            });
        }, delay);
      };
      trySynctex(600);
    } catch (err) {
      // Belt-and-braces — both inner fetches already swallow their
      // own errors, so this branch is only hit by a programming
      // error. Log loudly so we'd notice.
      log.compile.error('refreshArtifactUrls unexpected throw', err);
    }
  }, []);
  // Keep the ref aligned with the latest `refreshArtifactUrls`
  // identity so the bootstrap effect can call it without the
  // closure going stale.
  refreshArtifactUrlsRef.current = refreshArtifactUrls;

  const openStream = useCallback(
    async (jobId: CompileJobId) => {
      cleanupSocket();
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (token === undefined) return;
      const url = `${wsUrlFromApi(API_URL)}/api/compiles/${jobId}/stream?token=${encodeURIComponent(token)}`;
      const ws = new WebSocket(url);
      socketRef.current = ws;
      ws.onmessage = (event) => {
        try {
          const parsed = compileLogStreamMessageSchema.safeParse(JSON.parse(event.data as string));
          if (!parsed.success) return;
          const msg = parsed.data;
          if (msg.type === 'status') {
            setState((s) => ({ ...s, status: msg.status }));
          } else if (msg.type === 'log') {
            setState((s) => ({ ...s, entries: [...s.entries, msg.entry] }));
          } else if (msg.type === 'completed') {
            setState((s) => ({
              ...s,
              status: msg.status,
              errorMessage: msg.errorMessage,
            }));
            if (msg.pdfKey !== null) {
              void refreshArtifactUrls(jobId);
            }
          }
        } catch (err) {
          // Malformed JSON from the WS shouldn't happen if the server
          // and client are on the same protocol version. Log so we'd
          // catch a schema drift early.
          log.compile.warn('compile-stream WS message parse failed', err);
        }
      };
      ws.onerror = () => {
        setState((s) => ({ ...s, errorMessage: 'WebSocket error' }));
      };
      ws.onclose = () => {
        socketRef.current = null;
      };
    },
    [cleanupSocket, refreshArtifactUrls],
  );

  const compile = useCallback(
    async (mainFile?: string) => {
      if (projectId === null) return;
      setState({
        ...INITIAL,
        status: 'queued',
      });
      try {
        const job = await api.compiles.enqueue(
          projectId,
          mainFile !== undefined ? { mainFile } : {},
        );
        setState((s) => ({ ...s, job, status: job.status }));
        await openStream(job.id);
      } catch (err) {
        const msg = err instanceof ApiError ? err.body.message : 'Compile failed';
        setState((s) => ({ ...s, status: 'error', errorMessage: msg }));
      }
    },
    [projectId, openStream],
  );

  return {
    ...state,
    compiling: state.status === 'queued' || state.status === 'running',
    compile,
  };
}
