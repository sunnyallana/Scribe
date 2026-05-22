import { randomUUID } from 'node:crypto';

import {
  type CreateFileInput,
  err,
  type FileId,
  inferFileType,
  ok,
  type ProjectFile,
  type ProjectId,
  type RenameFileInput,
  type Result,
  serviceError,
  type ServiceError,
  type UserId,
} from '@scribe/shared';

import type { Database } from '@scribe/shared';
import type { SupabaseClient } from '@supabase/supabase-js';

import { rowToFile } from './mappers.js';
import { storageKey, type StorageService } from './storageService.js';

export interface FileServiceDeps {
  supabase: SupabaseClient<Database>;
  storage: StorageService;
  userId: UserId;
}

export function createFileService({ supabase, storage, userId }: FileServiceDeps) {
  return {
    async list(projectId: ProjectId): Promise<Result<ProjectFile[], ServiceError>> {
      const { data, error } = await supabase
        .from('project_files')
        .select('*')
        .eq('project_id', projectId)
        .order('path');

      if (error !== null) {
        return err(serviceError('internal', error.message));
      }
      return ok(data.map(rowToFile));
    },

    async create(
      projectId: ProjectId,
      input: CreateFileInput,
      content: Buffer | string,
      contentType = 'text/plain; charset=utf-8',
    ): Promise<Result<ProjectFile, ServiceError>> {
      const id = randomUUID();
      const key = storageKey(projectId, id);

      const buffer = typeof content === 'string' ? Buffer.from(content, 'utf-8') : content;

      const uploadResult = await storage.upload(key, buffer, contentType);
      if (!uploadResult.ok) return err(uploadResult.error);

      const fileType = input.type ?? inferFileType(input.path);

      const { data, error } = await supabase
        .from('project_files')
        .insert({
          id,
          project_id: projectId,
          path: input.path,
          type: fileType,
          storage_key: key,
          size_bytes: buffer.byteLength,
          created_by: userId,
        })
        .select('*')
        .single();

      if (error !== null) {
        await storage.remove([key]);
        if (error.code === '23505') {
          return err(serviceError('conflict', 'A file already exists at that path'));
        }
        return err(serviceError('internal', error.message));
      }
      return ok(rowToFile(data));
    },

    async rename(
      projectId: ProjectId,
      fileId: FileId,
      input: RenameFileInput,
    ): Promise<Result<ProjectFile, ServiceError>> {
      const { data, error } = await supabase
        .from('project_files')
        .update({ path: input.newPath })
        .eq('project_id', projectId)
        .eq('id', fileId)
        .select('*')
        .single();

      if (error !== null) {
        if (error.code === '23505') {
          return err(serviceError('conflict', 'A file already exists at that path'));
        }
        if (error.code === 'PGRST116') {
          return err(serviceError('not_found', 'File not found'));
        }
        return err(serviceError('internal', error.message));
      }
      return ok(rowToFile(data));
    },

    async remove(projectId: ProjectId, fileId: FileId): Promise<Result<void, ServiceError>> {
      const { data, error } = await supabase
        .from('project_files')
        .delete()
        .eq('project_id', projectId)
        .eq('id', fileId)
        .select('storage_key')
        .single();

      if (error !== null) {
        if (error.code === 'PGRST116') {
          return err(serviceError('not_found', 'File not found'));
        }
        return err(serviceError('internal', error.message));
      }

      await storage.remove([data.storage_key]);
      return ok(undefined);
    },

    async getDownloadUrl(
      projectId: ProjectId,
      fileId: FileId,
    ): Promise<Result<string, ServiceError>> {
      const { data, error } = await supabase
        .from('project_files')
        .select('storage_key')
        .eq('project_id', projectId)
        .eq('id', fileId)
        .single();

      if (error !== null || data === null) {
        return err(serviceError('not_found', 'File not found'));
      }
      return storage.signedUrl(data.storage_key, 60);
    },

    async writeContent(
      projectId: ProjectId,
      fileId: FileId,
      content: string,
    ): Promise<Result<ProjectFile, ServiceError>> {
      const lookup = await supabase
        .from('project_files')
        .select('storage_key')
        .eq('project_id', projectId)
        .eq('id', fileId)
        .single();

      if (lookup.error !== null || lookup.data === null) {
        return err(serviceError('not_found', 'File not found'));
      }

      const buffer = Buffer.from(content, 'utf-8');
      const upload = await storage.upload(
        lookup.data.storage_key,
        buffer,
        'text/plain; charset=utf-8',
      );
      if (!upload.ok) return err(upload.error);

      const { data, error } = await supabase
        .from('project_files')
        .update({ size_bytes: buffer.byteLength, updated_at: new Date().toISOString() })
        .eq('project_id', projectId)
        .eq('id', fileId)
        .select('*')
        .single();

      if (error !== null || data === null) {
        return err(serviceError('internal', error?.message ?? 'failed to update file row'));
      }
      return ok(rowToFile(data));
    },

    async readContent(
      projectId: ProjectId,
      fileId: FileId,
    ): Promise<Result<string, ServiceError>> {
      const lookup = await supabase
        .from('project_files')
        .select('storage_key')
        .eq('project_id', projectId)
        .eq('id', fileId)
        .single();

      if (lookup.error !== null || lookup.data === null) {
        return err(serviceError('not_found', 'File not found'));
      }

      const blob = await storage.download(lookup.data.storage_key);
      if (!blob.ok) return err(blob.error);

      const text = await blob.value.text();
      return ok(text);
    },
  };
}

export type FileService = ReturnType<typeof createFileService>;
