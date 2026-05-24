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
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly content: string;
  }>;
}

interface ManifestShape {
  readonly version: number;
  readonly updatedAt: string;
  readonly templates: readonly CommunityTemplate[];
}

const MANIFEST_URL = '/community-templates.json';

/** Cached fetch of the manifest. Stale-while-revalidate is fine —
 *  manifest content is curated; an hour-old copy isn't a problem. */
export function useCommunityTemplates() {
  return useQuery<readonly CommunityTemplate[]>({
    queryKey: ['community-templates'],
    queryFn: async () => {
      const res = await fetch(MANIFEST_URL, { cache: 'no-cache' });
      if (!res.ok) return [];
      const data = (await res.json()) as Partial<ManifestShape>;
      if (!Array.isArray(data.templates)) return [];
      // Light client-side validation so a malformed manifest doesn't
      // crash the dialog. Drop entries missing required fields.
      return data.templates.filter(
        (t): t is CommunityTemplate =>
          typeof t.id === 'string' &&
          typeof t.name === 'string' &&
          typeof t.mainFile === 'string' &&
          Array.isArray(t.files) &&
          t.files.every(
            (f: { path: unknown; content: unknown }) =>
              typeof f.path === 'string' && typeof f.content === 'string',
          ),
      );
    },
    staleTime: 60 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
}
