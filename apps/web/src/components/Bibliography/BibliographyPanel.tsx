import { type BibEntry, bibEntryPreview, type ProjectFile, type ProjectId } from '@scribe/shared';
import { Button, Input } from '@scribe/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { BookText, Copy, Loader2, Plus, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { api, type ApiError } from '../../lib/api';

interface BibliographyPanelProps {
  readonly projectId: ProjectId;
  readonly files: readonly ProjectFile[];
  readonly entries: readonly BibEntry[];
  readonly onCite: (key: string) => void;
  readonly onClose: () => void;
}

export function BibliographyPanel({
  projectId,
  files,
  entries,
  onCite,
  onClose,
}: BibliographyPanelProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState<string>('');
  const [adding, setAdding] = useState<boolean>(false);
  const [draft, setDraft] = useState<string>(
    '@article{citekey,\n  author = {Last, First},\n  title = {The title},\n  year = {2026},\n  journal = {Journal}\n}\n',
  );

  const bibFile = useMemo(
    () => files.find((f) => f.type === 'bib' || f.path.endsWith('.bib')),
    [files],
  );

  const filtered = useMemo(() => {
    if (search.trim() === '') return entries;
    const q = search.toLowerCase();
    return entries.filter((e) =>
      e.key.toLowerCase().includes(q) ||
      (e.fields.author ?? '').toLowerCase().includes(q) ||
      (e.fields.title ?? '').toLowerCase().includes(q),
    );
  }, [entries, search]);

  const appendMutation = useMutation<unknown, ApiError, string>({
    mutationFn: async (snippet) => {
      if (bibFile === undefined) {
        throw new Error(t('bibliography.noBibFile'));
      }
      const current = await api.files.readContent(projectId, bibFile.id);
      const trimmed = current.content.trimEnd();
      const next = trimmed === '' ? snippet : `${trimmed}\n\n${snippet}\n`;
      await api.files.writeContent(projectId, bibFile.id, next);
    },
    onSuccess: async () => {
      setAdding(false);
      toast.success(t('bibliography.added'));
      await queryClient.invalidateQueries({ queryKey: ['bib-entries', projectId] });
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  return (
    <div className="flex h-full w-full flex-col bg-background">
      <div className="flex items-center justify-between border-b px-3 py-2">
        <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <BookText className="h-3.5 w-3.5" aria-hidden="true" />
          {t('bibliography.title')}
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

      <div className="border-b p-2">
        <Input
          placeholder={t('bibliography.searchPlaceholder')}
          value={search}
          onChange={(e) => { setSearch(e.target.value); }}
          className="h-8 text-xs"
        />
      </div>

      <div className="flex-1 overflow-auto">
        {bibFile === undefined ? (
          <p className="p-3 text-xs text-muted-foreground">{t('bibliography.noBibFile')}</p>
        ) : filtered.length === 0 ? (
          <p className="p-3 text-xs text-muted-foreground">
            {search === ''
              ? t('bibliography.empty')
              : t('bibliography.noMatch', { query: search })}
          </p>
        ) : (
          <ul className="space-y-px p-2">
            {filtered.map((entry) => (
              <li key={entry.key} className="group rounded-md px-2 py-1.5 hover:bg-accent/60">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-mono">{entry.key}</div>
                    <div className="truncate text-[10px] text-muted-foreground">
                      {bibEntryPreview(entry)}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100"
                    aria-label={t('bibliography.cite', { key: entry.key })}
                    onClick={() => { onCite(entry.key); }}
                    title={t('bibliography.cite', { key: entry.key })}
                  >
                    <Copy className="h-3 w-3 text-muted-foreground hover:text-foreground" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="border-t p-2">
        {!adding ? (
          <Button
            size="sm"
            variant="outline"
            className="w-full gap-1.5"
            onClick={() => { setAdding(true); }}
            disabled={bibFile === undefined}
          >
            <Plus className="h-3 w-3" aria-hidden="true" />
            {t('bibliography.add')}
          </Button>
        ) : (
          <div className="space-y-2">
            <textarea
              className="w-full rounded-md border bg-background p-2 font-mono text-[10px]"
              rows={7}
              value={draft}
              onChange={(e) => { setDraft(e.target.value); }}
            />
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={() => { appendMutation.mutate(draft); }}
                disabled={appendMutation.isPending || draft.trim().length === 0}
                className="gap-1.5"
              >
                {appendMutation.isPending ? (
                  <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                ) : null}
                {t('bibliography.save')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => { setAdding(false); }}>
                {t('common.cancel')}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
