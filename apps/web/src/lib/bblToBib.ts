/**
 * Translate a SyncTeX inverse-lookup result that points at a `.bbl`
 * file into a jump location inside the corresponding `.bib`. The
 * SyncTeX pipeline can only see the BibTeX-emitted `.bbl` (which is
 * what pdflatex actually reads); when the user clicks a citation in
 * the rendered PDF, we get the `.bbl` line, and we need to translate
 * that into the cite key and then to the original `.bib` entry.
 *
 * Lookup chain:
 *
 *   PDF click  ──SyncTeX──▶  (main.bbl, line N)
 *                                     │
 *                       findBibKeyInBbl ▼ (this module)
 *                                     │
 *                                  cite-key
 *                                     │
 *                       findEntryLineInBib ▼ (this module)
 *                                     │
 *                            (.bib path, line)
 */

/** `\bibitem` patterns we need to recognise:
 *    `\bibitem{KEY}`                — standard bibtex
 *    `\bibitem[label]{KEY}`         — manually-labeled
 *    `\bibitem[label]{KEY}%...`     — with comment
 *    `\bibitem[\protect ...]{KEY}`  — biblatex emits this for some styles
 *    `\bibitem{KEY}%` etc.
 *
 *  We allow whitespace and any optional `[…]` block (with internal
 *  brackets balanced one level deep, which covers `\protect`).
 */
const BIBITEM_REGEX = /\\bibitem\s*(?:\[(?:[^[\]]|\[[^\]]*\])*\])?\s*\{\s*([^,}\s]+)\s*\}/;

/**
 * Find the cite-key for an inverse-lookup landing in a `.bbl`. The
 * SyncTeX record points at *some* line inside a `\bibitem` block;
 * we scan upward to find the `\bibitem{KEY}` that opened the block
 * the click sits inside. Returns null when the bbl doesn't contain
 * any `\bibitem` at or above the line (unlikely but handled).
 */
export function findBibKeyInBbl(bblContent: string, line: number): string | null {
  const lines = bblContent.split(/\r?\n/);
  // Walk upward from the SyncTeX line. Most bbl entries span 3-8
  // lines, so the bibitem we want is almost always within 20 lines
  // of the click. Cap at 200 to handle pathologically long entries
  // without blowing the call stack.
  const start = Math.min(line - 1, lines.length - 1);
  const stop = Math.max(0, start - 200);
  for (let i = start; i >= stop; i -= 1) {
    const row = lines[i] ?? '';
    const m = BIBITEM_REGEX.exec(row);
    if (m !== null) {
      return m[1] ?? null;
    }
  }
  return null;
}

/**
 * Find the source line of a `@type{KEY, …}` entry inside a `.bib`.
 * Match is case-insensitive on the key because BibTeX itself
 * normalises citation keys to lower-case during processing.
 * Returns null when the key isn't in this file.
 */
export function findEntryLineInBib(bibContent: string, key: string): number | null {
  const lines = bibContent.split(/\r?\n/);
  // Build the matcher once. We're looking for `@TYPE{KEY` where
  // TYPE is any letter sequence and KEY matches the caller's value
  // case-insensitively. `\b` round the key keeps `KEY` from matching
  // inside `KEY_LONG`.
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^\\s*@\\w+\\s*\\{\\s*${escaped}\\b`, 'i');
  for (let i = 0; i < lines.length; i += 1) {
    if (pattern.test(lines[i] ?? '')) return i + 1;
  }
  return null;
}
