import { StateEffect, StateField, type Extension } from '@codemirror/state';
import {
  keymap,
  EditorView,
  Decoration,
  WidgetType,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view';

class GhostWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }
  override eq(other: GhostWidget): boolean {
    return other.text === this.text;
  }
  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'cm-ghost-completion';
    span.style.opacity = '0.45';
    span.style.fontStyle = 'italic';
    // Render with newlines preserved.
    span.textContent = this.text;
    return span;
  }
  override ignoreEvent(): boolean {
    return true;
  }
}

interface GhostState {
  readonly text: string;
  readonly pos: number;
}

const setGhostEffect = StateEffect.define<GhostState | null>();

const ghostField = StateField.define<GhostState | null>({
  create() {
    return null;
  },
  update(value, tr) {
    if (tr.docChanged && value !== null) {
      // Any doc change while a ghost is showing — dismiss unless the change
      // was triggered by accepting it (which we'll handle by clearing first).
      return null;
    }
    for (const eff of tr.effects) {
      if (eff.is(setGhostEffect)) return eff.value;
    }
    if (value !== null && tr.selection !== undefined) {
      if (tr.selection.main.head !== value.pos) return null;
    }
    return value;
  },
  provide(field) {
    return EditorView.decorations.from(field, (value) => {
      if (value === null) return Decoration.none;
      const deco = Decoration.widget({
        widget: new GhostWidget(value.text),
        side: 1,
      });
      return Decoration.set([deco.range(value.pos)]);
    });
  },
});

export type GhostFetchFn = (context: {
  readonly textBefore: string;
  readonly fullText: string;
  readonly signal: AbortSignal;
}) => Promise<string | null>;

export interface GhostCompleteOptions {
  readonly fetch: GhostFetchFn;
  readonly debounceMs?: number;
  /** Minimum chars typed before triggering. */
  readonly minTrigger?: number;
}

export function ghostCompletion(opts: GhostCompleteOptions): Extension {
  const debounceMs = opts.debounceMs ?? 600;
  const minTrigger = opts.minTrigger ?? 8;

  const watcher = ViewPlugin.fromClass(
    class {
      timer: ReturnType<typeof setTimeout> | null = null;
      controller: AbortController | null = null;
      // Snapshot doc length at last fetch to detect "no change since trigger"
      lastSnapshotLen = -1;

      update(update: ViewUpdate): void {
        if (!update.docChanged && !update.selectionSet) return;
        if (this.controller !== null) {
          this.controller.abort();
          this.controller = null;
        }
        if (this.timer !== null) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
          this.schedule(update.view);
        }, debounceMs);
      }

      schedule(view: EditorView): void {
        const state = view.state;
        const head = state.selection.main.head;
        const textBefore = state.sliceDoc(0, head);
        const fullText = state.doc.toString();
        if (textBefore.length < minTrigger) return;
        const controller = new AbortController();
        this.controller = controller;
        this.lastSnapshotLen = fullText.length;
        void opts
          .fetch({ textBefore, fullText, signal: controller.signal })
          .then((suggestion) => {
            if (controller.signal.aborted) return;
            if (suggestion === null || suggestion === '') return;
            // Bail if document changed since we asked.
            if (view.state.doc.length !== this.lastSnapshotLen) return;
            if (view.state.selection.main.head !== head) return;
            view.dispatch({
              effects: setGhostEffect.of({ text: suggestion, pos: head }),
            });
          })
          .catch(() => {
            /* swallow; aborted or network */
          });
      }

      destroy(): void {
        if (this.timer !== null) clearTimeout(this.timer);
        this.controller?.abort();
      }
    },
  );

  const acceptKeymap = keymap.of([
    {
      key: 'Tab',
      run: (view) => {
        const ghost = view.state.field(ghostField, false);
        if (ghost === null || ghost === undefined) return false;
        view.dispatch({
          changes: { from: ghost.pos, insert: ghost.text },
          selection: { anchor: ghost.pos + ghost.text.length },
          effects: setGhostEffect.of(null),
          userEvent: 'input.complete',
        });
        return true;
      },
    },
    {
      key: 'Escape',
      run: (view) => {
        const ghost = view.state.field(ghostField, false);
        if (ghost === null || ghost === undefined) return false;
        view.dispatch({ effects: setGhostEffect.of(null) });
        return true;
      },
    },
  ]);

  return [ghostField, watcher, acceptKeymap];
}
