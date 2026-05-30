import {
  type BibEntry,
  type CompileJob,
  type CompileLogEntryDTO,
  parseBibTeX,
  type Project,
  type ProjectFile,
  type ProjectId,
} from '@scribe/shared';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@scribe/ui';
import { type PresenceUser } from '@scribe/yjs-provider';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BookText,
  CameraIcon,
  ChevronsRight,
  Command,
  Eye,
  FileText,
  History,
  ListTree,
  Loader2,
  MessageSquare,
  MoreHorizontal,
  PenLine,
  Play,
  Replace as ReplaceIcon,
  Search,
  Sigma,
  Sparkles,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type ImperativePanelHandle, Panel, PanelGroup } from 'react-resizable-panels';
import { toast } from 'sonner';

import { AIChat } from '../../components/AIChat/AIChat';
import { AICommandPalette } from '../../components/AICommandPalette/AICommandPalette';
import { BibliographyPanel } from '../../components/Bibliography/BibliographyPanel';
import { CitationLookup } from '../../components/Citations/CitationLookup';
import { CommandPalette, type CommandItem } from '../../components/CommandPalette/CommandPalette';
import { EditorTabs } from '../../components/Editor/EditorTabs';
import { LatexEditor, type LatexEditorImperativeHandle } from '../../components/Editor/LatexEditor';
import { PresenceAvatars } from '../../components/Editor/PresenceAvatars';
import { ErrorBoundary } from '../../components/ErrorBoundary/ErrorBoundary';
import { HandwritingToLatex } from '../../components/HandwritingToLatex/HandwritingToLatex';
import { ImageViewer } from '../../components/ImageViewer/ImageViewer';
import { Splitter } from '../../components/Layout/Splitter';
import { MathPalette } from '../../components/MathPalette/MathPalette';
import { OutlinePanel } from '../../components/Outline/OutlinePanel';
import { ReviewPanel } from '../../components/ReviewPanel/ReviewPanel';
import { SearchPanel } from '../../components/Search/SearchPanel';
import { StatusBar, type CompileStatusKind } from '../../components/StatusBar/StatusBar';
import { SyncConflictModal } from '../../components/SyncConflictModal';
import { VersionHistory } from '../../components/VersionHistory/VersionHistory';
import { VoiceControls } from '../../components/Voice/VoiceControls';
import { useCompileSession } from '../../hooks/useCompileSession';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { lookup, lookupReverse, useSyncTeX } from '../../hooks/useSyncTeX';
import { useYjsDoc } from '../../hooks/useYjsDoc';
import { api, ApiError } from '../../lib/api';
import { findBibKeyInBbl, findEntryLineInBib } from '../../lib/bblToBib';
import { log } from '../../lib/debug';
import { API_URL, getAccessTokenSync } from '../../lib/supabase';
import { type SyncConflict, syncManager } from '../../lib/sync';
import { isTauri } from '../../lib/tauri';
import { useAuthStore } from '../../stores/auth';
import { useProjectChrome } from '../../stores/projectChrome';
import { useSettings } from '../../stores/settings';

import { PreviewPanel } from './PreviewPanel';

import type { AutocompleteSources, HoverPreviewSources } from '@scribe/editor';

interface ProjectWorkspaceProps {
  readonly project: Project;
  readonly files: readonly ProjectFile[];
  readonly selectedFile: ProjectFile | null;
  readonly onSelectFile: (file: ProjectFile) => void;
  /** Ordered list of files currently open as editor tabs. */
  readonly openFiles: readonly ProjectFile[];
  readonly onCloseFile: (file: ProjectFile) => void;
  readonly sidebarCollapsed?: boolean;
  readonly onExpandSidebar?: () => void;
}

// Short debounce: 800ms is enough to coalesce a burst of keystrokes
// but small enough that a refresh-after-typing rarely loses work.
// Pair this with the `beforeunload` flush below for the edge case
// where the user refreshes inside the debounce window.
const SAVE_DEBOUNCE_MS = 800;
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

/** Browser-renderable image extensions. We open these in the
 *  ImageViewer instead of showing the "binary file" placeholder.
 *  .eps deliberately omitted — browsers can't render PostScript
 *  directly; we keep the placeholder there. */
const VIEWABLE_IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.avif'];
function isViewableImage(file: ProjectFile): boolean {
  if (file.type === 'image') {
    // Some uploads have type='image' but an unknown extension;
    // still try if it's listed.
    const lower = file.path.toLowerCase();
    return VIEWABLE_IMAGE_EXT.some((ext) => lower.endsWith(ext));
  }
  const lower = file.path.toLowerCase();
  return VIEWABLE_IMAGE_EXT.some((ext) => lower.endsWith(ext));
}

type RightPanelId =
  | 'outline'
  | 'review'
  | 'history'
  | 'bibliography'
  | 'citations'
  | 'find'
  | 'ai-chat'
  | 'math'
  | null;

