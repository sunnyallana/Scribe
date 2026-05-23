import {
  applyCompileDiagnostics,
  type AutocompleteSources,
  createScribeEditor,
  type ScribeEditorCollab,
  type ScribeEditorHandle,
  type ScribeEditorTheme,
} from '@scribe/editor';
import { useTheme } from '@scribe/ui';
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';

import { log } from '../../lib/debug';

import type { CompileLogEntry } from '@scribe/compiler-client';

export interface LatexEditorImperativeHandle {
  insertAtCursor: (text: string) => void;
  getSelection: () => string;
  /** Snapshot the editor's current view doc as a UTF-8 string. Used by
   *  autosave to avoid relying on possibly-stale React `next` closures. */
  getContent: () => string;
  gotoLine: (line: number, options?: { readonly flash?: boolean }) => void;
  focus: () => void;
}

interface LatexEditorProps {
  readonly filePath: string;
  readonly initialContent: string;
  readonly readOnly?: boolean;
  readonly autocomplete: AutocompleteSources;
  readonly logEntries: readonly CompileLogEntry[];
  readonly onChange: (next: string) => void;
  readonly onCompile: () => void;
  readonly onSave: () => void;
  readonly onCursor?: (line: number, column: number) => void;
  readonly collab?: ScribeEditorCollab | null;
}

function toEditorTheme(resolved: 'light' | 'dark' | 'high-contrast'): ScribeEditorTheme {
  return resolved;
}

export const LatexEditor = forwardRef<LatexEditorImperativeHandle, LatexEditorProps>(
  function LatexEditor(
    {
      filePath,
      initialContent,
      readOnly,
      autocomplete,
      logEntries,
      onChange,
      onCompile,
      onSave,
      onCursor,
      collab,
    },
    ref,
  ) {
    const containerRef = useRef<HTMLDivElement>(null);
    const handleRef = useRef<ScribeEditorHandle | null>(null);
    const { resolvedTheme } = useTheme();

    // Keep the latest callbacks in refs so the editor — which is only
    // rebuilt on `filePath` / `collab` change — can dispatch through
    // them and never invoke a stale closure. Without this, a parent
    // re-render that produced a new `onChange` (e.g. via `useCallback`
    // with a changed dep) would be ignored until the next file
    // switch, with the editor still calling the previous closure.
    const onChangeRef = useRef(onChange);
    const onCompileRef = useRef(onCompile);
    const onSaveRef = useRef(onSave);
    const onCursorRef = useRef(onCursor);
    onChangeRef.current = onChange;
    onCompileRef.current = onCompile;
    onSaveRef.current = onSave;
    onCursorRef.current = onCursor;

    useImperativeHandle(
      ref,
      () => ({
        insertAtCursor: (text) => { handleRef.current?.insertAtCursor(text); },
        getSelection: () => handleRef.current?.getSelection() ?? '',
        getContent: () => handleRef.current?.getContent() ?? '',
        gotoLine: (line, options) => { handleRef.current?.gotoLine(line, options); },
        focus: () => { handleRef.current?.view.focus(); },
      }),
      [],
    );

    // Rebuild the editor when the file or the collab session changes.
    // Watching `collab` (the object identity) — not a derived key — is
    // critical: if the Yjs provider gets swapped (e.g. after a Supabase
    // session refresh, or a transient disconnect that produced a fresh
    // Y.Doc), the new yText/awareness must replace the old binding.
    // Without this the editor stays bound to a Y.Doc nobody's writing
    // to and live updates silently fail to appear.
    useEffect(() => {
      if (containerRef.current === null) return;
      const hasCollab = collab !== null && collab !== undefined;
      log.editor('mount editor', {
        filePath,
        readOnly: readOnly ?? false,
        hasCollab,
        initialBytes: initialContent.length,
      });
      const editor = createScribeEditor({
        parent: containerRef.current,
        initialContent,
        filePath,
        theme: toEditorTheme(resolvedTheme),
        readOnly: readOnly ?? false,
        autocomplete,
        // Dispatch through the refs so the editor always sees the
        // latest closures from the parent, even when the parent
        // re-renders without remounting the editor.
        onChange: (next) => { onChangeRef.current(next); },
        onCompileRequest: () => { onCompileRef.current(); },
        onSaveRequest: () => { onSaveRef.current(); },
        onCursor: (line, column) => { onCursorRef.current?.(line, column); },
        ...(hasCollab ? { collab } : {}),
      });
      handleRef.current = editor;
      return () => {
        log.editor('unmount editor', { filePath });
        editor.destroy();
        handleRef.current = null;
      };
      // initialContent/readOnly/autocomplete/resolvedTheme are
      // intentionally excluded — they're either applied via the
      // separate effects below or only matter at mount time.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [filePath, collab]);

    useEffect(() => {
      handleRef.current?.setAutocompleteSources(autocomplete);
    }, [autocomplete]);

    useEffect(() => {
      handleRef.current?.setReadOnly(readOnly ?? false);
    }, [readOnly]);

    useEffect(() => {
      const handle = handleRef.current;
      if (handle === null) return;
      applyCompileDiagnostics(handle.view, logEntries, { filePath });
    }, [logEntries, filePath]);

    return <div ref={containerRef} className="h-full overflow-hidden" />;
  },
);
