import { z } from 'zod';

import { projectIdSchema, userIdSchema } from './ids.js';

export const versionIdSchema = z.string().uuid().brand<'VersionId'>();
export type VersionId = z.infer<typeof versionIdSchema>;

export const projectVersionSchema = z.object({
  id: versionIdSchema,
  projectId: projectIdSchema,
  createdBy: userIdSchema.nullable(),
  authorDisplayName: z.string().nullable(),
  label: z.string().nullable(),
  fileCount: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  createdAt: z.string(),
});
export type ProjectVersion = z.infer<typeof projectVersionSchema>;

export const versionFileSchema = z.object({
  path: z.string(),
  content: z.string(),
});
export type VersionFile = z.infer<typeof versionFileSchema>;

export const versionPayloadSchema = z.object({
  version: z.literal(1),
  files: z.array(versionFileSchema),
});
export type VersionPayload = z.infer<typeof versionPayloadSchema>;

export const createVersionInputSchema = z.object({
  label: z.string().trim().min(1).max(200).optional(),
});
export type CreateVersionInput = z.infer<typeof createVersionInputSchema>;
