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
  // chktex emits a column; tectonic / latexmk don't. When we have
  // one, narrow the underline to that token instead of underlining
  // the whole line — much less visually noisy in a paragraph of prose.
  let from = line.from;
  let to = line.to;
  if (entry.column !== undefined && entry.column > 0) {
    const colOffset = Math.min(entry.column - 1, line.length);
    from = line.from + colOffset;
    // Extend to the end of the current word (or 1 char if at EOL).
    // Good-enough heuristic since chktex doesn't tell us match length.
    const tail = line.text.slice(colOffset);
    const wordMatch = /^\S+/.exec(tail);
    to = wordMatch !== null ? from + wordMatch[0].length : Math.min(from + 1, line.to);
  }
  // Source string drives the small "chktex" / "tectonic" label
  // shown in the diagnostic tooltip. We tell them apart by the
  // [chktex N] prefix the server appends in chktex.rs.
  const isChktex = entry.message.startsWith('[chktex');
  return {
    from,
    to,
    severity: entry.level === 'error' ? 'error' : entry.level === 'warning' ? 'warning' : 'info',
    message: entry.message,
    source: isChktex ? 'chktex' : 'tectonic',
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
