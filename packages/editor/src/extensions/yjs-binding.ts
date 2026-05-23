/**
 * Minimal CodeMirror ↔ Y.Text binding + remote cursor rendering.
 *
 * Replaces `y-codemirror.next` because the upstream plugin (0.3.5)
 * intermittently fails to mirror editor transactions back into Y.Text
 * in our setup — the server-side broadcast was proven healthy by a
 * Node-vs-Node ping-pong test, but the browser's editor wasn't
 * generating any Yjs updates while the user typed.
 *
 * What this module does:
 *
 *   1. **Text sync (Y.Text ↔ CodeMirror)** — on attach, snap the
 *      editor's doc to `ytext.toString()`. After that, translate
 *      CodeMirror change sets into `ytext` ops (tagged with
 *      `LOCAL_ORIGIN`) and translate remote `YTextEvent`s back into
 *      CodeMirror dispatches (annotated with `fromYjs`). Each round
 *      trip is tagged so the inverse path silences itself — no echo
 *      loops, no double-applies.
 *
 *   2. **Local cursor → awareness** — whenever the selection moves,
 *      write the head/anchor offsets onto our awareness local state
 *      (merged into the existing `user` PresenceUser).
 *
 *   3. **Remote cursors → editor** — render each peer's caret as a
 *      `Decoration.widget` with their color and a small name label
 *      hovering above it. Selections rendered as colored marks.
 *      Peers viewing a different file are filtered out via the
 *      `currentFile` field already populated by `provider.setCursor`.
 */

import { Annotation, type Extension, type Range, StateEffect, StateField } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  type PluginValue,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from '@codemirror/view';
import { type Awareness } from 'y-protocols/awareness';
import { type Text as YText, type YTextEvent } from 'yjs';

/** Origin tag we use when applying CodeMirror's edits to Y.Text. The
 *  yText observer checks this so it doesn't try to re-apply our own
 *  changes back into CodeMirror (which would cause infinite churn). */
const LOCAL_ORIGIN = Symbol('scribe.yjs.local');

/** Annotation we attach to CodeMirror transactions that originated
 *  from a remote Y.Text change. The view-plugin `update` hook checks
 *  this so it doesn't push the same diff back into Y.Text. Exported
 *  so the editor's `updateListener` (which fires `onChange` and
 *  triggers autosave) can also skip remote-origin transactions —
 *  otherwise every received keystroke would queue a PUT, which is
 *  pointless for owners (no real change to save) and a stream of
 *  403s for viewers. */
export const fromYjs = Annotation.define<boolean>();

/** Pushed by the awareness listener; carries the latest decoration set
 *  for *remote* cursors. The state field swaps its value when this
 *  effect arrives. */
const setRemoteCursorsEffect = StateEffect.define<DecorationSet>();

const remoteCursorsField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    // Map existing decorations through any local doc changes so they
    // don't lag behind when the user types between awareness updates.
    let next = value.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(setRemoteCursorsEffect)) {
        next = effect.value;
      }
    }
    return next;
  },
  provide: (f) => EditorView.decorations.from(f),
});

class RemoteCursorWidget extends WidgetType {
  constructor(private readonly color: string, private readonly name: string) {
    super();
  }
  override eq(other: RemoteCursorWidget): boolean {
    return other.color === this.color && other.name === this.name;
  }
  override toDOM(): HTMLElement {
    const caret = document.createElement('span');
    caret.className = 'scribe-remote-cursor';
    caret.style.borderLeftColor = this.color;
    const label = document.createElement('span');
    label.className = 'scribe-remote-cursor-label';
    label.style.backgroundColor = this.color;
    label.textContent = this.name;
    caret.appendChild(label);
    return caret;
  }
  override ignoreEvent(): boolean {
    return true;
  }
}

/** Base theme for the remote-cursor widget + selection mark. Loaded
 *  alongside the binding so callers don't have to wire it in
 *  separately. */
