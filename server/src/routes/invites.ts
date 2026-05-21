import { inviteTokenSchema } from '@scribe/shared';

import { createInviteService } from '../services/inviteService.js';

import { sendResult } from './helpers.js';

import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

function getToken(request: FastifyRequest) {
  return inviteTokenSchema.parse((request.params as { token: string }).token);
}

export const invitesRoutes: FastifyPluginAsync = (app) => {
  app.get('/:token', async (request, reply) => {
    const invites = createInviteService({ admin: app.supabaseAdmin });
    return sendResult(reply, await invites.getDetails(getToken(request)));
  });

  app.post(
    '/:token/accept',
    { preHandler: app.requireAuth },
    async (request, reply) => {
      if (request.user === null) return reply.code(401).send();
      const invites = createInviteService({ admin: app.supabaseAdmin });
      return sendResult(
        reply,
        await invites.accept(getToken(request), request.user.id, request.user.email),
      );
    },
  );

  return Promise.resolve();
};
