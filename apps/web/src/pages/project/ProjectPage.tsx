import { type Project, type ProjectFile, projectIdSchema } from '@scribe/shared';
import { Button, Sheet, SheetContent, SheetTrigger } from '@scribe/ui';
import { useQuery } from '@tanstack/react-query';
import { Loader2, Settings as SettingsIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router-dom';

import { api, type ApiError } from '../../lib/api';

import { FileTree } from './FileTree';
import { ProjectSettingsSheet } from './ProjectSettingsSheet';
import { ProjectWorkspace } from './ProjectWorkspace';

export function ProjectPage() {
  const { t } = useTranslation();
  const { projectId: rawId } = useParams<{ projectId: string }>();
  const projectId = rawId !== undefined ? projectIdSchema.parse(rawId) : null;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [selectedFileId, setSelectedFileId] = useState<ProjectFile['id'] | null>(null);

  const {
    data: project,
    isLoading,
    error,
  } = useQuery<Project, ApiError>({
    queryKey: ['project', projectId],
    enabled: projectId !== null,
    queryFn: () => {
      if (projectId === null) throw new Error('projectId is null');
      return api.projects.get(projectId);
    },
  });

  const filesQuery = useQuery<ProjectFile[], ApiError>({
    queryKey: ['files', projectId],
    enabled: projectId !== null,
    queryFn: () => {
      if (projectId === null) throw new Error('projectId is null');
      return api.files.list(projectId);
    },
  });

  // Auto-select main.tex (or first .tex file) when the file list loads.
  useEffect(() => {
    if (selectedFileId !== null) return;
    const files = filesQuery.data ?? [];
    if (files.length === 0) return;
    const mainFile =
      files.find((f) => f.path === project?.mainFile) ??
      files.find((f) => f.path.endsWith('.tex')) ??
      files[0];
    if (mainFile !== undefined) setSelectedFileId(mainFile.id);
  }, [filesQuery.data, project?.mainFile, selectedFileId]);

  if (isLoading) {
    return (
      <div className="flex h-[calc(100vh-3.5rem)] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" aria-hidden="true" />
      </div>
    );
  }

  if (error !== null || project === undefined || projectId === null) {
    return (
      <div className="container py-8">
        <p className="text-sm text-destructive">{error?.body.message ?? t('errors.generic')}</p>
      </div>
    );
  }

  const files = filesQuery.data ?? [];
  const selectedFile = files.find((f) => f.id === selectedFileId) ?? null;

  return (
    <div className="flex h-[calc(100vh-3.5rem)]">
      <aside className="flex w-64 flex-col border-r bg-muted/30">
        <div className="flex items-center justify-between border-b p-3">
          <h2 className="truncate text-sm font-semibold" title={project.name}>
            {project.name}
          </h2>
          <Sheet open={settingsOpen} onOpenChange={setSettingsOpen}>
            <SheetTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t('project.projectSettings')}
                className="h-7 w-7"
              >
                <SettingsIcon className="h-4 w-4" />
              </Button>
            </SheetTrigger>
            <SheetContent className="w-full sm:max-w-md">
              <ProjectSettingsSheet
                project={project}
                onClosed={() => {
                  setSettingsOpen(false);
                }}
              />
            </SheetContent>
          </Sheet>
        </div>
        <div className="flex-1 overflow-auto p-2">
          <FileTree
            projectId={projectId}
            selectedFileId={selectedFileId}
            onSelect={(file) => {
              setSelectedFileId(file.id);
            }}
          />
        </div>
      </aside>
      <section className="flex-1 overflow-hidden">
        <ProjectWorkspace
          project={project}
          files={files}
          selectedFile={selectedFile}
          onSelectFile={(file) => {
            setSelectedFileId(file.id);
          }}
        />
      </section>
    </div>
  );
}
