import {
  createProjectInputSchema,
  projectIdSchema,
  updateProjectInputSchema,
} from '@scribe/shared';

import { createFileService } from '../services/fileService.js';
import { createProjectService } from '../services/projectService.js';
import { createStorageService } from '../services/storageService.js';

import { sendResult } from './helpers.js';

import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

function buildProjectServices(request: FastifyRequest) {
  if (request.user === null) throw new Error('auth required');
  const supabase = request.supabase;
  const userId = request.user.id;
  const storage = createStorageService({ supabase });
  const files = createFileService({ supabase, storage, userId });
  const projects = createProjectService({ supabase, files, userId });
  return projects;
}

export const projectsRoutes: FastifyPluginAsync = (app) => {
  app.addHook('preHandler', app.requireAuth);

  app.get('/', async (request, reply) => {
    const projects = buildProjectServices(request);
    return sendResult(reply, await projects.list());
  });

  app.post('/', async (request, reply) => {
    const input = createProjectInputSchema.parse(request.body);
    const projects = buildProjectServices(request);
    return sendResult(reply, await projects.create(input));
  });

  app.get('/:projectId', async (request, reply) => {
    const { projectId } = parseParams(request);
    const projects = buildProjectServices(request);
    return sendResult(reply, await projects.get(projectId));
  });

  app.patch('/:projectId', async (request, reply) => {
    const { projectId } = parseParams(request);
    const input = updateProjectInputSchema.parse(request.body);
    const projects = buildProjectServices(request);
    return sendResult(reply, await projects.update(projectId, input));
  });

  app.delete('/:projectId', async (request, reply) => {
    const { projectId } = parseParams(request);
    const projects = buildProjectServices(request);
    return sendResult(reply, await projects.remove(projectId));
  });

  return Promise.resolve();
};

function parseParams(request: FastifyRequest) {
  return {
    projectId: projectIdSchema.parse((request.params as { projectId: string }).projectId),
  };
}
