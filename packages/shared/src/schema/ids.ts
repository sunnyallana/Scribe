import { z } from 'zod';

export const userIdSchema = z.string().uuid().brand<'UserId'>();
export type UserId = z.infer<typeof userIdSchema>;

export const projectIdSchema = z.string().uuid().brand<'ProjectId'>();
export type ProjectId = z.infer<typeof projectIdSchema>;

export const fileIdSchema = z.string().uuid().brand<'FileId'>();
export type FileId = z.infer<typeof fileIdSchema>;

export const memberIdSchema = z.string().uuid().brand<'MemberId'>();
export type MemberId = z.infer<typeof memberIdSchema>;

export const inviteTokenSchema = z.string().min(20).brand<'InviteToken'>();
export type InviteToken = z.infer<typeof inviteTokenSchema>;
