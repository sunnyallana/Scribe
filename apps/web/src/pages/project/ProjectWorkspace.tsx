import {
  type CompileJob,
  type CompileLogEntryDTO,
  type Project,
  type ProjectFile,
  type ProjectId,
} from '@scribe/shared';
import { Button } from '@scribe/ui';
import { type PresenceUser } from '@scribe/yjs-provider';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { History, Loader2, MessageSquare, Play, Sparkles } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { AIChat } from '../../components/AIChat/AIChat';
import { AICommandPalette } from '../../components/AICommandPalette/AICommandPalette';
import { CompileLog } from '../../components/CompileLog/CompileLog';
import { LatexEditor, type LatexEditorImperativeHandle } from '../../components/Editor/LatexEditor';
import { PresenceAvatars } from '../../components/Editor/PresenceAvatars';
import { PDFPreview } from '../../components/PDFPreview/PDFPreview';
import { ReviewPanel } from '../../components/ReviewPanel/ReviewPanel';
import { VersionHistory } from '../../components/VersionHistory/VersionHistory';
import { useCompileSession } from '../../hooks/useCompileSession';
import { lookup, useSyncTeX } from '../../hooks/useSyncTeX';
import { useYjsDoc } from '../../hooks/useYjsDoc';
import { api, type ApiError } from '../../lib/api';
import { useAuthStore } from '../../stores/auth';

import type { AutocompleteSources } from '@scribe/editor';

interface ProjectWorkspaceProps {
  readonly project: Project;
  readonly files: readonly ProjectFile[];
  readonly selectedFile: ProjectFile | null;
  readonly onSelectFile: (file: ProjectFile) => void;
}

const SAVE_DEBOUNCE_MS = 2000;

