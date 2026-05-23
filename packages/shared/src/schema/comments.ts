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
  // START of the anchored block (1-based line, 0-based column).
  anchorLine: z.number().int().positive().nullable(),
  anchorColumn: z.number().int().nonnegative().nullable(),
  // END of the anchored block. Equal to (anchorLine, anchorColumn)
  // when the comment was made without a selection — degenerates to
  // a point anchor.
  anchorEndLine: z.number().int().positive().nullable(),
  anchorEndColumn: z.number().int().nonnegative().nullable(),
  // The literal text that was selected when the comment was made.
  // Acts as a resilient anchor — when line numbers drift due to
  // later edits, the SPA can re-locate the comment by searching for
  // this string. Capped at 1024 chars server-side.
  anchorSnippet: z.string().nullable(),
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
  anchorEndLine: z.number().int().positive().optional(),
  anchorEndColumn: z.number().int().nonnegative().optional(),
  anchorSnippet: z.string().max(1024).optional(),
  body: z.string().trim().min(1, 'Body is required').max(4000),
});
export type CreateCommentInput = z.infer<typeof createCommentInputSchema>;

export const updateCommentInputSchema = z.object({
  body: z.string().trim().min(1).max(4000).optional(),
  resolved: z.boolean().optional(),
});
export type UpdateCommentInput = z.infer<typeof updateCommentInputSchema>;
