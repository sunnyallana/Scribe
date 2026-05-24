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

import { type AutocompleteSources, createLatexAutocomplete, extractLabels } from './autocomplete.js';
import { autoCloseEnv } from './extensions/auto-close-env.js';
import { flashLineExtension, flashLineOnView } from './extensions/flash-line.js';
import { type HoverPreviewSources, hoverPreview } from './extensions/hover-preview.js';
import { ruler } from './extensions/ruler.js';
import { wordCountExtension } from './extensions/word-count.js';
import { fromYjs, scribeYjsBinding } from './extensions/yjs-binding.js';
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
  /** Sources for hover popovers on `\ref{...}` / `\cite{...}`. The
   *  callbacks are invoked lazily (only when the user hovers), so it's
   *  cheap to pass even on every render. */
  readonly hover?: HoverPreviewSources;
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
   * When provided, the editor binds to the Y.Text via the custom
   * `scribeYjsBinding` extension. Y.Text becomes the source of truth —
   * initialContent is ignored if the Y.Text already has content (collab
   * session was already started by another peer).
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
  /** Refresh the hover-preview lookup callbacks. Lazy — no
   *  reconfigure cost; the next hover picks up the new sources. */
  setHoverSources(sources: HoverPreviewSources): void;
  /** Move the cursor to the given 1-based line. When `flash` is true, briefly
   *  highlight the line so the user can see where the jump landed. */
  gotoLine(line: number, options?: { readonly flash?: boolean }): void;
  /** Replace the current selection (or insert at cursor if empty). */
  insertAtCursor(text: string): void;
  /** Return the currently selected text (empty string if no selection). */
  getSelection(): string;
  /** Return the current selection's start/end as 1-based (line, column).
   *  When there's no selection, `from` and `to` point at the cursor. */
  getSelectionRange(): {
    readonly from: { readonly line: number; readonly column: number };
    readonly to: { readonly line: number; readonly column: number };
    readonly text: string;
  };
  /** Restore an editor selection from 1-based (line, column) pairs and
   *  scroll it into view. Used by jump-to-comment to re-highlight the
   *  exact block the comment was anchored to. Clamps positions to the
   *  current doc so a stale comment from an older edit can't throw. */
  selectRange(
    from: { line: number; column: number },
    to: { line: number; column: number },
    options?: { readonly flash?: boolean },
  ): void;
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
  // Same trick for hover sources — host passes a fresh object on
  // every render, but the extension holds a closure over our `let`
  // so each tooltip invocation reads the latest value.
  let hoverSources: HoverPreviewSources = opts.hover ?? {};

  const autocompleteCompartment = new Compartment();
  const readOnlyCompartment = new Compartment();

  const changeListener = EditorView.updateListener.of((update) => {
    if (update.docChanged && opts.onChange !== undefined) {
      // Skip remote-origin transactions (initial yText snap + every
      // peer keystroke that the binding mirrored into our editor).
      // Those don't represent user intent, so they shouldn't trigger
      // autosave or any other "user-edited" downstream effect —
      // doing otherwise spams the file-write endpoint and gives
      // viewers a stream of 403s.
      const isRemote = update.transactions.some(
        (tr) => tr.annotation(fromYjs) === true,
      );
      if (!isRemote) {
        opts.onChange(update.state.doc.toString());
      }
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
    hoverPreview(() => hoverSources),
    autoCloseEnv(),
    wordCountExtension(),
    flashLineExtension(),
    lintGutter(),
    latexTheme(theme),
    readOnlyCompartment.of(EditorState.readOnly.of(readOnly)),
    changeListener,
  ];

  if (opts.collab !== undefined) {
    // Custom binding — see `extensions/yjs-binding.ts` for the contract
    // (origin tagging + annotation to break echo loops). We dropped
    // `y-codemirror.next` because v0.3.5 was silently failing to mirror
    // CodeMirror transactions back into Y.Text in this stack.
    extensions.push(
      scribeYjsBinding({
        yText: opts.collab.yText,
        awareness: opts.collab.awareness,
        filePath: opts.filePath,
      }),
    );
  }

  if (rulerColumn > 0) {
    extensions.push(ruler({ column: rulerColumn }));
  }

  if (opts.extraExtensions !== undefined) {
    extensions.push(...opts.extraExtensions);
  }

  // With a Y.Text binding, `scribeYjsBinding` snaps the editor doc to
  // the Y.Text contents on attach. We pass an empty initial doc so the
  // ProjectWorkspace's stale `initialContent` prop doesn't get pushed
  // into Y.Text as a phantom "user edit" before the snap.
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
    setHoverSources(next) {
      // Hover providers read through the `() => hoverSources` closure
      // on every popup, so no editor reconfigure is needed — we just
      // swap the value and the next hover picks it up.
      hoverSources = next;
    },
    gotoLine(line, options) {
      const safeLine = Math.min(Math.max(line, 1), view.state.doc.lines);
      const lineInfo = view.state.doc.line(safeLine);
      view.dispatch({
        selection: { anchor: lineInfo.from },
        scrollIntoView: true,
        effects: EditorView.scrollIntoView(lineInfo.from, { y: 'center' }),
      });
      view.focus();
      if (options?.flash === true) {
        flashLineOnView(view, safeLine);
      }
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
    getSelectionRange() {
      const range = view.state.selection.main;
      const doc = view.state.doc;
      const fromLine = doc.lineAt(range.from);
      const toLine = doc.lineAt(range.to);
      return {
        from: {
          line: fromLine.number,
          column: range.from - fromLine.from,
        },
        to: {
          line: toLine.number,
          column: range.to - toLine.from,
        },
        text: view.state.sliceDoc(range.from, range.to),
      };
    },
    selectRange(from, to, options) {
      const doc = view.state.doc;
      // Clamp every coordinate to the current doc so an out-of-date
      // comment from an older edit can't blow up the dispatch.
      const safeFromLine = Math.min(Math.max(from.line, 1), doc.lines);
      const fromLineInfo = doc.line(safeFromLine);
      const fromPos =
        fromLineInfo.from + Math.min(Math.max(from.column, 0), fromLineInfo.length);
      const safeToLine = Math.min(Math.max(to.line, 1), doc.lines);
      const toLineInfo = doc.line(safeToLine);
      const toPos =
        toLineInfo.from + Math.min(Math.max(to.column, 0), toLineInfo.length);
      // anchor is fromPos (range start), head is toPos (range end);
      // CodeMirror handles inverted ranges fine.
      view.dispatch({
        selection: { anchor: fromPos, head: toPos },
        scrollIntoView: true,
        effects: EditorView.scrollIntoView(fromPos, { y: 'center' }),
      });
      view.focus();
      if (options?.flash === true) {
        flashLineOnView(view, safeFromLine);
      }
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

