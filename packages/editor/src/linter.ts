import { type Diagnostic, setDiagnostics } from '@codemirror/lint';

import type { EditorView } from '@codemirror/view';
import type { CompileLogEntry } from '@scribe/compiler-client';

export interface LinterScope {
  /** Path of the file currently shown in the editor. Used to filter entries. */
  readonly filePath: string;
}

function entryToDiagnostic(view: EditorView, entry: CompileLogEntry): Diagnostic | null {
  if (entry.line === undefined) return null;
  const doc = view.state.doc;
  const lineNo = Math.min(Math.max(entry.line, 1), doc.lines);
  const line = doc.line(lineNo);
  return {
    from: line.from,
    to: line.to,
    severity:
      entry.level === 'error'
        ? 'error'
        : entry.level === 'warning'
          ? 'warning'
          : 'info',
    message: entry.message,
    source: 'tectonic',
  };
}

function matchesFile(entry: CompileLogEntry, scope: LinterScope): boolean {
  if (entry.file === undefined) return true;
  const path = scope.filePath.replace(/^\.\//, '');
  const entryPath = entry.file.replace(/^\.\//, '');
  return entryPath === path || entryPath.endsWith(`/${path}`) || path.endsWith(`/${entryPath}`);
}

/**
 * Apply compile-log entries as diagnostics for the file currently open in
 * the editor. Call this whenever a new compile finishes.
 */
export function applyCompileDiagnostics(
  view: EditorView,
  entries: readonly CompileLogEntry[],
  scope: LinterScope,
): void {
  const diagnostics: Diagnostic[] = [];
  for (const entry of entries) {
    if (!matchesFile(entry, scope)) continue;
    const diag = entryToDiagnostic(view, entry);
    if (diag !== null) diagnostics.push(diag);
  }
  view.dispatch(setDiagnostics(view.state, diagnostics));
}
