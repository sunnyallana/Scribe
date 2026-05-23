import { z } from 'zod';

import { projectIdSchema, shareLinkIdSchema, shareTokenSchema, userIdSchema } from './ids.js';

/** Roles a share link can grant. Deliberately narrower than the full
 *  `MemberRole` set — editor access via link bypasses owner approval,
 *  which is gated to explicit per-email invites for v1. */
export const shareRoleSchema = z.enum(['viewer', 'commenter']);
export type ShareRole = z.infer<typeof shareRoleSchema>;

export const shareLinkSchema = z.object({
  id: shareLinkIdSchema,
  projectId: projectIdSchema,
  token: shareTokenSchema,
  role: shareRoleSchema,
  createdBy: userIdSchema,
  createdAt: z.string(),
  expiresAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
});
export type ShareLink = z.infer<typeof shareLinkSchema>;

export const createShareLinkInputSchema = z.object({
  role: shareRoleSchema,
  /** ISO timestamp; omit to mean "never expires". */
  expiresAt: z.string().datetime().optional(),
});
export type CreateShareLinkInput = z.infer<typeof createShareLinkInputSchema>;

/** Public preview of a share link — what the landing page renders
 *  before the visitor signs in / accepts. No token in the response;
 *  the visitor already has it in the URL. */
export const sharePreviewSchema = z.object({
  projectId: projectIdSchema,
  projectName: z.string(),
  role: shareRoleSchema,
  expiresAt: z.string().nullable(),
});
export type SharePreview = z.infer<typeof sharePreviewSchema>;

export const redeemShareResponseSchema = z.object({
  projectId: projectIdSchema,
  role: shareRoleSchema,
});
export type RedeemShareResponse = z.infer<typeof redeemShareResponseSchema>;
