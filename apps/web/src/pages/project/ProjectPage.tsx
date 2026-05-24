import {
  type FileId,
  type Project,
  type ProjectFile,
  type ProjectId,
  projectIdSchema,
} from '@scribe/shared';
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
import { type ImperativePanelHandle, Panel, PanelGroup } from 'react-resizable-panels';
import { useParams } from 'react-router-dom';

import { Splitter } from '../../components/Layout/Splitter';
import { PageError } from '../../components/PageError/PageError';
import { ExportMenuItems } from '../../components/ProjectActions/ExportMenuItems';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { api, type ApiError } from '../../lib/api';
import { type LocalFile, desktopDb } from '../../lib/desktopDb';
import { isTauri } from '../../lib/tauri';
import { useProjectChrome } from '../../stores/projectChrome';

import { FileTree } from './FileTree';
import { ProjectSettingsSheet } from './ProjectSettingsSheet';
import { ProjectWorkspace } from './ProjectWorkspace';

function localFileToProjectFile(f: LocalFile): ProjectFile {
  // Branded-id cast: the SQLite mirror stores plain strings; the
  // server's UUID-validated branding is preserved by construction
  // (every row originally arrived via api.files.list). `createdBy`
  // isn't mirrored — surfacing null is fine since the file tree
  // doesn't read it.
  return {
    id: f.id as FileId,
    projectId: f.projectId as ProjectId,
    path: f.path,
    type: f.type,
    sizeBytes: f.size ?? 0,
    createdBy: null,
    createdAt: f.createdAt,
    updatedAt: f.updatedAt,
  };
}

