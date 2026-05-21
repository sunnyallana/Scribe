import { StateField } from '@codemirror/state';

import type { Extension, EditorState } from '@codemirror/state';

export interface WordCount {
  readonly words: number;
  readonly characters: number;
  readonly charactersNoSpaces: number;
  readonly lines: number;
}

const COMMENT_LINE = /(^|[^\\])%.*$/gm;
const COMMAND = /\\[a-zA-Z@]+\*?(?:\{[^}]*\})?/g;
const MATH_INLINE = /\$[^$\n]*\$/g;
const MATH_DISPLAY = /\\\[[\s\S]*?\\\]|\$\$[\s\S]*?\$\$/g;
const ENV_DELIMITER = /\\(?:begin|end)\{[^}]+\}/g;

/**
 * Strip LaTeX scaffolding from a document and count the remaining word-like
 * tokens. Designed for "looks about right" UX, not for thesis-grading.
 */
export function computeWordCount(text: string): WordCount {
  let cleaned = text;
  cleaned = cleaned.replace(COMMENT_LINE, '$1');
  cleaned = cleaned.replace(MATH_DISPLAY, ' ');
  cleaned = cleaned.replace(MATH_INLINE, ' ');
  cleaned = cleaned.replace(ENV_DELIMITER, ' ');
  cleaned = cleaned.replace(COMMAND, ' ');

  const trimmed = cleaned.trim();
  const words = trimmed === '' ? 0 : trimmed.split(/\s+/).length;
  const characters = text.length;
  const charactersNoSpaces = text.replace(/\s/g, '').length;
  const lines = text === '' ? 0 : text.split(/\r?\n/).length;

  return { words, characters, charactersNoSpaces, lines };
}

export const wordCountField = StateField.define<WordCount>({
  create(state: EditorState) {
    return computeWordCount(state.doc.toString());
  },
  update(prev, tr) {
    if (!tr.docChanged) return prev;
    return computeWordCount(tr.state.doc.toString());
  },
});

export function wordCountExtension(): Extension {
  return wordCountField;
}
