import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import fp from 'fastify-plugin';

import type { Database } from '@scribe/shared';
import type { FastifyPluginAsync } from 'fastify';

import type { Env } from '../config.js';

declare module 'fastify' {
  interface FastifyInstance {
    supabaseAdmin: SupabaseClient<Database>;
    supabaseAnonKey: string;
    supabaseUrl: string;
  }
  interface FastifyRequest {
    supabase: SupabaseClient<Database>;
  }
}

interface SupabasePluginOptions {
  env: Env;
}

const supabasePluginImpl: FastifyPluginAsync<SupabasePluginOptions> = (app, opts) => {
  const { env } = opts;

  const adminClient = createClient<Database>(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  app.decorate('supabaseAdmin', adminClient);
  app.decorate('supabaseAnonKey', env.SUPABASE_ANON_KEY);
  app.decorate('supabaseUrl', env.SUPABASE_URL);
  app.decorateRequest('supabase', null as unknown as SupabaseClient<Database>);

  app.addHook('onRequest', (request, _reply, done) => {
    const authHeader = request.headers.authorization;
    const token = authHeader?.startsWith('Bearer ') === true ? authHeader.slice(7) : null;

    request.supabase = createClient<Database>(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
      ...(token !== null
        ? { global: { headers: { Authorization: `Bearer ${token}` } } }
        : {}),
    });

    done();
  });

  return Promise.resolve();
};

export const supabasePlugin = fp(supabasePluginImpl, {
  name: 'supabase',
});
