import { useQuery } from '@tanstack/react-query';

import type { ProjectTemplateCategory } from '@scribe/shared';

/**
 * Community template — strictly client-side. The manifest lives at
 * `/community-templates.json` in the SPA's public folder; we never
 * ship template content through the server. Selecting a community
 * template in NewProjectDialog creates a blank project and seeds
 * its files via the existing `api.files.create` endpoint, so no
 * server-side support is required.
 */
export interface CommunityTemplate {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly category: ProjectTemplateCategory;
  readonly monogram: string;
  readonly accent: string;
  readonly mainFile: string;
  readonly files: readonly {
    readonly path: string;
    readonly content: string;
  }[];
}

const MANIFEST_URL = '/community-templates.json';

function isCommunityTemplate(value: unknown): value is CommunityTemplate {
  if (typeof value !== 'object' || value === null) return false;
  const t = value as {
    id?: unknown;
    name?: unknown;
    mainFile?: unknown;
    files?: unknown;
  };
  if (typeof t.id !== 'string') return false;
  if (typeof t.name !== 'string') return false;
  if (typeof t.mainFile !== 'string') return false;
  if (!Array.isArray(t.files)) return false;
  return (t.files as unknown[]).every((f) => {
    if (typeof f !== 'object' || f === null) return false;
    const file = f as { path?: unknown; content?: unknown };
    return typeof file.path === 'string' && typeof file.content === 'string';
  });
}

/** Cached fetch of the manifest. Stale-while-revalidate is fine —
 *  manifest content is curated; an hour-old copy isn't a problem. */
export function useCommunityTemplates() {
  return useQuery<readonly CommunityTemplate[]>({
    queryKey: ['community-templates'],
    queryFn: async () => {
      const res = await fetch(MANIFEST_URL, { cache: 'no-cache' });
      if (!res.ok) return [];
      const raw: unknown = await res.json();
      if (typeof raw !== 'object' || raw === null) return [];
      const candidate = raw as { templates?: unknown };
      if (!Array.isArray(candidate.templates)) return [];
      return (candidate.templates as unknown[]).filter(isCommunityTemplate);
    },
    staleTime: 60 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
}
