import {
  err,
  ok,
  type ProjectId,
  type Result,
  serviceError,
  type ServiceError,
} from '@scribe/shared';

import type { Database } from '@scribe/shared';
import type { SupabaseClient } from '@supabase/supabase-js';

export const PROJECT_FILES_BUCKET = 'project-files';
export const COMPILE_ARTIFACTS_BUCKET = 'compile-artifacts';

export interface StorageServiceDeps {
  supabase: SupabaseClient<Database>;
  bucket?: string;
}

export function storageKey(projectId: ProjectId, fileId: string): string {
  return `${projectId}/${fileId}`;
}

export function compileArtifactKey(
  projectId: ProjectId,
  jobId: string,
  filename: string,
): string {
  return `${projectId}/${jobId}/${filename}`;
}

export function createStorageService({ supabase, bucket = PROJECT_FILES_BUCKET }: StorageServiceDeps) {
  return {
    bucket,

    async upload(
      key: string,
      body: ArrayBuffer | Blob | Buffer,
      contentType: string,
    ): Promise<Result<void, ServiceError>> {
      const { error } = await supabase.storage.from(bucket).upload(key, body, {
        contentType,
        upsert: true,
      });
      if (error !== null) {
        return err(serviceError('storage_failed', error.message));
      }
      return ok(undefined);
    },

    async uploadText(key: string, content: string): Promise<Result<void, ServiceError>> {
      return this.upload(key, Buffer.from(content, 'utf-8'), 'text/plain; charset=utf-8');
    },

    async remove(keys: readonly string[]): Promise<Result<void, ServiceError>> {
      if (keys.length === 0) return ok(undefined);
      const { error } = await supabase.storage.from(bucket).remove([...keys]);
      if (error !== null) {
        return err(serviceError('storage_failed', error.message));
      }
      return ok(undefined);
    },

    async signedUrl(key: string, expiresInSeconds = 60): Promise<Result<string, ServiceError>> {
      const { data, error } = await supabase.storage
        .from(bucket)
        .createSignedUrl(key, expiresInSeconds);
      if (error !== null || data === null) {
        return err(serviceError('storage_failed', error?.message ?? 'no signed url'));
      }
      return ok(data.signedUrl);
    },

    async download(key: string): Promise<Result<Blob, ServiceError>> {
      const { data, error } = await supabase.storage.from(bucket).download(key);
      if (error !== null || data === null) {
        return err(serviceError('storage_failed', error?.message ?? 'no data'));
      }
      return ok(data);
    },
  };
}

export type StorageService = ReturnType<typeof createStorageService>;