const remoteCursorTheme = EditorView.baseTheme({
  '.scribe-remote-cursor': {
    position: 'relative',
    display: 'inline-block',
    width: '0',
    height: '1.1em',
    borderLeftStyle: 'solid',
    borderLeftWidth: '2px',
    marginLeft: '-1px',
    pointerEvents: 'none',
    verticalAlign: 'text-bottom',
  },
  '.scribe-remote-cursor-label': {
    position: 'absolute',
    bottom: 'calc(100% - 2px)',
    left: '-1px',
    fontSize: '10px',
    lineHeight: '14px',
    padding: '0 4px',
    color: '#fff',
    borderRadius: '3px 3px 3px 0',
    whiteSpace: 'nowrap',
    fontFamily:
      'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    fontWeight: '500',
    userSelect: 'none',
    pointerEvents: 'none',
    transform: 'translateY(2px)',
    boxShadow: '0 1px 2px rgba(0,0,0,.15)',
  },
  '.scribe-remote-selection': {
    // Translucent mark over the peer's selection range. Color comes
    // from the inline style on the mark.
    borderRadius: '1px',
  },
});

interface PeerUser {
  readonly userId?: string;
  readonly displayName?: string;
  readonly color?: string;
  readonly cursorAnchor?: number;
  readonly cursorHead?: number;
  readonly currentFile?: string;
}

interface AwarenessState {
  readonly user?: PeerUser;
}

export interface ScribeYjsCollab {
  readonly yText: YText;
  readonly awareness: Awareness | null;
  /** File path this editor instance is bound to. Used to filter out
   *  peers viewing a different file when rendering remote cursors. */
  readonly filePath?: string;
}

