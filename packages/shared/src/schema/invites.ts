import { z } from 'zod';

import { inviteTokenSchema, projectIdSchema } from './ids.js';
import { memberRoleSchema } from './members.js';

export const inviteDetailsSchema = z.object({
  token: inviteTokenSchema,
  projectId: projectIdSchema,
  projectName: z.string(),
  inviterDisplayName: z.string().nullable(),
  invitedEmail: z.string().email(),
  role: memberRoleSchema,
  expiresAt: z.string(),
  alreadyAccepted: z.boolean(),
});
export type InviteDetails = z.infer<typeof inviteDetailsSchema>;

export const acceptInviteResponseSchema = z.object({
  projectId: projectIdSchema,
});
export type AcceptInviteResponse = z.infer<typeof acceptInviteResponseSchema>;
