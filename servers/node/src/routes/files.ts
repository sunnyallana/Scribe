import { createRequire } from 'node:module';

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

import type ArchiverNS from 'archiver';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

const requireCjs = createRequire(import.meta.url);
const archiver = requireCjs('archiver') as typeof ArchiverNS;

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
    const contentType = request.headers['content-type'] ?? '';

    // JSON path: { path, type?, content? } — used by the in-app New File flow.
    if (contentType.includes('application/json')) {
      const input = createFileInputSchema.parse(request.body);
      const seed = input.content ?? '';
      const body = input.type ?? inferFileType(input.path);
      const inputForService = body === undefined ? { path: input.path } : { path: input.path, type: body };
      return sendResult(
        reply,
        await files.create(projectId, inputForService, seed, 'text/plain; charset=utf-8'),
      );
    }

    // Multipart path: file upload from the user's machine.
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

  app.get('/:projectId/download', async (request, reply) => {
    const projectId = getProjectId(request);
    const files = buildFileService(request);
    const list = await files.list(projectId);
    if (!list.ok) return sendResult(reply, list);

    reply.raw.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${projectId}.zip"`,
      'Cache-Control': 'no-store',
    });

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', (err) => {
      request.log.warn({ err }, 'zip stream failed');
      reply.raw.end();
    });
    archive.pipe(reply.raw);

    for (const f of list.value) {
      const content = await files.readContent(projectId, f.id);
      if (content.ok) {
        archive.append(content.value, { name: f.path });
      }
    }
    await archive.finalize();
    return reply;
  });

  return Promise.resolve();
};
