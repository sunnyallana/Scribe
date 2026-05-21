import { describe, expect, it } from 'vitest';

import { buildPrompt } from './prompts.js';

describe('buildPrompt', () => {
  it('improve-writing emits system+user pair with the selection', () => {
    const msgs = buildPrompt({ feature: 'improve-writing', selection: 'Hello.', options: {} });
    expect(msgs).toHaveLength(2);
    expect(msgs[0]?.role).toBe('system');
    expect(msgs[1]?.role).toBe('user');
    expect(msgs[1]?.content).toContain('Hello.');
  });

  it('translate uses targetLanguage option', () => {
    const msgs = buildPrompt({
      feature: 'translate',
      selection: 'Bonjour',
      options: { targetLanguage: 'German' },
    });
    expect(msgs[0]?.content).toContain('German');
  });

  it('chat preserves history turns', () => {
    const msgs = buildPrompt({
      feature: 'chat',
      selection: '',
      options: { message: 'follow-up' },
      history: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
      ],
    });
    // system + 2 history turns + new user message
    expect(msgs).toHaveLength(4);
    expect(msgs.at(-1)?.content).toBe('follow-up');
  });

  it('fix-error includes the error message', () => {
    const msgs = buildPrompt({
      feature: 'fix-error',
      selection: '\\foo{}',
      options: { errorMessage: 'Undefined control sequence \\foo' },
    });
    expect(msgs[1]?.content).toContain('Undefined control sequence');
  });
});
