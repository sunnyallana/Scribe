import {
  type CompileJob,
  type CompileJobId,
  type CompileJobStatus,
  type CompileLogEntryDTO,
  type CompileLogLevel,
  type CompilerEngine,
  compileLogStreamMessageSchema,
  type ProjectId,
} from '@scribe/shared';
import { useCallback, useEffect, useRef, useState } from 'react';

import { api, ApiError } from '../lib/api';
import { log } from '../lib/debug';
import {
  type DesktopCompileCompletedEvent,
  type DesktopCompileLogEvent,
  type DesktopCompileStatus,
  type DesktopCompileStatusEvent,
  loadDesktopSynctex,
  loadExistingDesktopPdf,
  onDesktopCompileCompleted,
  onDesktopCompileLog,
  onDesktopCompileStatus,
  prepareDesktopWorkdir,
  readDesktopPdfBase64,
  startDesktopCompile,
} from '../lib/desktopCompile';
import { supabase, wsOrigin } from '../lib/supabase';
import { isTauri } from '../lib/tauri';

// ── Pure helpers (exported for unit tests) ────────────────────────────
// The hook itself is a tangle of WebSocket / Tauri / React state; these
// pieces are the only parts that are pure and worth pinning down with
// direct tests. Exporting them carries no runtime cost — the hook uses
// the same identifier internally.

export function mapDesktopStatus(s: DesktopCompileStatus): CompileJobStatus {
  if (s === 'completed') return 'success';
  if (s === 'failed' || s === 'timedout') return 'error';
  if (s === 'cancelled') return 'cancelled';
  return 'running';
}

export function mapDesktopLog(e: DesktopCompileLogEvent): CompileLogEntryDTO {
  const level: CompileLogLevel = e.stream === 'stderr' ? 'warning' : 'info';
  return { level, message: e.line, raw: e.line };
}

export function isPlainTextSource(path: string): boolean {
  // Two extensions known to be user-authored UTF-8. Everything else
  // (.sty / .cls / .tikz / .latex / images / pdfs) ships as bytes
  // so non-UTF-8 encodings survive the round-trip. See compile()
  // for the routing.
  const lower = path.toLowerCase();
  return lower.endsWith('.tex') || lower.endsWith('.bib');
}

