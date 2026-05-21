import { EditorView } from '@codemirror/view';

import type { Extension } from '@codemirror/state';

export interface RulerOptions {
  /** Show a vertical ruler at this column (1-based). */
  readonly column: number;
  /** Color of the rule. Falls back to a theme-aware muted line. */
  readonly color?: string;
}

/**
 * A visual ruler at a given column. Useful for hard-wrap discipline.
 * Implemented as a theme that paints a 1px right border via a background
 * gradient on the content area.
 */
export function ruler({ column, color }: RulerOptions): Extension {
  const stroke = color ?? 'var(--scribe-editor-ruler, rgba(127,127,127,0.3))';
  return EditorView.theme({
    '.cm-content': {
      backgroundImage: `linear-gradient(to right, transparent calc(${column}ch - 0.5px), ${stroke} calc(${column}ch - 0.5px), ${stroke} calc(${column}ch + 0.5px), transparent calc(${column}ch + 0.5px))`,
      backgroundRepeat: 'no-repeat',
      backgroundSize: '100% 100%',
    },
  });
}
