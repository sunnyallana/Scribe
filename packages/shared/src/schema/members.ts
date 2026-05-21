import { z } from 'zod';

import { memberIdSchema, projectIdSchema, userIdSchema } from './ids.js';

export const memberRoleSchema = z.enum(['owner', 'editor', 'commenter', 'viewer']);
export type MemberRole = z.infer<typeof memberRoleSchema>;

export const inviteRoleSchema = z.enum(['editor', 'commenter', 'viewer']);
export type InviteRole = z.infer<typeof inviteRoleSchema>;

export const projectMemberSchema = z.object({
  id: memberIdSchema,
  projectId: projectIdSchema,
  userId: userIdSchema.nullable(),
  email: z.string().email().nullable(),
  displayName: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  role: memberRoleSchema,
  invitedAt: z.string(),
  acceptedAt: z.string().nullable(),
  expiresAt: z.string(),
  pending: z.boolean(),
});
export type ProjectMember = z.infer<typeof projectMemberSchema>;

export const inviteMemberInputSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  role: inviteRoleSchema.default('editor'),
});
export type InviteMemberInput = z.infer<typeof inviteMemberInputSchema>;

export const updateMemberRoleInputSchema = z.object({
  role: inviteRoleSchema,
});
export type UpdateMemberRoleInput = z.infer<typeof updateMemberRoleInputSchema>;

export const memberListResponseSchema = z.object({
  items: z.array(projectMemberSchema),
});
export type MemberListResponse = z.infer<typeof memberListResponseSchema>;
