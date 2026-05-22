import {
  type CreateProjectInput,
  err,
  ok,
  type Project,
  type ProjectId,
  type Result,
  serviceError,
  type ServiceError,
  type UpdateProjectInput,
  type UserId,
} from '@scribe/shared';

import type { Database } from '@scribe/shared';
import type { SupabaseClient } from '@supabase/supabase-js';

import { rowToProject } from './mappers.js';
import { type FileService } from './fileService.js';
import { filesForTemplate } from './templates.js';

export interface ProjectServiceDeps {
  supabase: SupabaseClient<Database>;
  files: FileService;
  userId: UserId;
}

export function createProjectService({ supabase, files, userId }: ProjectServiceDeps) {
  return {
    async list(): Promise<Result<Project[], ServiceError>> {
      const { data, error } = await supabase
        .from('projects')
        .select('*')
        .is('archived_at', null)
        .order('updated_at', { ascending: false });

      if (error !== null) {
        return err(serviceError('internal', error.message));
      }
      return ok(data.map(rowToProject));
    },

    async get(id: ProjectId): Promise<Result<Project, ServiceError>> {
      const { data, error } = await supabase.from('projects').select('*').eq('id', id).single();
      if (error !== null || data === null) {
        if (error?.code === 'PGRST116') {
          return err(serviceError('not_found', 'Project not found'));
        }
        return err(serviceError('internal', error?.message ?? 'unknown error'));
      }
      return ok(rowToProject(data));
    },

    async create(input: CreateProjectInput): Promise<Result<Project, ServiceError>> {
      const insertPayload: Database['public']['Tables']['projects']['Insert'] = {
        name: input.name,
        owner_id: userId,
        template: input.template,
        compiler: input.compiler,
      };
      if (input.description !== undefined) {
        insertPayload.description = input.description;
      }
      const { data, error } = await supabase
        .from('projects')
        .insert(insertPayload)
        .select('*')
        .single();

      if (error !== null) {
        return err(serviceError('internal', error.message));
      }

      const project = rowToProject(data);

      for (const file of filesForTemplate(input.template)) {
        const seedResult = await files.create(
          project.id,
          { path: file.path, type: 'tex' },
          file.content,
        );
        if (!seedResult.ok) {
          await supabase.from('projects').delete().eq('id', project.id);
          return err(seedResult.error);
        }
      }

      return ok(project);
    },

    async update(
      id: ProjectId,
      input: UpdateProjectInput,
    ): Promise<Result<Project, ServiceError>> {
      const updatePayload: Database['public']['Tables']['projects']['Update'] = {};
      if (input.name !== undefined) updatePayload.name = input.name;
      if (input.description !== undefined) updatePayload.description = input.description;
      if (input.compiler !== undefined) updatePayload.compiler = input.compiler;
      if (input.mainFile !== undefined) updatePayload.main_file = input.mainFile;
      if (input.isPublic !== undefined) updatePayload.is_public = input.isPublic;

      const { data, error } = await supabase
        .from('projects')
        .update(updatePayload)
        .eq('id', id)
        .select('*')
        .single();

      if (error !== null || data === null) {
        if (error?.code === 'PGRST116') {
          return err(serviceError('not_found', 'Project not found'));
        }
        return err(serviceError('internal', error?.message ?? 'unknown error'));
      }
      return ok(rowToProject(data));
    },

    async remove(id: ProjectId): Promise<Result<void, ServiceError>> {
      const { error } = await supabase.from('projects').delete().eq('id', id);
      if (error !== null) {
        return err(serviceError('internal', error.message));
      }
      return ok(undefined);
    },
  };
}

export type ProjectService = ReturnType<typeof createProjectService>;
