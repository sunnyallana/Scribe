import { StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';

export const setFlashLine = StateEffect.define<number | null>();

const flashDecoration = Decoration.line({ class: 'cm-flash-line' });

const flashField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const eff of tr.effects) {
      if (eff.is(setFlashLine)) {
        if (eff.value === null) return Decoration.none;
        const safe = Math.min(Math.max(eff.value, 1), tr.state.doc.lines);
        const line = tr.state.doc.line(safe);
        return Decoration.set([flashDecoration.range(line.from)]);
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const flashTheme = EditorView.baseTheme({
  '.cm-flash-line': {
    animation: 'cm-flash-line-anim 900ms ease-out',
  },
  '@keyframes cm-flash-line-anim': {
    '0%': { backgroundColor: 'rgba(59, 130, 246, 0.0)' },
    '15%': { backgroundColor: 'rgba(59, 130, 246, 0.35)' },
    '100%': { backgroundColor: 'rgba(59, 130, 246, 0.0)' },
  },
});

export function flashLineExtension() {
  return [flashField, flashTheme];
}

export function flashLineOnView(view: EditorView, line: number): void {
  view.dispatch({ effects: setFlashLine.of(line) });
  window.setTimeout(() => {
    view.dispatch({ effects: setFlashLine.of(null) });
  }, 900);
}