export function arrayBufferToBase64(buf: ArrayBuffer): string {
  // Chunked to dodge the call-stack limit on large images; the
  // single-shot `String.fromCharCode(...bytes)` form blows up around
  // 64 KiB on most engines.
  const bytes = new Uint8Array(buf);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function desktopEngineToCompilerEngine(e: string): CompilerEngine {
  // The shared `CompilerEngine` enum doesn't include `latexmk` — it's
  // an orchestration name, not a distinct binary. Coerce to `pdflatex`
  // so the synthetic CompileJob conforms; the engine field is purely
  // cosmetic in the UI.
  if (e === 'pdflatex' || e === 'xelatex' || e === 'lualatex' || e === 'tectonic') return e;
  return 'pdflatex';
}

export interface CompileSessionState {
  readonly status: CompileJobStatus | 'idle';
  readonly job: CompileJob | null;
  readonly entries: readonly CompileLogEntryDTO[];
  readonly pdfUrl: string | null;
  readonly synctexUrl: string | null;
  readonly errorMessage: string | null;
  readonly compiling: boolean;
  readonly compile: (
    mainFile?: string,
    overrides?: Readonly<Record<string, string>>,
  ) => Promise<void>;
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
  //
  // Skipped in Tauri mode: we don't persist compile history locally
  // yet, so there's nothing to restore. The user gets the empty
  // state until they hit Compile.
  useEffect(() => {
    if (projectId === null) {
      setState(INITIAL);
      return;
    }
    if (isTauri()) {
      setState(INITIAL);
      // Best-effort restore: if the workdir from a prior session
      // still has a PDF on disk, surface it as `state.pdfUrl` so the
      // preview panel doesn't flash empty before the next compile.
      let cancelled = false;
      void (async () => {
        try {
          const b64 = await loadExistingDesktopPdf(projectId);
          if (cancelled || b64 === null) return;
          setState((s) => ({
            ...s,
            pdfUrl: `data:application/pdf;base64,${b64}`,
          }));
        } catch (err) {
          log.compile.warn('failed to restore last compile pdf', err);
        }
      })();
      return () => {
        cancelled = true;
      };
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
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // Desktop event-subscription cleanup. Each compile registers three
  // listeners (log / status / completed); we keep their unlisten
  // callbacks in a ref so the next compile (or unmount) can drop the
  // previous round before installing fresh ones.
  const desktopUnlistenersRef = useRef<readonly (() => void)[]>([]);
  const cleanupDesktopListeners = useCallback(() => {
    for (const u of desktopUnlistenersRef.current) {
      try {
        u();
      } catch (err) {
        log.compile.warn('failed to unsubscribe desktop compile listener', err);
      }
    }
    desktopUnlistenersRef.current = [];
  }, []);
  useEffect(() => cleanupDesktopListeners, [cleanupDesktopListeners]);

  // Forward-ref so the bootstrap effect above can call the
  // memoised `refreshArtifactUrls` without listing it as a dep
  // (its identity depends on `setState`, which would loop).
  const refreshArtifactUrlsRef = useRef<(jobId: CompileJobId) => Promise<void>>(async () => {
    /* set below */
  });

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
            .then((res) => {
              setState((s) => ({ ...s, synctexUrl: res.url }));
            })
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
      const url = `${wsOrigin()}/api/compiles/${jobId}/stream?token=${encodeURIComponent(token)}`;
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
              // Stamp the final duration onto `state.job` so the
              // log panel's `(2.34s)` indicator updates immediately.
              // Without this the WS told us we're done but the job
              // row stayed frozen at its enqueue-time `durationMs:
              // null` until a manual refetch — i.e. the timing
              // never showed in the UI.
              job:
                s.job !== null
                  ? { ...s.job, status: msg.status, durationMs: msg.durationMs }
                  : s.job,
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
    async (mainFile?: string, editorOverrides?: Readonly<Record<string, string>>) => {
      if (projectId === null) return;
      setState({
        ...INITIAL,
        status: 'queued',
      });
      if (isTauri()) {
        cleanupDesktopListeners();
        try {
          // Pull current file content from the server and hand it
          // directly to the Rust workdir-prep.
          //
          // Routing rule: `.tex` / `.bib` go through
          // `api.files.readContent` which returns the body as a JS
          // string (the editor surfaces these as text buffers). Every
          // other extension — `.sty`, `.cls`, `.tikz`, `.latex`,
          // images, PDFs, EPS — goes through a signed download URL +
          // fetch → ArrayBuffer → base64 so the on-disk bytes match
          // what Storage holds. JS-string round-trips through UTF-16
          // mojibake any non-UTF-8 byte (the canonical example being
          // Latin-1 `.sty` files lifted from old templates); going
          // binary preserves them exactly.
          const files = await api.files.list(projectId);
          const overrides: Record<string, string> = {};
          const binaryOverrides: Record<string, string> = {};
          await Promise.all(
            files.map(async (f) => {
              try {
                if (isPlainTextSource(f.path)) {
                  const { content } = await api.files.readContent(projectId, f.id);
                  overrides[f.path] = content;
                } else {
                  const { url } = await api.files.downloadUrl(projectId, f.id);
                  const res = await fetch(url);
                  if (!res.ok) {
                    throw new Error(`download ${res.status.toString()}`);
                  }
                  const buf = await res.arrayBuffer();
                  binaryOverrides[f.path] = arrayBufferToBase64(buf);
                }
              } catch (err) {
                log.compile.warn('failed to fetch file for compile', {
                  path: f.path,
                  type: f.type,
                  err,
                });
              }
            }),
          );
          // Editor-buffer overlay wins over server-fetched content.
          // Lets a user hit Compile mid-edit without waiting on the
          // autosave round-trip to land on the server.
          if (editorOverrides !== undefined) {
            for (const [path, body] of Object.entries(editorOverrides)) {
              overrides[path] = body;
            }
          }
          const prep = await prepareDesktopWorkdir(projectId, overrides, binaryOverrides);
          if (prep.filesWritten === 0) {
            throw new Error(
              'no project files materialised — the project may be empty or every fetch failed',
            );
          }
          const { workdir } = prep;
          const resolvedMain = mainFile ?? 'main.tex';
          const info = await startDesktopCompile({
            workdir,
            mainFile: resolvedMain,
          });
          const syntheticJob: CompileJob = {
            id: info.jobId as CompileJobId,
            projectId,
            triggeredBy: null,
            status: 'running',
            engine: desktopEngineToCompilerEngine(info.engine),
            mainFile: resolvedMain,
            exitCode: null,
            pdfKey: null,
            logKey: null,
            synctexKey: null,
            errorMessage: null,
            durationMs: null,
            enqueuedAt: info.startedAt,
            startedAt: info.startedAt,
            completedAt: null,
          };
          setState((s) => ({ ...s, job: syntheticJob, status: 'running' }));

          const unlistenLog = await onDesktopCompileLog((e: DesktopCompileLogEvent) => {
            if (e.jobId !== info.jobId) return;
            setState((s) => ({ ...s, entries: [...s.entries, mapDesktopLog(e)] }));
          });
          const unlistenStatus = await onDesktopCompileStatus((e: DesktopCompileStatusEvent) => {
            if (e.jobId !== info.jobId) return;
            setState((s) => ({ ...s, status: mapDesktopStatus(e.status) }));
          });
          const unlistenDone = await onDesktopCompileCompleted(
            (e: DesktopCompileCompletedEvent) => {
              if (e.jobId !== info.jobId) return;
              const finalStatus = mapDesktopStatus(e.status);
              if (e.status === 'completed') {
                // Load the PDF + SyncTeX asynchronously; let state
                // finalize first so the log panel shows "success"
                // without waiting on base64 transfer over the bridge.
                void (async () => {
                  try {
                    const b64 = await readDesktopPdfBase64(workdir, resolvedMain);
                    setState((s) => ({
                      ...s,
                      pdfUrl: `data:application/pdf;base64,${b64}`,
                    }));
                  } catch (err) {
                    log.compile.warn('failed to read desktop pdf', err);
                  }
                })();
                void (async () => {
                  try {
                    const synctexB64 = await loadDesktopSynctex(workdir, resolvedMain);
                    if (synctexB64 !== null) {
                      setState((s) => ({
                        ...s,
                        synctexUrl: `data:application/gzip;base64,${synctexB64}`,
                      }));
                    }
                  } catch (err) {
                    log.compile.warn('failed to read desktop synctex', err);
                  }
                })();
              }
              setState((s) => ({
                ...s,
                status: finalStatus,
                errorMessage:
                  e.status === 'failed' || e.status === 'timedout'
                    ? `compile ${e.status} (exit ${e.exitCode.toString()})`
                    : s.errorMessage,
                job:
                  s.job !== null
                    ? {
                        ...s.job,
                        status: finalStatus,
                        durationMs: e.durationMs,
                        exitCode: e.exitCode,
                        completedAt: new Date().toISOString(),
                      }
                    : s.job,
              }));
              cleanupDesktopListeners();
            },
          );
          desktopUnlistenersRef.current = [unlistenLog, unlistenStatus, unlistenDone];
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Desktop compile failed';
          setState((s) => ({ ...s, status: 'error', errorMessage: msg }));
          cleanupDesktopListeners();
        }
        return;
      }
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
    [projectId, openStream, cleanupDesktopListeners],
  );

  return {
    ...state,
    compiling: state.status === 'queued' || state.status === 'running',
    compile,
  };
}
