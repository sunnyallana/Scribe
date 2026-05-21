import { describe, expect, it } from 'vitest';

import { createFileInputSchema, inferFileType } from './files.js';

describe('inferFileType', () => {
  it.each([
    ['main.tex', 'tex'],
    ['sections/intro.tex', 'tex'],
    ['refs.bib', 'bib'],
    ['logo.png', 'image'],
    ['photo.JPG', 'image'],
    ['custom.cls', 'tex'],
    ['data.csv', 'other'],
    ['README', 'other'],
  ] as const)('infers %s as %s', (path, expected) => {
    expect(inferFileType(path)).toBe(expected);
  });
});

describe('createFileInputSchema', () => {
  it('rejects paths containing ..', () => {
    const result = createFileInputSchema.safeParse({ path: '../etc/passwd' });
    expect(result.success).toBe(false);
  });

  it('rejects absolute paths', () => {
    const result = createFileInputSchema.safeParse({ path: '/etc/passwd' });
    expect(result.success).toBe(false);
  });

  it('accepts a normal nested path', () => {
    const result = createFileInputSchema.safeParse({ path: 'sections/intro.tex' });
    expect(result.success).toBe(true);
  });
});