// Right-side panel toggles in display order. Lives at module scope so
// both the inline button row (wide layouts) and the overflow dropdown
// (narrow layouts) iterate the exact same list — labels and icons stay
// in lock-step without us hand-syncing two copies.
import type { LucideIcon } from 'lucide-react';
const PANEL_TOGGLES: readonly {
  readonly id: NonNullable<RightPanelId>;
  readonly icon: LucideIcon;
  readonly labelKey: string;
}[] = [
  { id: 'outline', icon: ListTree, labelKey: 'outline.title' },
  { id: 'review', icon: MessageSquare, labelKey: 'review.title' },
  { id: 'history', icon: History, labelKey: 'history.title' },
  { id: 'bibliography', icon: BookText, labelKey: 'bibliography.title' },
  { id: 'citations', icon: Search, labelKey: 'citations.title' },
  { id: 'find', icon: ReplaceIcon, labelKey: 'search.title' },
  { id: 'ai-chat', icon: Sparkles, labelKey: 'ai.chat.title' },
  { id: 'math', icon: Sigma, labelKey: 'math.title' },
];

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
  openFiles,
  onCloseFile,
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
  const [handwritingOpen, setHandwritingOpen] = useState(false);
  const [cmdPaletteOpen, setCmdPaletteOpen] = useState(false);
  const previewPanelRef = useRef<ImperativePanelHandle>(null);
  const [previewCollapsed, setPreviewCollapsed] = useState(false);
  const togglePreview = useCallback(() => {
    const panel = previewPanelRef.current;
    if (panel === null) return;
    if (panel.isCollapsed()) panel.expand();
    else panel.collapse();
  }, []);
  // Auto-collapse the preview at mobile widths. Two columns at <=
  // 768px crushes both panels below usable width; folding the preview
  // gives the editor the full viewport. User can toggle it back on via
  // the Eye button when they want to inspect the rendered PDF or log.
  // We *don't* auto-expand when the viewport grows again — once the
  // user is in a layout, respect that until they change it.
  const isNarrowViewport = useMediaQuery('(max-width: 768px)');
  const lastNarrowRef = useRef<boolean>(isNarrowViewport);
  useEffect(() => {
    if (isNarrowViewport && !lastNarrowRef.current) {
      previewPanelRef.current?.collapse();
    }
    lastNarrowRef.current = isNarrowViewport;
  }, [isNarrowViewport]);
  // First mount on a mobile viewport: collapse straight away so the
  // editor isn't squeezed for the initial paint. The effect above
  // would only fire on a desktop→mobile transition, not on first
  // mount in mobile.
  useEffect(() => {
    if (isNarrowViewport) {
      // Defer one frame so the panel is mounted with its handle ready.
      const id = window.setTimeout(() => {
        previewPanelRef.current?.collapse();
      }, 0);
      return () => {
        window.clearTimeout(id);
      };
    }
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fetch the caller's role on this project so we can gate the editor.
  // Read-only roles (viewer/commenter) get a non-writable CodeMirror — the
  // server already drops their updates, but disabling at the UI layer
  // avoids the "I typed something and it vanished" confusion.
  const membersQuery = useQuery({
    queryKey: ['members', projectId],
    queryFn: () => api.members.list(projectId),
  });
  const myRole = useMemo<'owner' | 'editor' | 'commenter' | 'viewer' | null>(() => {
    const me = (membersQuery.data ?? []).find(
      (m) => m.userId !== null && m.userId === authUser?.id,
    );
    return me?.role ?? null;
  }, [membersQuery.data, authUser?.id]);
  const editorReadOnly = myRole === 'viewer' || myRole === 'commenter';
  useEffect(() => {
    if (myRole !== null) {
      log.role(`resolved role for this session: ${myRole}`, {
        projectId,
        userId: authUser?.id,
        readOnly: editorReadOnly,
      });
    }
  }, [myRole, projectId, authUser?.id, editorReadOnly]);

  // Tauri-only: kick a sync cycle once per project mount. The cycle
  // pulls the server's file list into SQLite (mirror) and pushes any
  // dirty local rows. Hard collisions surface as `conflicts`; we open
  // the modal so the user picks per file. No-ops outside the desktop
  // shell (`isTauri()` short-circuits inside the manager).
  const [syncConflicts, setSyncConflicts] = useState<readonly SyncConflict[]>([]);
  useEffect(() => {
    if (!isTauri()) return undefined;
    let cancelled = false;
    void (async () => {
      try {
        const result = await syncManager.syncProject(project);
        if (cancelled) return;
        if (result.conflicts.length > 0) {
          setSyncConflicts(result.conflicts);
        }
      } catch (err) {
        log.api.warn('initial desktop sync failed', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [project, projectId]);

  function toggleRightPanel(id: NonNullable<RightPanelId>) {
    setRightPanel((current) => (current === id ? null : id));
  }
  const compileSession = useCompileSession(projectId);
  const synctex = useSyncTeX(compileSession.synctexUrl);
  const editorRef = useRef<LatexEditorImperativeHandle>(null);

  // Publish the compiled PDF URL into the chrome store so the navbar
  // project-menu and the sidebar download button can offer
  // "Download PDF" without having to be wired through props.
  const setChrome = useProjectChrome((s) => s.set);
  useEffect(() => {
    setChrome({ pdfUrl: compileSession.pdfUrl });
  }, [compileSession.pdfUrl, setChrome]);

  // Ctrl/Cmd+Shift+A → AI palette. Ctrl/Cmd+K → global command
  // palette. Ctrl/Cmd+W → close current tab (browsers reserve this
  // for the window/tab on most desktop shortcuts, but as a SPA we
  // can intercept it — same trick Overleaf / VS-Code-Web use).
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
      } else if (mod && !e.shiftKey && (e.key === 'w' || e.key === 'W')) {
        if (selectedFile !== null) {
          e.preventDefault();
          onCloseFile(selectedFile);
        }
      }
    }
    window.addEventListener('keydown', handler);
    return () => {
      window.removeEventListener('keydown', handler);
    };
  }, [aiPaletteOpen, selectedFile, onCloseFile]);

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
        : (authUser.email ?? 'User');
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
    // File content rarely changes outside of our own writes (which
    // invalidate the query via writeMutation.onSuccess). Treating
    // the cached body as fresh for 30 s saves a round-trip on every
    // tab-switch / window refocus without risking serious staleness
    // — the Yjs WS still pushes live edits regardless.
    staleTime: 30_000,
  });

  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const writeMutation = useMutation<
    unknown,
    ApiError,
    { fileId: ProjectFile['id']; content: string }
  >({
    mutationFn: ({ fileId, content }) => {
      log.save('autosave →', { fileId, bytes: content.length });
      return api.files.writeContent(projectId, fileId, content);
    },
    onSuccess: (_data, variables) => {
      log.save('autosave ok', { fileId: variables.fileId, bytes: variables.content.length });
      setLastSavedAt(Date.now());
    },
    onError: (err, variables) => {
      log.save.error('autosave failed', {
        fileId: variables.fileId,
        bytes: variables.content.length,
        status: err.status,
        message: err.body.message,
      });
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
    if (yjs.synced) {
      // The earlier behavior left `collabTimedOut` stuck at `true`
      // once the timeout fired, which meant a single slow handshake
      // would put the editor in solo mode for the rest of the
      // session — even after the WS reconnected. Clear the flag any
      // time we're synced so a reconnect restores collab.
      setCollabTimedOut(false);
      return;
    }
    const id = window.setTimeout(() => {
      log.yjs.warn(
        'collab timed out after',
        COLLAB_TIMEOUT_MS,
        'ms — falling back to solo until WS reconnects',
      );
      setCollabTimedOut(true);
    }, COLLAB_TIMEOUT_MS);
    return () => {
      window.clearTimeout(id);
    };
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

  // Fetch every .tex file's content so the Outline panel can show
  // sections from the whole project, not just the currently-open
  // file. Per-file React-Query entries (one query per file) instead
  // of a single allSettled-wrapped batch — three benefits:
  //
  //   1. The outline renders INCREMENTALLY: each file that finishes
  //      shows up in the panel immediately, instead of all of them
  //      blocking on the slowest one.
  //   2. Each per-file fetch piggybacks off the editor reader's
  //      `file-content` cache (same query key), so when the active
  //      file is also a .tex file we don't double-fetch.
  //   3. Files already in cache from a previous visit render with
  //      zero network round-trip.
  //
  // Gated on the outline panel being visible to avoid pulling
  // dozens of files on every project open.
  const texFiles = useMemo(
    () => files.filter((f) => f.type === 'tex' || f.path.endsWith('.tex')),
    [files],
  );
  const outlineFileQueries = useQueries({
    queries: texFiles.map((f) => ({
      queryKey: ['file-content', projectId, f.id],
      enabled: rightPanel === 'outline',
      queryFn: () => api.files.readContent(projectId, f.id),
      staleTime: 30_000,
    })),
  });
  // Merge in the live editor buffer for the open .tex file so newly
  // added sections appear immediately, without waiting for autosave
  // (~800 ms) and a fresh fetch.
  const outlineContents = useMemo(() => {
    const merged = new Map<string, string>();
    for (let i = 0; i < texFiles.length; i += 1) {
      const file = texFiles[i];
      const q = outlineFileQueries[i];
      if (file !== undefined && q?.data !== undefined) {
        merged.set(file.path, q.data.content);
      }
    }
    if (
      selectedFile !== null &&
      (selectedFile.type === 'tex' || selectedFile.path.endsWith('.tex')) &&
      editorContent.length > 0
    ) {
      merged.set(selectedFile.path, editorContent);
    }
    return merged;
  }, [texFiles, outlineFileQueries, selectedFile, editorContent]);

  // .bib files — shared between (a) the cite-key autocomplete in
  // the editor, (b) the bibliography panel UI, and (c) the bbl-to-
  // bib reverse lookup. We fetch each file's raw content via React
  // Query, using the same `file-content` cache key the editor
  // reader uses so a .bib that's open in the editor is a free hit.
  // The parsed BibEntry[] is derived from that — single source of
  // truth, one fetch per file across the whole page lifetime.
  const bibFiles = useMemo(
    () => files.filter((f) => f.type === 'bib' || f.path.endsWith('.bib')),
    [files],
  );
  const bibContentQueries = useQueries({
    queries: bibFiles.map((f) => ({
      queryKey: ['file-content', projectId, f.id],
      enabled: bibFiles.length > 0,
      queryFn: () => api.files.readContent(projectId, f.id),
      staleTime: 60 * 1000,
    })),
  });
  const bibEntries = useMemo(() => {
    const out: BibEntry[] = [];
    for (const q of bibContentQueries) {
      if (q.data !== undefined) {
        out.push(...parseBibTeX(q.data.content));
      }
    }
    return out;
  }, [bibContentQueries]);
  const autocomplete: AutocompleteSources = useMemo(
    () => ({
      labels,
      citations: bibEntries.map((e) => e.key),
    }),
    [labels, bibEntries],
  );

  // Hover preview lookups. The editor extension calls these lazily
  // (only when the user hovers a `\ref{...}` / `\cite{...}`) so the
  // O(N) scan over project contents only runs on demand.
  const hoverSources = useMemo<HoverPreviewSources>(
    () => ({
      resolveLabel: (name) => resolveLabelPreview(name, outlineContents),
      resolveCitation: (name) => resolveCitationPreview(name, bibEntries),
    }),
    [outlineContents, bibEntries],
  );

  // Debounced auto-save: writes content back to Storage on idle.
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const liveCompile = useSettings((s) => s.editor.liveCompile);
  const liveCompileDelayMs = useSettings((s) => s.editor.liveCompileDelayMs);
  const liveCompileTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Live-lint: debounced fire on typing pauses (separate from auto-
  // save so a user with `liveCompile=false` still gets fast lint
  // feedback). Results live in a per-file map so switching tabs
  // doesn't drop the previous file's lint state. 800 ms matches the
  // autosave debounce — same UX cadence the user already feels.
  const lintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [liveLintByPath, setLiveLintByPath] = useState<
    ReadonlyMap<string, readonly CompileLogEntryDTO[]>
  >(new Map());
  const LINT_DEBOUNCE_MS = 800;

  const triggerLint = useCallback(
    (filePath: string, content: string) => {
      // Avoid sending massive buffers to lint; server caps at 4 MiB
      // and rejects with 413, so just stop here too.
      if (content.length === 0 || content.length > 4 * 1024 * 1024) return;
      void api.lint
        .run(projectId, filePath, content)
        .then((entries) => {
          setLiveLintByPath((prev) => {
            const next = new Map(prev);
            next.set(filePath, entries);
            return next;
          });
        })
        .catch((err: unknown) => {
          // Network blip or 503 when chktex isn't installed —
          // surface in dev console but don't toast at the user.
          log.api.warn('live-lint failed', err);
        });
    },
    [projectId],
  );

  const handleChange = useCallback(
    (next: string) => {
      // Loud, verbose log so anyone debugging "edits don't persist"
      // can see exactly what the editor reported to us per keystroke.
      log.editor('onChange', {
        bytes: next.length,
        preview: next.length > 0 ? next.slice(0, 40) : '<empty>',
      });
      setEditorContent(next);
      setLabels(extractLabelsFromText(next));
      if (selectedFile === null) return;
      // Safety net: never autosave an empty body. CodeMirror + yCollab
      // can fire a transient empty onChange during mount races (editor
      // doc swapped to yText before the seed insert lands), and that
      // empty value would silently overwrite the user's file in
      // Storage. If they really want to empty the file, they can
      // explicitly delete each character — onChange will keep firing
      // with the latest non-empty buffer until the final delete, and
      // by then a deliberate save shortcut works too.
      if (next.length === 0) {
        log.save.warn('blocked: refusing to autosave empty content', { fileId: selectedFile.id });
        return;
      }
      if (saveTimerRef.current !== null) clearTimeout(saveTimerRef.current);
      const fileId = selectedFile.id;
      saveTimerRef.current = setTimeout(() => {
        // Read the editor's CURRENT view content rather than relying
        // on `next` from a possibly-stale closure. If the editor went
        // through any transactions between handleChange firing and the
        // debounce window expiring (e.g. a remote Yjs update applied
        // after the user's keystroke), `next` would be the older
        // post-keystroke value; the editor handle always returns the
        // freshest view doc.
        const live = editorRef.current?.getContent() ?? next;
        log.save('autosave fire', { fileId, viewBytes: live.length, closureBytes: next.length });
        writeMutation.mutate({ fileId, content: live });
      }, SAVE_DEBOUNCE_MS);
      if (liveCompile) {
        if (liveCompileTimerRef.current !== null) clearTimeout(liveCompileTimerRef.current);
        liveCompileTimerRef.current = setTimeout(() => {
          void handleCompile();
        }, liveCompileDelayMs);
      }
      // Schedule a lint pass too. Independent of liveCompile — lint
      // is cheap (~50-100 ms server-side) so we don't want to gate
      // it on a heavyweight compile. Only fires for .tex-like files
      // (chktex doesn't understand .bib / images / etc.).
      const isTex = selectedFile.type === 'tex' || selectedFile.path.toLowerCase().endsWith('.tex');
      if (isTex) {
        if (lintTimerRef.current !== null) clearTimeout(lintTimerRef.current);
        const filePath = selectedFile.path;
        lintTimerRef.current = setTimeout(() => {
          const live = editorRef.current?.getContent() ?? next;
          triggerLint(filePath, live);
        }, LINT_DEBOUNCE_MS);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedFile, writeMutation, liveCompile, liveCompileDelayMs, triggerLint],
  );

  const handleSave = useCallback(() => {
    if (selectedFile === null) return;
    if (saveTimerRef.current !== null) clearTimeout(saveTimerRef.current);
    // Ctrl+S: always read the editor view directly. `editorContent`
    // state can lag behind transient editor transactions and we never
    // want a manual save to write a stale buffer.
    const live = editorRef.current?.getContent() ?? editorContent;
    log.save('manual save', { fileId: selectedFile.id, viewBytes: live.length });
    if (live.length === 0) {
      log.save.warn('blocked: manual save refused for empty buffer', { fileId: selectedFile.id });
      return;
    }
    writeMutation.mutate(
      { fileId: selectedFile.id, content: live },
      {
        onSuccess: () => {
          toast.success(t('compile.saved'));
        },
      },
    );
  }, [editorContent, selectedFile, writeMutation, t]);

  const handleCompile = useCallback(async () => {
    if (selectedFile !== null && !editorReadOnly) {
      // Owners + editors only: force-save before compile so the worker
      // sees the latest content. Viewers/commenters skip this step
      // entirely — the server would 403 their PUT and we'd then
      // refuse to compile something we have full read access to. They
      // can still kick off a compile of whatever the file currently
      // contains in Storage.
      if (saveTimerRef.current !== null) clearTimeout(saveTimerRef.current);
      const live = editorRef.current?.getContent() ?? editorContent;
      if (live.length > 0) {
        try {
          await api.files.writeContent(projectId, selectedFile.id, live);
        } catch (err) {
          // Soft-fail: log the save error but still compile. A viewer
          // who somehow got here (or any other write-blocked role)
          // should still be able to render the persisted PDF.
          log.compile.warn('pre-compile save failed; compiling anyway', err);
        }
      }
    }
    // Mid-edit overlay (Tauri only — `compile()` ignores overrides
    // in browser mode where the server is the source of truth).
    // We hand the current editor buffer to the desktop compile path
    // so it doesn't have to wait for the autosave round-trip to
    // land before the workdir reflects what the user just typed.
    //
    // GUARD: only override when the editor actually has content.
    // The Yjs binding fills the buffer asynchronously; hitting
    // Compile mid-sync gives us `""`, which would write a zero-byte
    // main.tex over the perfectly fine server copy and fail compile
    // with an "Emergency stop" (no \documentclass found).
    const liveBuffer = editorRef.current?.getContent() ?? editorContent;
    const editorOverrides: Record<string, string> | undefined =
      selectedFile !== null && !editorReadOnly && liveBuffer.length > 0
        ? { [selectedFile.path]: liveBuffer }
        : undefined;
    await compileSession.compile(project.mainFile, editorOverrides);
    await queryClient.invalidateQueries({ queryKey: ['compiles', projectId] });
  }, [
    compileSession,
    editorContent,
    editorReadOnly,
    project.mainFile,
    projectId,
    queryClient,
    selectedFile,
  ]);

  // Flush any pending autosave when the user navigates away or
  // refreshes inside the debounce window. `sendBeacon` is fire-and-
  // forget but reliable during page unload — `fetch` calls get
  // cancelled mid-flight otherwise.
  useEffect(() => {
    if (selectedFile === null) return;
    const fileId = selectedFile.id;
    const onUnload = () => {
      const live = editorRef.current?.getContent() ?? '';
      if (live.length === 0) return;
      // `supabase.auth.getSession()` is async and can't be awaited
      // here — the page is dying. `getAccessTokenSync()` reads from a
      // cache kept in sync via `supabase.auth.onAuthStateChange` in
      // `lib/supabase.ts`. Robust to Supabase changing its storage
      // schema, which our old `localStorage` scan was not.
      const accessToken = getAccessTokenSync();
      if (accessToken === null) return;
      const url = `${API_URL}/api/projects/${projectId}/files/${fileId}/content`;
      try {
        const body = JSON.stringify({ content: live });
        // `fetch(..., { keepalive: true })` is supported in every
        // evergreen browser and is the documented mechanism for "send
        // this last request before unload". Unlike `sendBeacon` it
        // accepts Authorization headers, so we don't need a fallback
        // path that smuggles the token into a query param.
        void fetch(url, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
          body,
          keepalive: true,
        });
        log.save('beforeunload flush', { fileId, bytes: live.length });
      } catch (err) {
        log.save.error('beforeunload flush failed', err);
      }
    };
    window.addEventListener('beforeunload', onUnload);
    return () => {
      window.removeEventListener('beforeunload', onUnload);
    };
  }, [projectId, selectedFile]);

  // Map a SyncTeX-recorded path (or a log-parser-extracted path) to
  // the matching project file. SyncTeX is inconsistent across
  // distributions: it might store `./sec/intro.tex`, `sec/intro` (no
  // extension), the basename alone, or the absolute path inside the
  // compile workdir. We try matchers in order of specificity and
  // stop at the first hit so a basename match never trumps a full
  // path match.
  const resolveProjectFile = useCallback(
    (raw: string): ProjectFile | undefined => {
      // Normalise separators (Windows-style backslashes show up when
      // MiKTeX is the underlying engine) and strip leading `./`.
      const cleaned = raw.replace(/\\/g, '/').replace(/^\.\//, '').trim();
      const withTexExt = cleaned.endsWith('.tex') ? cleaned : `${cleaned}.tex`;
      const cleanedBase = cleaned.substring(cleaned.lastIndexOf('/') + 1);
      const baseWithExt = cleanedBase.endsWith('.tex') ? cleanedBase : `${cleanedBase}.tex`;

      // 1. Exact path match.
      let target = files.find((f) => f.path === cleaned);
      if (target !== undefined) return target;

      // 2. Path equality after appending `.tex` (covers \input{foo}
      //    recorded without the extension).
      target = files.find((f) => f.path === withTexExt);
      if (target !== undefined) return target;

      // 3. Suffix match: SyncTeX gave us a longer path (e.g. absolute
      //    inside a temp workdir) that ends with our project path.
      target = files.find(
        (f) => cleaned.endsWith(`/${f.path}`) || withTexExt.endsWith(`/${f.path}`),
      );
      if (target !== undefined) return target;

      // 4. Reverse suffix: our project path ends with the cleaned
      //    record (when SyncTeX stored just the basename or a
      //    sub-path).
      target = files.find(
        (f) => f.path.endsWith(`/${cleaned}`) || f.path.endsWith(`/${withTexExt}`),
      );
      if (target !== undefined) return target;

      // 5. Basename-only match — last resort; lossy when two files
      //    in different folders share a name, but better than a
      //    silent miss.
      target = files.find((f) => {
        const fname = f.path.substring(f.path.lastIndexOf('/') + 1);
        return fname === cleanedBase || fname === baseWithExt;
      });
      return target;
    },
    [files],
  );

  // Pending cross-file jump. The previous "setTimeout(..., 220ms)"
  // approach failed when the editor needed longer than 220 ms to
  // mount with the new file's content — the gotoLine call fired
  // against an editor that was still bootstrapping, so it no-op'd
  // and the user had to double-click again. This state holds the
  // jump until the editor for the right file is genuinely ready;
  // the effect below fires the jump deterministically once that's
  // true, with no fixed-delay guesswork.
  const [pendingJump, setPendingJump] = useState<{
    fileId: string;
    line: number;
    flash: boolean;
  } | null>(null);

  const handleJumpTo = useCallback(
    (filePath: string, line: number) => {
      const target = resolveProjectFile(filePath);
      if (target === undefined) return;
      if (target.id !== selectedFile?.id) {
        setPendingJump({ fileId: target.id, line, flash: false });
        onSelectFile(target);
      } else {
        editorRef.current?.gotoLine(line);
      }
    },
    [resolveProjectFile, selectedFile, onSelectFile],
  );

  // Range jump used by the Reviews panel — opens the target file and
  // selects the exact block that was anchored when the comment was
  // made. `snippet` is the resilience fallback: when later edits have
  // shifted line numbers, we search for the original snippet text in
  // the current doc and select that span instead. Stale anchors that
  // can't be found anywhere fall back to a plain gotoLine of the
  // recorded start line — no silent misses.
  const handleJumpToRange = useCallback(
    (
      filePath: string,
      from: { line: number; column: number },
      to: { line: number; column: number },
      snippet: string | null,
    ) => {
      const target = resolveProjectFile(filePath);
      if (target === undefined) return;
      const doSelect = () => {
        const handle = editorRef.current;
        if (handle === null) return;
        if (snippet !== null && snippet.length > 0) {
          // Try the snippet first — it's resilient to line drift.
          const content = handle.getContent();
          const idx = content.indexOf(snippet);
          if (idx !== -1) {
            // Convert character offset → (line, column).
            const before = content.slice(0, idx);
            const line = before.split(/\r?\n/).length;
            const lastNL = before.lastIndexOf('\n');
            const column = lastNL === -1 ? idx : idx - lastNL - 1;
            const endBefore = content.slice(0, idx + snippet.length);
            const endLine = endBefore.split(/\r?\n/).length;
            const lastNLEnd = endBefore.lastIndexOf('\n');
            const endColumn =
              lastNLEnd === -1 ? idx + snippet.length : idx + snippet.length - lastNLEnd - 1;
            handle.selectRange(
              { line, column },
              { line: endLine, column: endColumn },
              { flash: true },
            );
            return;
          }
        }
        // No snippet, or snippet has been edited away — fall back
        // to the recorded line/column positions.
        handle.selectRange(from, to, { flash: true });
      };
      if (target.id !== selectedFile?.id) {
        setPendingJump({ fileId: target.id, line: from.line, flash: true });
        onSelectFile(target);
        // Once the pending-jump effect fires its gotoLine, refine
        // to a proper range selection on the next frame.
        setTimeout(doSelect, 250);
      } else {
        doSelect();
      }
    },
    [resolveProjectFile, selectedFile, onSelectFile],
  );

  // ---- Bibliography reverse-lookup ----
  //
  // SyncTeX only ever sees `main.bbl` (BibTeX's output that pdflatex
  // consumes); it never references the source `.bib`. The .bbl text
  // is fetched once per compile job and cached so the click handler
  // below is a synchronous cache read; bib contents are already
  // cached by the shared `bibContentQueries` above.

  // .bbl text, keyed by compile job ID. One-shot per compile —
  // .bbl content can't change after the compile finishes, so a
  // long staleTime + Infinity gcTime is safe and makes second-click
  // latency literally zero. Eagerly enabled the moment a job ID +
  // a .bib file are both present, which is the prefetch behaviour.
  const bblQuery = useQuery({
    queryKey: ['compile-bbl', compileSession.job?.id],
    enabled: compileSession.job?.id !== undefined && bibFiles.length > 0,
    queryFn: async () => {
      const jobId = compileSession.job?.id;
      if (jobId === undefined) throw new Error('no compile job');
      const { url } = await api.compiles.artifactUrl(jobId, 'bbl');
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`bbl HTTP ${resp.status.toString()}`);
      return resp.text();
    },
    staleTime: 5 * 60 * 1000,
    gcTime: Infinity,
    // Don't retry the 404 we get for compiles that ran before the
    // .bbl-upload feature shipped — useless and noisy.
    retry: (failureCount, err) =>
      !(err instanceof ApiError && err.status === 404) && failureCount < 2,
  });

  const handleBblInverseSync = useCallback(
    (bblLine: number) => {
      const jobId = compileSession.job?.id;
      if (jobId === undefined) {
        toast.info(t('compile.inverseSyncBblNeedsCompile'));
        return;
      }
      if (bibFiles.length === 0) {
        toast.info(t('compile.inverseSyncBblNoBib'));
        return;
      }
      // Read straight from the React Query cache. If the prefetch
      // already landed (it will have, in steady state) this is
      // synchronous; otherwise the click waits on the same fetch
      // that any future click would have waited on too.
      const bblText = bblQuery.data;
      if (bblText === undefined) {
        if (bblQuery.error !== null) {
          toast.info(t('compile.inverseSyncBblFetchFailed'));
        } else {
          toast.info(t('common.loading'));
        }
        return;
      }
      const key = findBibKeyInBbl(bblText, bblLine);
      if (key === null) {
        toast.info(t('compile.inverseSyncBblKeyMiss'));
        return;
      }
      // Walk cached .bib contents — synchronous, fast. Falls back
      // to a "still loading" toast if any are pending, but that's
      // unlikely after the prefetch fired.
      for (let i = 0; i < bibFiles.length; i += 1) {
        const bib = bibFiles[i];
        const q = bibContentQueries[i];
        if (bib === undefined || q?.data === undefined) continue;
        const entryLine = findEntryLineInBib(q.data.content, key);
        if (entryLine === null) continue;
        if (bib.id !== selectedFile?.id) {
          setPendingJump({ fileId: bib.id, line: entryLine, flash: true });
          onSelectFile(bib);
        } else {
          editorRef.current?.gotoLine(entryLine, { flash: true });
        }
        return;
      }
      log.compile.warn('inverse-sync: cite key not found in any .bib', {
        key,
        searchedFiles: bibFiles.map((b) => b.path),
      });
      toast.info(t('compile.inverseSyncBblEntryMiss', { key }));
    },
    [
      compileSession.job?.id,
      bibFiles,
      bibContentQueries,
      bblQuery.data,
      bblQuery.error,
      selectedFile,
      onSelectFile,
      t,
    ],
  );

  const handleInverseSync = useCallback(
    (page: number, x: number, y: number) => {
      // Accept records pointing at project files AS WELL AS the
      // bibliography (`.bbl`). Without admitting `.bbl` through the
      // filter, citation clicks would silently miss because the
      // BibTeX-emitted file isn't in the project's source tree.
      const loc = lookupReverse(synctex.index, page, x, y, (filename) => {
        if (filename.toLowerCase().endsWith('.bbl')) return true;
        return resolveProjectFile(filename) !== undefined;
      });
      if (loc === null) {
        toast.info(t('compile.inverseSyncMiss'));
        return;
      }
      // Bibliography path: translate (.bbl, line) into the matching
      // .bib entry. Async because we have to fetch the .bbl.
      if (loc.filename.toLowerCase().endsWith('.bbl')) {
        handleBblInverseSync(loc.line);
        return;
      }
      const target = resolveProjectFile(loc.filename);
      if (target === undefined) {
        log.compile.warn('inverse-sync: source file not in project', {
          synctexPath: loc.filename,
          line: loc.line,
          knownPaths: files.map((f) => f.path),
        });
        toast.info(t('compile.inverseSyncMiss'));
        return;
      }
      if (target.id !== selectedFile?.id) {
        // Cross-file jump — defer until the editor remounts with
        // the new file's content (see comment on `pendingJump`).
        setPendingJump({ fileId: target.id, line: loc.line, flash: true });
        onSelectFile(target);
      } else {
        editorRef.current?.gotoLine(loc.line, { flash: true });
      }
    },
    [synctex.index, resolveProjectFile, files, selectedFile, onSelectFile, t, handleBblInverseSync],
  );

  // Honour the user's lint toggle here so the editor's gutter
  // squiggles + the diagnostic counts skip chktex entries when
  // it's off, without us needing to thread the flag any deeper.
  const lintEnabledPref = useSettings((s) => s.editor.lintEnabled);
  // Merge compile-time chktex entries with live-lint results. For
  // files where live-lint has produced output, drop the compile
  // entries for that file — live-lint is always fresher because
  // it reflects the unsaved buffer. Compile entries for files
  // *not* in the live-lint map stay (e.g. you compiled, then
  // switched to another file without editing — old lint on the
  // unrelated file is still useful).
  const logEntries = useMemo(() => {
    const compileEntries = compileSession.entries;
    if (!lintEnabledPref) {
      return compileEntries.filter((e) => e.source !== 'chktex');
    }
    const filesWithLiveLint = new Set(liveLintByPath.keys());
    const merged: CompileLogEntryDTO[] = [];
    for (const e of compileEntries) {
      if (e.source === 'chktex' && e.file !== undefined && filesWithLiveLint.has(e.file)) continue;
      merged.push(e);
    }
    for (const entries of liveLintByPath.values()) {
      for (const e of entries) merged.push(e);
    }
    return merged;
  }, [compileSession.entries, lintEnabledPref, liveLintByPath]);

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

  // Editor mounts once we have content to render. We delay mounting
  // until *either* the Yjs provider is fully primed (`editorPrimed`)
  // *or* we've given up on it (`collabTimedOut`). Without this guard
  // the editor would mount in solo mode for the first ~100–1000 ms
  // before the WS finishes syncing, then rebuild with yCollab — and
  // the rebuild discards whatever the user typed in that window
  // (since the post-rebuild seed only knows about the original
  // file content, not the unsaved edits).
  const editorReadyNow =
    selectedFile !== null &&
    isEditableTextFile(selectedFile) &&
    !fileContent.isLoading &&
    (editorPrimed || collabTimedOut);

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
    editorReadyNow || (selectedFile !== null && stickyReadyFileId === selectedFile.id);

  // Fire any deferred cross-file jump once the editor for the target
  // file is *actually* mounted and primed. Relying on a fixed delay
  // was racy — large files or a still-syncing Yjs handshake would
  // miss the timer and the user had to double-click again. Here we
  // listen for the genuine "ready" signal and only then invoke
  // gotoLine — robust regardless of mount latency.
  useEffect(() => {
    if (pendingJump === null) return;
    if (selectedFile?.id !== pendingJump.fileId) return;
    if (!editorReady) return;
    // One more microtask to make sure the editor's view has the
    // initial doc content laid out (gotoLine is a no-op against an
    // empty doc).
    const id = window.setTimeout(() => {
      editorRef.current?.gotoLine(pendingJump.line, { flash: pendingJump.flash });
      setPendingJump(null);
    }, 0);
    return () => {
      window.clearTimeout(id);
    };
  }, [pendingJump, selectedFile?.id, editorReady]);

  const commandList = useMemo<CommandItem[]>(() => {
    const cmds: CommandItem[] = [
      {
        id: 'compile',
        label: t('command.compile'),
        group: t('command.groupActions'),
        icon: Play,
        hint: 'Ctrl+Enter',
        keywords: ['compile', 'build', 'run', 'pdf'],
        action: () => {
          void handleCompile();
        },
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
        action: () => {
          toggleRightPanel('outline');
        },
      },
      {
        id: 'review',
        label: t('command.toggleReview'),
        group: t('command.groupPanels'),
        icon: MessageSquare,
        action: () => {
          toggleRightPanel('review');
        },
      },
      {
        id: 'history',
        label: t('command.toggleHistory'),
        group: t('command.groupPanels'),
        icon: History,
        action: () => {
          toggleRightPanel('history');
        },
      },
      {
        id: 'bibliography',
        label: t('command.toggleBibliography'),
        group: t('command.groupPanels'),
        icon: BookText,
        action: () => {
          toggleRightPanel('bibliography');
        },
      },
      {
        id: 'citations',
        label: t('command.toggleCitations'),
        group: t('command.groupPanels'),
        icon: Search,
        action: () => {
          toggleRightPanel('citations');
        },
      },
      {
        id: 'find',
        label: t('command.toggleFind'),
        group: t('command.groupPanels'),
        icon: ReplaceIcon,
        action: () => {
          toggleRightPanel('find');
        },
      },
      {
        id: 'ai-chat',
        label: t('command.toggleAIChat'),
        group: t('command.groupPanels'),
        icon: Sparkles,
        action: () => {
          toggleRightPanel('ai-chat');
        },
      },
      {
        id: 'math',
        label: t('command.toggleMath'),
        group: t('command.groupPanels'),
        icon: Sigma,
        action: () => {
          toggleRightPanel('math');
        },
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
        action: () => {
          onSelectFile(f);
        },
      });
    }
    return cmds;
  }, [files, handleCompile, onSelectFile, t]);

  // Debounced word count. The previous version recomputed via
  // `useMemo` on every `editorContent` change — that's every
  // keystroke, with three regex passes over the entire document. A
  // 50 KB file did ~5-20 ms of regex work per keystroke on the main
  // thread, visibly stuttering on slow machines. Compute only when
  // the user pauses for 400 ms; show the last computed value in
  // between (good enough for an indicator).
  const [wordCount, setWordCount] = useState(0);
  useEffect(() => {
    if (editorContent === '') {
      setWordCount(0);
      return;
    }
    const handle = window.setTimeout(() => {
      const count = editorContent
        .replace(/%.*$/gm, '')
        .replace(/\\[a-zA-Z@]+\*?(\{[^}]*\})?/g, ' ')
        .replace(/\$[^$\n]*\$/g, ' ')
        .trim()
        .split(/\s+/)
        .filter((w) => w.length > 0).length;
      setWordCount(count);
    }, 400);
    return () => {
      window.clearTimeout(handle);
    };
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
      <EditorTabs
        tabs={openFiles}
        activeFileId={selectedFile?.id ?? null}
        onSelect={onSelectFile}
        onClose={onCloseFile}
      />
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
          {/* Folder path of the active file. The tab strip above
              already shows the basename, so we render just the
              parent directory here — keeps the breadcrumb useful for
              nested layouts (e.g. "chapters/intro.tex") without
              duplicating the filename. */}
          {selectedFile !== null ? (
            (() => {
              const idx = selectedFile.path.lastIndexOf('/');
              const folder = idx === -1 ? '' : selectedFile.path.slice(0, idx);
              return folder !== '' ? (
                <span className="truncate text-xs text-muted-foreground" title={selectedFile.path}>
                  {folder}/
                </span>
              ) : null;
            })()
          ) : (
            <span className="truncate text-sm font-medium">{t('compile.noFileSelected')}</span>
          )}
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
          <VoiceControls projectId={projectId} />
          <div className="mx-1 h-4 w-px bg-border" aria-hidden="true" />
          {/* Wide layouts: every panel toggle inline. */}
          <div className="hidden items-center gap-0.5 xl:flex">
            {PANEL_TOGGLES.map((toggle) => (
              <Button
                key={toggle.id}
                variant={rightPanel === toggle.id ? 'default' : 'ghost'}
                size="icon"
                aria-label={t(toggle.labelKey)}
                aria-pressed={rightPanel === toggle.id}
                className="h-7 w-7"
                onClick={() => {
                  toggleRightPanel(toggle.id);
                }}
                title={t(toggle.labelKey)}
              >
                <toggle.icon className="h-3.5 w-3.5" aria-hidden="true" />
              </Button>
            ))}
          </div>
          {/* Narrow layouts: collapse panel toggles into an overflow menu. */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t('project.morePanels')}
                className="h-7 w-7 xl:hidden"
                title={t('project.morePanels')}
              >
                <MoreHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[12rem]">
              {PANEL_TOGGLES.map((toggle) => (
                <DropdownMenuItem
                  key={toggle.id}
                  onSelect={() => {
                    toggleRightPanel(toggle.id);
                  }}
                  className="gap-2"
                >
                  <toggle.icon className="h-3.5 w-3.5" aria-hidden="true" />
                  <span className="flex-1">{t(toggle.labelKey)}</span>
                  {rightPanel === toggle.id ? (
                    <span className="ml-auto text-[10px] text-muted-foreground">●</span>
                  ) : null}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
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
            aria-label={t('handwriting.title')}
            className="h-7 w-7"
            onClick={() => {
              setHandwritingOpen(true);
            }}
            title={t('handwriting.title')}
          >
            <PenLine className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('command.title')}
            className="h-7 w-7"
            onClick={() => {
              setCmdPaletteOpen(true);
            }}
            title="Ctrl+K"
          >
            <Command className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
          {previewCollapsed ? (
            <Button
              variant="ghost"
              size="icon"
              aria-label={t('project.showPreview')}
              title={t('project.showPreview')}
              className="h-7 w-7"
              onClick={togglePreview}
            >
              <Eye className="h-3.5 w-3.5" aria-hidden="true" />
            </Button>
          ) : null}
          <div className="mx-1 h-4 w-px bg-border" aria-hidden="true" />
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
            <span className="hidden sm:inline">{t('compile.runButton')}</span>
          </Button>
        </div>
      </div>
      <div className="flex-1 overflow-hidden">
        {selectedFile === null ? (
          <div className="flex h-full items-center justify-center bg-muted/30 p-6 text-center text-sm text-muted-foreground">
            {t('compile.openTexFile')}
          </div>
        ) : isViewableImage(selectedFile) ? (
          <ImageViewer projectId={projectId} file={selectedFile} />
        ) : !isEditableTextFile(selectedFile) ? (
          <div className="flex h-full items-center justify-center bg-muted/30 p-6 text-center text-sm text-muted-foreground">
            {t('compile.nonTextFile', { path: selectedFile.path })}
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
            hover={hoverSources}
            collab={collab}
            readOnly={editorReadOnly}
            logEntries={logEntries.map((e) => ({
              level: e.level,
              message: e.message,
              ...(e.file !== undefined ? { file: e.file } : {}),
              ...(e.line !== undefined ? { line: e.line } : {}),
              ...(e.column !== undefined ? { column: e.column } : {}),
              ...(e.raw !== undefined ? { raw: e.raw } : {}),
              ...(e.source !== undefined ? { source: e.source } : {}),
            }))}
            onChange={handleChange}
            onCompile={() => {
              void handleCompile();
            }}
            onSave={handleSave}
            onCursor={(line, column) => {
              setCursorLine(line);
              setCursorCol(column);
            }}
          />
        )}
      </div>
    </div>
  );

  const previewPanel = (
    <PreviewPanel
      compileSession={compileSession}
      highlight={highlight}
      onInverseSync={handleInverseSync}
      onJumpTo={handleJumpTo}
      onCollapse={togglePreview}
      downloadFilename={project.name}
    />
  );

  const collabSynced = collab !== null ? yjs.synced : null;
  const compileStatus: CompileStatusKind = compileSession.status;
  const showWordCount = selectedFile !== null && isTexFile(selectedFile);

  return (
    <div className="flex h-full flex-col">
      <PanelGroup direction="horizontal" autoSaveId="scribe:workspace" className="min-h-0 flex-1">
        <Panel defaultSize={50} minSize={20}>
          <ErrorBoundary scope="editor">{editorPanel}</ErrorBoundary>
        </Panel>
        <Splitter orientation="vertical" />
        <Panel
          ref={previewPanelRef}
          defaultSize={50}
          minSize={20}
          collapsible
          collapsedSize={0}
          onCollapse={() => {
            setPreviewCollapsed(true);
          }}
          onExpand={() => {
            setPreviewCollapsed(false);
          }}
        >
          <ErrorBoundary scope="preview">{previewPanel}</ErrorBoundary>
        </Panel>
        {rightPanel !== null ? (
          <>
            <Splitter orientation="vertical" />
            <Panel defaultSize={25} minSize={15} maxSize={45}>
              {rightPanel === 'outline' ? (
                <OutlinePanel
                  contents={outlineContents}
                  mainFile={project.mainFile}
                  onJump={(filePath, line) => {
                    handleJumpTo(filePath, line);
                  }}
                  onClose={() => {
                    setRightPanel(null);
                  }}
                />
              ) : null}
              {rightPanel === 'review' ? (
                <ReviewPanel
                  projectId={projectId}
                  files={files}
                  selectedFile={selectedFile}
                  currentLine={cursorLine}
                  getEditorSelection={() => editorRef.current?.getSelectionRange() ?? null}
                  onJumpToRange={(filePath, from, to, snippet) => {
                    handleJumpToRange(filePath, from, to, snippet);
                  }}
                  onClose={() => {
                    setRightPanel(null);
                  }}
                  currentUserId={authUser?.id ?? null}
                  isProjectOwner={myRole === 'owner'}
                  onApplySuggestion={async ({ replacement }) => {
                    // ReviewPanel already positioned the selection
                    // via onJumpToRange. Give it a microtask so the
                    // editor's scroll + selection settle, then paste.
                    await new Promise<void>((resolve) => {
                      window.setTimeout(() => {
                        editorRef.current?.insertAtCursor(replacement);
                        resolve();
                      }, 30);
                    });
                  }}
                />
              ) : null}
              {rightPanel === 'history' ? (
                <VersionHistory
                  projectId={projectId}
                  onClose={() => {
                    setRightPanel(null);
                  }}
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
                  onClose={() => {
                    setRightPanel(null);
                  }}
                />
              ) : null}
              {rightPanel === 'citations' ? (
                <CitationLookup
                  projectId={projectId}
                  files={files}
                  onCite={(key) => {
                    editorRef.current?.insertAtCursor(`\\cite{${key}}`);
                  }}
                  onClose={() => {
                    setRightPanel(null);
                  }}
                />
              ) : null}
              {rightPanel === 'find' ? (
                <SearchPanel
                  projectId={projectId}
                  files={files}
                  activeFileId={selectedFile?.id ?? null}
                  activeFileContent={editorContent}
                  onSelectFile={(file, line) => {
                    handleJumpTo(file.path, line);
                  }}
                  onClose={() => {
                    setRightPanel(null);
                  }}
                />
              ) : null}
              {rightPanel === 'ai-chat' ? (
                <AIChat
                  onInsert={handleAIInsert}
                  onClose={() => {
                    setRightPanel(null);
                  }}
                />
              ) : null}
              {rightPanel === 'math' ? (
                <MathPalette
                  onInsert={(latex) => {
                    editorRef.current?.insertAtCursor(latex);
                  }}
                  onClose={() => {
                    setRightPanel(null);
                  }}
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
      <HandwritingToLatex
        open={handwritingOpen}
        onOpenChange={setHandwritingOpen}
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
        role={myRole}
      />
      {syncConflicts.length > 0 ? (
        <SyncConflictModal
          projectId={projectId}
          conflicts={syncConflicts}
          onAllResolved={() => {
            setSyncConflicts([]);
          }}
          onClose={() => {
            setSyncConflicts([]);
          }}
        />
      ) : null}
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

/** Environments whose source we surface in a `\ref` hover. Order
 *  affects nothing — we just match the innermost enclosing block. */
const PREVIEWABLE_ENVIRONMENTS = new Set([
  'equation',
  'equation*',
  'align',
  'align*',
  'gather',
  'gather*',
  'multline',
  'multline*',
  'eqnarray',
  'eqnarray*',
  'cases',
  'figure',
  'figure*',
  'table',
  'table*',
  'theorem',
  'lemma',
  'proposition',
  'corollary',
  'definition',
  'remark',
  'example',
  'proof',
]);

interface RefPreview {
  readonly title: string;
  readonly body: string;
  readonly mono: boolean;
}

/** Scan every project .tex file for `\label{name}` and, when found,
 *  walk back to the innermost enclosing `\begin{env}` whose `\end`
 *  comes after the label. Returns the enclosing source block as the
 *  preview body so a hover answers "what does eq:foo look like?"
 *  with the actual equation source. */
function resolveLabelPreview(name: string, contents: Map<string, string>): RefPreview | null {
  if (name === '') return null;
  const labelRe = new RegExp(`\\\\label\\{${name.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\}`);
  for (const [path, content] of contents) {
    const labelMatch = labelRe.exec(content);
    if (labelMatch === null) continue;
    const labelPos = labelMatch.index;
    // Walk every `\begin{env}` … `\end{env}` pair and pick the
    // innermost one that brackets the label position.
    const beginRe = /\\begin\{([a-zA-Z*]+)\}/g;
    let chosen: { env: string; from: number; to: number } | null = null;
    let bm: RegExpExecArray | null;
    while ((bm = beginRe.exec(content)) !== null) {
      const env = bm[1] ?? '';
      if (!PREVIEWABLE_ENVIRONMENTS.has(env)) continue;
      const beginPos = bm.index;
      if (beginPos > labelPos) break;
      const endRe = new RegExp(`\\\\end\\{${env.replace('*', '\\*')}\\}`);
      endRe.lastIndex = beginPos;
      const em = endRe.exec(content.slice(beginPos));
      if (em === null) continue;
      const endPos = beginPos + em.index + em[0].length;
      if (endPos < labelPos) continue;
      // Innermost wins — keep the latest match that still brackets the label.
      chosen = { env, from: beginPos, to: endPos };
    }
    if (chosen !== null) {
      const body = content.slice(chosen.from, chosen.to).trim();
      const trimmed = body.length > 1200 ? `${body.slice(0, 1200)}…` : body;
      return {
        title: `${chosen.env} · ${name}  (${basenameOf(path)})`,
        body: trimmed,
        mono: true,
      };
    }
    // Found the label but not inside a known environment — fall
    // back to a 3-line context window.
    const lineStart = content.lastIndexOf('\n', labelPos) + 1;
    const lineEnd = content.indexOf('\n', labelPos + labelMatch[0].length);
    const around = content.slice(lineStart, lineEnd === -1 ? content.length : lineEnd);
    return {
      title: `label · ${name}  (${basenameOf(path)})`,
      body: around.trim(),
      mono: true,
    };
  }
  return null;
}

/** Format a `\cite{key}` hover as authors · year · title · journal,
 *  pulling fields from the already-parsed bib entries. */
function resolveCitationPreview(
  name: string,
  entries: readonly {
    readonly key: string;
    readonly type: string;
    readonly fields: Readonly<Record<string, string>>;
  }[],
): RefPreview | null {
  if (name === '') return null;
  const entry = entries.find((e) => e.key === name);
  if (entry === undefined) return null;
  const { fields } = entry;
  const authors = fields.author ?? fields.editor ?? '';
  const year = fields.year ?? fields.date ?? '';
  const title = fields.title ?? '';
  const venue = fields.journal ?? fields.booktitle ?? fields.publisher ?? '';
  const lines: string[] = [];
  if (authors !== '') lines.push(stripBraces(authors));
  const meta = [year, venue].filter((s) => s !== '').join(' · ');
  if (meta !== '') lines.push(meta);
  if (title !== '') lines.push(stripBraces(title));
  return {
    title: `${entry.type} · ${name}`,
    body: lines.join('\n'),
    mono: false,
  };
}

function stripBraces(s: string): string {
  return s.replace(/[{}]/g, '').replace(/\s+/g, ' ').trim();
}

function basenameOf(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? path : path.slice(idx + 1);
}

// Re-exports used by tests if any.
export type { CompileJob, CompileLogEntryDTO };
