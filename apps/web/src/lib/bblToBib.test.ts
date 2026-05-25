import { describe, expect, it } from 'vitest';

import { findBibKeyInBbl, findEntryLineInBib } from './bblToBib';

describe('findBibKeyInBbl', () => {
  it('returns the key when the click line is the bibitem line itself', () => {
    const bbl = [
      '\\begin{thebibliography}{99}',
      '\\bibitem{einstein1905}',
      'A. Einstein. ...',
      '\\end{thebibliography}',
    ].join('\n');
    expect(findBibKeyInBbl(bbl, 2)).toBe('einstein1905');
  });

  it('walks upward when the click lands inside the bibitem body', () => {
    // SyncTeX usually points at the body line of a bibitem block,
    // not the `\bibitem{…}` header itself.
    const bbl = [
      '\\begin{thebibliography}{99}',
      '',
      '\\bibitem{newton1687}',
      'I. Newton. Philosophiæ Naturalis',
      'Principia Mathematica. 1687.',
      '',
      '\\end{thebibliography}',
    ].join('\n');
    expect(findBibKeyInBbl(bbl, 4)).toBe('newton1687');
    expect(findBibKeyInBbl(bbl, 5)).toBe('newton1687');
  });

  it('handles the bracketed label form `\\bibitem[label]{KEY}`', () => {
    const bbl = '\\bibitem[Ein05]{einstein1905}\nA. Einstein.';
    expect(findBibKeyInBbl(bbl, 2)).toBe('einstein1905');
  });

  it('handles biblatex `\\protect`-laden label forms', () => {
    // biblatex generates labels like `[\protect\citenamefont{Knuth}…]`
    // which contain nested brackets. The regex allows one level of
    // bracket nesting inside the label block — pin this down.
    const bbl = '\\bibitem[\\protect\\citenamefont{Knuth}]{knuth1984}\nD. E. Knuth.';
    expect(findBibKeyInBbl(bbl, 2)).toBe('knuth1984');
  });

  it('returns the nearest earlier bibitem when the click is between entries', () => {
    const bbl = ['\\bibitem{first}', 'one', '', '\\bibitem{second}', 'two', 'still two'].join('\n');
    // Line 6 should snap upward to `\bibitem{second}` (line 4), not to
    // `\bibitem{first}` (line 1).
    expect(findBibKeyInBbl(bbl, 6)).toBe('second');
  });

  it('returns null when there is no preceding bibitem', () => {
    const bbl = 'Preamble text\nmore preamble\n';
    expect(findBibKeyInBbl(bbl, 2)).toBeNull();
  });

  it('clamps a beyond-EOF line to the last available line', () => {
    const bbl = '\\bibitem{only}\nbody';
    // Asking for line 99 should still find `only` instead of crashing.
    expect(findBibKeyInBbl(bbl, 99)).toBe('only');
  });

  it('survives CRLF line endings', () => {
    const bbl = '\\bibitem{crlf}\r\nbody\r\n';
    expect(findBibKeyInBbl(bbl, 2)).toBe('crlf');
  });

  it('does not match `\\bibitemsep` or other non-bibitem commands', () => {
    // The regex is `\\bibitem\s*…\{…\}` — `\bibitemsep` is a length,
    // not an entry, and matching it would lock the wrong key in.
    const bbl = '\\setlength\\bibitemsep{0pt}\nbody';
    expect(findBibKeyInBbl(bbl, 2)).toBeNull();
  });

  it('caps backward scan at ~200 lines to avoid runaway walks', () => {
    // 250 empty lines then the bibitem near the end → the click on
    // the very last line is still within range. Pathologically the
    // limit is 200, so a bibitem 250 lines back would NOT be found.
    const lines = Array(250)
      .fill('')
      .map((_, i) => `padding ${i.toString()}`);
    lines[0] = '\\bibitem{far_away}';
    const bbl = lines.join('\n');
    // Click on the last line — `far_away` is 250 lines back, beyond cap.
    expect(findBibKeyInBbl(bbl, 250)).toBeNull();
  });
});

describe('findEntryLineInBib', () => {
  it('returns 1-based line of `@type{KEY,` declarations', () => {
    const bib = [
      '@article{einstein1905,',
      '  title = {On the electrodynamics},',
      '}',
      '',
      '@book{newton1687,',
      '  title = {Principia},',
      '}',
    ].join('\n');
    expect(findEntryLineInBib(bib, 'einstein1905')).toBe(1);
    expect(findEntryLineInBib(bib, 'newton1687')).toBe(5);
  });

  it('matches case-insensitively because BibTeX itself does', () => {
    const bib = '@article{EinsTein1905,\n  year = {1905},\n}';
    expect(findEntryLineInBib(bib, 'einstein1905')).toBe(1);
    expect(findEntryLineInBib(bib, 'EINSTEIN1905')).toBe(1);
  });

  it('tolerates whitespace before `@` and around the key', () => {
    const bib = '   @article{   spacy_key  ,\n  title = {…},\n}';
    expect(findEntryLineInBib(bib, 'spacy_key')).toBe(1);
  });

  it('does not match a key that is a prefix of a longer key', () => {
    // `\b` boundary means `KEY` cannot match inside `KEY_LONG`.
    const bib = '@article{einstein1905_addendum,\n  …\n}';
    expect(findEntryLineInBib(bib, 'einstein1905')).toBeNull();
  });

  it('returns null when the key is missing', () => {
    const bib = '@article{newton1687,\n  …\n}';
    expect(findEntryLineInBib(bib, 'einstein1905')).toBeNull();
  });

  it('escapes regex metacharacters in the key', () => {
    // BibTeX keys can legally contain `.` and `-`; if we don't escape,
    // `.` matches any char and would return false-positive lines.
    const bib = '@misc{lib.v1.2-rc1,\n  …\n}\n@misc{libxv123rc1,\n}';
    expect(findEntryLineInBib(bib, 'lib.v1.2-rc1')).toBe(1);
    // The escaped-dot version must NOT match `libxv123rc1`.
    expect(findEntryLineInBib(bib, 'lib.v1.2-rc1')).not.toBe(4);
  });

  it('handles CRLF line endings and returns the correct 1-based line', () => {
    const bib = '% header\r\n@article{crlf_key,\r\n  title = {x},\r\n}\r\n';
    expect(findEntryLineInBib(bib, 'crlf_key')).toBe(2);
  });
});
