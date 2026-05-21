import fp from 'fastify-plugin';

import { createCompileQueue, type CompileQueue } from '../services/compileQueue.js';

import type { Env } from '../config.js';
import type { FastifyPluginAsync } from 'fastify';

declare module 'fastify' {
  interface FastifyInstance {
    compileQueue: CompileQueue;
  }
}

interface CompileQueuePluginOptions {
  env: Env;
}

const impl: FastifyPluginAsync<CompileQueuePluginOptions> = async (app, opts) => {
  const queue = createCompileQueue({
    redisUrl: opts.env.REDIS_URL,
    queueName: opts.env.COMPILE_QUEUE_NAME,
  });

  app.decorate('compileQueue', queue);
  app.addHook('onClose', async () => {
    await queue.close();
  });
  await Promise.resolve();
};

export const compileQueuePlugin = fp(impl, { name: 'compile-queue' });
