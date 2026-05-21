import { EditorView } from '@codemirror/view';

import type { Extension } from '@codemirror/state';

const ENV_REGEX = /\\begin\{([a-zA-Z*]+)\}$/;

/**
 * When the user types `\begin{env}` and presses Enter, auto-insert the
 * matching `\end{env}` below the cursor, leaving the caret on a blank
 * indented line in between.
 */
export function autoCloseEnv(): Extension {
  return EditorView.updateListener.of((update) => {
    if (!update.docChanged) return;

    update.transactions.forEach((tr) => {
      if (!tr.isUserEvent('input.type') && !tr.isUserEvent('input.complete')) return;

      tr.changes.iterChanges((_fromA, _toA, _fromB, toB, inserted) => {
        const text = inserted.toString();
        if (text !== '\n') return;

        const cursorPos = toB;
        const line = update.state.doc.lineAt(cursorPos - 1);
        const before = line.text;
        const match = ENV_REGEX.exec(before);
        if (match?.[1] === undefined) return;

        const envName = match[1];
        const indent = /^\s*/.exec(before)?.[0] ?? '';
        const insertion = `${indent}\t\n${indent}\\end{${envName}}`;

        queueMicrotask(() => {
          update.view.dispatch({
            changes: { from: cursorPos, to: cursorPos, insert: insertion },
            selection: { anchor: cursorPos + indent.length + 1 },
          });
        });
      });
    });
  });
}
