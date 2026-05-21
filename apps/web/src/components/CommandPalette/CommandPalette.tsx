import { Dialog, DialogContent } from '@scribe/ui';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { LucideIcon } from 'lucide-react';

export interface CommandItem {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly group: string;
  readonly icon?: LucideIcon;
  readonly hint?: string;
  readonly keywords?: readonly string[];
  readonly action: () => void;
}

interface CommandPaletteProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly commands: readonly CommandItem[];
}

function score(query: string, item: CommandItem): number {
  if (query === '') return 1;
  const q = query.toLowerCase();
  const haystack = [
    item.label,
    item.description ?? '',
    item.group,
    ...(item.keywords ?? []),
  ]
    .join(' ')
    .toLowerCase();
  if (!haystack.includes(q.split(' ')[0] ?? q)) return 0;
  // Boost matches on the label itself.
  let s = 0;
  if (item.label.toLowerCase().includes(q)) s += 10;
  if (haystack.includes(q)) s += 5;
  // Token AND-match boost.
  const tokens = q.split(/\s+/).filter((t) => t.length > 0);
  for (const tk of tokens) {
    if (haystack.includes(tk)) s += 1;
  }
  return s;
}

export function CommandPalette({ open, onOpenChange, commands }: CommandPaletteProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (!open) {
      setQuery('');
      setActiveIdx(0);
    }
  }, [open]);

  const filtered = useMemo(() => {
    const scored = commands
      .map((c) => ({ cmd: c, s: score(query, c) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s);
    return scored.map((x) => x.cmd);
  }, [commands, query]);

  const groups = useMemo(() => {
    const out = new Map<string, CommandItem[]>();
    for (const c of filtered) {
      const list = out.get(c.group) ?? [];
      list.push(c);
      out.set(c.group, list);
    }
    return out;
  }, [filtered]);

  // Keep activeIdx in range.
  useEffect(() => {
    if (activeIdx >= filtered.length) setActiveIdx(Math.max(0, filtered.length - 1));
  }, [filtered.length, activeIdx]);

  // Scroll active item into view.
  useEffect(() => {
    const list = listRef.current;
    if (list === null) return;
    const el = list.querySelector<HTMLElement>(`[data-cmd-index="${activeIdx.toString()}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIdx]);

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx((i) => Math.min(filtered.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const cmd = filtered[activeIdx];
      if (cmd !== undefined) {
        onOpenChange(false);
        cmd.action();
      }
    }
  }

  let runningIdx = 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="overflow-hidden p-0 sm:max-w-xl">
        <input
          // eslint-disable-next-line jsx-a11y/no-autofocus -- command palette UX
          autoFocus
          value={query}
          onChange={(e) => { setQuery(e.target.value); }}
          onKeyDown={handleKeyDown}
          placeholder={t('command.placeholder')}
          className="w-full border-b bg-transparent px-4 py-3 text-sm outline-none placeholder:text-muted-foreground"
        />
        <ul ref={listRef} className="max-h-80 overflow-auto p-1">
          {filtered.length === 0 ? (
            <li className="px-3 py-2 text-xs text-muted-foreground">{t('command.empty')}</li>
          ) : null}
          {Array.from(groups.entries()).map(([group, items]) => (
            <li key={group}>
              <div className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                {group}
              </div>
              <ul>
                {items.map((c) => {
                  const Icon = c.icon;
                  const myIdx = runningIdx++;
                  const isActive = myIdx === activeIdx;
                  return (
                    <li key={c.id}>
                      <button
                        type="button"
                        data-cmd-index={myIdx.toString()}
                        onMouseEnter={() => { setActiveIdx(myIdx); }}
                        onClick={() => {
                          onOpenChange(false);
                          c.action();
                        }}
                        className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm ${
                          isActive ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/60'
                        }`}
                      >
                        {Icon !== undefined ? (
                          <Icon className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" aria-hidden="true" />
                        ) : (
                          <span className="w-3.5" aria-hidden="true" />
                        )}
                        <span className="flex-1 truncate">{c.label}</span>
                        {c.hint !== undefined ? (
                          <kbd className="rounded border bg-muted/40 px-1 py-0.5 font-mono text-[10px] text-muted-foreground">
                            {c.hint}
                          </kbd>
                        ) : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
