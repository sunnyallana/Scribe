import { type ProjectFile, type ProjectId } from '@scribe/shared';
import {
  Button,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@scribe/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ChevronDown,
  ChevronRight,
  Download,
  FilePlus,
  FileText,
  FolderClosed,
  FolderOpen,
  FolderPlus,
  Loader2,
  Pencil,
  Trash2,
  Upload,
} from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { api, type ApiError } from '../../lib/api';
import { log } from '../../lib/debug';

interface FileTreeProps {
  readonly projectId: ProjectId;
  readonly files: readonly ProjectFile[];
  readonly selectedFileId?: ProjectFile['id'] | null;
  readonly onSelect?: (file: ProjectFile) => void;
}

interface FolderNode {
  readonly type: 'folder';
  readonly name: string;
  readonly path: string;
  children: TreeNode[];
}
interface FileNode {
  readonly type: 'file';
  readonly name: string;
  readonly file: ProjectFile;
}
type TreeNode = FolderNode | FileNode;

const MIME_FILE_DRAG = 'application/x-scribe-file';

function buildTree(files: readonly ProjectFile[]): TreeNode[] {
  const root: FolderNode = { type: 'folder', name: '', path: '', children: [] };

  for (const file of files) {
    const parts = file.path.split('/').filter((p) => p.length > 0);
    if (parts.length === 0) continue;
    let cursor = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const segment = parts[i];
      if (segment === undefined) continue;
      let folder = cursor.children.find(
        (c): c is FolderNode => c.type === 'folder' && c.name === segment,
      );
      if (folder === undefined) {
        folder = {
          type: 'folder',
          name: segment,
          path: parts.slice(0, i + 1).join('/'),
          children: [],
        };
        cursor.children.push(folder);
      }
      cursor = folder;
    }
    const leaf = parts[parts.length - 1];
    if (leaf === undefined || leaf === '.gitkeep') continue;
    cursor.children.push({ type: 'file', name: leaf, file });
  }

  sort(root.children);
  return root.children;
}

function sort(nodes: TreeNode[]): void {
  nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const n of nodes) {
    if (n.type === 'folder') sort(n.children);
  }
}

/** All files whose path is `folderPath/...`. */
function filesUnder(files: readonly ProjectFile[], folderPath: string): ProjectFile[] {
  const prefix = `${folderPath}/`;
  return files.filter((f) => f.path === `${folderPath}/.gitkeep` || f.path.startsWith(prefix));
}

