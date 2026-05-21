import { type ProjectFile, type ProjectId } from '@scribe/shared';
import { Button, Skeleton } from '@scribe/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText, Loader2, Trash2, Upload } from 'lucide-react';
import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { api, type ApiError } from '../../lib/api';

interface FileTreeProps {
  readonly projectId: ProjectId;
  readonly selectedFileId?: ProjectFile['id'] | null;
  readonly onSelect?: (file: ProjectFile) => void;
}

export function FileTree({ projectId, selectedFileId, onSelect }: FileTreeProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data: files, isLoading } = useQuery<ProjectFile[], ApiError>({
    queryKey: ['files', projectId],
    queryFn: () => api.files.list(projectId),
  });

  const uploadMutation = useMutation<ProjectFile, ApiError, { path: string; file: File }>({
    mutationFn: ({ path, file }) => api.files.upload(projectId, path, file),
    onSuccess: async (file) => {
      await queryClient.invalidateQueries({ queryKey: ['files', projectId] });
      toast.success(t('project.fileUploaded', { path: file.path }));
    },
    onError: (error) => {
      toast.error(error.body.message);
    },
  });

  const deleteMutation = useMutation<unknown, ApiError, ProjectFile>({
    mutationFn: (file) => api.files.remove(projectId, file.id),
    onSuccess: async (_, file) => {
      await queryClient.invalidateQueries({ queryKey: ['files', projectId] });
      toast.success(t('project.fileDeleted', { path: file.path }));
    },
    onError: (error) => {
      toast.error(error.body.message);
    },
  });

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file === undefined) return;
    uploadMutation.mutate({ path: file.name, file });
    event.target.value = '';
  };

  const handleDelete = (file: ProjectFile) => {
    if (window.confirm(t('project.deleteFileConfirm', { path: file.path }))) {
      deleteMutation.mutate(file);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase text-muted-foreground">
          {t('project.files')}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          aria-label={t('project.uploadFile')}
          onClick={() => fileInputRef.current?.click()}
          disabled={uploadMutation.isPending}
        >
          {uploadMutation.isPending ? (
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
          ) : (
            <Upload className="h-3 w-3" aria-hidden="true" />
          )}
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          onChange={handleFileChange}
          aria-hidden="true"
        />
      </div>
      {isLoading ? (
        <div className="space-y-1">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-6 w-full" />
          ))}
        </div>
      ) : files === undefined || files.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t('project.noFiles')}</p>
      ) : (
        <ul className="space-y-px">
          {files.map((file) => {
            const isSelected = selectedFileId === file.id;
            return (
              <li
                key={file.id}
                className={`group flex items-center gap-2 rounded px-2 py-1 text-sm ${
                  isSelected ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/60'
                }`}
              >
                <button
                  type="button"
                  className="flex flex-1 items-center gap-2 truncate text-left"
                  onClick={() => onSelect?.(file)}
                  aria-current={isSelected ? 'true' : undefined}
                >
                  <FileText
                    className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <span className="flex-1 truncate">{file.path}</span>
                </button>
                <button
                  type="button"
                  onClick={() => { handleDelete(file); }}
                  className="opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100"
                  aria-label={t('common.delete')}
                  disabled={deleteMutation.isPending}
                >
                  <Trash2 className="h-3.5 w-3.5 text-muted-foreground hover:text-destructive" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
