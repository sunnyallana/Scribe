import {
  commentIdSchema,
  createCommentInputSchema,
  projectIdSchema,
  updateCommentInputSchema,
} from '@scribe/shared';

import { createCommentService } from '../services/commentService.js';

import { sendResult } from './helpers.js';

import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

function buildService(request: FastifyRequest) {
  if (request.user === null) throw new Error('auth required');
  return createCommentService({ supabase: request.supabase, userId: request.user.id });
}

function getProjectId(request: FastifyRequest) {
  return projectIdSchema.parse((request.params as { projectId: string }).projectId);
}

function getCommentId(request: FastifyRequest) {
  return commentIdSchema.parse((request.params as { commentId: string }).commentId);
}

export const commentsRoutes: FastifyPluginAsync = (app) => {
  app.addHook('preHandler', app.requireAuth);

  app.get('/:projectId/comments', async (request, reply) => {
    return sendResult(reply, await buildService(request).list(getProjectId(request)));
  });

  app.post('/:projectId/comments', async (request, reply) => {
    const input = createCommentInputSchema.parse(request.body);
    return sendResult(reply, await buildService(request).create(getProjectId(request), input));
  });

  app.patch('/:projectId/comments/:commentId', async (request, reply) => {
    const input = updateCommentInputSchema.parse(request.body);
    return sendResult(
      reply,
      await buildService(request).update(getProjectId(request), getCommentId(request), input),
    );
  });

  app.delete('/:projectId/comments/:commentId', async (request, reply) => {
    return sendResult(
      reply,
      await buildService(request).remove(getProjectId(request), getCommentId(request)),
    );
  });

  return Promise.resolve();
};
