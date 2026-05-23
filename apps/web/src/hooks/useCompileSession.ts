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

  const refreshArtifactUrls = useCallback(async (jobId: CompileJobId) => {
    try {
      const [pdf, synctex] = await Promise.allSettled([
        api.compiles.artifactUrl(jobId, 'pdf'),
        api.compiles.artifactUrl(jobId, 'synctex'),
      ]);
      setState((s) => ({
        ...s,
        pdfUrl: pdf.status === 'fulfilled' ? pdf.value.url : s.pdfUrl,
        synctexUrl: synctex.status === 'fulfilled' ? synctex.value.url : null,
      }));
      if (pdf.status === 'rejected') {
        log.compile.warn('artifact-url fetch failed (pdf)', pdf.reason);
      }
      if (synctex.status === 'rejected') {
        // Synctex is uploaded in the background after the PDF lands, so
        // for a short window after compile-completion the artifact-url
        // route legitimately 404s. Demote the noise; only warn on
        // unexpected statuses.
        const reason = synctex.reason as unknown;
        const isExpected404 =
          reason instanceof ApiError && reason.status === 404;
        if (isExpected404) {
          // Retry once after the typical upload window; if it still
          // fails we'll fall through silently — synctex is non-critical.
          window.setTimeout(() => {
            void api.compiles
              .artifactUrl(jobId, 'synctex')
              .then((res) => { setState((s) => ({ ...s, synctexUrl: res.url })); })
              .catch(() => { /* still not ready; ignore */ });
          }, 750);
        } else {
          log.compile.warn('artifact-url fetch failed (synctex)', reason);
        }
      }
    } catch (err) {
      // Best-effort path — both fetches errored before Promise.allSettled
      // resolved. That's a programming error (allSettled itself doesn't
      // reject) but log it so we'd notice if it ever happens.
      log.compile.error('refreshArtifactUrls unexpected throw', err);
    }
  }, []);

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
