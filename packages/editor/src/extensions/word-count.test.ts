import { describe, expect, it } from 'vitest';

import { computeWordCount } from './word-count.js';

describe('computeWordCount', () => {
  it('counts plain prose', () => {
    expect(computeWordCount('Hello world foo bar')).toMatchObject({ words: 4 });
  });

  it('strips LaTeX commands before counting', () => {
    const tex = String.raw`\section{Intro} Hello \emph{world}.`;
    expect(computeWordCount(tex).words).toBe(2);
  });

  it('strips comments and math', () => {
    const tex = 'Real text % a comment with words\n$x = y$ more';
    expect(computeWordCount(tex).words).toBe(3);
  });

  it('reports zero for empty input', () => {
    expect(computeWordCount('')).toEqual({
      words: 0,
      characters: 0,
      charactersNoSpaces: 0,
      lines: 0,
    });
  });
});
