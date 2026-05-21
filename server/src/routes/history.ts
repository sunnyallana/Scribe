import { createVersionInputSchema, projectIdSchema, versionIdSchema } from '@scribe/shared';

import { createVersionService } from '../services/versionService.js';

import { sendResult } from './helpers.js';

import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

function buildService(request: FastifyRequest) {
  if (request.user === null) throw new Error('auth required');
  return createVersionService({ supabase: request.supabase, userId: request.user.id });
}

function getProjectId(request: FastifyRequest) {
  return projectIdSchema.parse((request.params as { projectId: string }).projectId);
}

function getVersionId(request: FastifyRequest) {
  return versionIdSchema.parse((request.params as { versionId: string }).versionId);
}

export const historyRoutes: FastifyPluginAsync = (app) => {
  app.addHook('preHandler', app.requireAuth);

  app.get('/:projectId/versions', async (request, reply) => {
    return sendResult(reply, await buildService(request).list(getProjectId(request)));
  });

  app.post('/:projectId/versions', async (request, reply) => {
    const input = createVersionInputSchema.parse(request.body ?? {});
    return sendResult(reply, await buildService(request).snapshot(getProjectId(request), input));
  });

  app.get('/:projectId/versions/:versionId', async (request, reply) => {
    return sendResult(reply, await buildService(request).get(getVersionId(request)));
  });

  app.post('/:projectId/versions/:versionId/restore', async (request, reply) => {
    return sendResult(
      reply,
      await buildService(request).restore(getProjectId(request), getVersionId(request)),
    );
  });

  return Promise.resolve();
};
