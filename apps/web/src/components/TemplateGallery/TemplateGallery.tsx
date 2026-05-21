import {
  type ProjectTemplate,
  type ProjectTemplateCategory,
  TEMPLATE_METADATA,
} from '@scribe/shared';
import { Input } from '@scribe/ui';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

interface TemplateGalleryProps {
  readonly selected: ProjectTemplate;
  readonly onSelect: (template: ProjectTemplate) => void;
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

  const templates = useMemo(() => {
    const all = Object.values(TEMPLATE_METADATA);
    const filtered = all.filter((m) => category === 'all' || m.category === category);
    if (search.trim() === '') return filtered;
    const q = search.toLowerCase();
    return filtered.filter((m) =>
      t(m.labelKey).toLowerCase().includes(q) ||
      t(m.descriptionKey).toLowerCase().includes(q),
    );
  }, [category, search, t]);

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
      <ul className="grid max-h-80 grid-cols-2 gap-2 overflow-auto">
        {templates.map((m) => {
          const isSelected = selected === m.id;
          return (
            <li key={m.id}>
              <button
                type="button"
                aria-pressed={isSelected}
                className={`flex w-full items-start gap-3 rounded-lg border p-2.5 text-left transition-colors ${
                  isSelected ? 'border-primary bg-primary/10' : 'border-border hover:bg-accent/40'
                }`}
                onClick={() => { onSelect(m.id); }}
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
    </div>
  );
}
