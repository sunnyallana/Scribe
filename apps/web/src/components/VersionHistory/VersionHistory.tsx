import { type ProjectId, type ProjectVersion, type VersionId } from '@scribe/shared';
import { Button, Skeleton } from '@scribe/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { diff_match_patch as DiffMatchPatch } from 'diff-match-patch';
import { CameraIcon, History, Loader2, RotateCcw, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { api, type ApiError } from '../../lib/api';

interface VersionHistoryProps {
  readonly projectId: ProjectId;
  readonly onClose: () => void;
}

export function VersionHistory({ projectId, onClose }: VersionHistoryProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [selectedVersionId, setSelectedVersionId] = useState<VersionId | null>(null);
  const [diffFile, setDiffFile] = useState<string | null>(null);

  const versionsQuery = useQuery<ProjectVersion[], ApiError>({
    queryKey: ['versions', projectId],
    queryFn: () => api.versions.list(projectId),
  });

  const snapshotMutation = useMutation<ProjectVersion, ApiError>({
    mutationFn: () => api.versions.snapshot(projectId, {}),
    onSuccess: async (version) => {
      toast.success(t('history.snapshotCreated', { count: version.fileCount }));
      await queryClient.invalidateQueries({ queryKey: ['versions', projectId] });
    },
    onError: (err) => {
      toast.error(err.body.message);
    },
  });

  const restoreMutation = useMutation<unknown, ApiError, VersionId>({
    mutationFn: (versionId) => api.versions.restore(projectId, versionId),
    onSuccess: async () => {
      toast.success(t('history.restored'));
      await queryClient.invalidateQueries();
    },
    onError: (err) => {
      toast.error(err.body.message);
    },
  });

  const versionPayloadQuery = useQuery({
    queryKey: ['version-payload', projectId, selectedVersionId],
    enabled: selectedVersionId !== null,
    queryFn: () => {
      if (selectedVersionId === null) throw new Error('no version');
      return api.versions.get(projectId, selectedVersionId);
    },
  });

  const diffHtml = useMemo(() => {
    if (versionPayloadQuery.data === undefined || diffFile === null) return null;
    const file = versionPayloadQuery.data.files.find((f) => f.path === diffFile);
    if (file === undefined) return null;
    // Compare snapshot to "" baseline; in a richer UI we'd diff against the
    // current Storage content. v1 just shows the snapshot itself with line
    // breaks preserved.
    const dmp = new DiffMatchPatch();
    const diffs = dmp.diff_main('', file.content);
    dmp.diff_cleanupSemantic(diffs);
    return diffs
      .map(([op, text]) => {
        const safe = text
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;');
        if (op === 1) return `<ins class="bg-emerald-100 dark:bg-emerald-900/30">${safe}</ins>`;
        if (op === -1) return `<del class="bg-rose-100 dark:bg-rose-900/30">${safe}</del>`;
        return safe;
      })
      .join('');
  }, [versionPayloadQuery.data, diffFile]);

  return (
    <div className="flex h-full w-96 flex-col border-l bg-background">
      <div className="flex items-center justify-between border-b px-3 py-2">
        <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <History className="h-3.5 w-3.5" aria-hidden="true" />
          {t('history.title')}
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
      <div className="border-b p-3">
        <Button
          size="sm"
          className="w-full gap-1.5"
          onClick={() => {
            snapshotMutation.mutate();
          }}
          disabled={snapshotMutation.isPending}
        >
          {snapshotMutation.isPending ? (
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
          ) : (
            <CameraIcon className="h-3 w-3" aria-hidden="true" />
          )}
          {t('history.snapshotNow')}
        </Button>
      </div>
      <div className="flex-1 overflow-auto">
        {versionsQuery.isLoading ? (
          <div className="p-3">
            <Skeleton className="h-10 w-full" />
          </div>
        ) : (versionsQuery.data ?? []).length === 0 ? (
          <p className="p-3 text-xs text-muted-foreground">{t('history.empty')}</p>
        ) : (
          <ul className="space-y-px p-2">
            {(versionsQuery.data ?? []).map((v) => {
              const isSelected = selectedVersionId === v.id;
              return (
                <li key={v.id}>
                  <button
                    type="button"
                    className={`w-full rounded px-2 py-1.5 text-left text-xs ${
                      isSelected ? 'bg-accent' : 'hover:bg-accent/60'
                    }`}
                    onClick={() => {
                      setSelectedVersionId(v.id);
                      setDiffFile(null);
                    }}
                  >
                    <div className="font-medium">
                      {v.label ?? new Date(v.createdAt).toLocaleString()}
                    </div>
                    <div className="text-[10px] text-muted-foreground">
                      {t('history.fileCount', { count: v.fileCount })}
                      {v.authorDisplayName !== null ? ` · ${v.authorDisplayName}` : ''}
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {selectedVersionId !== null ? (
        <div className="flex flex-col border-t" style={{ maxHeight: '50%' }}>
          <div className="flex items-center justify-between border-b p-2">
            <span className="text-xs font-medium">
              {versionPayloadQuery.data?.files.length ?? 0} {t('history.filesInVersion')}
            </span>
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5"
              onClick={() => {
                if (window.confirm(t('history.restoreConfirm'))) {
                  restoreMutation.mutate(selectedVersionId);
                }
              }}
              disabled={restoreMutation.isPending}
            >
              {restoreMutation.isPending ? (
                <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
              ) : (
                <RotateCcw className="h-3 w-3" aria-hidden="true" />
              )}
              {t('history.restore')}
            </Button>
          </div>
          <div className="flex-1 overflow-auto">
            {versionPayloadQuery.isLoading ? (
              <div className="p-3">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden="true" />
              </div>
            ) : (
              <div className="grid grid-cols-2 h-full">
                <ul className="space-y-px overflow-auto border-r p-2 text-xs">
                  {(versionPayloadQuery.data?.files ?? []).map((f) => (
                    <li key={f.path}>
                      <button
                        type="button"
                        className={`w-full rounded px-2 py-1 text-left ${
                          diffFile === f.path ? 'bg-accent' : 'hover:bg-accent/60'
                        }`}
                        onClick={() => {
                          setDiffFile(f.path);
                        }}
                      >
                        {f.path}
                      </button>
                    </li>
                  ))}
                </ul>
                <div className="overflow-auto p-2 font-mono text-[10px]">
                  {diffFile !== null && diffHtml !== null ? (
                    <pre
                      className="whitespace-pre-wrap break-words"
                      // eslint-disable-next-line react/no-danger
                      dangerouslySetInnerHTML={{ __html: diffHtml }}
                    />
                  ) : (
                    <p className="text-muted-foreground">{t('history.selectFile')}</p>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
