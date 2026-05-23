/**
 * Minimal CodeMirror ↔ Y.Text binding.
 *
 * Replaces `y-codemirror.next` because the upstream plugin (0.3.5)
 * intermittently fails to mirror editor transactions back into Y.Text
 * in our setup — the server-side broadcast was proven healthy by a
 * Node-vs-Node ping-pong test, but the browser's editor wasn't
 * generating any Yjs updates while the user typed.
 *
 * What this plugin does (and only this — no awareness/cursors yet):
 *
 *   1. On attach, snap the editor's doc to `ytext.toString()` so the
 *      two start in sync. Marks the transaction with `fromYjs` so the
 *      update step below doesn't immediately echo it back.
 *
 *   2. On every CodeMirror transaction that mutated the doc and was
 *      NOT originated by us (no `fromYjs` annotation), translate the
 *      diff into a series of `ytext.delete` / `ytext.insert` ops
 *      inside a single `ytext.doc.transact(…, LOCAL_ORIGIN)`. The
 *      origin tag is unique to this module so the observer (below)
 *      knows to skip the resulting `YTextEvent`.
 *
 *   3. On every `ytext` change whose transaction origin ISN'T our
 *      `LOCAL_ORIGIN` — i.e. it came from the WebSocket provider
 *      applying a remote update — convert the Yjs delta into a
 *      CodeMirror change set and dispatch it, annotated with
 *      `fromYjs` so step 2 doesn't re-apply it.
 *
 * Convergence: every change makes exactly one round trip
 * (editor → ytext or ytext → editor) before being silenced by the
 * origin tag / annotation. No echo loops, no double-applies.
 */

import { Annotation, type Extension } from '@codemirror/state';
import { EditorView, type PluginValue, ViewPlugin, type ViewUpdate } from '@codemirror/view';
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

export interface ScribeYjsCollab {
  readonly yText: YText;
  /** Reserved — passed in so the API matches `y-codemirror.next`'s
   *  `yCollab(yText, awareness)` shape. Used for presence/cursors in a
   *  follow-up extension. */
  readonly awareness: Awareness | null;
}

export function scribeYjsBinding(opts: ScribeYjsCollab): Extension {
  const { yText } = opts;
  return ViewPlugin.fromClass(
    class implements PluginValue {
      private readonly view: EditorView;
      private readonly observer: (event: YTextEvent) => void;
      private destroyed = false;

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
      }

      // ── Editor → Y.Text ────────────────────────────────────────────
      update(update: ViewUpdate): void {
        if (!update.docChanged) return;
        // Skip if this transaction is the echo of a remote yText change
        // we just dispatched. Without this guard, every keystroke from
        // a peer would round-trip into yText again and the doc grows
        // forever.
        const isEcho = update.transactions.some(
          (tr) => tr.annotation(fromYjs) === true,
        );
        if (isEcho) return;

        // Translate the CodeMirror change set into Y.Text ops inside a
        // single Y.Doc transaction so the WS provider serialises them
        // as one update message (one fewer round-trip, atomic on the
        // peer side). `LOCAL_ORIGIN` is unique to this module so the
        // observer above knows to skip the resulting event.
        const doc = yText.doc;
        if (doc === null || doc === undefined) return;
        doc.transact(() => {
          // iterChanges hands us positions in the OLD doc (`fromA`/`toA`).
          // We need positions in the CURRENT yText, which still matches
          // the old doc. As we apply each delete/insert, yText shifts;
          // track the running net length delta so subsequent ranges
          // line up.
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

      destroy(): void {
        this.destroyed = true;
        yText.unobserve(this.observer);
      }
    },
  );
}
