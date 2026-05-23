import type { FastifyPluginAsync } from 'fastify';

interface HealthResponse {
  readonly status: 'ok';
  readonly uptimeSeconds: number;
}

export const healthRoute: FastifyPluginAsync = (app) => {
  app.get('/health', (): HealthResponse => ({ status: 'ok', uptimeSeconds: process.uptime() }));
  return Promise.resolve();
};
