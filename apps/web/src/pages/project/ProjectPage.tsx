import { type Project, type ProjectFile, projectIdSchema } from '@scribe/shared';
import { Button, Sheet, SheetContent, SheetTrigger } from '@scribe/ui';
import { useQuery } from '@tanstack/react-query';
import { ChevronsLeft, Download, Loader2, Settings as SettingsIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router-dom';
import { type ImperativePanelHandle, Panel, PanelGroup } from 'react-resizable-panels';
import { toast } from 'sonner';

import { Splitter } from '../../components/Layout/Splitter';
import { api, type ApiError } from '../../lib/api';
import { log } from '../../lib/debug';
import { supabase } from '../../lib/supabase';
import { useProjectChrome } from '../../stores/projectChrome';

import { FileTree } from './FileTree';
import { ProjectSettingsSheet } from './ProjectSettingsSheet';
import { ProjectWorkspace } from './ProjectWorkspace';

export function ProjectPage() {
  const { t } = useTranslation();
  const { projectId: rawId } = useParams<{ projectId: string }>();
  const projectId = rawId !== undefined ? projectIdSchema.parse(rawId) : null;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [selectedFileId, setSelectedFileId] = useState<ProjectFile['id'] | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const sidebarRef = useRef<ImperativePanelHandle>(null);

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

  // Publish the active project + a hook for opening the settings sheet
  // so the AppShell can render the project name + actions in the navbar.
  const setChrome = useProjectChrome((s) => s.set);
  const clearChrome = useProjectChrome((s) => s.clear);
  useEffect(() => {
    if (project === undefined) return;
    setChrome({
      project,
      openSettings: () => { setSettingsOpen(true); },
    });
    return () => { clearChrome(); };
  }, [project, setChrome, clearChrome]);

  function toggleSidebar() {
    const panel = sidebarRef.current;
    if (panel === null) return;
    if (panel.isCollapsed()) {
      panel.expand();
    } else {
      panel.collapse();
    }
  }

  async function downloadZip() {
    if (projectId === null) return;
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token ?? '';
      const resp = await fetch(api.files.zipUrl(projectId), {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status.toString()}`);
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${project?.name ?? 'project'}.zip`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      // Was previously `window.alert` which is jarring and breaks
      // tests. Toast keeps the UX consistent with every other failure
      // path, and the underlying error goes to the categorised logger
      // for bug-report copy-paste.
      const msg = e instanceof Error ? e.message : String(e);
      log.api.error('zip download failed', e);
      toast.error(`Couldn't download project ZIP: ${msg}`);
    }
  }

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
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
    <div className="h-full">
      <PanelGroup
        direction="horizontal"
        autoSaveId="scribe:project-layout"
        className="h-full"
      >
        <Panel
          ref={sidebarRef}
          defaultSize={18}
          minSize={12}
          maxSize={35}
          collapsible
          collapsedSize={0}
          onCollapse={() => { setSidebarCollapsed(true); }}
          onExpand={() => { setSidebarCollapsed(false); }}
        >
          <aside className="flex h-full flex-col border-r bg-muted/30">
            <div className="flex items-center justify-between gap-2 border-b p-3">
              <h2 className="truncate text-sm font-semibold" title={project.name}>
                {project.name}
              </h2>
              <div className="flex items-center">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={() => { void downloadZip(); }}
                  aria-label={t('project.downloadZip')}
                  title={t('project.downloadZip')}
                >
                  <Download className="h-4 w-4" />
                </Button>
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
                      onClosed={() => { setSettingsOpen(false); }}
                    />
                  </SheetContent>
                </Sheet>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={toggleSidebar}
                  aria-label={t('project.collapseSidebar')}
                  title={t('project.collapseSidebar')}
                >
                  <ChevronsLeft className="h-4 w-4" />
                </Button>
              </div>
            </div>
            <div className="flex-1 overflow-auto p-2">
              <FileTree
                projectId={projectId}
                files={files}
                selectedFileId={selectedFileId}
                onSelect={(file) => { setSelectedFileId(file.id); }}
              />
            </div>
          </aside>
        </Panel>
        <Splitter orientation="vertical" />
        <Panel>
          <ProjectWorkspace
            project={project}
            files={files}
            selectedFile={selectedFile}
            onSelectFile={(file) => { setSelectedFileId(file.id); }}
            sidebarCollapsed={sidebarCollapsed}
            onExpandSidebar={toggleSidebar}
          />
        </Panel>
      </PanelGroup>
    </div>
  );
}
