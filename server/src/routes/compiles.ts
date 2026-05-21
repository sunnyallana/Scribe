import {
  type CompileJobId,
  compileJobIdSchema,
  compileLogStreamMessageSchema,
  createCompileJobInputSchema,
  projectIdSchema,
  type UserId,
} from '@scribe/shared';
import { createClient } from '@supabase/supabase-js';

import { createTokenVerifier } from '../plugins/verifyToken.js';
import { compileChannel } from '../services/compileQueue.js';
import { createCompileService } from '../services/compileService.js';

import { sendResult } from './helpers.js';

import type { Database } from '@scribe/shared';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

interface CompileRouteContext {
  serviceFor(request: FastifyRequest): ReturnType<typeof createCompileService>;
  jobId(request: FastifyRequest): CompileJobId;
  projectId(request: FastifyRequest): ReturnType<typeof projectIdSchema.parse>;
}

function buildContext(): CompileRouteContext {
  return {
    serviceFor(request) {
      if (request.user === null) throw new Error('auth required');
      const userId = request.user.id;
      const queue = request.server.compileQueue;
      return createCompileService({ supabase: request.supabase, queue, userId });
    },
    jobId(request) {
      const params = request.params as { jobId: string };
      return compileJobIdSchema.parse(params.jobId);
    },
    projectId(request) {
      const params = request.params as { projectId: string };
      return projectIdSchema.parse(params.projectId);
    },
  };
}

interface JwtPayload {
  readonly sub?: string;
  readonly email?: string;
}

export const compilesRoutes: FastifyPluginAsync = async (app) => {
  const ctx = buildContext();
  const env = app.env;
  const verifyToken = createTokenVerifier(env);

  // ---------- HTTP endpoints (auth via header) ----------
  app.addHook('preHandler', async (request, reply) => {
    if (request.url.includes('/stream')) return;
    await app.requireAuth(request, reply);
  });

  app.post('/projects/:projectId/compile', async (request, reply) => {
    const input = createCompileJobInputSchema.parse(request.body ?? {});
    const service = ctx.serviceFor(request);
    return sendResult(reply, await service.enqueue(ctx.projectId(request), input));
  });

  app.get('/projects/:projectId/compiles', async (request, reply) => {
    const service = ctx.serviceFor(request);
    return sendResult(reply, await service.list(ctx.projectId(request)));
  });

  app.get('/compiles/:jobId', async (request, reply) => {
    const service = ctx.serviceFor(request);
    return sendResult(reply, await service.get(ctx.jobId(request)));
  });

  app.get('/compiles/:jobId/artifact-url', async (request, reply) => {
    const query = request.query as { kind?: string };
    const kind = (query.kind ?? 'pdf') as 'pdf' | 'log' | 'synctex';
    const service = ctx.serviceFor(request);
    const result = await service.get(ctx.jobId(request));
    if (!result.ok) return sendResult(reply, result);
    const job = result.value;
    const key =
      kind === 'pdf' ? job.pdfKey : kind === 'log' ? job.logKey : job.synctexKey;
    if (key === null) {
      return reply.code(404).send({ code: 'not_found', message: `No ${kind} artifact` });
    }
    const { data, error } = await request.supabase.storage
      .from('compile-artifacts')
      .createSignedUrl(key, 300);
    if (error !== null || data === null) {
      return reply
        .code(500)
        .send({ code: 'storage_failed', message: error?.message ?? 'failed to sign' });
    }
    return { url: data.signedUrl };
  });

  // ---------- WebSocket log stream (auth via ?token=...) ----------
  app.get(
    '/compiles/:jobId/stream',
    { websocket: true },
    (connection, request) => {
      const socket = connection;
      const { jobId: rawJobId } = request.params as { jobId: string };
      const parsedJobId = compileJobIdSchema.safeParse(rawJobId);
      if (!parsedJobId.success) {
        socket.close(1008, 'invalid job id');
        return;
      }
      const jobId = parsedJobId.data;

      const query = request.query as { token?: string };
      const token = query.token;
      if (token === undefined) {
        socket.close(1008, 'missing token');
        return;
      }

      void (async () => {
        try {
          const payload = await verifyToken(token);
          if (payload === null) {
            socket.close(1008, 'invalid token');
            return;
          }
          const claims = payload as JwtPayload;
          const userId = claims.sub as UserId | undefined;
          if (userId === undefined) {
            socket.close(1008, 'invalid token');
            return;
          }

          // Build a per-connection supabase client using the same access token
          // so RLS applies to compile_jobs reads.
          const supabase = createClient<Database>(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
            auth: { autoRefreshToken: false, persistSession: false },
            global: { headers: { Authorization: `Bearer ${token}` } },
          });

          const service = createCompileService({
            supabase,
            queue: app.compileQueue,
            userId,
          });

          // Replay any persisted state first so the client gets a complete view.
          const replay = await service.replayMessages(jobId);
          if (!replay.ok) {
            socket.close(1008, replay.error.message);
            return;
          }
          for (const msg of replay.value) {
            if (socket.readyState === socket.OPEN) {
              socket.send(JSON.stringify(msg));
            }
          }

          // If the job already finished, close gracefully.
          const finalMsg = replay.value.find((m) => m.type === 'completed');
          if (finalMsg !== undefined) {
            socket.close(1000, 'job already complete');
            return;
          }

          // Subscribe to live updates.
          const subscriber = app.compileQueue.subscriber();
          const channel = compileChannel(jobId);
          await subscriber.subscribe(channel);

          subscriber.on('message', (_ch, payloadStr) => {
            if (socket.readyState !== socket.OPEN) return;
            try {
              const parsed = compileLogStreamMessageSchema.safeParse(JSON.parse(payloadStr));
              if (!parsed.success) return;
              socket.send(JSON.stringify(parsed.data));
              if (parsed.data.type === 'completed') {
                socket.close(1000, 'job complete');
              }
            } catch (err) {
              app.log.warn({ err }, 'malformed compile log payload');
            }
          });

          socket.on('close', () => {
            void subscriber.unsubscribe(channel).then(() => subscriber.quit());
          });
        } catch (err) {
          app.log.warn({ err }, 'compile stream auth failed');
          socket.close(1008, 'auth failed');
        }
      })();
    },
  );

  await Promise.resolve();
};
