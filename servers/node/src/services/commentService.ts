import {
  type Comment,
  type CommentId,
  type CreateCommentInput,
  err,
  ok,
  type ProjectId,
  type Result,
  serviceError,
  type ServiceError,
  type UpdateCommentInput,
  type UserId,
} from '@scribe/shared';

import { type CommentRowWithAuthor, rowToComment } from './mappers.js';

import type { Database } from '@scribe/shared';
import type { SupabaseClient } from '@supabase/supabase-js';

export interface CommentServiceDeps {
  supabase: SupabaseClient<Database>;
  userId: UserId;
}

export function createCommentService({ supabase, userId }: CommentServiceDeps) {
  return {
    async list(projectId: ProjectId): Promise<Result<Comment[], ServiceError>> {
      const { data, error } = await supabase
        .from('comments')
        .select('*, author:users!comments_author_id_fkey(display_name, email)')
        .eq('project_id', projectId)
        .order('created_at', { ascending: true });
      if (error !== null) {
        return err(serviceError('internal', error.message));
      }
      return ok(
        (data as unknown as CommentRowWithAuthor[]).map((row) => rowToComment(row)),
      );
    },

    async create(
      projectId: ProjectId,
      input: CreateCommentInput,
    ): Promise<Result<Comment, ServiceError>> {
      const payload: Database['public']['Tables']['comments']['Insert'] = {
        project_id: projectId,
        author_id: userId,
        body: input.body,
      };
      if (input.fileId !== undefined) payload.file_id = input.fileId;
      if (input.parentId !== undefined) payload.parent_id = input.parentId;
      if (input.anchorLine !== undefined) payload.anchor_line = input.anchorLine;
      if (input.anchorColumn !== undefined) payload.anchor_column = input.anchorColumn;

      const { data, error } = await supabase
        .from('comments')
        .insert(payload)
        .select('*, author:users!comments_author_id_fkey(display_name, email)')
        .single();
      if (error !== null || data === null) {
        return err(serviceError('internal', error?.message ?? 'failed to insert comment'));
      }
      return ok(rowToComment(data as unknown as CommentRowWithAuthor));
    },

    async update(
      projectId: ProjectId,
      commentId: CommentId,
      input: UpdateCommentInput,
    ): Promise<Result<Comment, ServiceError>> {
      const patch: Database['public']['Tables']['comments']['Update'] = {};
      if (input.body !== undefined) patch.body = input.body;
      if (input.resolved !== undefined) {
        patch.resolved_at = input.resolved ? new Date().toISOString() : null;
        patch.resolved_by = input.resolved ? userId : null;
      }

      const { data, error } = await supabase
        .from('comments')
        .update(patch)
        .eq('project_id', projectId)
        .eq('id', commentId)
        .select('*, author:users!comments_author_id_fkey(display_name, email)')
        .single();
      if (error !== null || data === null) {
        if (error?.code === 'PGRST116') {
          return err(serviceError('not_found', 'Comment not found'));
        }
        return err(serviceError('internal', error?.message ?? 'failed to update comment'));
      }
      return ok(rowToComment(data as unknown as CommentRowWithAuthor));
    },

    async remove(projectId: ProjectId, commentId: CommentId): Promise<Result<void, ServiceError>> {
      const { error } = await supabase
        .from('comments')
        .delete()
        .eq('project_id', projectId)
        .eq('id', commentId);
      if (error !== null) {
        return err(serviceError('internal', error.message));
      }
      return ok(undefined);
    },
  };
}

export type CommentService = ReturnType<typeof createCommentService>;
