import { createSecretKey, type KeyObject } from 'node:crypto';

import fp from 'fastify-plugin';
import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify } from 'jose';

import type { UserId } from '@scribe/shared';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';

import type { Env } from '../config.js';

export interface AuthenticatedUser {
  readonly id: UserId;
  readonly email: string;
}

declare module 'fastify' {
  interface FastifyInstance {
    requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
  interface FastifyRequest {
    user: AuthenticatedUser | null;
  }
}

const NULL_USER: AuthenticatedUser | null = null;

interface JwtPayload {
  readonly sub?: string;
  readonly email?: string;
  readonly exp?: number;
}

interface AuthPluginOptions {
  env: Env;
}

const authPluginImpl: FastifyPluginAsync<AuthPluginOptions> = (app, opts) => {
  // Supabase signs user-session JWTs with the project's asymmetric key
  // (ES256/RS256, served at /auth/v1/.well-known/jwks.json) for new
  // projects, but legacy projects still use HS256 with the static secret.
  // Support both: pick verifier by header alg.
  const hsSecret: KeyObject = createSecretKey(opts.env.SUPABASE_JWT_SECRET, 'utf-8');
  const jwks = createRemoteJWKSet(
    new URL(`${opts.env.SUPABASE_URL.replace(/\/$/, '')}/auth/v1/.well-known/jwks.json`),
  );

  app.decorateRequest('user', NULL_USER);

  app.addHook('onRequest', async (request) => {
    const authHeader = request.headers.authorization;
    if (authHeader?.startsWith('Bearer ') !== true) {
      request.user = null;
      return;
    }
    const token = authHeader.slice(7);
    try {
      const header = decodeProtectedHeader(token);
      const alg = header.alg ?? 'HS256';
      const payload =
        alg === 'HS256'
          ? (await jwtVerify(token, hsSecret, { algorithms: ['HS256'] })).payload
          : (await jwtVerify(token, jwks, { algorithms: ['ES256', 'RS256'] })).payload;
      const claims = payload as JwtPayload;
      if (claims.sub === undefined || claims.email === undefined) {
        request.user = null;
        return;
      }
      request.user = { id: claims.sub as UserId, email: claims.email };
    } catch {
      request.user = null;
    }
  });

  app.decorate('requireAuth', async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.user === null) {
      await reply.code(401).send({
        code: 'unauthorized',
        message: 'Authentication required',
      });
    }
  });

  return Promise.resolve();
};

export const authPlugin = fp(authPluginImpl, {
  name: 'auth',
  dependencies: ['supabase'],
});
