import {
  inviteMemberInputSchema,
  memberIdSchema,
  projectIdSchema,
  updateMemberRoleInputSchema,
} from '@scribe/shared';

import { createEmailService } from '../services/emailService.js';
import { createMemberService } from '../services/memberService.js';

import { sendResult } from './helpers.js';

import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

function buildMemberService(request: FastifyRequest) {
  if (request.user === null) throw new Error('auth required');
  const email = createEmailService({ env: request.server.env, logger: request.log });
  return createMemberService({
    supabase: request.supabase,
    admin: request.server.supabaseAdmin,
    email,
    appUrl: request.server.env.APP_URL,
    inviterId: request.user.id,
  });
}

function getProjectId(request: FastifyRequest) {
  return projectIdSchema.parse((request.params as { projectId: string }).projectId);
}

function getMemberId(request: FastifyRequest) {
  return memberIdSchema.parse((request.params as { memberId: string }).memberId);
}

export const membersRoutes: FastifyPluginAsync = (app) => {
  app.addHook('preHandler', app.requireAuth);

  app.get('/:projectId/members', async (request, reply) => {
    const members = buildMemberService(request);
    return sendResult(reply, await members.list(getProjectId(request)));
  });

  app.post('/:projectId/members', async (request, reply) => {
    const input = inviteMemberInputSchema.parse(request.body);
    const members = buildMemberService(request);
    return sendResult(reply, await members.invite(getProjectId(request), input));
  });

  app.patch('/:projectId/members/:memberId', async (request, reply) => {
    const input = updateMemberRoleInputSchema.parse(request.body);
    const members = buildMemberService(request);
    return sendResult(
      reply,
      await members.updateRole(getProjectId(request), getMemberId(request), input),
    );
  });

  app.delete('/:projectId/members/:memberId', async (request, reply) => {
    const members = buildMemberService(request);
    return sendResult(reply, await members.remove(getProjectId(request), getMemberId(request)));
  });

  return Promise.resolve();
};
