import {
  createFileInputSchema,
  fileContentInputSchema,
  fileIdSchema,
  inferFileType,
  projectIdSchema,
  renameFileInputSchema,
} from '@scribe/shared';

import { createFileService } from '../services/fileService.js';
import { createStorageService } from '../services/storageService.js';

import { sendResult } from './helpers.js';

import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

function buildFileService(request: FastifyRequest) {
  if (request.user === null) throw new Error('auth required');
  const supabase = request.supabase;
  const userId = request.user.id;
  const storage = createStorageService({ supabase });
  return createFileService({ supabase, storage, userId });
}

function getProjectId(request: FastifyRequest) {
  return projectIdSchema.parse((request.params as { projectId: string }).projectId);
}

function getFileId(request: FastifyRequest) {
  return fileIdSchema.parse((request.params as { fileId: string }).fileId);
}

export const filesRoutes: FastifyPluginAsync = (app) => {
  app.addHook('preHandler', app.requireAuth);

  app.get('/:projectId/files', async (request, reply) => {
    const files = buildFileService(request);
    return sendResult(reply, await files.list(getProjectId(request)));
  });

  app.post('/:projectId/files', async (request, reply) => {
    const projectId = getProjectId(request);
    const files = buildFileService(request);

    const data = await request.file({ limits: { fileSize: app.env.FILE_SIZE_MAX_BYTES } });
    if (data === undefined) {
      return reply
        .code(400)
        .send({ code: 'validation_failed', message: 'A multipart file is required' });
    }

    const pathField = data.fields.path;
    const requestedPath =
      pathField !== undefined && 'value' in pathField && typeof pathField.value === 'string'
        ? pathField.value
        : data.filename;

    const input = createFileInputSchema.parse({
      path: requestedPath,
      type: inferFileType(requestedPath),
    });
    const buffer = await data.toBuffer();

    return sendResult(
      reply,
      await files.create(projectId, input, buffer, data.mimetype || 'application/octet-stream'),
    );
  });

  app.patch('/:projectId/files/:fileId', async (request, reply) => {
    const input = renameFileInputSchema.parse(request.body);
    const files = buildFileService(request);
    return sendResult(
      reply,
      await files.rename(getProjectId(request), getFileId(request), input),
    );
  });

  app.delete('/:projectId/files/:fileId', async (request, reply) => {
    const files = buildFileService(request);
    return sendResult(reply, await files.remove(getProjectId(request), getFileId(request)));
  });

  app.get('/:projectId/files/:fileId/download-url', async (request, reply) => {
    const files = buildFileService(request);
    const result = await files.getDownloadUrl(getProjectId(request), getFileId(request));
    if (!result.ok) return sendResult(reply, result);
    return { url: result.value };
  });

  app.get('/:projectId/files/:fileId/content', async (request, reply) => {
    const files = buildFileService(request);
    const result = await files.readContent(getProjectId(request), getFileId(request));
    if (!result.ok) return sendResult(reply, result);
    return { content: result.value };
  });

  app.put('/:projectId/files/:fileId/content', async (request, reply) => {
    const input = fileContentInputSchema.parse(request.body);
    const files = buildFileService(request);
    const result = await files.writeContent(
      getProjectId(request),
      getFileId(request),
      input.content,
    );
    if (!result.ok) return sendResult(reply, result);
    return {
      path: result.value.path,
      sizeBytes: result.value.sizeBytes,
      updatedAt: result.value.updatedAt,
    };
  });

  return Promise.resolve();
};