export function FileTree({ projectId, files, selectedFileId, onSelect }: FileTreeProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(['']));
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const tree = useMemo(() => buildTree(files), [files]);

  const createMutation = useMutation<ProjectFile, ApiError, { path: string; content?: string }>({
    mutationFn: ({ path, content }) => api.files.create(projectId, path, content),
    onSuccess: async (file) => {
      toast.success(t('project.fileCreated', { path: file.path }));
      await queryClient.invalidateQueries({ queryKey: ['files', projectId] });
    },
    onError: (err) => { toast.error(err.body.message); },
  });

  const uploadMutation = useMutation<ProjectFile, ApiError, { path: string; file: File }>({
    mutationFn: ({ path, file }) => api.files.upload(projectId, path, file),
    onSuccess: async (file) => {
      toast.success(t('project.fileUploaded', { path: file.path }));
      await queryClient.invalidateQueries({ queryKey: ['files', projectId] });
    },
    onError: (err) => { toast.error(err.body.message); },
  });

  const renameMutation = useMutation<unknown, ApiError, { fileId: ProjectFile['id']; newPath: string }>({
    mutationFn: ({ fileId, newPath }) => api.files.rename(projectId, fileId, { newPath }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['files', projectId] });
    },
    onError: (err) => { toast.error(err.body.message); },
  });

  const deleteMutation = useMutation<unknown, ApiError, ProjectFile>({
    mutationFn: (file) => api.files.remove(projectId, file.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['files', projectId] });
    },
    onError: (err) => { toast.error(err.body.message); },
  });

  async function downloadFile(file: ProjectFile) {
    try {
      const { url } = await api.files.downloadUrl(projectId, file.id);
      const a = document.createElement('a');
      a.href = url;
      a.download = file.path.split('/').pop() ?? file.path;
      a.click();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  function promptNewFile(prefix = '') {
    const seed = prefix === '' ? 'new.tex' : `${prefix}/new.tex`;
    const name = window.prompt(t('project.newFilePrompt'), seed);
    if (name === null || name.trim() === '') return;
    createMutation.mutate({ path: name.trim() });
  }

  function promptNewFolder(prefix = '') {
    const seed = prefix === '' ? 'chapters' : `${prefix}/sub`;
    const name = window.prompt(t('project.newFolderPrompt'), seed);
    if (name === null || name.trim() === '') return;
    const folder = name.trim().replace(/\/$/, '');
    createMutation.mutate({ path: `${folder}/.gitkeep`, content: '' });
    setExpanded((s) => new Set([...s, folder]));
  }

  function promptRenameFile(file: ProjectFile) {
    const next = window.prompt(t('project.renameFilePrompt'), file.path);
    if (next === null || next.trim() === '' || next.trim() === file.path) return;
    renameMutation.mutate(
      { fileId: file.id, newPath: next.trim() },
      { onSuccess: () => { toast.success(t('project.fileRenamed', { path: next.trim() })); } },
    );
  }

  async function promptRenameFolder(folder: FolderNode) {
    const next = window.prompt(t('project.renameFolderPrompt'), folder.path);
    if (next === null || next.trim() === '' || next.trim() === folder.path) return;
    const newPath = next.trim().replace(/\/$/, '');
    const contained = filesUnder(files, folder.path);
    try {
      await Promise.all(
        contained.map((f) => {
          const rewritten = newPath + f.path.slice(folder.path.length);
          return api.files.rename(projectId, f.id, { newPath: rewritten });
        }),
      );
      await queryClient.invalidateQueries({ queryKey: ['files', projectId] });
      toast.success(t('project.folderRenamed', { path: newPath }));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  async function confirmDeleteFolder(folder: FolderNode) {
    const contained = filesUnder(files, folder.path);
    const ok = window.confirm(
      t('project.deleteFolderConfirm', { path: folder.path, count: contained.length }),
    );
    if (!ok) return;
    try {
      await Promise.all(contained.map((f) => api.files.remove(projectId, f.id)));
      await queryClient.invalidateQueries({ queryKey: ['files', projectId] });
      toast.success(t('project.folderDeleted', { path: folder.path }));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  function handleDelete(file: ProjectFile) {
    if (window.confirm(t('project.deleteFileConfirm', { path: file.path }))) {
      deleteMutation.mutate(file, {
        onSuccess: () => { toast.success(t('project.fileDeleted', { path: file.path })); },
      });
    }
  }

  function handleUploadChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file === undefined) return;
    if (file.name.toLowerCase().endsWith('.zip')) {
      void handleZipUpload(file);
    } else {
      uploadMutation.mutate({ path: file.name, file });
    }
    event.target.value = '';
  }

  async function handleZipUpload(file: File): Promise<void> {
    const { unzipSync } = await import('fflate');
    const buffer = new Uint8Array(await file.arrayBuffer());
    let entries: Record<string, Uint8Array>;
    try {
      entries = unzipSync(buffer);
    } catch (err) {
      // Underlying error matters for bug reports — a corrupt ZIP and
      // an unsupported algorithm (e.g. encrypted) fail the same way
      // from the user's perspective. Log it so a console.export tells
      // us which it was.
      log.editor.warn('zip unpack failed', err, { name: file.name, bytes: file.size });
      toast.error(t('project.zipParseFailed'));
      return;
    }
    const toUpload = Object.entries(entries).filter(([name, data]) => {
      if (name.endsWith('/')) return false;          // directory entry
      if (name.startsWith('__MACOSX/')) return false; // macOS resource forks
      if (name.endsWith('.DS_Store')) return false;
      if (data.byteLength === 0) return false;
      return true;
    });
    if (toUpload.length === 0) {
      toast.warning(t('project.zipEmpty'));
      return;
    }
    const progressId = toast.loading(t('project.zipUploading', { count: toUpload.length }));
    const existingPaths = new Set(files.map((f) => f.path));
    const results = await Promise.allSettled(
      toUpload.map(async ([name, data]) => {
        // Normalize: drop leading "./" or single-folder ZIP wrappers so the
        // project tree mirrors what the user packed, not what their OS did.
        const normalized = name.replace(/^\.\/+/, '').replace(/\\/g, '/');
        const finalPath = existingPaths.has(normalized)
          ? `${normalized}.${Date.now().toString()}`
          : normalized;
        const isLikelyText = /\.(tex|bib|cls|sty|bst|tikz|latex|md|txt|csv|json|yml|yaml|xml|html|ini|cfg)$/i.test(finalPath);
        if (isLikelyText) {
          const text = new TextDecoder('utf-8', { fatal: false }).decode(data);
          return api.files.create(projectId, finalPath, text);
        }
        // Slice off any potential SharedArrayBuffer backing so the TS lib's
        // strict Blob/File typings accept the bytes.
        const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
        const blob = new Blob([ab], { type: 'application/octet-stream' });
        const f = new File([blob], finalPath.split('/').pop() ?? 'file', {
          type: 'application/octet-stream',
        });
        return api.files.upload(projectId, finalPath, f);
      }),
    );
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const failed = results.length - ok;
    toast.dismiss(progressId);
    if (failed === 0) {
      toast.success(t('project.zipUploaded', { count: ok }));
    } else {
      toast.warning(t('project.zipUploadedPartial', { ok, failed }));
    }
    await queryClient.invalidateQueries({ queryKey: ['files', projectId] });
  }

  function toggleFolder(path: string) {
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function handleFileDragStart(e: React.DragEvent<HTMLDivElement>, file: ProjectFile) {
    e.dataTransfer.setData(MIME_FILE_DRAG, file.id);
    e.dataTransfer.effectAllowed = 'move';
  }

  function handleFolderDragOver(e: React.DragEvent<HTMLElement>, folderPath: string) {
    if (!e.dataTransfer.types.includes(MIME_FILE_DRAG)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDropTarget(folderPath);
  }

  function handleFolderDrop(e: React.DragEvent<HTMLElement>, folderPath: string) {
    e.preventDefault();
    setDropTarget(null);
    const fileId = e.dataTransfer.getData(MIME_FILE_DRAG);
    const file = files.find((f) => f.id === fileId);
    if (file === undefined) return;
    const leaf = file.path.split('/').pop() ?? file.path;
    const newPath = folderPath === '' ? leaf : `${folderPath}/${leaf}`;
    if (newPath === file.path) return;
    renameMutation.mutate(
      { fileId: file.id, newPath },
      { onSuccess: () => { toast.success(t('project.fileMoved', { path: newPath })); } },
    );
  }

  const renderNode = (node: TreeNode, depth: number): React.ReactNode => {
    const indent = { paddingLeft: `${(depth * 8 + 4).toString()}px` };
    if (node.type === 'folder') {
      const isOpen = expanded.has(node.path);
      const Icon = isOpen ? FolderOpen : FolderClosed;
      const Chevron = isOpen ? ChevronDown : ChevronRight;
      const isDropTarget = dropTarget === node.path;
      return (
        <li key={`folder:${node.path}`}>
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <div
                className={`group flex items-center gap-1 rounded px-1 py-1 text-sm hover:bg-accent/60 ${
                  isDropTarget ? 'outline outline-1 outline-primary/60 bg-primary/5' : ''
                }`}
                style={indent}
                onDragOver={(e) => { handleFolderDragOver(e, node.path); }}
                onDragLeave={() => { if (dropTarget === node.path) setDropTarget(null); }}
                onDrop={(e) => { handleFolderDrop(e, node.path); }}
              >
                <button
                  type="button"
                  className="flex flex-1 items-center gap-1 truncate text-left"
                  onClick={() => { toggleFolder(node.path); }}
                >
                  <Chevron className="h-3 w-3 flex-shrink-0 text-muted-foreground" aria-hidden="true" />
                  <Icon className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="flex-1 truncate">{node.name}</span>
                </button>
                <button
                  type="button"
                  className="opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100"
                  onClick={() => { promptNewFile(node.path); }}
                  aria-label={t('project.newFile')}
                  title={t('project.newFile')}
                >
                  <FilePlus className="h-3 w-3 text-muted-foreground hover:text-foreground" />
                </button>
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem onClick={() => { promptNewFile(node.path); }}>
                <FilePlus className="h-3.5 w-3.5" aria-hidden="true" />
                {t('project.newFile')}
              </ContextMenuItem>
              <ContextMenuItem onClick={() => { promptNewFolder(node.path); }}>
                <FolderPlus className="h-3.5 w-3.5" aria-hidden="true" />
                {t('project.newFolder')}
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem onClick={() => { void promptRenameFolder(node); }}>
                <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                {t('project.renameFile')}
              </ContextMenuItem>
              <ContextMenuItem destructive onClick={() => { void confirmDeleteFolder(node); }}>
                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                {t('common.delete')}
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
          {isOpen && node.children.length > 0 ? (
            <ul className="space-y-px">{node.children.map((c) => renderNode(c, depth + 1))}</ul>
          ) : null}
        </li>
      );
    }
    const isSelected = selectedFileId === node.file.id;
    return (
      <li key={node.file.id}>
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <div
              className={`group flex items-center gap-1 rounded px-1 py-1 text-sm ${
                isSelected ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/60'
              }`}
              style={indent}
              draggable
              onDragStart={(e) => { handleFileDragStart(e, node.file); }}
            >
              <button
                type="button"
                className="flex flex-1 items-center gap-1 truncate text-left"
                onClick={() => onSelect?.(node.file)}
                onDoubleClick={() => { promptRenameFile(node.file); }}
                aria-current={isSelected ? 'true' : undefined}
              >
                <span className="w-3" aria-hidden="true" />
                <FileText className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="flex-1 truncate">{node.name}</span>
              </button>
              <button
                type="button"
                className="opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100"
                onClick={() => { promptRenameFile(node.file); }}
                aria-label={t('project.renameFile')}
                title={t('project.renameFile')}
              >
                <Pencil className="h-3 w-3 text-muted-foreground hover:text-foreground" />
              </button>
              <button
                type="button"
                className="opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100"
                onClick={() => { handleDelete(node.file); }}
                aria-label={t('common.delete')}
              >
                <Trash2 className="h-3 w-3 text-muted-foreground hover:text-destructive" />
              </button>
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem onClick={() => onSelect?.(node.file)}>
              <FileText className="h-3.5 w-3.5" aria-hidden="true" />
              {t('project.openFile')}
            </ContextMenuItem>
            <ContextMenuItem onClick={() => { promptRenameFile(node.file); }}>
              <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
              {t('project.renameFile')}
            </ContextMenuItem>
            <ContextMenuItem onClick={() => { void downloadFile(node.file); }}>
              <Download className="h-3.5 w-3.5" aria-hidden="true" />
              {t('project.downloadFile')}
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem destructive onClick={() => { handleDelete(node.file); }}>
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              {t('common.delete')}
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      </li>
    );
  };

  const busy = createMutation.isPending || uploadMutation.isPending || renameMutation.isPending;

  return (
    <div
      className={`space-y-2 ${dropTarget === '' ? 'rounded outline outline-1 outline-primary/60' : ''}`}
      onDragOver={(e) => { handleFolderDragOver(e, ''); }}
      onDragLeave={() => { if (dropTarget === '') setDropTarget(null); }}
      onDrop={(e) => { handleFolderDrop(e, ''); }}
    >
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase text-muted-foreground">
          {t('project.files')}
        </span>
        <div className="flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            aria-label={t('project.newFile')}
            title={t('project.newFile')}
            onClick={() => { promptNewFile(); }}
            disabled={busy}
          >
            <FilePlus className="h-3 w-3" aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            aria-label={t('project.newFolder')}
            title={t('project.newFolder')}
            onClick={() => { promptNewFolder(); }}
            disabled={busy}
          >
            <FolderPlus className="h-3 w-3" aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            aria-label={t('project.uploadFile')}
            title={t('project.uploadFile')}
            onClick={() => uploadInputRef.current?.click()}
            disabled={busy}
          >
            {uploadMutation.isPending ? (
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
            ) : (
              <Upload className="h-3 w-3" aria-hidden="true" />
            )}
          </Button>
          <input
            ref={uploadInputRef}
            type="file"
            id="file-tree-upload"
            name="file-tree-upload"
            accept=".tex,.bib,.cls,.sty,.bst,.tikz,.latex,.md,.txt,.csv,.json,.png,.jpg,.jpeg,.gif,.webp,.svg,.pdf,.eps,.zip"
            className="hidden"
            onChange={handleUploadChange}
            aria-hidden="true"
          />
        </div>
      </div>
      {tree.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t('project.noFiles')}</p>
      ) : (
        <ul className="space-y-px">{tree.map((n) => renderNode(n, 0))}</ul>
      )}
    </div>
  );
}
