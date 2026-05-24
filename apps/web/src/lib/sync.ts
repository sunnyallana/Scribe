// Sync orchestrator for the Tauri desktop shell.
//
// Rust handles persistence (`desktopDb.*`) and exposes the conflict-
// detection primitive (`sync_apply_remote_files`). This module drives
// the protocol:
//
//   1. Pull: ask the server for its file list, hand it to Rust. Rust
//      replays each entry into SQLite UNLESS our local row is dirty
//      and the server's `updated_at` advanced past our last sync —
//      then it returns the row as a `SyncConflict` and skips it.
//   2. Push: for every dirty local file (minus the conflicting ones),
//      read content from SQLite and PUT it to the server. On success
//      Rust marks the row clean with the server's new `updated_at`.
//   3. Yjs: every editor mutation is appended to SQLite as a
//      `yjs_updates` row. On reconnect the Yjs sync protocol handles
//      the CRDT merge on its own — we just replay our persisted
//      updates into the local doc before connecting so the server's
//      first sync-step-1 reflects everything.
//
// Hard metadata collisions surface as `SyncConflict[]`. The SPA
// renders the `SyncConflictModal` and calls the per-row resolver.

import {
  type FileId,
  type Project,
  type ProjectFile,
  type ProjectId,
  type RenameFileInput,
} from '@scribe/shared';

import { api } from './api';
import { type LocalFile, desktopDb, type YjsUpdateRow } from './desktopDb';
import { invoke, isTauri } from './tauri';

export type SyncStatus = 'idle' | 'syncing' | 'offline' | 'error';

export interface SyncConflict {
  readonly fileId: string;
  readonly path: string;
  readonly localUpdatedAt: string;
  readonly remoteUpdatedAt: string;
}

interface SyncApplyResult {
  readonly applied: number;
  readonly conflicts: readonly SyncConflict[];
}

interface RemoteFilePayload {
  id: string;
  projectId: string;
  path: string;
  type: string;
  updatedAt: string;
  size: number | null;
}

function toRemotePayload(file: ProjectFile): RemoteFilePayload {
  return {
    id: file.id,
    projectId: file.projectId,
    path: file.path,
    type: file.type,
    updatedAt: file.updatedAt,
    size: file.sizeBytes,
  };
}

export interface SyncCycleResult {
  readonly conflicts: readonly SyncConflict[];
  readonly filesPushed: number;
  readonly filesPulled: number;
}

export class SyncManager {
  private readonly listeners = new Set<(status: SyncStatus) => void>();
  private status: SyncStatus = 'idle';

  getStatus(): SyncStatus {
    return this.status;
  }

  onStatus(listener: (status: SyncStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.status);
    return () => this.listeners.delete(listener);
  }

  private setStatus(next: SyncStatus): void {
    if (this.status === next) return;
    this.status = next;
    for (const l of this.listeners) l(next);
  }

