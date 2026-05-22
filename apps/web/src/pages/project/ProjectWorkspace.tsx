import {
  type BibEntry,
  type CompileJob,
  type CompileLogEntryDTO,
  parseBibTeX,
  type Project,
  type ProjectFile,
  type ProjectId,
} from '@scribe/shared';
import { Button } from '@scribe/ui';
import { type PresenceUser } from '@scribe/yjs-provider';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BookText,
  CameraIcon,
  ChevronsRight,
  Command,
  FileText,
  History,
  ListTree,
  Loader2,
  MessageSquare,
  Play,
  Sigma,
  Sparkles,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Panel, PanelGroup } from 'react-resizable-panels';
import { toast } from 'sonner';

import { Splitter } from '../../components/Layout/Splitter';

import { AIChat } from '../../components/AIChat/AIChat';
import { AICommandPalette } from '../../components/AICommandPalette/AICommandPalette';
import { BibliographyPanel } from '../../components/Bibliography/BibliographyPanel';
import { CommandPalette, type CommandItem } from '../../components/CommandPalette/CommandPalette';
import { CompileLog } from '../../components/CompileLog/CompileLog';
import { MathPalette } from '../../components/MathPalette/MathPalette';
import { OutlinePanel } from '../../components/Outline/OutlinePanel';
import { LatexEditor, type LatexEditorImperativeHandle } from '../../components/Editor/LatexEditor';
import { PresenceAvatars } from '../../components/Editor/PresenceAvatars';
import { PDFPreview } from '../../components/PDFPreview/PDFPreview';
import { StatusBar, type CompileStatusKind } from '../../components/StatusBar/StatusBar';
import { ReviewPanel } from '../../components/ReviewPanel/ReviewPanel';
import { VersionHistory } from '../../components/VersionHistory/VersionHistory';
import { useCompileSession } from '../../hooks/useCompileSession';
import { lookup, lookupReverse, useSyncTeX } from '../../hooks/useSyncTeX';
import { useYjsDoc } from '../../hooks/useYjsDoc';
import { api, type ApiError } from '../../lib/api';
import { useAuthStore } from '../../stores/auth';
import { useSettings } from '../../stores/settings';

import type { AutocompleteSources } from '@scribe/editor';

interface ProjectWorkspaceProps {
  readonly project: Project;
  readonly files: readonly ProjectFile[];
  readonly selectedFile: ProjectFile | null;
  readonly onSelectFile: (file: ProjectFile) => void;
  readonly sidebarCollapsed?: boolean;
  readonly onExpandSidebar?: () => void;
}

const SAVE_DEBOUNCE_MS = 2000;
const COLLAB_TIMEOUT_MS = 2500;

function isTexFile(file: ProjectFile): boolean {
  return file.type === 'tex' || file.path.endsWith('.tex');
}

/** True for any plain-text file the editor can usefully open. Images and
 *  PDFs are non-textual; everything else (.tex, .bib, .cls, .sty, .bst,
 *  .csv, README, …) is fair game. */
function isEditableTextFile(file: ProjectFile): boolean {
  if (file.type === 'image') return false;
  const lower = file.path.toLowerCase();
  const BINARY_EXT = ['.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.eps', '.zip'];
  return !BINARY_EXT.some((ext) => lower.endsWith(ext));
}

type RightPanelId = 'outline' | 'review' | 'history' | 'bibliography' | 'ai-chat' | 'math' | null;

const PRESENCE_COLORS = [
  '#3b82f6',
  '#22c55e',
  '#f97316',
  '#a855f7',
  '#ef4444',
  '#14b8a6',
  '#eab308',
  '#ec4899',
] as const;

function colorForUser(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i += 1) {
    hash = (hash * 31 + userId.charCodeAt(i)) | 0;
  }
  const idx = Math.abs(hash) % PRESENCE_COLORS.length;
  return PRESENCE_COLORS[idx] ?? PRESENCE_COLORS[0] ?? '#3b82f6';
}

