import { createSecretKey, type KeyObject } from 'node:crypto';

import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify, type JWTPayload } from 'jose';

import type { Env } from '../config.js';

/**
 * Verify a Supabase JWT. Supabase now signs user-session tokens with the
 * project's asymmetric ES256 key (JWKS at /auth/v1/.well-known/jwks.json),
 * while legacy projects use HS256 with the static SUPABASE_JWT_SECRET.
 * This helper picks the verifier based on the JWT header alg.
 */
export function createTokenVerifier(env: Env): (token: string) => Promise<JWTPayload | null> {
  const hsSecret: KeyObject = createSecretKey(env.SUPABASE_JWT_SECRET, 'utf-8');
  const jwks = createRemoteJWKSet(
    new URL(`${env.SUPABASE_URL.replace(/\/$/, '')}/auth/v1/.well-known/jwks.json`),
  );

  return async (token: string): Promise<JWTPayload | null> => {
    try {
      const header = decodeProtectedHeader(token);
      const alg = header.alg ?? 'HS256';
      if (alg === 'HS256') {
        const { payload } = await jwtVerify(token, hsSecret, { algorithms: ['HS256'] });
        return payload;
      }
      const { payload } = await jwtVerify(token, jwks, {
        algorithms: ['ES256', 'RS256'],
      });
      return payload;
    } catch {
      return null;
    }
  };
}
