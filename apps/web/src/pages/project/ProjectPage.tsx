import { type Project, type ProjectFile, projectIdSchema } from '@scribe/shared';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  Sheet,
  SheetContent,
  SheetTrigger,
} from '@scribe/ui';
import { useQuery } from '@tanstack/react-query';
import { ChevronsLeft, Download, Loader2, Settings as SettingsIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router-dom';
import { type ImperativePanelHandle, Panel, PanelGroup } from 'react-resizable-panels';

import { Splitter } from '../../components/Layout/Splitter';
import { ExportMenuItems } from '../../components/ProjectActions/ExportMenuItems';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { api, type ApiError } from '../../lib/api';
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
  // Below this width the resizable sidebar steals too much of the
  // editor's real estate (18% of 500px is 90px — unusable). Hide the
  // panel and surface the same content through a slide-in drawer so
  // the editor takes the full viewport on phones / narrow windows.
  const isMobileLayout = useMediaQuery('(max-width: 768px)');
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  // Close the drawer whenever we cross back into desktop layout so a
  // stale "open" doesn't persist when the user widens the window.
  useEffect(() => {
    if (!isMobileLayout && mobileSidebarOpen) setMobileSidebarOpen(false);
  }, [isMobileLayout, mobileSidebarOpen]);

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

  useDocumentTitle(project?.name ?? null);

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
    if (isMobileLayout) {
      setMobileSidebarOpen((open) => !open);
      return;
    }
    const panel = sidebarRef.current;
    if (panel === null) return;
    if (panel.isCollapsed()) {
      panel.expand();
    } else {
      panel.collapse();
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

  // Sidebar contents are the same in both layouts — the only thing
  // that differs is where they're mounted (resizable Panel vs Sheet).
  const sidebarHeader = (
    <div className="flex items-center justify-between gap-2 border-b p-3">
      <h2 className="truncate text-sm font-semibold" title={project.name}>
        {project.name}
      </h2>
      <div className="flex items-center">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              aria-label={t('export.menuLabel')}
              title={t('export.menuLabel')}
            >
              <Download className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[15rem]">
            <ExportMenuItems />
          </DropdownMenuContent>
        </DropdownMenu>
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
  );

  const sidebarFileTree = (
    <div className="flex-1 overflow-auto p-2">
      <FileTree
        projectId={projectId}
        files={files}
        selectedFileId={selectedFileId}
        onSelect={(file) => {
          setSelectedFileId(file.id);
          // Mobile: dismiss the drawer after picking a file. Desktop
          // panels stay open. Without this you'd have to manually
          // close the drawer to see the editor for the file you just
          // opened — annoying on phones.
          if (isMobileLayout) setMobileSidebarOpen(false);
        }}
      />
    </div>
  );

  return (
    <div className="h-full">
      <PanelGroup
        direction="horizontal"
        autoSaveId="scribe:project-layout"
        className="h-full"
      >
        {isMobileLayout ? null : (
          <>
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
                {sidebarHeader}
                {sidebarFileTree}
              </aside>
            </Panel>
            <Splitter orientation="vertical" />
          </>
        )}
        <Panel>
          <ProjectWorkspace
            project={project}
            files={files}
            selectedFile={selectedFile}
            onSelectFile={(file) => { setSelectedFileId(file.id); }}
            // On mobile the drawer is closed by default, so the
            // workspace's "expand sidebar" arrow needs to be visible
            // any time it can re-open the drawer. We pretend the
            // sidebar is collapsed when the drawer isn't open, which
            // surfaces the same chevron — wired to `toggleSidebar`,
            // which the new mobile-aware impl above resolves to the
            // drawer toggle instead of the Panel handle.
            sidebarCollapsed={isMobileLayout ? !mobileSidebarOpen : sidebarCollapsed}
            onExpandSidebar={toggleSidebar}
          />
        </Panel>
      </PanelGroup>

      {/* Mobile drawer for the sidebar. Mounted regardless of viewport
          state (cheap when closed) so a window resize while open
          doesn't strand it. */}
      <Sheet open={isMobileLayout && mobileSidebarOpen} onOpenChange={setMobileSidebarOpen}>
        <SheetContent
          side="left"
          hideCloseButton
          className="flex w-72 max-w-[85vw] flex-col p-0"
        >
          {sidebarHeader}
          {sidebarFileTree}
        </SheetContent>
      </Sheet>
    </div>
  );
}