  /** Run one full pull→push cycle for the given project. */
  async syncProject(project: Project): Promise<SyncCycleResult> {
    if (!isTauri()) {
      return { conflicts: [], filesPushed: 0, filesPulled: 0 };
    }
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      this.setStatus('offline');
      return { conflicts: [], filesPushed: 0, filesPulled: 0 };
    }
    this.setStatus('syncing');
    try {
      const result = await this.runCycle(project);
      this.setStatus('idle');
      return result;
    } catch (err) {
      this.setStatus('error');
      throw err;
    }
  }

  private async runCycle(project: Project): Promise<SyncCycleResult> {
    // The local `project_files` table has a FK on `projects(id)`, so
    // we MUST seed the parent row before any file insert — otherwise
    // every row gets rejected and the transaction rolls back, leaving
    // SQLite empty even though api.files.list succeeded.
    await desktopDb.projects.upsert({
      id: project.id,
      name: project.name,
      description: project.description,
      mainFile: project.mainFile,
      localOnly: false,
    });
    const projectId = project.id;
    // Pull
    const serverFiles = await api.files.list(projectId);
    const applyResult = await invoke<SyncApplyResult>('sync_apply_remote_files', {
      projectId,
      remoteFiles: serverFiles.map(toRemotePayload),
    });
    const conflictIds = new Set(applyResult.conflicts.map((c) => c.fileId));

    // Push (skip files currently in conflict — user must resolve first)
    const dirty = await invoke<LocalFile[]>('sync_list_dirty_files', { projectId });
    let pushed = 0;
    for (const local of dirty) {
      if (conflictIds.has(local.id)) continue;
      const content = await desktopDb.files.readContent(local.id);
      if (content === null) continue;
      const written = await api.files.writeContent(projectId, local.id as FileId, content);
      await invoke('sync_mark_file_clean', {
        fileId: local.id,
        serverUpdatedAt: written.updatedAt,
      });
      pushed += 1;
    }

    return {
      conflicts: applyResult.conflicts,
      filesPushed: pushed,
      filesPulled: applyResult.applied,
    };
  }

  /** Resolution: take our copy. Pushes the local content and clears the conflict. */
  async resolveKeepLocal(projectId: ProjectId, fileId: string): Promise<void> {
    const content = await desktopDb.files.readContent(fileId);
    if (content === null) {
      throw new Error(`local file ${fileId} has no content to push`);
    }
    const written = await api.files.writeContent(projectId, fileId as FileId, content);
    await invoke('sync_mark_file_clean', {
      fileId,
      serverUpdatedAt: written.updatedAt,
    });
  }

  /** Resolution: take the server's copy. Overwrites local content. */
  async resolveKeepRemote(projectId: ProjectId, fileId: string): Promise<void> {
    const { content } = await api.files.readContent(projectId, fileId as FileId);
    // Pull fresh metadata (server `updated_at` may have advanced again).
    const [server] = (await api.files.list(projectId)).filter((f) => f.id === fileId);
    if (server === undefined) {
      throw new Error(`server file ${fileId} disappeared during conflict resolution`);
    }
    await invoke('sync_apply_remote_content', {
      fileId,
      content,
      remoteUpdatedAt: server.updatedAt,
    });
  }

  /**
   * Resolution: keep both. Copies the local row to a new path
   * (suffixed) and pushes it as a brand-new file, then takes the
   * server's version into the original row.
   */
  async resolveMakeCopy(
    projectId: ProjectId,
    fileId: string,
    suggestedNewPath: string,
  ): Promise<void> {
    const localContent = await desktopDb.files.readContent(fileId);
    if (localContent === null) {
      throw new Error(`local file ${fileId} has no content to copy`);
    }
    // Push a brand-new file with the conflict suffix so both versions exist on the server.
    const createdRemote = await api.files.create(projectId, suggestedNewPath, localContent);
    await invoke('sync_resolve_make_copy', {
      sourceFileId: fileId,
      newFileId: createdRemote.id,
      newPath: suggestedNewPath,
    });
    await invoke('sync_mark_file_clean', {
      fileId: createdRemote.id,
      serverUpdatedAt: createdRemote.updatedAt,
    });
    // Now reset the original row to the server's version.
    await this.resolveKeepRemote(projectId, fileId);
  }

  // ---- Yjs helpers --------------------------------------------------------

  /** Append a Yjs update to local storage. */
  async persistYjsUpdate(docId: string, updateBase64: string): Promise<void> {
    if (!isTauri()) return;
    await desktopDb.yjs.append(docId, updateBase64);
  }

  /** Load all persisted updates so the caller can replay them into a Y.Doc. */
  async loadYjsUpdates(docId: string): Promise<readonly YjsUpdateRow[]> {
    if (!isTauri()) return [];
    return desktopDb.yjs.load(docId);
  }
}

export const syncManager = new SyncManager();

// Renames are a metadata-only mutation but the desktop has to mirror
// the server's response so the local path reflects reality before the
// next pull. Exported as a helper rather than a method so callers can
// drop it into existing flows alongside `api.files.rename`.
export async function syncRename(
  projectId: ProjectId,
  fileId: FileId,
  input: RenameFileInput,
): Promise<ProjectFile> {
  const result = await api.files.rename(projectId, fileId, input);
  if (isTauri()) {
    await desktopDb.files.upsert({
      id: result.id,
      projectId: result.projectId,
      path: result.path,
      type: result.type,
    });
    await invoke('sync_mark_file_clean', {
      fileId: result.id,
      serverUpdatedAt: result.updatedAt,
    });
  }
  return result;
}
