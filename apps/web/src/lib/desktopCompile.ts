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
  await invoke<void>('cancel_compile', { jobId });
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