function isTexFile(file: ProjectFile): boolean {
  return file.type === 'tex' || file.path.endsWith('.tex');
}

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
}: ProjectWorkspaceProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const projectId: ProjectId = project.id;
  const authUser = useAuthStore((s) => s.user);

  const [editorContent, setEditorContent] = useState<string>('');
  const [labels, setLabels] = useState<readonly string[]>([]);
  const [cursorLine, setCursorLine] = useState<number>(1);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [aiChatOpen, setAIChatOpen] = useState(false);
  const [aiPaletteOpen, setAIPaletteOpen] = useState(false);
  const compileSession = useCompileSession(projectId);
  const synctex = useSyncTeX(compileSession.synctexUrl);
  const editorRef = useRef<LatexEditorImperativeHandle>(null);

  // Ctrl/Cmd+Shift+A toggles the AI command palette.
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'A' || e.key === 'a')) {
        e.preventDefault();
        if (aiPaletteOpen) {
          setAIPaletteOpen(false);
        } else {
          setAISelection(editorRef.current?.getSelection() ?? '');
          setAIPaletteOpen(true);
        }
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

  const writeMutation = useMutation<unknown, ApiError, { fileId: ProjectFile['id']; content: string }>({
    mutationFn: ({ fileId, content }) => api.files.writeContent(projectId, fileId, content),
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

  // Bootstrap: once Yjs syncs, if the Y.Text is empty (nobody has edited
  // yet), seed it with the file's Storage content so collaborators see
  // the existing document.
  useEffect(() => {
    if (!yjs.synced || yjs.yText === null) return;
    if (yjs.yText.length > 0) return;
    if (fileContent.data === undefined) return;
    const seed = fileContent.data.content;
    if (seed.length === 0) return;
    yjs.yText.insert(0, seed);
  }, [yjs.synced, yjs.yText, fileContent.data]);

  // Compute citation keys from .bib files in the project (best-effort).
  const bibContents = useQuery({
    queryKey: ['bib-keys', projectId],
    queryFn: async () => {
      const bibFiles = files.filter((f) => f.type === 'bib' || f.path.endsWith('.bib'));
      const results = await Promise.allSettled(
        bibFiles.map((f) => api.files.readContent(projectId, f.id)),
      );
      const keys: string[] = [];
      for (const r of results) {
        if (r.status === 'fulfilled') {
          keys.push(...extractBibKeys(r.value.content));
        }
      }
      return keys;
    },
  });

  const autocomplete: AutocompleteSources = useMemo(
    () => ({
      labels,
      citations: bibContents.data ?? [],
    }),
    [labels, bibContents.data],
  );

  // Debounced auto-save: writes content back to Storage on idle.
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleChange = useCallback(
    (next: string) => {
      setEditorContent(next);
      setLabels(extractLabelsFromText(next));
      if (selectedFile === null) return;
      if (saveTimerRef.current !== null) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        writeMutation.mutate({ fileId: selectedFile.id, content: next });
      }, SAVE_DEBOUNCE_MS);
    },
    [selectedFile, writeMutation],
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

  const logEntries = compileSession.entries;

  const highlight = useMemo(() => {
    if (selectedFile === null || synctex.index === null) return null;
    return lookup(synctex.index, selectedFile.path, cursorLine);
  }, [selectedFile, synctex.index, cursorLine]);

  const collab = useMemo(
    () =>
      yjs.yText !== null && yjs.awareness !== null
        ? { yText: yjs.yText, awareness: yjs.awareness }
        : null,
    [yjs.yText, yjs.awareness],
  );

  const editorReady = selectedFile !== null && isTexFile(selectedFile) && (collab !== null || !fileContent.isLoading);

  return (
    <div className="flex h-full">
      <div
        className="grid flex-1 min-w-0"
        style={{ gridTemplateColumns: '1fr 1fr', gridTemplateRows: '1fr auto' }}
      >
      <div className="flex flex-col border-r" style={{ gridColumn: 1, gridRow: '1 / 3' }}>
        <div className="flex items-center justify-between border-b bg-background px-3 py-2">
          <span className="truncate text-sm font-medium">
            {selectedFile?.path ?? t('compile.noFileSelected')}
          </span>
          <div className="flex items-center gap-3">
            <PresenceAvatars peers={yjs.peers} localUser={localUser} />
            <Button
              variant={reviewOpen ? 'default' : 'ghost'}
              size="icon"
              aria-label={t('review.title')}
              aria-pressed={reviewOpen}
              className="h-7 w-7"
              onClick={() => {
                setReviewOpen((v) => !v);
              }}
            >
              <MessageSquare className="h-3.5 w-3.5" aria-hidden="true" />
            </Button>
            <Button
              variant={historyOpen ? 'default' : 'ghost'}
              size="icon"
              aria-label={t('history.title')}
              aria-pressed={historyOpen}
              className="h-7 w-7"
              onClick={() => {
                setHistoryOpen((v) => !v);
              }}
            >
              <History className="h-3.5 w-3.5" aria-hidden="true" />
            </Button>
            <Button
              variant={aiChatOpen ? 'default' : 'ghost'}
              size="icon"
              aria-label={t('ai.chat.title')}
              aria-pressed={aiChatOpen}
              className="h-7 w-7"
              onClick={() => {
                setAIChatOpen((v) => !v);
              }}
            >
              <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
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
              size="sm"
              onClick={() => {
                void handleCompile();
              }}
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
          {selectedFile === null || !isTexFile(selectedFile) ? (
            <div className="flex h-full items-center justify-center bg-muted/30 p-6 text-center text-sm text-muted-foreground">
              {selectedFile === null
                ? t('compile.openTexFile')
                : t('compile.nonTexFile', { path: selectedFile.path })}
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
              onCompile={() => {
                void handleCompile();
              }}
              onSave={handleSave}
              onCursor={(line) => { setCursorLine(line); }}
            />
          )}
        </div>
      </div>
      <div style={{ gridColumn: 2, gridRow: 1 }} className="overflow-hidden">
        <PDFPreview
          url={compileSession.pdfUrl}
          compiling={compileSession.compiling}
          highlight={highlight}
        />
      </div>
      <div style={{ gridColumn: 2, gridRow: 2 }} className="h-48 overflow-hidden">
        <CompileLog
          status={compileSession.status}
          entries={logEntries}
          durationMs={compileSession.job?.durationMs ?? null}
          errorMessage={compileSession.errorMessage}
          onJumpTo={handleJumpTo}
        />
      </div>
      </div>
      {reviewOpen ? (
        <ReviewPanel
          projectId={projectId}
          selectedFile={selectedFile}
          currentLine={cursorLine}
          onJumpTo={handleJumpTo}
          onClose={() => { setReviewOpen(false); }}
        />
      ) : null}
      {historyOpen ? (
        <VersionHistory
          projectId={projectId}
          onClose={() => { setHistoryOpen(false); }}
        />
      ) : null}
      {aiChatOpen ? (
        <AIChat onInsert={handleAIInsert} onClose={() => { setAIChatOpen(false); }} />
      ) : null}
      <AICommandPalette
        open={aiPaletteOpen}
        onOpenChange={setAIPaletteOpen}
        selection={aiSelection}
        onInsert={handleAIInsert}
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

const BIBKEY_RE = /@\w+\s*\{\s*([^,\s}]+)/g;

function extractBibKeys(text: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = BIBKEY_RE.exec(text)) !== null) {
    if (m[1] !== undefined) out.push(m[1]);
  }
  return out;
}

// Re-exports used by tests if any.
export type { CompileJob, CompileLogEntryDTO };
