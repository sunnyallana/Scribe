import { describe, expect, it } from 'vitest';

import { lookupForward, lookupInverse, parseSyncTeX } from './synctex.js';

const SAMPLE = `SyncTeX Version:1
Input:1:./main.tex
Input:2:./chapter.tex
Output:pdf
Magnification:1000
Unit:1
X Offset:0
Y Offset:0
{1
h1,3:1000,2000:50
h1,5:1500,2500:50
h2,10:2000,3000:50
}
{2
h1,42:3000,4000:50
}
Postamble:
`;

describe('parseSyncTeX', () => {
  it('extracts file mapping and records', () => {
    const idx = parseSyncTeX(SAMPLE);
    expect(idx.files.size).toBe(2);
    expect(idx.files.get(1)).toBe('./main.tex');
    expect(idx.records).toHaveLength(4);
  });

  it('forward lookup finds nearest record at or before the requested line', () => {
    const idx = parseSyncTeX(SAMPLE);
    const pos = lookupForward(idx, 'main.tex', 4);
    expect(pos).not.toBeNull();
    expect(pos?.page).toBe(1);
    // Line 3 record at h=1000sp / 65536 sp/pt ≈ 0.01526
    expect(pos?.x).toBeCloseTo(1000 / 65536, 5);
  });

  it('returns null for unknown file', () => {
    const idx = parseSyncTeX(SAMPLE);
    expect(lookupForward(idx, 'missing.tex', 1)).toBeNull();
  });

  it('matches relative filename with ./ prefix in index', () => {
    const idx = parseSyncTeX(SAMPLE);
    const pos = lookupForward(idx, './main.tex', 5);
    expect(pos?.page).toBe(1);
  });

  it('handles last-page record', () => {
    const idx = parseSyncTeX(SAMPLE);
    const pos = lookupForward(idx, 'main.tex', 999);
    expect(pos?.page).toBe(2);
  });
});

describe('lookupInverse', () => {
  it('picks the nearest record on the requested page', () => {
    const idx = parseSyncTeX(SAMPLE);
    // Page 1 has records at line 3 (h=1000, v=2000), line 5 (h=1500, v=2500),
    // line 10 (h=2000, v=3000). Convert h=1100sp to pt: 1100/65536 ≈ 0.01678
    const loc = lookupInverse(idx, 1, 1100 / 65536, 2050 / 65536);
    expect(loc).not.toBeNull();
    expect(loc?.line).toBe(3);
    expect(loc?.filename).toBe('./main.tex');
  });

  it('returns null when no record on that page', () => {
    const idx = parseSyncTeX(SAMPLE);
    expect(lookupInverse(idx, 99, 0, 0)).toBeNull();
  });
});