export function scribeYjsBinding(opts: ScribeYjsCollab): Extension {
  const { yText, awareness, filePath } = opts;
  const plugin = ViewPlugin.fromClass(
    class implements PluginValue {
      private readonly view: EditorView;
      private readonly observer: (event: YTextEvent) => void;
      private readonly awarenessHandler:
        | ((changes: { added: number[]; updated: number[]; removed: number[] }) => void)
        | null;
      private destroyed = false;
      private lastLocalAnchor = -1;
      private lastLocalHead = -1;

      constructor(view: EditorView) {
        this.view = view;

        // ── Initial snap ─────────────────────────────────────────────
        // The plugin constructor runs *while CodeMirror is in the
        // middle of building the view*, so synchronous `view.dispatch`
        // here throws "Calls to EditorView.update are not allowed
        // while an update is in progress" — which kills the whole
        // plugin and the observer below never gets installed. Defer
        // the snap to a microtask so the construction completes first.
        Promise.resolve().then(() => {
          if (this.destroyed) return;
          const remote = yText.toString();
          const local = view.state.doc.toString();
          if (remote === local) return;
          view.dispatch({
            changes: { from: 0, to: local.length, insert: remote },
            annotations: fromYjs.of(true),
          });
        });

        // ── Remote → editor ──────────────────────────────────────────
        this.observer = (event: YTextEvent) => {
          if (this.destroyed) return;
          if (event.transaction.origin === LOCAL_ORIGIN) {
            // Our own write — the editor already has it.
            return;
          }
          const changes: Array<{ from: number; to?: number; insert?: string }> = [];
          let cursor = 0;
          for (const op of event.delta) {
            if (op.retain !== undefined) {
              cursor += op.retain;
            } else if (op.delete !== undefined) {
              changes.push({ from: cursor, to: cursor + op.delete });
              // cursor stays — chars after it have shifted in by `delete`.
            } else if (typeof op.insert === 'string') {
              changes.push({ from: cursor, insert: op.insert });
              cursor += op.insert.length;
            }
            // Non-string inserts (embeds) aren't supported here; we
            // don't use them anywhere. If they appear, they're ignored.
          }
          if (changes.length === 0) return;
          this.view.dispatch({
            changes,
            annotations: fromYjs.of(true),
          });
        };
        yText.observe(this.observer);

        // ── Awareness → remote cursor decorations ────────────────────
        if (awareness !== null) {
          const localId = awareness.clientID;
          this.awarenessHandler = (changes: {
            added: number[];
            updated: number[];
            removed: number[];
          }) => {
            if (this.destroyed) return;
            // Skip when only our own client changed — that handler fires
            // synchronously from inside `setLocalState`, which we call
            // from `update()`. Dispatching back into the view during an
            // update throws "Calls to EditorView.update are not allowed
            // while an update is in progress" and kills the plugin.
            const remoteChanged =
              changes.added.some((id) => id !== localId) ||
              changes.updated.some((id) => id !== localId) ||
              changes.removed.some((id) => id !== localId);
            if (!remoteChanged) return;
            // Even when triggered by a genuine remote change, the
            // handler can still fire during another transaction (the
            // network read happens off the main update loop, but
            // belt-and-braces). Defer to a microtask so we never
            // dispatch from inside another dispatch.
            Promise.resolve().then(() => { this.refreshRemoteCursors(); });
          };
          awareness.on('change', this.awarenessHandler);
          // Initial paint (peers already present at attach time).
          Promise.resolve().then(() => { this.refreshRemoteCursors(); });
        } else {
          this.awarenessHandler = null;
        }
      }

      // ── Editor → Y.Text + local cursor → awareness ────────────────
      update(update: ViewUpdate): void {
        const isEcho = update.transactions.some(
          (tr) => tr.annotation(fromYjs) === true,
        );

        // Text changes — translate to Y.Text ops.
        if (update.docChanged && !isEcho) {
          const doc = yText.doc;
          if (doc !== null && doc !== undefined) {
            doc.transact(() => {
              let offset = 0;
              update.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
                const at = fromA + offset;
                const deleteLen = toA - fromA;
                if (deleteLen > 0) {
                  yText.delete(at, deleteLen);
                }
                const insertStr = inserted.toString();
                if (insertStr.length > 0) {
                  yText.insert(at, insertStr);
                }
                offset += insertStr.length - deleteLen;
              });
            }, LOCAL_ORIGIN);
          }
        }

        // Local cursor → awareness. Fire on selection move and on doc
        // change (a typed char moves the cursor without
        // `selectionSet`). De-dupe so we don't flood the WS with
        // identical states.
        if (awareness !== null && (update.selectionSet || update.docChanged)) {
          const sel = update.state.selection.main;
          if (sel.anchor !== this.lastLocalAnchor || sel.head !== this.lastLocalHead) {
            this.lastLocalAnchor = sel.anchor;
            this.lastLocalHead = sel.head;
            const existing = awareness.getLocalState() as AwarenessState | null;
            const existingUser: PeerUser = existing?.user ?? {};
            awareness.setLocalState({
              ...existing,
              user: {
                ...existingUser,
                ...(filePath !== undefined ? { currentFile: filePath } : {}),
                cursorAnchor: sel.anchor,
                cursorHead: sel.head,
              },
            });
          }
        }
      }

      private refreshRemoteCursors(): void {
        if (awareness === null) return;
        const localId = awareness.clientID;
        const states = awareness.getStates();
        const docLength = this.view.state.doc.length;
        const ranges: Range<Decoration>[] = [];

        // States is a Map<number, AwarenessState>. Sort by clientID so
        // overlapping carets render in a stable order across frames.
        const entries: Array<[number, AwarenessState]> = [];
        states.forEach((value, key) => {
          entries.push([key, value as AwarenessState]);
        });
        entries.sort((a, b) => a[0] - b[0]);

        for (const [clientId, state] of entries) {
          if (clientId === localId) continue;
          const user = state.user;
          if (user === undefined) continue;
          // Skip peers in a different file (cursors would land at
          // meaningless offsets in this doc).
          if (
            filePath !== undefined &&
            user.currentFile !== undefined &&
            user.currentFile !== filePath
          ) {
            continue;
          }
          const head = user.cursorHead;
          const anchor = user.cursorAnchor;
          if (typeof head !== 'number') continue;
          const color = user.color ?? '#888';
          const name = user.displayName ?? 'Anonymous';

          // Selection mark (if anchor != head).
          if (typeof anchor === 'number' && anchor !== head) {
            const from = Math.max(0, Math.min(anchor, head, docLength));
            const to = Math.max(0, Math.min(Math.max(anchor, head), docLength));
            if (from < to) {
              ranges.push(
                Decoration.mark({
                  class: 'scribe-remote-selection',
                  attributes: {
                    style: `background-color: ${color}33;`, // 20% alpha
                  },
                }).range(from, to),
              );
            }
          }

          // Caret widget at the head position (clamped).
          const at = Math.max(0, Math.min(head, docLength));
          ranges.push(
            Decoration.widget({
              widget: new RemoteCursorWidget(color, name),
              side: 0,
            }).range(at),
          );
        }

        // Decorations must be sorted by `from`, then by `startSide`.
        ranges.sort((a, b) => a.from - b.from || a.value.startSide - b.value.startSide);
        this.view.dispatch({
          effects: setRemoteCursorsEffect.of(Decoration.set(ranges, true)),
        });
      }

      destroy(): void {
        this.destroyed = true;
        yText.unobserve(this.observer);
        if (awareness !== null && this.awarenessHandler !== null) {
          awareness.off('change', this.awarenessHandler);
        }
      }
    },
  );

  return [plugin, remoteCursorsField, remoteCursorTheme];
}
