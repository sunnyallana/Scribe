import {
  type AcceptInviteResponse,
  err,
  type InviteDetails,
  type InviteToken,
  ok,
  type ProjectId,
  type Result,
  serviceError,
  type ServiceError,
} from '@scribe/shared';

import type { Database } from '@scribe/shared';
import type { SupabaseClient } from '@supabase/supabase-js';

export interface InviteServiceDeps {
  admin: SupabaseClient<Database>;
}

interface InviteRecord {
  readonly id: string;
  readonly project_id: string;
  readonly invited_email: string | null;
  readonly role: 'owner' | 'editor' | 'commenter' | 'viewer';
  readonly invite_expires_at: string;
  readonly invite_accepted_at: string | null;
  readonly user_id: string | null;
  readonly invited_by: string | null;
}

export function createInviteService({ admin }: InviteServiceDeps) {
  return {
    async getDetails(token: InviteToken): Promise<Result<InviteDetails, ServiceError>> {
      const { data: invite, error } = await admin
        .from('project_members')
        .select(
          `
            id,
            project_id,
            invited_email,
            role,
            invite_expires_at,
            invite_accepted_at,
            user_id,
            invited_by,
            project:projects ( name ),
            inviter:users!project_members_invited_by_fkey ( display_name )
          `,
        )
        .eq('invite_token', token)
        .maybeSingle();

      if (error !== null) {
        return err(serviceError('internal', error.message));
      }
      if (invite === null) {
        return err(serviceError('not_found', 'Invitation not found'));
      }
      const record = invite as unknown as InviteRecord & {
        project: { name: string } | null;
        inviter: { display_name: string | null } | null;
      };
      if (record.invited_email === null) {
        return err(serviceError('internal', 'Invitation is missing an email'));
      }
      if (new Date(record.invite_expires_at).getTime() < Date.now()) {
        return err(serviceError('invite_expired', 'Invitation has expired'));
      }
      return ok({
        token,
        projectId: record.project_id as ProjectId,
        projectName: record.project?.name ?? '',
        inviterDisplayName: record.inviter?.display_name ?? null,
        invitedEmail: record.invited_email,
        role: record.role,
        expiresAt: record.invite_expires_at,
        alreadyAccepted: record.invite_accepted_at !== null,
      });
    },

    async accept(
      token: InviteToken,
      acceptingUserId: string,
      acceptingUserEmail: string,
    ): Promise<Result<AcceptInviteResponse, ServiceError>> {
      const { data: invite, error: findError } = await admin
        .from('project_members')
        .select('id, project_id, invited_email, invite_expires_at, invite_accepted_at, user_id')
        .eq('invite_token', token)
        .maybeSingle();

      if (findError !== null) {
        return err(serviceError('internal', findError.message));
      }
      if (invite === null) {
        return err(serviceError('not_found', 'Invitation not found'));
      }
      if (new Date(invite.invite_expires_at).getTime() < Date.now()) {
        return err(serviceError('invite_expired', 'Invitation has expired'));
      }
      if (
        invite.invited_email !== null &&
        invite.invited_email.toLowerCase() !== acceptingUserEmail.toLowerCase()
      ) {
        return err(serviceError('forbidden', 'This invitation is for a different email address'));
      }
      if (invite.invite_accepted_at !== null && invite.user_id !== acceptingUserId) {
        return err(serviceError('invite_consumed', 'This invitation has already been accepted'));
      }

      const { error: updateError } = await admin
        .from('project_members')
        .update({
          user_id: acceptingUserId,
          invite_accepted_at: new Date().toISOString(),
        })
        .eq('id', invite.id);

      if (updateError !== null) {
        return err(serviceError('internal', updateError.message));
      }

      return ok({ projectId: invite.project_id as ProjectId });
    },
  };
}

export type InviteService = ReturnType<typeof createInviteService>;
