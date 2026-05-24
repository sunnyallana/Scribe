// Adapter over the Rust-side SQLite mirror. Mirrors the Postgres
// shape so the SPA can swap `api.*` calls for `desktopDb.*` when
// running in Tauri without rewriting the React layer.

import { type FileType } from '@scribe/shared';

import { invoke } from './tauri';

export interface LocalProject {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly mainFile: string | null;
  readonly lastOpenedAt: string | null;
  readonly serverSyncedAt: string | null;
  readonly localOnly: number;
  readonly dirty: number;
}

export interface LocalFile {
  readonly id: string;
  readonly projectId: string;
  readonly path: string;
  readonly type: FileType;
  readonly size: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly dirty: number;
  readonly lastSyncedAt: string | null;
}

export interface UpsertProjectInput {
  readonly id: string;
  readonly name: string;
  readonly description?: string | null;
  readonly mainFile?: string | null;
  readonly localOnly: boolean;
}

export interface UpsertFileInput {
  readonly id: string;
  readonly projectId: string;
  readonly path: string;
  readonly type: FileType;
}

export interface YjsUpdateRow {
  readonly id: number;
  readonly docId: string;
  readonly updateBase64: string;
  readonly pushed: number;
}

export const desktopDb = {
  projects: {
    list(): Promise<LocalProject[]> {
      return invoke<LocalProject[]>('db_list_projects');
    },
    get(id: string): Promise<LocalProject | null> {
      return invoke<LocalProject | null>('db_get_project', { id });
    },
    upsert(input: UpsertProjectInput): Promise<void> {
      return invoke<void>('db_upsert_project', {
        input: {
          id: input.id,
          name: input.name,
          description: input.description ?? null,
          mainFile: input.mainFile ?? null,
          localOnly: input.localOnly,
        },
      });
    },
    touch(id: string): Promise<void> {
      return invoke<void>('db_touch_project', { id });
    },
  },
  files: {
    list(projectId: string): Promise<LocalFile[]> {
      return invoke<LocalFile[]>('db_list_files', { projectId });
    },
    readContent(fileId: string): Promise<string | null> {
      return invoke<string | null>('db_read_file', { fileId });
    },
    upsert(input: UpsertFileInput): Promise<void> {
      return invoke<void>('db_upsert_file', {
        input: {
          id: input.id,
          projectId: input.projectId,
          path: input.path,
          type: input.type,
        },
      });
    },
    writeContent(fileId: string, content: string): Promise<void> {
      return invoke<void>('db_write_file_content', { fileId, content });
    },
    remove(fileId: string): Promise<void> {
      return invoke<void>('db_remove_file', { fileId });
    },
  },
  yjs: {
    append(docId: string, updateBase64: string): Promise<number> {
      return invoke<number>('db_append_yjs_update', { docId, updateBase64 });
    },
    load(docId: string): Promise<YjsUpdateRow[]> {
      return invoke<YjsUpdateRow[]>('db_load_yjs_updates', { docId });
    },
    pending(docId: string): Promise<YjsUpdateRow[]> {
      return invoke<YjsUpdateRow[]>('db_pending_yjs_updates', { docId });
    },
    markPushed(ids: number[]): Promise<void> {
      return invoke<void>('db_mark_yjs_pushed', { ids });
    },
  },
  syncState: {
    get(key: string): Promise<string | null> {
      return invoke<string | null>('db_get_sync_state', { key });
    },
    set(key: string, value: string): Promise<void> {
      return invoke<void>('db_set_sync_state', { key, value });
    },
  },
} as const;
