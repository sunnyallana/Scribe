import { describe, expect, it } from 'vitest';

import { parseCompileLog } from './log-parser.js';

describe('parseCompileLog', () => {
  it('captures a classic LaTeX error with line number', () => {
    const log = [
      '(./main.tex',
      'Some random output',
      '! Undefined control sequence.',
      'l.42 \\foo',
      '          {bar}',
    ].join('\n');

    const entries = parseCompileLog(log);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      level: 'error',
      message: 'Undefined control sequence.',
      file: './main.tex',
      line: 42,
    });
  });

  it('captures a LaTeX Warning with input line', () => {
    const log = [
      '(./main.tex',
      "LaTeX Warning: Reference `foo' on page 1 undefined on input line 12.",
    ].join('\n');

    const entries = parseCompileLog(log);
    expect(entries.length).toBeGreaterThan(0);
    const warning = entries.find((e) => e.level === 'warning');
    expect(warning).toBeDefined();
    expect(warning?.line).toBe(12);
    expect(warning?.file).toBe('./main.tex');
  });

  it('captures Overfull \\hbox warnings with line range', () => {
    const log = [
      '(./main.tex',
      'Overfull \\hbox (10.5pt too wide) in paragraph at lines 5--7',
    ].join('\n');

    const entries = parseCompileLog(log);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.level).toBe('warning');
    expect(entries[0]?.line).toBe(5);
  });

  it('tracks file context across pushes and pops', () => {
    const log = [
      '(./main.tex',
      '(./preamble.sty',
      'LaTeX Warning: in preamble on input line 3.',
      ')',
      'LaTeX Warning: in main on input line 100.',
    ].join('\n');

    const entries = parseCompileLog(log);
    expect(entries).toHaveLength(2);
    expect(entries[0]?.file).toBe('./preamble.sty');
    expect(entries[1]?.file).toBe('./main.tex');
  });

  it('captures tectonic-style note/warning/error prefixes', () => {
    const log = ['note: skipped 1 file', 'warning: package mismatch', 'error: missing $'].join(
      '\n',
    );
    const entries = parseCompileLog(log);
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.level)).toEqual(['info', 'warning', 'error']);
  });

  it('returns no entries for an empty log', () => {
    expect(parseCompileLog('')).toEqual([]);
  });
});
