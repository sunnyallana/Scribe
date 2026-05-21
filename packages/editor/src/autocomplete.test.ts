import { describe, expect, it } from 'vitest';

import { extractLabels } from './autocomplete.js';

describe('extractLabels', () => {
  it('returns labels in order', () => {
    const tex = String.raw`
      \section{Intro}\label{sec:intro}
      \begin{equation}\label{eq:one}
      x=1
      \end{equation}
    `;
    expect(extractLabels(tex)).toEqual(['sec:intro', 'eq:one']);
  });

  it('handles documents with no labels', () => {
    expect(extractLabels('plain text')).toEqual([]);
  });
});
