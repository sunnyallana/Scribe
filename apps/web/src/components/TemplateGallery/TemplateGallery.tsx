import {
  type ProjectTemplate,
  type ProjectTemplateCategory,
  TEMPLATE_METADATA,
} from '@scribe/shared';
import { Input } from '@scribe/ui';
import { Users } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { type CommunityTemplate, useCommunityTemplates } from './useCommunityTemplates';

/** What the gallery returns when something is selected. Built-in
 *  templates pass through unchanged; community templates carry the
 *  full file list so NewProjectDialog can seed them after creating
 *  the empty project. */
export type TemplateSelection =
  | { readonly kind: 'builtin'; readonly id: ProjectTemplate }
  | { readonly kind: 'community'; readonly template: CommunityTemplate };

interface TemplateGalleryProps {
  /** The current selection, either built-in or community. */
  readonly selected: TemplateSelection;
  readonly onSelect: (next: TemplateSelection) => void;
}

const CATEGORIES: readonly (ProjectTemplateCategory | 'all')[] = [
  'all',
  'general',
  'academic',
  'presentation',
  'personal',
];

export function TemplateGallery({ selected, onSelect }: TemplateGalleryProps) {
  const { t } = useTranslation();
  const [category, setCategory] = useState<ProjectTemplateCategory | 'all'>('all');
  const [search, setSearch] = useState<string>('');
  const communityQuery = useCommunityTemplates();

  const builtins = useMemo(() => {
    const all = Object.values(TEMPLATE_METADATA);
    const filtered = all.filter((m) => category === 'all' || m.category === category);
    if (search.trim() === '') return filtered;
    const q = search.toLowerCase();
    return filtered.filter((m) =>
      t(m.labelKey).toLowerCase().includes(q) ||
      t(m.descriptionKey).toLowerCase().includes(q),
    );
  }, [category, search, t]);

  const community = useMemo(() => {
    const all = communityQuery.data ?? [];
    const filtered = all.filter((m) => category === 'all' || m.category === category);
    if (search.trim() === '') return filtered;
    const q = search.toLowerCase();
    return filtered.filter((m) =>
      m.name.toLowerCase().includes(q) ||
      m.description.toLowerCase().includes(q),
    );
  }, [category, search, communityQuery.data]);

  const builtinSelectedId = selected.kind === 'builtin' ? selected.id : null;
  const communitySelectedId = selected.kind === 'community' ? selected.template.id : null;

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <Input
          value={search}
          onChange={(e) => { setSearch(e.target.value); }}
          placeholder={t('project.gallerySearch')}
          className="flex-1 h-8 text-xs"
        />
      </div>
      <div className="flex flex-wrap gap-1">
        {CATEGORIES.map((c) => (
          <button
            key={c}
            type="button"
            className={`rounded-full px-2.5 py-0.5 text-[10px] uppercase tracking-wide ${
              category === c
                ? 'bg-foreground text-background'
                : 'bg-muted text-muted-foreground hover:bg-muted/80'
            }`}
            onClick={() => { setCategory(c); }}
          >
            {t(`project.galleryCategory.${c}`)}
          </button>
        ))}
      </div>
      <div className="max-h-80 space-y-3 overflow-auto">
        {builtins.length > 0 ? (
          <ul className="grid grid-cols-2 gap-2">
            {builtins.map((m) => {
              const isSelected = builtinSelectedId === m.id;
              return (
                <li key={m.id}>
                  <button
                    type="button"
                    aria-pressed={isSelected}
                    className={`flex w-full items-start gap-3 rounded-lg border p-2.5 text-left transition-colors ${
                      isSelected ? 'border-primary bg-primary/10' : 'border-border hover:bg-accent/40'
                    }`}
                    onClick={() => { onSelect({ kind: 'builtin', id: m.id }); }}
                  >
                    <div
                      aria-hidden="true"
                      className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-md font-mono text-sm text-white"
                      style={{ backgroundColor: m.accent }}
                    >
                      {m.monogram}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs font-medium">{t(m.labelKey)}</div>
                      <div className="line-clamp-2 text-[10px] text-muted-foreground">
                        {t(m.descriptionKey)}
                      </div>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}
        {community.length > 0 ? (
          <div className="space-y-1.5">
            <h4 className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              <Users className="h-3 w-3" aria-hidden="true" />
              {t('project.galleryCommunity')}
            </h4>
            <ul className="grid grid-cols-2 gap-2">
              {community.map((m) => {
                const isSelected = communitySelectedId === m.id;
                return (
                  <li key={m.id}>
                    <button
                      type="button"
                      aria-pressed={isSelected}
                      title={m.description}
                      className={`flex w-full items-start gap-3 rounded-lg border p-2.5 text-left transition-colors ${
                        isSelected ? 'border-primary bg-primary/10' : 'border-border hover:bg-accent/40'
                      }`}
                      onClick={() => { onSelect({ kind: 'community', template: m }); }}
                    >
                      <div
                        aria-hidden="true"
                        className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-md font-mono text-sm text-white"
                        style={{ backgroundColor: m.accent }}
                      >
                        {m.monogram}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-xs font-medium">{m.name}</div>
                        <div className="line-clamp-2 text-[10px] text-muted-foreground">
                          {m.description}
                        </div>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}
        {builtins.length === 0 && community.length === 0 ? (
          <p className="text-center text-xs text-muted-foreground">
            {t('project.galleryEmpty')}
          </p>
        ) : null}
      </div>
    </div>
  );
}
