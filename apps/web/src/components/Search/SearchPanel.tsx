import { type ProjectFile, type ProjectId } from '@scribe/shared';
import { Button, Input } from '@scribe/ui';
import { useMutation, useQueries, useQueryClient } from '@tanstack/react-query';
import { CaseSensitive, FileText, Loader2, Regex, Replace, Search, WholeWord, X } from 'lucide-react';
import { type FormEvent, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { api } from '../../lib/api';

interface SearchPanelProps {
  readonly projectId: ProjectId;
  readonly files: readonly ProjectFile[];
  /** Active file id — replacement is skipped here because the Yjs
   *  doc owns the source of truth and a direct writeContent would
   *  race with the editor's debounced autosave. */
  readonly activeFileId: ProjectFile['id'] | null;
  /** Live editor buffer for the active file, so unsaved edits are
   *  reflected in search results in real time. */
  readonly activeFileContent: string;
  readonly onSelectFile: (file: ProjectFile, line: number) => void;
  readonly onClose: () => void;
}

interface Match {
  readonly file: ProjectFile;
  readonly line: number;
  readonly column: number;
  readonly matchLength: number;
  readonly lineText: string;
}

/** Files we consider searchable. Binaries (PDFs, images) and large
 *  generated artifacts (logs, synctex) would just be noise. */
function isSearchable(file: ProjectFile): boolean {
  if (file.type === 'image') return false;
  const lower = file.path.toLowerCase();
  const SKIP = ['.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.eps', '.zip', '.synctex.gz', '.log', '.aux', '.bbl', '.bcf', '.fls', '.out', '.toc'];
  return !SKIP.some((ext) => lower.endsWith(ext));
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Build a search regex from the user's input + options. Returns
 *  `null` if the query is empty or (in regex mode) malformed — the
 *  caller treats that as "no results to display." */
function buildRegex(
  query: string,
  caseSensitive: boolean,
  wholeWord: boolean,
  useRegex: boolean,
): RegExp | null {
  if (query === '') return null;
  let pattern = useRegex ? query : escapeRegex(query);
  if (wholeWord) pattern = `\\b${pattern}\\b`;
  const flags = caseSensitive ? 'g' : 'gi';
  try {
    return new RegExp(pattern, flags);
  } catch {
    return null;
  }
}

export function SearchPanel({
  projectId,
  files,
  activeFileId,
  activeFileContent,
  onSelectFile,
  onClose,
}: SearchPanelProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [query, setQuery] = useState('');
  const [replaceText, setReplaceText] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [showReplace, setShowReplace] = useState(false);

  const searchable = useMemo(() => files.filter(isSearchable), [files]);

  // Fan-out fetch of every searchable file. Same query key as the
  // editor uses, so opened files are a free cache hit.
  const fileQueries = useQueries({
    queries: searchable.map((f) => ({
      queryKey: ['file-content', projectId, f.id],
      queryFn: () => api.files.readContent(projectId, f.id),
      staleTime: 30_000,
    })),
  });

  const allReady = fileQueries.every((q) => !q.isPending);

  // Search runs on every keystroke against the in-memory cache —
  // no network calls per query, so it's basically free. For very
  // large projects we'd debounce; in practice typical project size
  // (10-50 files, KB each) makes this comfortably interactive.
  const { matches, fileGroups } = useMemo(() => {
    const re = buildRegex(query, caseSensitive, wholeWord, useRegex);
    if (re === null) return { matches: [] as Match[], fileGroups: new Map<string, Match[]>() };
    const out: Match[] = [];
    const groups = new Map<string, Match[]>();
    for (let i = 0; i < searchable.length; i += 1) {
      const f = searchable[i];
      const q = fileQueries[i];
      if (f === undefined) continue;
      // Prefer the live editor buffer for the active file so unsaved
      // edits show up in results immediately.
      const content =
        f.id === activeFileId
          ? activeFileContent
          : (q?.data?.content ?? '');
      if (content === '') continue;
      const lines = content.split('\n');
      for (let lineIdx = 0; lineIdx < lines.length; lineIdx += 1) {
        const line = lines[lineIdx] ?? '';
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(line)) !== null) {
          if (m[0] === '') {
            // Zero-width matches (e.g. `\b` against empty input)
            // would infinite-loop without this.
            re.lastIndex += 1;
            continue;
          }
          const match: Match = {
            file: f,
            line: lineIdx + 1,
            column: m.index + 1,
            matchLength: m[0].length,
            lineText: line,
          };
          out.push(match);
          const arr = groups.get(f.id);
          if (arr === undefined) groups.set(f.id, [match]);
          else arr.push(match);
          if (out.length >= 1000) break;
        }
        if (out.length >= 1000) break;
      }
      if (out.length >= 1000) break;
    }
    return { matches: out, fileGroups: groups };
  }, [query, caseSensitive, wholeWord, useRegex, searchable, fileQueries, activeFileId, activeFileContent]);

  /** Replace-all in every non-active file with hits. The active
   *  file is skipped (Yjs doc owns its content; a direct write
   *  would race with autosave) — the user is told to do active-file
   *  edits via Ctrl+F instead. */
  const replaceMutation = useMutation({
    mutationFn: async () => {
      const re = buildRegex(query, caseSensitive, wholeWord, useRegex);
      if (re === null) throw new Error('invalid pattern');
      let filesChanged = 0;
      let totalReplacements = 0;
      for (let i = 0; i < searchable.length; i += 1) {
        const f = searchable[i];
        const q = fileQueries[i];
        if (f === undefined || q?.data === undefined) continue;
        if (f.id === activeFileId) continue;
        const before = q.data.content;
        let count = 0;
        const after = before.replace(re, (...args) => {
          count += 1;
          // CodeMirror-style $N substitutions are not what we want
          // here; the second-to-last arg in String.replace with a
          // function receiver is `offset` and last is the original
          // input. We resolve $N ourselves so user-provided `$1`
          // works against captured groups in regex mode.
          const matchGroups = args.slice(1, args.length - 2) as string[];
          return useRegex
            ? replaceText.replace(/\$(\d+)/g, (_, n) => matchGroups[Number(n) - 1] ?? '')
            : replaceText;
        });
        if (count > 0 && after !== before) {
          await api.files.writeContent(projectId, f.id, after);
          filesChanged += 1;
          totalReplacements += count;
        }
      }
      return { filesChanged, totalReplacements };
    },
    onSuccess: async ({ filesChanged, totalReplacements }) => {
      await queryClient.invalidateQueries({ queryKey: ['file-content', projectId] });
      toast.success(t('search.replaceDone', { count: totalReplacements, files: filesChanged }));
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : t('search.replaceFailed'));
    },
  });

  const handleSubmit = (e: FormEvent<HTMLFormElement>) => { e.preventDefault(); };
  const activeFileHits = activeFileId !== null ? (fileGroups.get(activeFileId)?.length ?? 0) : 0;
  const replaceableHits = matches.length - activeFileHits;

  return (
    <section className="flex h-full flex-col border-l">
      <header className="flex items-center justify-between gap-2 border-b px-3 py-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <Search className="h-3.5 w-3.5" aria-hidden="true" />
          {t('search.title')}
        </h2>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          aria-label={t('common.close')}
          title={t('common.close')}
          onClick={onClose}
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </Button>
      </header>
      <form onSubmit={handleSubmit} className="space-y-2 border-b p-2">
        <Input
          value={query}
          onChange={(e) => { setQuery(e.target.value); }}
          placeholder={t('search.placeholder')}
          className="h-7 text-xs"
          autoFocus
        />
        <div className="flex items-center gap-0.5">
          <Toggle
            on={caseSensitive}
            onToggle={() => { setCaseSensitive((v) => !v); }}
            icon={CaseSensitive}
            label={t('search.caseSensitive')}
          />
          <Toggle
            on={wholeWord}
            onToggle={() => { setWholeWord((v) => !v); }}
            icon={WholeWord}
            label={t('search.wholeWord')}
          />
          <Toggle
            on={useRegex}
            onToggle={() => { setUseRegex((v) => !v); }}
            icon={Regex}
            label={t('search.regex')}
          />
          <Toggle
            on={showReplace}
            onToggle={() => { setShowReplace((v) => !v); }}
            icon={Replace}
            label={t('search.toggleReplace')}
          />
          <span className="ml-auto text-[10px] tabular-nums text-muted-foreground">
            {allReady
              ? t('search.matchCount', { count: matches.length })
              : t('search.loading')}
          </span>
        </div>
        {showReplace ? (
          <>
            <Input
              value={replaceText}
              onChange={(e) => { setReplaceText(e.target.value); }}
              placeholder={t('search.replacePlaceholder')}
              className="h-7 text-xs"
            />
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] text-muted-foreground">
                {activeFileHits > 0
                  ? t('search.activeFileSkipped', { count: activeFileHits })
                  : null}
              </span>
              <Button
                type="button"
                size="sm"
                className="h-7 px-2 text-xs"
                disabled={replaceableHits === 0 || replaceMutation.isPending || query === ''}
                onClick={() => {
                  if (window.confirm(t('search.replaceConfirm', { count: replaceableHits }))) {
                    replaceMutation.mutate();
                  }
                }}
              >
                {replaceMutation.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                ) : null}
                {t('search.replaceAll', { count: replaceableHits })}
              </Button>
            </div>
          </>
        ) : null}
      </form>
      <div className="flex-1 overflow-y-auto p-1.5 text-xs">
        {query === '' ? (
          <p className="px-2 py-3 text-center text-muted-foreground">{t('search.empty')}</p>
        ) : !allReady ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden="true" />
          </div>
        ) : matches.length === 0 ? (
          <p className="px-2 py-3 text-center text-muted-foreground">{t('search.noMatches')}</p>
        ) : (
          <ul className="space-y-1.5">
            {[...fileGroups.entries()].map(([fileId, groupMatches]) => {
              const file = searchable.find((f) => f.id === fileId);
              if (file === undefined || groupMatches.length === 0) return null;
              return (
                <li key={fileId} className="rounded border bg-card">
                  <div className="flex items-center gap-1.5 border-b bg-muted/40 px-2 py-1">
                    <FileText className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate font-mono text-[10px]" title={file.path}>
                      {file.path}
                    </span>
                    <span className="text-[10px] tabular-nums text-muted-foreground">
                      {groupMatches.length}
                    </span>
                  </div>
                  <ul>
                    {groupMatches.slice(0, 50).map((m, i) => (
                      <li key={`${m.line}-${m.column}-${String(i)}`}>
                        <button
                          type="button"
                          className="flex w-full gap-2 px-2 py-0.5 text-left hover:bg-muted/40"
                          onClick={() => { onSelectFile(file, m.line); }}
                        >
                          <span className="w-8 shrink-0 text-right font-mono text-[10px] text-muted-foreground">
                            {m.line}
                          </span>
                          <span className="min-w-0 flex-1 truncate font-mono text-[10px]">
                            {m.lineText.slice(0, Math.max(0, m.column - 1))}
                            <mark className="bg-yellow-200/70 px-0.5 dark:bg-yellow-500/30">
                              {m.lineText.slice(m.column - 1, m.column - 1 + m.matchLength)}
                            </mark>
                            {m.lineText.slice(m.column - 1 + m.matchLength)}
                          </span>
                        </button>
                      </li>
                    ))}
                    {groupMatches.length > 50 ? (
                      <li className="px-2 py-1 text-[10px] text-muted-foreground">
                        {t('search.moreHits', { count: groupMatches.length - 50 })}
                      </li>
                    ) : null}
                  </ul>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}

function Toggle({
  on,
  onToggle,
  icon: Icon,
  label,
}: {
  readonly on: boolean;
  readonly onToggle: () => void;
  readonly icon: typeof CaseSensitive;
  readonly label: string;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      title={label}
      aria-label={label}
      aria-pressed={on}
      className={`flex h-6 w-6 items-center justify-center rounded transition-colors ${
        on ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-muted'
      }`}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
    </button>
  );
}
