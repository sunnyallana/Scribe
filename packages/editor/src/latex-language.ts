import { StreamLanguage, LanguageSupport } from '@codemirror/language';
import { stex } from '@codemirror/legacy-modes/mode/stex';

/**
 * LaTeX language support backed by the legacy stex stream parser. This is a
 * pragmatic Phase 2 choice — a full Lezer grammar is planned but is a multi-
 * day effort (PLAN.md Q-risks). Stream highlighting plus the autocomplete
 * extension below gives us a usable editor today, and the public API here
 * is stable so swapping in a Lezer parser later is a drop-in replacement.
 */
export const latexLanguage = StreamLanguage.define(stex);

export function latexLanguageSupport(): LanguageSupport {
  return new LanguageSupport(latexLanguage);
}
