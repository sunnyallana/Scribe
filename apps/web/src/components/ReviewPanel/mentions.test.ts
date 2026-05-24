import { describe, expect, it } from 'vitest';

import {
  detectMentionTrigger,
  extractMentionedUserIds,
  filterMembers,
  insertMentionToken,
  parseBody,
} from './mentions';

import type { ProjectMember } from '@scribe/shared';

const UUID_A = '11111111-1111-4111-a111-111111111111';
const UUID_B = '22222222-2222-4222-a222-222222222222';

function member(
  id: string,
  name: string,
  email = `${name.toLowerCase().replace(/\s+/g, '')}@x.test`,
): ProjectMember {
  return {
    id: 'mem-id' as never,
    projectId: 'proj-id' as never,
    userId: id as never,
    email,
    displayName: name,
    avatarUrl: null,
    role: 'editor',
    invitedAt: '2026-01-01T00:00:00Z',
    acceptedAt: '2026-01-01T00:00:00Z',
    expiresAt: '2027-01-01T00:00:00Z',
    pending: false,
  };
}

describe('parseBody', () => {
  it('returns a single text token when there are no mentions', () => {
    expect(parseBody('plain comment')).toEqual([
      { kind: 'text', value: 'plain comment' },
    ]);
  });

  it('extracts mention tokens with display name and user id', () => {
    const tokens = parseBody(`hello @[Sunny](${UUID_A}) and @[Alex](${UUID_B})!`);
    expect(tokens).toEqual([
      { kind: 'text', value: 'hello ' },
      { kind: 'mention', displayName: 'Sunny', userId: UUID_A },
      { kind: 'text', value: ' and ' },
      { kind: 'mention', displayName: 'Alex', userId: UUID_B },
      { kind: 'text', value: '!' },
    ]);
  });
});

describe('extractMentionedUserIds', () => {
  it('deduplicates ids and returns insertion order', () => {
    const ids = extractMentionedUserIds(
      `@[A](${UUID_A}) @[B](${UUID_B}) again @[A](${UUID_A})`,
    );
    expect(ids).toEqual([UUID_A, UUID_B]);
  });
});

describe('detectMentionTrigger', () => {
  it('detects an @ at start of input', () => {
    const trig = detectMentionTrigger('@su', 3);
    expect(trig).toEqual({ active: true, query: 'su', start: 0, end: 3 });
  });

  it('detects an @ after whitespace', () => {
    const trig = detectMentionTrigger('hi @al', 6);
    expect(trig.active).toBe(true);
    expect(trig.query).toBe('al');
  });

  it('does NOT trigger when @ is preceded by a word character (email-like)', () => {
    const trig = detectMentionTrigger('user@example', 12);
    expect(trig.active).toBe(false);
  });

  it('does NOT trigger after a whitespace breaks the query', () => {
    const trig = detectMentionTrigger('@foo bar', 8);
    expect(trig.active).toBe(false);
  });
});

describe('filterMembers', () => {
  const all = [member(UUID_A, 'Sunny Shaban'), member(UUID_B, 'Alex Doe')];

  it('returns all matching members when query is empty', () => {
    expect(filterMembers(all, '')).toHaveLength(2);
  });

  it('matches on display name case-insensitively', () => {
    expect(filterMembers(all, 'sun')).toEqual([all[0]]);
  });

  it('matches on email', () => {
    expect(filterMembers(all, 'alex')).toEqual([all[1]]);
  });
});

describe('insertMentionToken', () => {
  it('replaces the partial trigger with a tokenized mention plus trailing space', () => {
    const body = 'hi @su';
    const trig = detectMentionTrigger(body, 6);
    const m = member(UUID_A, 'Sunny');
    const result = insertMentionToken(body, trig, m);
    expect(result.body).toBe(`hi @[Sunny](${UUID_A}) `);
    expect(result.nextCaret).toBe(result.body.length);
  });
});
