import fp from 'fastify-plugin';

import { YjsRegistry } from '../yjs/registry.js';

import type { FastifyPluginAsync } from 'fastify';

declare module 'fastify' {
  interface FastifyInstance {
    yjs: YjsRegistry;
  }
}

const impl: FastifyPluginAsync = async (app) => {
  const registry = new YjsRegistry(app.supabaseAdmin, app.log);
  app.decorate('yjs', registry);
  await Promise.resolve();
};

export const yjsPlugin = fp(impl, { name: 'yjs', dependencies: ['supabase'] });
