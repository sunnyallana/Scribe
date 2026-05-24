import { Avatar, AvatarFallback } from '@scribe/ui';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  detectMentionTrigger,
  filterMembers,
  insertMentionToken,
  type MentionTriggerState,
} from './mentions';

import type { ProjectMember } from '@scribe/shared';

interface MentionTextareaProps {
  readonly value: string;
  readonly onChange: (next: string) => void;
  readonly members: readonly ProjectMember[];
  readonly placeholder?: string;
  readonly rows?: number;
  readonly disabled?: boolean;
  readonly className?: string;
}

function initialsFor(name: string | null, email: string | null): string {
  const src = name ?? email ?? '';
  if (src.trim() === '') return '??';
  return src
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

export function MentionTextarea({
  value,
  onChange,
  members,
  placeholder,
  rows = 3,
  disabled = false,
  className,
}: MentionTextareaProps) {
  const { t } = useTranslation();
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [trigger, setTrigger] = useState<MentionTriggerState>({
    active: false,
    query: '',
    start: -1,
    end: 0,
  });
  const [activeIdx, setActiveIdx] = useState(0);

  const candidates = trigger.active ? filterMembers(members, trigger.query) : [];

  useEffect(() => {
    if (activeIdx >= candidates.length) setActiveIdx(0);
  }, [candidates.length, activeIdx]);

  function refreshTrigger() {
    const ta = taRef.current;
    if (ta === null) return;
    const caret = ta.selectionStart;
    setTrigger(detectMentionTrigger(value, caret));
  }

  function commitMention(member: ProjectMember) {
    if (!trigger.active) return;
    const { body, nextCaret } = insertMentionToken(value, trigger, member);
    onChange(body);
    setTrigger({ active: false, query: '', start: -1, end: nextCaret });
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (ta !== null) {
        ta.focus();
        ta.setSelectionRange(nextCaret, nextCaret);
      }
    });
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (!trigger.active || candidates.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx((i) => Math.min(candidates.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      const choice = candidates[activeIdx];
      if (choice !== undefined) {
        e.preventDefault();
        commitMention(choice);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setTrigger({ active: false, query: '', start: -1, end: trigger.end });
    }
  }

  return (
    <div className="relative">
      <textarea
        ref={taRef}
        className={className ?? 'w-full rounded-md border bg-background p-2 text-xs'}
        rows={rows}
        placeholder={placeholder}
        value={value}
        disabled={disabled}
        onChange={(e) => {
          onChange(e.target.value);
          // Defer one tick so selectionStart reflects the new caret.
          requestAnimationFrame(refreshTrigger);
        }}
        onKeyUp={refreshTrigger}
        onClick={refreshTrigger}
        onBlur={() => {
          // Allow click-to-pick on the popover before dismissing.
          setTimeout(() => {
            setTrigger((s) => ({ ...s, active: false }));
          }, 120);
        }}
        onKeyDown={handleKeyDown}
      />
      {trigger.active && candidates.length > 0 ? (
        <ul
          className="absolute z-50 mt-1 w-64 max-h-48 overflow-auto rounded-md border bg-popover shadow-lg"
          role="listbox"
          aria-label={t('mentions.popoverLabel')}
        >
          {candidates.map((m, idx) => (
            <li key={m.id}>
              <button
                type="button"
                className={`flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs ${
                  idx === activeIdx ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/60'
                }`}
                onMouseEnter={() => {
                  setActiveIdx(idx);
                }}
                onMouseDown={(e) => {
                  e.preventDefault();
                  commitMention(m);
                }}
              >
                <Avatar className="h-5 w-5">
                  <AvatarFallback className="text-[9px]">
                    {initialsFor(m.displayName, m.email)}
                  </AvatarFallback>
                </Avatar>
                <span className="min-w-0 flex-1 truncate">
                  {m.displayName ?? m.email ?? t('mentions.unknown')}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
