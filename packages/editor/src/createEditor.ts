import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, foldGutter, foldKeymap, indentOnInput } from '@codemirror/language';
import { lintGutter, lintKeymap } from '@codemirror/lint';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from '@codemirror/view';
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';

import { type AutocompleteSources, createLatexAutocomplete, extractLabels } from './autocomplete.js';
import { autoCloseEnv } from './extensions/auto-close-env.js';
import { ruler } from './extensions/ruler.js';
import { wordCountExtension } from './extensions/word-count.js';
import { latexLanguageSupport } from './latex-language.js';
import { latexTheme, type ScribeEditorTheme } from './theme.js';

import type { Awareness } from 'y-protocols/awareness';
import type { Text as YText } from 'yjs';

export interface ScribeEditorCollab {
  readonly yText: YText;
  readonly awareness: Awareness;
}

export interface ScribeEditorOptions {
  readonly parent: HTMLElement;
  readonly initialContent: string;
  readonly filePath: string;
  readonly theme?: ScribeEditorTheme;
  readonly readOnly?: boolean;
  readonly autocomplete?: AutocompleteSources;
  /** Show a vertical ruler at this column. 0 disables. */
  readonly rulerColumn?: number;
  readonly onChange?: (content: string) => void;
  readonly onCompileRequest?: () => void;
  readonly onSaveRequest?: () => void;
  /** Fires when the cursor moves. Useful for forward SyncTeX integration. */
  readonly onCursor?: (line: number, column: number) => void;
  /** Optional extra extensions appended after the defaults. */
  readonly extraExtensions?: readonly Extension[];
  /**
   * When provided, the editor binds to the Y.Text via y-codemirror.next.
   * The Y.Text becomes the source of truth — initialContent is ignored if
   * the Y.Text already has content (collab session was already started by
   * another peer).
   */
  readonly collab?: ScribeEditorCollab;
}

export interface ScribeEditorHandle {
  readonly view: EditorView;
  destroy(): void;
  setContent(text: string): void;
  getContent(): string;
  setReadOnly(readOnly: boolean): void;
  /** Refresh the autocomplete sources without rebuilding the editor. */
  setAutocompleteSources(sources: AutocompleteSources): void;
  /** Move the cursor to the given 1-based line. */
  gotoLine(line: number): void;
  /** Replace the current selection (or insert at cursor if empty). */
  insertAtCursor(text: string): void;
  /** Return the currently selected text (empty string if no selection). */
  getSelection(): string;
  /** Extract labels from the current document. */
  labels(): string[];
}

const DEFAULT_RULER = 80;

export function createScribeEditor(opts: ScribeEditorOptions): ScribeEditorHandle {
  const theme = opts.theme ?? 'light';
  const readOnly = opts.readOnly === true;
  const rulerColumn = opts.rulerColumn ?? DEFAULT_RULER;

  // Mutable autocomplete sources so we can swap them via setAutocompleteSources()
  // without tearing down the editor state.
  let autocompleteSources: AutocompleteSources = opts.autocomplete ?? { labels: [], citations: [] };

  const autocompleteCompartment = new Compartment();
  const readOnlyCompartment = new Compartment();

  const changeListener = EditorView.updateListener.of((update) => {
    if (update.docChanged && opts.onChange !== undefined) {
      opts.onChange(update.state.doc.toString());
    }
    if (update.selectionSet && opts.onCursor !== undefined) {
      const head = update.state.selection.main.head;
      const lineInfo = update.state.doc.lineAt(head);
      opts.onCursor(lineInfo.number, head - lineInfo.from + 1);
    }
  });

  const compileKeymap = keymap.of([
    {
      key: 'Mod-Enter',
      preventDefault: true,
      run: () => {
        opts.onCompileRequest?.();
        return true;
      },
    },
    {
      key: 'Mod-s',
      preventDefault: true,
      run: () => {
        opts.onSaveRequest?.();
        return true;
      },
    },
  ]);

  const extensions: Extension[] = [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    foldGutter(),
    drawSelection(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    bracketMatching(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    rectangularSelection(),
    keymap.of([
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      ...foldKeymap,
      ...lintKeymap,
      indentWithTab,
    ]),
    compileKeymap,
    latexLanguageSupport(),
    autocompleteCompartment.of(createLatexAutocomplete(autocompleteSources)),
    autoCloseEnv(),
    wordCountExtension(),
    lintGutter(),
    latexTheme(theme),
    readOnlyCompartment.of(EditorState.readOnly.of(readOnly)),
    changeListener,
  ];

  if (opts.collab !== undefined) {
    extensions.push(yCollab(opts.collab.yText, opts.collab.awareness));
    extensions.push(keymap.of(yUndoManagerKeymap));
  }

  if (rulerColumn > 0) {
    extensions.push(ruler({ column: rulerColumn }));
  }

  if (opts.extraExtensions !== undefined) {
    extensions.push(...opts.extraExtensions);
  }

  // With a Y.Text binding, y-codemirror.next replaces the document with
  // the Y.Text contents on attach. We pass an empty initial doc to avoid
  // the initial content being inserted into Yjs as a "user edit".
  const initialDoc = opts.collab !== undefined ? '' : opts.initialContent;

  const state = EditorState.create({
    doc: initialDoc,
    extensions,
  });

  const view = new EditorView({ state, parent: opts.parent });

  return {
    view,
    destroy() {
      view.destroy();
    },
    getContent() {
      return view.state.doc.toString();
    },
    setContent(text) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
      });
    },
    setReadOnly(next) {
      view.dispatch({
        effects: readOnlyCompartment.reconfigure(EditorState.readOnly.of(next)),
      });
    },
    setAutocompleteSources(next) {
      autocompleteSources = next;
      view.dispatch({
        effects: autocompleteCompartment.reconfigure(createLatexAutocomplete(autocompleteSources)),
      });
    },
    gotoLine(line) {
      const safeLine = Math.min(Math.max(line, 1), view.state.doc.lines);
      const lineInfo = view.state.doc.line(safeLine);
      view.dispatch({
        selection: { anchor: lineInfo.from },
        scrollIntoView: true,
        effects: EditorView.scrollIntoView(lineInfo.from, { y: 'center' }),
      });
      view.focus();
    },
    insertAtCursor(text) {
      const range = view.state.selection.main;
      view.dispatch({
        changes: { from: range.from, to: range.to, insert: text },
        selection: { anchor: range.from + text.length },
        scrollIntoView: true,
      });
      view.focus();
    },
    getSelection() {
      const range = view.state.selection.main;
      return view.state.sliceDoc(range.from, range.to);
    },
    labels() {
      return extractLabels(view.state.doc.toString());
    },
  };
}

