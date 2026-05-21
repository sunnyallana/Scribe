import { describe, expect, it } from 'vitest';

import { err, ok, type Result } from './result.js';

describe('Result', () => {
  it('ok carries a value', () => {
    const r: Result<number> = ok(42);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(42);
  });

  it('err carries an error', () => {
    const cause = new Error('boom');
    const r: Result<number> = err(cause);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe(cause);
  });

  it('narrows discriminated union by ok flag', () => {
    const r: Result<string> = ok('hello');
    const length = r.ok ? r.value.length : 0;
    expect(length).toBe(5);
  });
});
