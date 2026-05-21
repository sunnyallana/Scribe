import { z } from 'zod';

import { fileIdSchema, projectIdSchema, userIdSchema } from './ids.js';

export const commentIdSchema = z.string().uuid().brand<'CommentId'>();
export type CommentId = z.infer<typeof commentIdSchema>;

export const commentSchema = z.object({
  id: commentIdSchema,
  projectId: projectIdSchema,
  fileId: fileIdSchema.nullable(),
  parentId: commentIdSchema.nullable(),
  authorId: userIdSchema,
  authorDisplayName: z.string().nullable(),
  anchorLine: z.number().int().positive().nullable(),
  anchorColumn: z.number().int().nonnegative().nullable(),
  body: z.string(),
  resolvedAt: z.string().nullable(),
  resolvedBy: userIdSchema.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Comment = z.infer<typeof commentSchema>;

export const createCommentInputSchema = z.object({
  fileId: fileIdSchema.optional(),
  parentId: commentIdSchema.optional(),
  anchorLine: z.number().int().positive().optional(),
  anchorColumn: z.number().int().nonnegative().optional(),
  body: z.string().trim().min(1, 'Body is required').max(4000),
});
export type CreateCommentInput = z.infer<typeof createCommentInputSchema>;

export const updateCommentInputSchema = z.object({
  body: z.string().trim().min(1).max(4000).optional(),
  resolved: z.boolean().optional(),
});
export type UpdateCommentInput = z.infer<typeof updateCommentInputSchema>;
