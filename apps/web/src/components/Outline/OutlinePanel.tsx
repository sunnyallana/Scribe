import { Button } from '@scribe/ui';
import { ListTree, X } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

interface OutlinePanelProps {
  readonly content: string;
  readonly onJump: (line: number) => void;
  readonly onClose: () => void;
}

interface OutlineEntry {
  readonly level: number;
  readonly title: string;
  readonly line: number;
}

const SECTION_REGEX =
  /^\s*\\(chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\s*(?:\[[^\]]*\])?\{([^}]*)\}/;

const LEVEL_BY_CMD: Readonly<Record<string, number>> = {
  chapter: 0,
  section: 1,
  subsection: 2,
  subsubsection: 3,
  paragraph: 4,
  subparagraph: 5,
};

function parseOutline(text: string): OutlineEntry[] {
  const entries: OutlineEntry[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    // Strip trailing comments (simple: anything after an unescaped %).
    const cleaned = line.replace(/(^|[^\\])%.*$/g, '$1');
    const match = SECTION_REGEX.exec(cleaned);
    if (match === null) continue;
    const cmd = (match[1] ?? '').toLowerCase();
    const title = (match[2] ?? '').trim();
    const level = LEVEL_BY_CMD[cmd] ?? 1;
    entries.push({ level, title, line: i + 1 });
  }
  return entries;
}

export function OutlinePanel({ content, onJump, onClose }: OutlinePanelProps) {
  const { t } = useTranslation();
  const entries = useMemo(() => parseOutline(content), [content]);

  return (
    <div className="flex h-full w-full flex-col bg-background">
      <div className="flex items-center justify-between border-b px-3 py-2">
        <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <ListTree className="h-3.5 w-3.5" aria-hidden="true" />
          {t('outline.title')}
        </h3>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('common.close')}
          className="h-6 w-6"
          onClick={onClose}
        >
          <X className="h-3 w-3" aria-hidden="true" />
        </Button>
      </div>
      <div className="flex-1 overflow-auto">
        {entries.length === 0 ? (
          <p className="p-3 text-xs text-muted-foreground">{t('outline.empty')}</p>
        ) : (
          <ul className="space-y-px p-2">
            {entries.map((e, idx) => (
              <li key={`${e.line.toString()}-${idx.toString()}`}>
                <button
                  type="button"
                  className="flex w-full items-center gap-1 truncate rounded px-2 py-1 text-left text-xs hover:bg-accent/60"
                  style={{ paddingLeft: `${(e.level * 10 + 6).toString()}px` }}
                  onClick={() => { onJump(e.line); }}
                >
                  <span className="flex-1 truncate">{e.title}</span>
                  <span className="ml-2 shrink-0 text-[10px] tabular-nums text-muted-foreground">
                    L{e.line}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
