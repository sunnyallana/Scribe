import { describe, expect, it } from 'vitest';

import { bibEntryPreview, parseBibTeX } from './bibtex.js';

describe('parseBibTeX', () => {
  it('parses a basic article entry with braced + quoted fields', () => {
    const src = `@article{smith2020,
      author = {Smith, John and Doe, Jane},
      title = "On parsing BibTeX",
      year = 2020,
      journal = {J. Parsers},
    }`;
    const out = parseBibTeX(src);
    expect(out).toHaveLength(1);
    expect(out[0]?.type).toBe('article');
    expect(out[0]?.key).toBe('smith2020');
    expect(out[0]?.fields.author).toBe('Smith, John and Doe, Jane');
    expect(out[0]?.fields.title).toBe('On parsing BibTeX');
    expect(out[0]?.fields.year).toBe('2020');
  });

  it('handles nested braces inside values', () => {
    const src = `@book{nested,
      title = {On the {Origin} of Things},
      year = 1900
    }`;
    const out = parseBibTeX(src);
    expect(out[0]?.fields.title).toBe('On the {Origin} of Things');
  });

  it('parses multiple entries and skips @comment', () => {
    const src = `@comment{this is a comment}
      @article{a, title = {A}}
      @book{b, title = {B}}`;
    const out = parseBibTeX(src);
    expect(out.map((e) => e.key)).toEqual(['a', 'b']);
  });

  it('skips entries with empty keys', () => {
    expect(parseBibTeX('@article{, title = {x}}')).toEqual([]);
  });

  it('previews author, year, title in one line', () => {
    const out = parseBibTeX('@article{x, author = {Doe}, year = {2020}, title = {Hi}}');
    expect(bibEntryPreview(out[0]!)).toBe('Doe · 2020 · Hi');
  });
});
