import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import sensible from '@fastify/sensible';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';

import { type Env } from './config.js';
import { authPlugin } from './plugins/auth.js';
import { compileQueuePlugin } from './plugins/compileQueue.js';
import { errorHandlerPlugin } from './plugins/error-handler.js';
import { supabasePlugin } from './plugins/supabase.js';
import { yjsPlugin } from './plugins/yjs.js';
import { aiRoutes } from './routes/ai.js';
import { authRoutes } from './routes/auth.js';
import { commentsRoutes } from './routes/comments.js';
import { compilesRoutes } from './routes/compiles.js';
import { filesRoutes } from './routes/files.js';
import { healthRoute } from './routes/health.js';
import { historyRoutes } from './routes/history.js';
import { invitesRoutes } from './routes/invites.js';
import { membersRoutes } from './routes/members.js';
import { projectsRoutes } from './routes/projects.js';
import { yjsRoutes } from './routes/yjs.js';

declare module 'fastify' {
  interface FastifyInstance {
    env: Env;
  }
}

export async function buildApp(env: Env): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      ...(env.NODE_ENV === 'development'
        ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
        : {}),
    },
    trustProxy: true,
    disableRequestLogging: env.NODE_ENV === 'test',
    bodyLimit: env.FILE_SIZE_MAX_BYTES,
  });

  app.decorate('env', env);

  await app.register(sensible);
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    origin: env.CORS_ORIGIN,
    credentials: true,
  });
  await app.register(multipart, {
    limits: { fileSize: env.FILE_SIZE_MAX_BYTES, files: 1 },
  });

  await app.register(websocket);
  await app.register(errorHandlerPlugin);
  await app.register(supabasePlugin, { env });
  await app.register(authPlugin, { env });

  if (env.NODE_ENV !== 'test') {
    await app.register(compileQueuePlugin, { env });
  }
  await app.register(yjsPlugin);

  await app.register(healthRoute);
  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(projectsRoutes, { prefix: '/api/projects' });
  await app.register(filesRoutes, { prefix: '/api/projects' });
  await app.register(membersRoutes, { prefix: '/api/projects' });
  await app.register(invitesRoutes, { prefix: '/api/invites' });
  await app.register(commentsRoutes, { prefix: '/api/projects' });
  await app.register(historyRoutes, { prefix: '/api/projects' });
  await app.register(aiRoutes, { prefix: '/api/ai' });
  if (env.NODE_ENV !== 'test') {
    await app.register(compilesRoutes, { prefix: '/api' });
  }
  await app.register(yjsRoutes, { prefix: '/api/yjs' });

  return app;
}
