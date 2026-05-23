import {
  aiCompleteInputSchema,
  type UserId,
  updateAIConfigInputSchema,
} from '@scribe/shared';

import { createAIService } from '../services/aiService.js';
import { createCryptoBox, type CryptoBox } from '../services/encryption.js';

import { sendResult } from './helpers.js';

import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

function buildService(request: FastifyRequest, crypto: CryptoBox) {
  if (request.user === null) throw new Error('auth required');
  const userId: UserId = request.user.id;
  // We use supabaseAdmin because ai_config lives on users; standard RLS
  // requires the row owner to use auth.uid() on UPDATE — admin sidesteps
  // that and the service still enforces ownership via userId match.
  return createAIService({ supabase: request.server.supabaseAdmin, crypto, userId });
}

export const aiRoutes: FastifyPluginAsync = async (app) => {
  // Initialize crypto box at plugin boot; missing key fails fast at request time only.
  let crypto: CryptoBox | null = null;
  try {
    crypto = createCryptoBox(app.env.AI_KEY_ENCRYPTION_KEY);
  } catch (err) {
    app.log.warn({ err }, 'AI encryption key not configured — /api/ai routes will 503');
  }

  app.addHook('preHandler', app.requireAuth);
  app.addHook('preHandler', async (_request, reply) => {
    if (crypto === null) {
      await reply.code(503).send({
        code: 'internal',
        message: 'AI features disabled: AI_KEY_ENCRYPTION_KEY not configured on server',
      });
    }
  });

  app.get('/config', async (request, reply) => {
    if (crypto === null) return;
    const service = buildService(request, crypto);
    return sendResult(reply, await service.getConfig());
  });

  app.put('/config', async (request, reply) => {
    if (crypto === null) return;
    const input = updateAIConfigInputSchema.parse(request.body);
    const service = buildService(request, crypto);
    return sendResult(reply, await service.updateConfig(input));
  });

  app.post('/ping', async (request, reply) => {
    if (crypto === null) return;
    const service = buildService(request, crypto);
    return sendResult(reply, await service.ping());
  });

  app.post('/complete', async (request, reply) => {
    if (crypto === null) return reply;
    const input = aiCompleteInputSchema.parse(request.body);
    const service = buildService(request, crypto);
    const streamResult = await service.stream(input);
    if (!streamResult.ok) return sendResult(reply, streamResult);

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const abort = new AbortController();
    request.raw.on('close', () => {
      abort.abort();
    });

    try {
      for await (const chunk of streamResult.value) {
        if (abort.signal.aborted) break;
        reply.raw.write(`data: ${JSON.stringify({ text: chunk })}\n\n`);
      }
      reply.raw.write('data: [DONE]\n\n');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      reply.raw.write(`data: ${JSON.stringify({ error: msg })}\n\n`);
    } finally {
      reply.raw.end();
    }
    return reply;
  });

  await Promise.resolve();
};
