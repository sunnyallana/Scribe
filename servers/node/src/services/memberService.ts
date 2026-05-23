import { randomBytes } from 'node:crypto';

import {
  err,
  type InviteMemberInput,
  type MemberId,
  ok,
  type ProjectId,
  type ProjectMember,
  type Result,
  serviceError,
  type ServiceError,
  type UpdateMemberRoleInput,
  type UserId,
} from '@scribe/shared';

import type { Database } from '@scribe/shared';
import type { SupabaseClient } from '@supabase/supabase-js';

import { rowToMember, type MemberRowWithUser } from './mappers.js';
import { type EmailService } from './emailService.js';

export interface MemberServiceDeps {
  supabase: SupabaseClient<Database>;
  admin: SupabaseClient<Database>;
  email: EmailService;
  appUrl: string;
  inviterId: UserId;
}

const MEMBER_SELECT = `
  id,
  project_id,
  user_id,
  invited_email,
  role,
  invited_at,
  invite_expires_at,
  invite_accepted_at,
  user:users (
    email,
    display_name,
    avatar_url
  )
`;

export function createMemberService(deps: MemberServiceDeps) {
  const { supabase, admin, email, appUrl, inviterId } = deps;

  return {
    async list(projectId: ProjectId): Promise<Result<ProjectMember[], ServiceError>> {
      const { data, error } = await supabase
        .from('project_members')
        .select(MEMBER_SELECT)
        .eq('project_id', projectId)
        .order('invited_at', { ascending: true });

      if (error !== null) {
        return err(serviceError('internal', error.message));
      }
      const rows = data as unknown as MemberRowWithUser[];
      return ok(rows.map(rowToMember));
    },

    async invite(
      projectId: ProjectId,
      input: InviteMemberInput,
    ): Promise<Result<ProjectMember, ServiceError>> {
      const inviteToken = randomBytes(32).toString('base64url');

      const { data: existingUser } = await admin
        .from('users')
        .select('id')
        .ilike('email', input.email)
        .maybeSingle();

      const insertPayload: Database['public']['Tables']['project_members']['Insert'] = {
        project_id: projectId,
        invited_email: input.email,
        role: input.role,
        invite_token: inviteToken,
        invited_by: inviterId,
      };
      if (existingUser !== null) {
        insertPayload.user_id = existingUser.id;
      }

      const { data: insertedRaw, error: insertError } = await supabase
        .from('project_members')
        .insert(insertPayload)
        .select(MEMBER_SELECT)
        .single();

      if (insertError !== null) {
        if (insertError.code === '23505') {
          return err(serviceError('conflict', 'That user is already invited or a member'));
        }
        return err(serviceError('internal', insertError.message));
      }

      const inserted = insertedRaw as unknown as MemberRowWithUser;

      const [{ data: projectRow }, { data: inviter }] = await Promise.all([
        admin.from('projects').select('name').eq('id', projectId).single(),
        admin.from('users').select('display_name').eq('id', inviterId).maybeSingle(),
      ]);

      if (projectRow !== null) {
        const sendResult = await email.sendInvite({
          to: input.email,
          inviterDisplayName: inviter?.display_name ?? null,
          projectName: projectRow.name,
          role: input.role,
          acceptUrl: `${appUrl}/invite/${inviteToken}`,
          expiresAt: inserted.invite_expires_at,
        });
        if (!sendResult.ok) {
          await admin.from('project_members').delete().eq('id', inserted.id);
          return err(sendResult.error);
        }
      }

      return ok(rowToMember(inserted));
    },

    async updateRole(
      projectId: ProjectId,
      memberId: MemberId,
      input: UpdateMemberRoleInput,
    ): Promise<Result<ProjectMember, ServiceError>> {
      const { data: updatedRaw, error } = await supabase
        .from('project_members')
        .update({ role: input.role })
        .eq('id', memberId)
        .eq('project_id', projectId)
        .neq('role', 'owner')
        .select(MEMBER_SELECT)
        .single();

      if (error !== null) {
        if (error.code === 'PGRST116') {
          return err(serviceError('not_found', 'Member not found'));
        }
        return err(serviceError('internal', error.message));
      }
      return ok(rowToMember(updatedRaw as unknown as MemberRowWithUser));
    },

    async remove(projectId: ProjectId, memberId: MemberId): Promise<Result<void, ServiceError>> {
      const { error } = await supabase
        .from('project_members')
        .delete()
        .eq('id', memberId)
        .eq('project_id', projectId)
        .neq('role', 'owner');

      if (error !== null) {
        return err(serviceError('internal', error.message));
      }
      return ok(undefined);
    },
  };
}

export type MemberService = ReturnType<typeof createMemberService>;
