import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),

  APP_URL: z.string().url().default('http://localhost:5173'),

  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  SUPABASE_JWT_SECRET: z.string().min(16),

  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().max(65535).default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().default('Scribe <no-reply@scribe.local>'),

  FILE_SIZE_MAX_BYTES: z.coerce.number().int().positive().default(52_428_800),
  PROJECT_SIZE_MAX_BYTES: z.coerce.number().int().positive().default(104_857_600),

  INVITE_EXPIRY_DAYS: z.coerce.number().int().positive().default(7),

  REDIS_URL: z.string().default('redis://127.0.0.1:6379'),
  COMPILE_QUEUE_NAME: z.string().default('scribe-compile'),
  COMPILE_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  COMPILE_JOBS_CONCURRENT_PER_USER: z.coerce.number().int().positive().default(5),
  MAX_COMPILE_ARTIFACTS_PER_PROJECT: z.coerce.number().int().positive().default(10),
  TECTONIC_BIN: z.string().default('tectonic'),

  /** 32 random bytes, base64-encoded. Required for any AI feature. */
  AI_KEY_ENCRYPTION_KEY: z.string().optional(),
  AI_REQUESTS_PER_MINUTE: z.coerce.number().int().positive().default(20),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const formatted = JSON.stringify(result.error.format(), null, 2);
    throw new Error(`Invalid environment variables:\n${formatted}`);
  }
  return result.data;
}

const TEST_DEFAULTS = {
  SUPABASE_URL: 'http://127.0.0.1:54321',
  SUPABASE_ANON_KEY: 'test-anon-key',
  SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
  SUPABASE_JWT_SECRET: 'test-jwt-secret-must-be-at-least-16-chars',
} as const;

export function loadTestEnv(overrides: Partial<NodeJS.ProcessEnv> = {}): Env {
  return loadEnv({ NODE_ENV: 'test', ...TEST_DEFAULTS, ...overrides });
}
