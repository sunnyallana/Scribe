// Adapter for the Rust-side compile pipeline exposed by the Tauri
// shell. Mirrors the call shape of `api.compiles.*` so the editor's
// existing flow can branch on `isTauri()` and pick this adapter
// without the rest of the code knowing where compiles actually run.

import { invoke, listen } from './tauri';

export type DesktopEngine = 'tectonic' | 'latexmk' | 'pdflatex' | 'xelatex' | 'lualatex';

export type DesktopCompileStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'timedout';

export interface DesktopCompileRequest {
  readonly workdir: string;
  readonly mainFile: string;
  readonly engine?: DesktopEngine;
  readonly timeoutSecs?: number;
}

interface CompileRequestPayload {
  workdir: string;
  main_file: string;
  engine: DesktopEngine | null;
  timeout_secs: number;
}

export interface DesktopCompileJobInfo {
  readonly jobId: string;
  readonly engine: DesktopEngine;
  readonly startedAt: string;
}

export interface DesktopCompileLogEvent {
  readonly jobId: string;
  readonly line: string;
  readonly stream: 'stdout' | 'stderr';
}

export interface DesktopCompileStatusEvent {
  readonly jobId: string;
  readonly status: DesktopCompileStatus;
}

export interface DesktopCompileCompletedEvent {
  readonly jobId: string;
  readonly status: DesktopCompileStatus;
  readonly exitCode: number;
  readonly durationMs: number;
}

export async function startDesktopCompile(
  req: DesktopCompileRequest,
): Promise<DesktopCompileJobInfo> {
  const payload: CompileRequestPayload = {
    workdir: req.workdir,
    main_file: req.mainFile,
    engine: req.engine ?? null,
    timeout_secs: req.timeoutSecs ?? 120,
  };
  return invoke<DesktopCompileJobInfo>('start_compile', { req: payload });
}

export async function cancelDesktopCompile(jobId: string): Promise<void> {
  await invoke('cancel_compile', { jobId });
}

export function onDesktopCompileLog(
  handler: (e: DesktopCompileLogEvent) => void,
): Promise<() => void> {
  return listen<DesktopCompileLogEvent>('compile:log', handler);
}

export function onDesktopCompileStatus(
  handler: (e: DesktopCompileStatusEvent) => void,
): Promise<() => void> {
  return listen<DesktopCompileStatusEvent>('compile:status', handler);
}

export function onDesktopCompileCompleted(
  handler: (e: DesktopCompileCompletedEvent) => void,
): Promise<() => void> {
  return listen<DesktopCompileCompletedEvent>('compile:completed', handler);
}

// ---- Workdir + PDF helpers -------------------------------------------------

export interface DesktopWorkdirInfo {
  readonly workdir: string;
  readonly filesWritten: number;
}

/**
 * Materialise the SQLite-mirrored project files into a real on-disk
 * directory the local LaTeX engine can read from.
 *
 * `overrides` — `path` → text body. Used for the project's `.tex` /
 *   `.bib` / `.sty` content so the editor can swap the in-memory
 *   buffer for the synced version mid-edit.
 * `binaryOverrides` — `path` → base64-encoded bytes. Used for images
 *   and any other binary asset `\includegraphics` references.
 */
export async function prepareDesktopWorkdir(
  projectId: string,
  overrides?: Readonly<Record<string, string>>,
  binaryOverrides?: Readonly<Record<string, string>>,
): Promise<DesktopWorkdirInfo> {
  return invoke<DesktopWorkdirInfo>('compile_prepare_workdir', {
    projectId,
    overrides: overrides ?? null,
    binaryOverrides: binaryOverrides ?? null,
  });
}

/**
 * Read the emitted PDF as base64. Pair with a `data:application/pdf;base64,`
 * prefix and hand the result to pdf.js. Throws if the PDF is missing
 * (compile failed before the writer ran).
 */
export async function readDesktopPdfBase64(workdir: string, mainFile: string): Promise<string> {
  return invoke<string>('compile_read_pdf_base64', { workdir, mainFile });
}

/**
 * Try to restore the last-compiled PDF for a project from disk.
 * Returns null when no prior compile artifact exists (fresh project
 * mount, or one that's only ever been compiled on the server). Used
 * on `useCompileSession` mount to seed `state.pdfUrl` so the preview
 * panel doesn't blank between sessions.
 */
export async function loadExistingDesktopPdf(
  projectId: string,
  mainFile?: string,
): Promise<string | null> {
  return invoke<string | null>('compile_load_existing_pdf', {
    projectId,
    mainFile: mainFile ?? null,
  });
}

/**
 * Read the `.synctex.gz` emitted by the local LaTeX engine as base64.
 * Returns null if no synctex artifact exists yet (compile failed
 * before the engine wrote one). The caller wraps the bytes in a
 * `data:application/gzip;base64,` URL and feeds it to the existing
 * `useSyncTeX` hook, which already knows how to gunzip + parse the
 * server-fetched form.
 */
export async function loadDesktopSynctex(
  workdir: string,
  mainFile: string,
): Promise<string | null> {
  return invoke<string | null>('compile_load_synctex', { workdir, mainFile });
}
