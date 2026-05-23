import { z } from 'zod';

import { projectIdSchema, userIdSchema } from './ids.js';

/** Notification kinds we emit today. New kinds should map to a new
 *  case in the UI's renderer + (usually) a new server-side event
 *  hook that calls NotificationService::emit. */
export const notificationKindSchema = z.enum([
  'mention',
  'comment_reply',
  'invite_accepted',
  'share_redeemed',
]);
export type NotificationKind = z.infer<typeof notificationKindSchema>;

/** Per-kind payload shapes. The server stores the union as `jsonb`;
 *  the client validates as it renders. Adding a field to a kind is
 *  forward-compatible — old clients ignore unknown keys. */
export const notificationPayloadSchema = z
  .object({
    projectId: projectIdSchema.optional(),
    projectName: z.string().optional(),
    /** Display name of whoever triggered the notification. */
    actorName: z.string().optional(),
    actorId: userIdSchema.optional(),
    /** Comment id when the kind is mention / comment_reply. */
    commentId: z.string().optional(),
    /** Snippet of the comment body for at-a-glance context. */
    snippet: z.string().optional(),
    /** Role the share link granted; only on `share_redeemed`. */
    role: z.string().optional(),
  })
  .passthrough();
export type NotificationPayload = z.infer<typeof notificationPayloadSchema>;

export const notificationSchema = z.object({
  id: z.string().uuid(),
  userId: userIdSchema,
  kind: notificationKindSchema,
  payload: notificationPayloadSchema,
  readAt: z.string().nullable(),
  createdAt: z.string(),
});
export type Notification = z.infer<typeof notificationSchema>;

export const unreadCountResponseSchema = z.object({
  count: z.number().int().nonnegative(),
});
export type UnreadCountResponse = z.infer<typeof unreadCountResponseSchema>;