export function ProjectPage() {
  const { t } = useTranslation();
  const { projectId: rawId } = useParams<{ projectId: string }>();
  const projectId = rawId !== undefined ? projectIdSchema.parse(rawId) : null;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [selectedFileId, setSelectedFileId] = useState<ProjectFile['id'] | null>(null);
  // Ordered list of files the user has opened as tabs. The active tab
  // is `selectedFileId`; `openFileIds` always contains it (push-on-
  // select below). Persisted per-project to localStorage so a refresh
  // restores the same tab strip the user left open — matches the way
  // Overleaf and VS Code remember tabs.
  const tabsStorageKey = projectId !== null ? `scribe:tabs:${projectId}` : null;
  const [openFileIds, setOpenFileIds] = useState<readonly ProjectFile['id'][]>(() => {
    if (tabsStorageKey === null) return [];
    try {
      const raw = window.localStorage.getItem(tabsStorageKey);
      if (raw === null) return [];
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((v): v is ProjectFile['id'] => typeof v === 'string');
    } catch {
      return [];
    }
  });
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

  const projectQuery = useQuery<Project, ApiError>({
    queryKey: ['project', projectId],
    enabled: projectId !== null,
    queryFn: () => {
      if (projectId === null) throw new Error('projectId is null');
      return api.projects.get(projectId);
    },
  });
  const { data: project, isLoading, error } = projectQuery;

  useDocumentTitle(project?.name ?? null);

  const filesQuery = useQuery<ProjectFile[], ApiError>({
    queryKey: ['files', projectId],
    enabled: projectId !== null,
    queryFn: async () => {
      if (projectId === null) throw new Error('projectId is null');
      // Tauri + offline: serve from the local SQLite mirror so the
      // file tree still renders without network. Online (or in the
      // browser) keeps using the server as the source of truth; the
      // mirror gets refreshed by `syncManager.syncProject` on
      // project mount.
      if (isTauri() && typeof navigator !== 'undefined' && !navigator.onLine) {
        const local = await desktopDb.files.list(projectId);
        return local.map(localFileToProjectFile);
      }
      return api.files.list(projectId);
    },
  });

  // Auto-select the main file ONCE per project, on first load. Without
  // the ref guard, this effect would fight `closeTab` — closing the
  // last open tab sets selectedFileId to null, which would re-trigger
  // the auto-select and instantly re-open the main file. The guard
  // keeps "no tabs open" as a stable state.
  const autoSelectedRef = useRef(false);
  // Reset the auto-select guard when switching to a different project
  // — the route navigates between projects without unmounting the
  // page, so we need to re-run the bootstrap.
  useEffect(() => {
    autoSelectedRef.current = false;
  }, [projectId]);
  useEffect(() => {
    if (autoSelectedRef.current) return;
    if (selectedFileId !== null) {
      autoSelectedRef.current = true;
      return;
    }
    const files = filesQuery.data ?? [];
    if (files.length === 0) return;
    const mainFile =
      files.find((f) => f.path === project?.mainFile) ??
      files.find((f) => f.path.endsWith('.tex')) ??
      files[0];
    if (mainFile !== undefined) {
      setSelectedFileId(mainFile.id);
      autoSelectedRef.current = true;
    }
  }, [filesQuery.data, project?.mainFile, selectedFileId]);

  // Prune any stored tab IDs that no longer correspond to a file in
  // the project (file deleted between sessions). Without this the
  // tab strip would render dead tabs that crash when clicked.
  useEffect(() => {
    if (filesQuery.data === undefined) return;
    const valid = new Set(filesQuery.data.map((f) => f.id));
    setOpenFileIds((prev) => {
      const next = prev.filter((id) => valid.has(id));
      return next.length === prev.length ? prev : next;
    });
  }, [filesQuery.data]);

  // Whenever the active file changes (file-tree click, command
  // palette open, jump-to-error), make sure it's in the tab strip.
  // Appends to the end; if already open we keep its existing slot
  // so reordering doesn't surprise the user.
  useEffect(() => {
    if (selectedFileId === null) return;
    setOpenFileIds((prev) => (prev.includes(selectedFileId) ? prev : [...prev, selectedFileId]));
  }, [selectedFileId]);

  // Persist the tab list. The active file lives in route state via
  // setSelectedFileId; only the *order* of open tabs needs to live
  // in localStorage.
  useEffect(() => {
    if (tabsStorageKey === null) return;
    try {
      window.localStorage.setItem(tabsStorageKey, JSON.stringify(openFileIds));
    } catch {
      /* quota exceeded; the tab strip just won't restore */
    }
  }, [tabsStorageKey, openFileIds]);

  function closeTab(id: ProjectFile['id']) {
    setOpenFileIds((prev) => {
      const idx = prev.indexOf(id);
      if (idx === -1) return prev;
      const next = prev.slice(0, idx).concat(prev.slice(idx + 1));
      // If we're closing the active tab, move focus to the neighbour
      // (prefer the previous tab — same heuristic as VS Code). When
      // it was the last tab open, fall back to no selection so the
      // editor shows the empty state.
      if (id === selectedFileId) {
        const fallback = next[idx - 1] ?? next[idx] ?? null;
        setSelectedFileId(fallback);
      }
      return next;
    });
  }

  // Publish the active project + a hook for opening the settings sheet
  // so the AppShell can render the project name + actions in the navbar.
  const setChrome = useProjectChrome((s) => s.set);
  const clearChrome = useProjectChrome((s) => s.clear);
  useEffect(() => {
    if (project === undefined) return;
    setChrome({
      project,
      openSettings: () => {
        setSettingsOpen(true);
      },
    });
    return () => {
      clearChrome();
    };
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
      <PageError
        title={t('errors.couldntLoadProject')}
        {...(error?.body.message !== undefined ? { description: error.body.message } : {})}
        onRetry={() => {
          void projectQuery.refetch();
        }}
      />
    );
  }

  const files = filesQuery.data ?? [];
  const selectedFile = files.find((f) => f.id === selectedFileId) ?? null;
  const openFiles = openFileIds
    .map((id) => files.find((f) => f.id === id))
    .filter((f): f is ProjectFile => f !== undefined);

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
              onClosed={() => {
                setSettingsOpen(false);
              }}
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
      <PanelGroup direction="horizontal" autoSaveId="scribe:project-layout" className="h-full">
        {isMobileLayout ? null : (
          <>
            <Panel
              ref={sidebarRef}
              defaultSize={18}
              minSize={12}
              maxSize={35}
              collapsible
              collapsedSize={0}
              onCollapse={() => {
                setSidebarCollapsed(true);
              }}
              onExpand={() => {
                setSidebarCollapsed(false);
              }}
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
            onSelectFile={(file) => {
              setSelectedFileId(file.id);
            }}
            openFiles={openFiles}
            onCloseFile={(file) => {
              closeTab(file.id);
            }}
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
        <SheetContent side="left" hideCloseButton className="flex w-72 max-w-[85vw] flex-col p-0">
          {sidebarHeader}
          {sidebarFileTree}
        </SheetContent>
      </Sheet>
    </div>
  );
}
