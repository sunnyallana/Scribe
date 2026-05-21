import type { FastifyPluginAsync } from 'fastify';

export const authRoutes: FastifyPluginAsync = (app) => {
  app.get(
    '/me',
    { preHandler: app.requireAuth },
    async (request, reply) => {
      if (request.user === null) return reply.code(401).send();
      const { data, error } = await app.supabaseAdmin
        .from('users')
        .select('id, email, display_name, avatar_url')
        .eq('id', request.user.id)
        .single();
      if (error !== null || data === null) {
        return reply.code(404).send({ code: 'not_found', message: 'User profile not found' });
      }
      return {
        id: data.id,
        email: data.email,
        displayName: data.display_name,
        avatarUrl: data.avatar_url,
      };
    },
  );

  return Promise.resolve();
};