export function ProjectWorkspace({
  project,
  files,
  selectedFile,
  onSelectFile,
  sidebarCollapsed = false,
  onExpandSidebar,
}: ProjectWorkspaceProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const projectId: ProjectId = project.id;
  const authUser = useAuthStore((s) => s.user);

  const [editorContent, setEditorContent] = useState<string>('');
  const [labels, setLabels] = useState<readonly string[]>([]);
  const [cursorLine, setCursorLine] = useState<number>(1);
  const [cursorCol, setCursorCol] = useState<number>(1);
  const [rightPanel, setRightPanel] = useState<RightPanelId>(null);
  const [aiPaletteOpen, setAIPaletteOpen] = useState(false);
  const [cmdPaletteOpen, setCmdPaletteOpen] = useState(false);

  function toggleRightPanel(id: NonNullable<RightPanelId>) {
    setRightPanel((current) => (current === id ? null : id));
  }
  const compileSession = useCompileSession(projectId);
  const synctex = useSyncTeX(compileSession.synctexUrl);
  const editorRef = useRef<LatexEditorImperativeHandle>(null);

  // Ctrl/Cmd+Shift+A → AI palette. Ctrl/Cmd+K → global command palette.
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.shiftKey && (e.key === 'A' || e.key === 'a')) {
        e.preventDefault();
        if (aiPaletteOpen) {
          setAIPaletteOpen(false);
        } else {
          setAISelection(editorRef.current?.getSelection() ?? '');
          setAIPaletteOpen(true);
        }
      } else if (mod && !e.shiftKey && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setCmdPaletteOpen((v) => !v);
      }
    }
    window.addEventListener('keydown', handler);
    return () => { window.removeEventListener('keydown', handler); };
  }, [aiPaletteOpen]);

  const [aiSelection, setAISelection] = useState<string>('');

  const handleAIInsert = useCallback((text: string) => {
    editorRef.current?.insertAtCursor(text);
  }, []);

  const openAIPalette = useCallback(() => {
    setAISelection(editorRef.current?.getSelection() ?? '');
    setAIPaletteOpen(true);
  }, []);

  const localUser = useMemo<PresenceUser | null>(() => {
    if (authUser === null) return null;
    const displayName =
      typeof authUser.user_metadata.display_name === 'string'
        ? authUser.user_metadata.display_name
        : authUser.email ?? 'User';
    return {
      userId: authUser.id,
      displayName,
      color: colorForUser(authUser.id),
    };
  }, [authUser]);

  const yjs = useYjsDoc(projectId, selectedFile?.id ?? null, localUser);

  const fileContent = useQuery({
    queryKey: ['file-content', projectId, selectedFile?.id],
    enabled: selectedFile !== null,
    queryFn: () => {
      if (selectedFile === null) throw new Error('no file selected');
      return api.files.readContent(projectId, selectedFile.id);
    },
  });

  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const writeMutation = useMutation<unknown, ApiError, { fileId: ProjectFile['id']; content: string }>({
    mutationFn: ({ fileId, content }) => api.files.writeContent(projectId, fileId, content),
    onSuccess: () => {
      setLastSavedAt(Date.now());
    },
    onError: (err) => {
      toast.error(err.body.message);
    },
  });

  useEffect(() => {
    if (fileContent.data !== undefined) {
      setEditorContent(fileContent.data.content);
      setLabels(extractLabelsFromText(fileContent.data.content));
    }
  }, [fileContent.data]);

  // `editorPrimed` is the React-visible signal that the editor is safe to
  // mount: Yjs has synced and Y.Text either already had content or we just
  // finished seeding it from Storage. We can't read `yText.length` directly
  // in render — Y.Text isn't a reactive proxy, so a seed insert never
  // triggers a re-render and the editor would stay stuck.
  const [editorPrimed, setEditorPrimed] = useState(false);
  // If Yjs hasn't synced after `COLLAB_TIMEOUT_MS`, fall back to solo mode
  // so a broken websocket doesn't permanently block the editor.
  const [collabTimedOut, setCollabTimedOut] = useState(false);

  useEffect(() => {
    setEditorPrimed(false);
    setCollabTimedOut(false);
  }, [selectedFile?.id]);

  useEffect(() => {
    if (yjs.synced) return;
    const id = window.setTimeout(() => { setCollabTimedOut(true); }, COLLAB_TIMEOUT_MS);
    return () => { window.clearTimeout(id); };
  }, [yjs.synced, selectedFile?.id]);

  useEffect(() => {
    if (editorPrimed) return;
    if (!yjs.synced || yjs.yText === null) return;
    if (fileContent.data === undefined) return;
    if (yjs.yText.length === 0 && fileContent.data.content.length > 0) {
      yjs.yText.insert(0, fileContent.data.content);
    }
    setEditorPrimed(true);
  }, [editorPrimed, yjs.synced, yjs.yText, fileContent.data]);

  // Parse all .bib files in the project; cache entries + keys.
  const bibContents = useQuery({
    queryKey: ['bib-entries', projectId],
    queryFn: async () => {
      const bibFiles = files.filter((f) => f.type === 'bib' || f.path.endsWith('.bib'));
      const results = await Promise.allSettled(
        bibFiles.map((f) => api.files.readContent(projectId, f.id)),
      );
      const entries: BibEntry[] = [];
      for (const r of results) {
        if (r.status === 'fulfilled') {
          entries.push(...parseBibTeX(r.value.content));
        }
      }
      return entries;
    },
  });

  const bibEntries = bibContents.data ?? [];
  const autocomplete: AutocompleteSources = useMemo(
    () => ({
      labels,
      citations: bibEntries.map((e) => e.key),
    }),
    [labels, bibEntries],
  );

  // Debounced auto-save: writes content back to Storage on idle.
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const liveCompile = useSettings((s) => s.editor.liveCompile);
  const liveCompileDelayMs = useSettings((s) => s.editor.liveCompileDelayMs);
  const liveCompileTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleChange = useCallback(
    (next: string) => {
      setEditorContent(next);
      setLabels(extractLabelsFromText(next));
      if (selectedFile === null) return;
      if (saveTimerRef.current !== null) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        writeMutation.mutate({ fileId: selectedFile.id, content: next });
      }, SAVE_DEBOUNCE_MS);
      if (liveCompile) {
        if (liveCompileTimerRef.current !== null) clearTimeout(liveCompileTimerRef.current);
        liveCompileTimerRef.current = setTimeout(() => {
          void handleCompile();
        }, liveCompileDelayMs);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedFile, writeMutation, liveCompile, liveCompileDelayMs],
  );

  const handleSave = useCallback(() => {
    if (selectedFile === null) return;
    if (saveTimerRef.current !== null) clearTimeout(saveTimerRef.current);
    writeMutation.mutate(
      { fileId: selectedFile.id, content: editorContent },
      {
        onSuccess: () => { toast.success(t('compile.saved')); },
      },
    );
  }, [editorContent, selectedFile, writeMutation, t]);

  const handleCompile = useCallback(async () => {
    if (selectedFile !== null) {
      // Force-save before compile so the worker sees latest content.
      if (saveTimerRef.current !== null) clearTimeout(saveTimerRef.current);
      try {
        await api.files.writeContent(projectId, selectedFile.id, editorContent);
      } catch (err) {
        if (err instanceof Error) toast.error(err.message);
        return;
      }
    }
    await compileSession.compile(project.mainFile);
    await queryClient.invalidateQueries({ queryKey: ['compiles', projectId] });
  }, [compileSession, editorContent, project.mainFile, projectId, queryClient, selectedFile]);

  const handleJumpTo = useCallback(
    (filePath: string, line: number) => {
      const target = files.find(
        (f) => f.path === filePath || f.path === filePath.replace(/^\.\//, ''),
      );
      if (target !== undefined && target.id !== selectedFile?.id) {
        onSelectFile(target);
        // Defer until the file loads — best-effort jump.
        setTimeout(() => editorRef.current?.gotoLine(line), 200);
      } else {
        editorRef.current?.gotoLine(line);
      }
    },
    [files, selectedFile, onSelectFile],
  );

  const handleInverseSync = useCallback(
    (page: number, x: number, y: number) => {
      const loc = lookupReverse(synctex.index, page, x, y);
      if (loc === null) {
        toast.info(t('compile.inverseSyncMiss'));
        return;
      }
      // Switch file if needed, then jump-and-flash. The 200ms inside
      // handleJumpTo waits for the new file's editor to mount before
      // invoking gotoLine; we replicate the same delay here so the flash
      // happens in the *target* file's editor instance.
      const target = files.find(
        (f) => f.path === loc.filename || f.path === loc.filename.replace(/^\.\//, ''),
      );
      if (target !== undefined && target.id !== selectedFile?.id) {
        onSelectFile(target);
        setTimeout(() => editorRef.current?.gotoLine(loc.line, { flash: true }), 220);
      } else {
        editorRef.current?.gotoLine(loc.line, { flash: true });
      }
    },
    [synctex.index, files, selectedFile, onSelectFile, t],
  );

  const logEntries = compileSession.entries;

  const highlight = useMemo(() => {
    if (selectedFile === null || synctex.index === null) return null;
    return lookup(synctex.index, selectedFile.path, cursorLine);
  }, [selectedFile, synctex.index, cursorLine]);

  const collab = useMemo(
    () =>
      !collabTimedOut && yjs.yText !== null && yjs.awareness !== null
        ? { yText: yjs.yText, awareness: yjs.awareness }
        : null,
    [collabTimedOut, yjs.yText, yjs.awareness],
  );

  // Editor mounts once we have content to render:
  //   • Collab path: Yjs synced and we've finished seeding Y.Text (or
  //     confirmed it already has content), tracked by `editorPrimed`.
  //   • Collab-off path (timeout fallback or no collab session): just wait
  //     for fileContent to finish loading.
  const editorReadyNow =
    selectedFile !== null &&
    isEditableTextFile(selectedFile) &&
    (collab !== null ? editorPrimed : !fileContent.isLoading);

  // Sticky: once we've shown the editor for a given file, don't fall back
  // to the spinner because `collab` flipped from null → set mid-load. The
  // LatexEditor internally rebuilds its CodeMirror view when `collab`
  // changes, so the swap is seamless without unmounting our wrapper.
  const [stickyReadyFileId, setStickyReadyFileId] = useState<string | null>(null);
  useEffect(() => {
    if (editorReadyNow && selectedFile !== null) {
      setStickyReadyFileId(selectedFile.id);
    }
  }, [editorReadyNow, selectedFile?.id]);
  const editorReady =
    editorReadyNow ||
    (selectedFile !== null && stickyReadyFileId === selectedFile.id);

  const commandList = useMemo<CommandItem[]>(() => {
    const cmds: CommandItem[] = [
      {
        id: 'compile',
        label: t('command.compile'),
        group: t('command.groupActions'),
        icon: Play,
        hint: 'Ctrl+Enter',
        keywords: ['compile', 'build', 'run', 'pdf'],
        action: () => { void handleCompile(); },
      },
      {
        id: 'ai-palette',
        label: t('command.aiAssist'),
        group: t('command.groupActions'),
        icon: Sparkles,
        hint: 'Ctrl+Shift+A',
        action: () => {
          setAISelection(editorRef.current?.getSelection() ?? '');
          setAIPaletteOpen(true);
        },
      },
      {
        id: 'outline',
        label: t('command.toggleOutline'),
        group: t('command.groupPanels'),
        icon: ListTree,
        action: () => { toggleRightPanel('outline'); },
      },
      {
        id: 'review',
        label: t('command.toggleReview'),
        group: t('command.groupPanels'),
        icon: MessageSquare,
        action: () => { toggleRightPanel('review'); },
      },
      {
        id: 'history',
        label: t('command.toggleHistory'),
        group: t('command.groupPanels'),
        icon: History,
        action: () => { toggleRightPanel('history'); },
      },
      {
        id: 'bibliography',
        label: t('command.toggleBibliography'),
        group: t('command.groupPanels'),
        icon: BookText,
        action: () => { toggleRightPanel('bibliography'); },
      },
      {
        id: 'ai-chat',
        label: t('command.toggleAIChat'),
        group: t('command.groupPanels'),
        icon: Sparkles,
        action: () => { toggleRightPanel('ai-chat'); },
      },
      {
        id: 'math',
        label: t('command.toggleMath'),
        group: t('command.groupPanels'),
        icon: Sigma,
        action: () => { toggleRightPanel('math'); },
      },
      {
        id: 'snapshot',
        label: t('command.snapshotNow'),
        group: t('command.groupActions'),
        icon: CameraIcon,
        action: () => {
          toggleRightPanel('history');
          // Best-effort: VersionHistory exposes the button; user clicks Snapshot.
        },
      },
    ];
    for (const f of files) {
      cmds.push({
        id: `open:${f.id}`,
        label: f.path,
        group: t('command.groupFiles'),
        icon: FileText,
        keywords: ['file', 'open', 'switch'],
        action: () => { onSelectFile(f); },
      });
    }
    return cmds;
  }, [files, handleCompile, onSelectFile, t]);

  const wordCount = useMemo(() => {
    if (editorContent === '') return 0;
    return editorContent
      .replace(/%.*$/gm, '')
      .replace(/\\[a-zA-Z@]+\*?(\{[^}]*\})?/g, ' ')
      .replace(/\$[^$\n]*\$/g, ' ')
      .trim()
      .split(/\s+/)
      .filter((w) => w.length > 0).length;
  }, [editorContent]);

  const saveStatusLabel = (() => {
    if (writeMutation.isPending) return t('project.saving');
    if (lastSavedAt !== null) {
      const ago = Math.round((Date.now() - lastSavedAt) / 1000);
      if (ago < 5) return t('project.saved');
    }
    return null;
  })();

  const editorPanel = (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 border-b bg-background px-3 py-1.5">
        <div className="flex min-w-0 items-center gap-2">
          {sidebarCollapsed && onExpandSidebar !== undefined ? (
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 shrink-0"
              onClick={onExpandSidebar}
              aria-label={t('project.expandSidebar')}
              title={t('project.expandSidebar')}
            >
              <ChevronsRight className="h-3.5 w-3.5" aria-hidden="true" />
            </Button>
          ) : null}
          <span className="truncate text-sm font-medium">
            {selectedFile?.path ?? t('compile.noFileSelected')}
          </span>
          {saveStatusLabel !== null ? (
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
              {saveStatusLabel}
            </span>
          ) : null}
          {selectedFile !== null && isTexFile(selectedFile) ? (
            <span className="text-[10px] tabular-nums text-muted-foreground">
              {t('project.wordCount', { count: wordCount })}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-1.5">
          <PresenceAvatars peers={yjs.peers} localUser={localUser} />
          <div className="mx-1 h-4 w-px bg-border" aria-hidden="true" />
          <Button
            variant={rightPanel === 'outline' ? 'default' : 'ghost'}
            size="icon"
            aria-label={t('outline.title')}
            aria-pressed={rightPanel === 'outline'}
            className="h-7 w-7"
            onClick={() => { toggleRightPanel('outline'); }}
          >
            <ListTree className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
          <Button
            variant={rightPanel === 'review' ? 'default' : 'ghost'}
            size="icon"
            aria-label={t('review.title')}
            aria-pressed={rightPanel === 'review'}
            className="h-7 w-7"
            onClick={() => { toggleRightPanel('review'); }}
          >
            <MessageSquare className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
          <Button
            variant={rightPanel === 'history' ? 'default' : 'ghost'}
            size="icon"
            aria-label={t('history.title')}
            aria-pressed={rightPanel === 'history'}
            className="h-7 w-7"
            onClick={() => { toggleRightPanel('history'); }}
          >
            <History className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
          <Button
            variant={rightPanel === 'bibliography' ? 'default' : 'ghost'}
            size="icon"
            aria-label={t('bibliography.title')}
            aria-pressed={rightPanel === 'bibliography'}
            className="h-7 w-7"
            onClick={() => { toggleRightPanel('bibliography'); }}
          >
            <BookText className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
          <Button
            variant={rightPanel === 'ai-chat' ? 'default' : 'ghost'}
            size="icon"
            aria-label={t('ai.chat.title')}
            aria-pressed={rightPanel === 'ai-chat'}
            className="h-7 w-7"
            onClick={() => { toggleRightPanel('ai-chat'); }}
          >
            <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
          <Button
            variant={rightPanel === 'math' ? 'default' : 'ghost'}
            size="icon"
            aria-label={t('math.title')}
            aria-pressed={rightPanel === 'math'}
            className="h-7 w-7"
            onClick={() => { toggleRightPanel('math'); }}
          >
            <Sigma className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('ai.palette.title')}
            className="h-7 w-7"
            onClick={openAIPalette}
            title="Ctrl+Shift+A"
          >
            <span className="text-[10px] font-mono">AI</span>
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('command.title')}
            className="h-7 w-7"
            onClick={() => { setCmdPaletteOpen(true); }}
            title="Ctrl+K"
          >
            <Command className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
          <div className="mx-1 h-4 w-px bg-border" aria-hidden="true" />
          <Button
            size="sm"
            onClick={() => { void handleCompile(); }}
            disabled={compileSession.compiling}
            className="gap-1.5"
          >
            {compileSession.compiling ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <Play className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            {t('compile.runButton')}
          </Button>
        </div>
      </div>
      <div className="flex-1 overflow-hidden">
        {selectedFile === null || !isEditableTextFile(selectedFile) ? (
          <div className="flex h-full items-center justify-center bg-muted/30 p-6 text-center text-sm text-muted-foreground">
            {selectedFile === null
              ? t('compile.openTexFile')
              : t('compile.nonTextFile', { path: selectedFile.path })}
          </div>
        ) : !editorReady ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-hidden="true" />
          </div>
        ) : (
          <LatexEditor
            key={selectedFile.id}
            ref={editorRef}
            filePath={selectedFile.path}
            initialContent={fileContent.data?.content ?? ''}
            autocomplete={autocomplete}
            collab={collab}
            logEntries={logEntries.map((e) => ({
              level: e.level,
              message: e.message,
              ...(e.file !== undefined ? { file: e.file } : {}),
              ...(e.line !== undefined ? { line: e.line } : {}),
              ...(e.column !== undefined ? { column: e.column } : {}),
              ...(e.raw !== undefined ? { raw: e.raw } : {}),
            }))}
            onChange={handleChange}
            onCompile={() => { void handleCompile(); }}
            onSave={handleSave}
            onCursor={(line, column) => { setCursorLine(line); setCursorCol(column); }}
          />
        )}
      </div>
    </div>
  );

  const previewPanel = (
    <PanelGroup direction="vertical" autoSaveId="scribe:preview-stack" className="h-full">
      <Panel defaultSize={70} minSize={20}>
        <PDFPreview
          url={compileSession.pdfUrl}
          compiling={compileSession.compiling}
          highlight={highlight}
          onInverseSync={handleInverseSync}
        />
      </Panel>
      <Splitter orientation="horizontal" />
      <Panel defaultSize={30} minSize={10}>
        <CompileLog
          status={compileSession.status}
          entries={logEntries}
          durationMs={compileSession.job?.durationMs ?? null}
          errorMessage={compileSession.errorMessage}
          onJumpTo={handleJumpTo}
        />
      </Panel>
    </PanelGroup>
  );

  const collabSynced = collab !== null ? yjs.synced : null;
  const compileStatus: CompileStatusKind = compileSession.status;
  const showWordCount = selectedFile !== null && isTexFile(selectedFile);

  return (
    <div className="flex h-full flex-col">
      <PanelGroup direction="horizontal" autoSaveId="scribe:workspace" className="min-h-0 flex-1">
        <Panel defaultSize={50} minSize={20}>{editorPanel}</Panel>
        <Splitter orientation="vertical" />
        <Panel defaultSize={50} minSize={20}>{previewPanel}</Panel>
        {rightPanel !== null ? (
          <>
            <Splitter orientation="vertical" />
            <Panel defaultSize={25} minSize={15} maxSize={45}>
              {rightPanel === 'outline' ? (
                <OutlinePanel
                  content={editorContent}
                  onJump={(line) => { editorRef.current?.gotoLine(line); }}
                  onClose={() => { setRightPanel(null); }}
                />
              ) : null}
              {rightPanel === 'review' ? (
                <ReviewPanel
                  projectId={projectId}
                  selectedFile={selectedFile}
                  currentLine={cursorLine}
                  onJumpTo={handleJumpTo}
                  onClose={() => { setRightPanel(null); }}
                />
              ) : null}
              {rightPanel === 'history' ? (
                <VersionHistory
                  projectId={projectId}
                  onClose={() => { setRightPanel(null); }}
                />
              ) : null}
              {rightPanel === 'bibliography' ? (
                <BibliographyPanel
                  projectId={projectId}
                  files={files}
                  entries={bibEntries}
                  onCite={(key) => {
                    editorRef.current?.insertAtCursor(`\\cite{${key}}`);
                  }}
                  onClose={() => { setRightPanel(null); }}
                />
              ) : null}
              {rightPanel === 'ai-chat' ? (
                <AIChat onInsert={handleAIInsert} onClose={() => { setRightPanel(null); }} />
              ) : null}
              {rightPanel === 'math' ? (
                <MathPalette
                  onInsert={(latex) => {
                    editorRef.current?.insertAtCursor(latex);
                  }}
                  onClose={() => { setRightPanel(null); }}
                />
              ) : null}
            </Panel>
          </>
        ) : null}
      </PanelGroup>
      <AICommandPalette
        open={aiPaletteOpen}
        onOpenChange={setAIPaletteOpen}
        selection={aiSelection}
        onInsert={handleAIInsert}
      />
      <CommandPalette
        open={cmdPaletteOpen}
        onOpenChange={setCmdPaletteOpen}
        commands={commandList}
      />
      <StatusBar
        path={selectedFile?.path ?? null}
        line={cursorLine}
        column={cursorCol}
        wordCount={showWordCount ? wordCount : null}
        lastSavedAt={lastSavedAt}
        saving={writeMutation.isPending}
        collabSynced={collabSynced}
        peerCount={yjs.peers.length}
        compileStatus={compileStatus}
      />
    </div>
  );
}

const LABEL_RE = /\\label\{([^}]+)\}/g;

function extractLabelsFromText(text: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = LABEL_RE.exec(text)) !== null) {
    if (m[1] !== undefined) out.push(m[1]);
  }
  return out;
}

// Re-exports used by tests if any.
export type { CompileJob, CompileLogEntryDTO };
