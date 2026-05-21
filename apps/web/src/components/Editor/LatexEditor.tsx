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

import type { CompileLogEntry } from '@scribe/compiler-client';

export interface LatexEditorImperativeHandle {
  insertAtCursor: (text: string) => void;
  getSelection: () => string;
  gotoLine: (line: number) => void;
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

    useImperativeHandle(
      ref,
      () => ({
        insertAtCursor: (text) => { handleRef.current?.insertAtCursor(text); },
        getSelection: () => handleRef.current?.getSelection() ?? '',
        gotoLine: (line) => { handleRef.current?.gotoLine(line); },
        focus: () => { handleRef.current?.view.focus(); },
      }),
      [],
    );

    const collabKey = collab !== null && collab !== undefined ? 'collab' : 'solo';
    useEffect(() => {
      if (containerRef.current === null) return;
      const editor = createScribeEditor({
        parent: containerRef.current,
        initialContent,
        filePath,
        theme: toEditorTheme(resolvedTheme),
        readOnly: readOnly ?? false,
        autocomplete,
        onChange,
        onCompileRequest: onCompile,
        onSaveRequest: onSave,
        ...(onCursor !== undefined ? { onCursor } : {}),
        ...(collab !== null && collab !== undefined ? { collab } : {}),
      });
      handleRef.current = editor;
      return () => {
        editor.destroy();
        handleRef.current = null;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [filePath, collabKey]);

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
