import type { ProjectMember } from '@scribe/shared';

const MENTION_RE = /@\[([^\]]+)\]\(([0-9a-fA-F-]{36})\)/g;

export interface MentionToken {
  readonly kind: 'mention';
  readonly displayName: string;
  readonly userId: string;
}

export interface TextToken {
  readonly kind: 'text';
  readonly value: string;
}

export type BodyToken = MentionToken | TextToken;

export function parseBody(body: string): BodyToken[] {
  const tokens: BodyToken[] = [];
  let cursor = 0;
  MENTION_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MENTION_RE.exec(body)) !== null) {
    if (match.index > cursor) {
      tokens.push({ kind: 'text', value: body.slice(cursor, match.index) });
    }
    tokens.push({
      kind: 'mention',
      displayName: match[1] ?? '',
      userId: match[2] ?? '',
    });
    cursor = match.index + match[0].length;
  }
  if (cursor < body.length) {
    tokens.push({ kind: 'text', value: body.slice(cursor) });
  }
  return tokens;
}

export function extractMentionedUserIds(body: string): string[] {
  const ids: string[] = [];
  MENTION_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MENTION_RE.exec(body)) !== null) {
    if (match[2] !== undefined && !ids.includes(match[2])) {
      ids.push(match[2]);
    }
  }
  return ids;
}

export interface MentionTriggerState {
  readonly active: boolean;
  /** The partial query after `@` and before the cursor. */
  readonly query: string;
  /** Position in the textarea where `@` appears. */
  readonly start: number;
  /** Position immediately after the query end (cursor position). */
  readonly end: number;
}

/**
 * Inspect the textarea body and the current cursor position; if the user is
 * mid-typing an `@token`, return the trigger state. Otherwise return `inactive`.
 *
 * Trigger rules: `@` must be at start-of-text or preceded by whitespace, and
 * the partial query must contain no whitespace.
 */
export function detectMentionTrigger(body: string, caret: number): MentionTriggerState {
  const inactive: MentionTriggerState = { active: false, query: '', start: -1, end: caret };
  let i = caret - 1;
  while (i >= 0) {
    const ch = body[i];
    if (ch === '@') {
      const prev = body[i - 1];
      if (i === 0 || prev === ' ' || prev === '\n' || prev === '\t') {
        return { active: true, query: body.slice(i + 1, caret), start: i, end: caret };
      }
      return inactive;
    }
    if (ch === ' ' || ch === '\n' || ch === '\t') return inactive;
    i--;
  }
  return inactive;
}

export function filterMembers(
  members: readonly ProjectMember[],
  query: string,
): readonly ProjectMember[] {
  const q = query.toLowerCase();
  return members
    .filter((m) => m.userId !== null)
    .filter((m) => {
      if (q === '') return true;
      const name = (m.displayName ?? '').toLowerCase();
      const email = (m.email ?? '').toLowerCase();
      return name.includes(q) || email.includes(q);
    })
    .slice(0, 8);
}

export function insertMentionToken(
  body: string,
  trigger: MentionTriggerState,
  member: ProjectMember,
): { readonly body: string; readonly nextCaret: number } {
  if (member.userId === null) return { body, nextCaret: trigger.end };
  const display = member.displayName ?? member.email ?? 'user';
  const token = `@[${display}](${member.userId}) `;
  const before = body.slice(0, trigger.start);
  const after = body.slice(trigger.end);
  return { body: `${before}${token}${after}`, nextCaret: before.length + token.length };
}
