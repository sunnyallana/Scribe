import {
  type CreateVersionInput,
  err,
  ok,
  type ProjectId,
  type ProjectVersion,
  type Result,
  serviceError,
  type ServiceError,
  type UserId,
  type VersionFile,
  versionIdSchema,
  type VersionPayload,
  versionPayloadSchema,
} from '@scribe/shared';

import {
  COMPILE_ARTIFACTS_BUCKET,
  createStorageService,
  PROJECT_FILES_BUCKET,
} from './storageService.js';

import type { Database } from '@scribe/shared';
import type { SupabaseClient } from '@supabase/supabase-js';

const VERSION_BUCKET = 'version-snapshots';

export interface VersionServiceDeps {
  supabase: SupabaseClient<Database>;
  userId: UserId;
}

interface ProjectVersionRow {
  readonly id: string;
  readonly project_id: string;
  readonly created_by: string | null;
  readonly label: string | null;
  readonly storage_key: string;
  readonly file_count: number;
  readonly total_bytes: number;
  readonly created_at: string;
  readonly author?: { readonly display_name: string | null; readonly email: string | null } | null;
}

function rowToVersion(row: ProjectVersionRow): ProjectVersion {
  return {
    id: versionIdSchema.parse(row.id),
    projectId: row.project_id as ProjectId,
    createdBy: row.created_by === null ? null : (row.created_by as UserId),
    authorDisplayName: row.author?.display_name ?? row.author?.email ?? null,
    label: row.label,
    fileCount: row.file_count,
    totalBytes: row.total_bytes,
    createdAt: row.created_at,
  };
}

export function createVersionService({ supabase, userId }: VersionServiceDeps) {
  const versionStorage = createStorageService({ supabase, bucket: VERSION_BUCKET });
  const projectStorage = createStorageService({ supabase, bucket: PROJECT_FILES_BUCKET });

  // Reference COMPILE_ARTIFACTS_BUCKET to keep imports clear about what's used
  // elsewhere; lint will drop unused otherwise.
  void COMPILE_ARTIFACTS_BUCKET;

  return {
    async list(projectId: ProjectId): Promise<Result<ProjectVersion[], ServiceError>> {
      const { data, error } = await supabase
        .from('project_versions')
        .select('*, author:users!project_versions_created_by_fkey(display_name, email)')
        .eq('project_id', projectId)
        .order('created_at', { ascending: false })
        .limit(100);
      if (error !== null) return err(serviceError('internal', error.message));
      return ok((data as unknown as ProjectVersionRow[]).map(rowToVersion));
    },

    async snapshot(
      projectId: ProjectId,
      input: CreateVersionInput,
    ): Promise<Result<ProjectVersion, ServiceError>> {
      // Fetch all .tex / .bib files for the project.
      const filesResp = await supabase
        .from('project_files')
        .select('path, storage_key, type')
        .eq('project_id', projectId)
        .in('type', ['tex', 'bib']);
      if (filesResp.error !== null) {
        return err(serviceError('internal', filesResp.error.message));
      }

      const files: VersionFile[] = [];
      let totalBytes = 0;
      for (const file of filesResp.data) {
        const dl = await projectStorage.download(file.storage_key);
        if (!dl.ok) {
          return err(dl.error);
        }
        const text = await dl.value.text();
        files.push({ path: file.path, content: text });
        totalBytes += Buffer.byteLength(text, 'utf-8');
      }

      const payload: VersionPayload = { version: 1, files };
      const versionId = crypto.randomUUID();
      const storageKey = `${projectId}/${versionId}.json`;
      const body = Buffer.from(JSON.stringify(payload), 'utf-8');
      const upload = await versionStorage.upload(storageKey, body, 'application/json');
      if (!upload.ok) return err(upload.error);

      const insertPayload: Database['public']['Tables']['project_versions']['Insert'] = {
        id: versionId,
        project_id: projectId,
        created_by: userId,
        storage_key: storageKey,
        file_count: files.length,
        total_bytes: totalBytes,
      };
      if (input.label !== undefined) insertPayload.label = input.label;

      const { data, error } = await supabase
        .from('project_versions')
        .insert(insertPayload)
        .select('*, author:users!project_versions_created_by_fkey(display_name, email)')
        .single();
      if (error !== null || data === null) {
        await versionStorage.remove([storageKey]);
        return err(serviceError('internal', error?.message ?? 'failed to insert version row'));
      }
      return ok(rowToVersion(data as unknown as ProjectVersionRow));
    },

    async get(versionId: string): Promise<Result<VersionPayload, ServiceError>> {
      const row = await supabase
        .from('project_versions')
        .select('storage_key')
        .eq('id', versionId)
        .single();
      if (row.error !== null || row.data === null) {
        return err(serviceError('not_found', 'Version not found'));
      }
      const dl = await versionStorage.download(row.data.storage_key);
      if (!dl.ok) return err(dl.error);
      try {
        const text = await dl.value.text();
        return ok(versionPayloadSchema.parse(JSON.parse(text)));
      } catch (e) {
        return err(serviceError('internal', `Version payload malformed: ${(e as Error).message}`));
      }
    },

    async restore(projectId: ProjectId, versionId: string): Promise<Result<void, ServiceError>> {
      const payload = await this.get(versionId);
      if (!payload.ok) return err(payload.error);

      const filesResp = await supabase
        .from('project_files')
        .select('id, path, storage_key')
        .eq('project_id', projectId);
      if (filesResp.error !== null) {
        return err(serviceError('internal', filesResp.error.message));
      }
      const byPath = new Map(filesResp.data.map((f) => [f.path, f]));

      for (const file of payload.value.files) {
        const existing = byPath.get(file.path);
        if (existing === undefined) continue; // skip files no longer in project
        const up = await projectStorage.uploadText(existing.storage_key, file.content);
        if (!up.ok) return err(up.error);
        const upd = await supabase
          .from('project_files')
          .update({
            size_bytes: Buffer.byteLength(file.content, 'utf-8'),
            updated_at: new Date().toISOString(),
          })
          .eq('id', existing.id);
        if (upd.error !== null) {
          return err(serviceError('internal', upd.error.message));
        }
      }
      return ok(undefined);
    },
  };
}

export type VersionService = ReturnType<typeof createVersionService>;
