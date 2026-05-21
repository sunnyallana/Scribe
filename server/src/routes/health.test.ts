import { describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';
import { loadTestEnv } from '../config.js';

describe('GET /health', () => {
  it('returns ok status with uptime', async () => {
    const env = loadTestEnv();
    const app = await buildApp(env);

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ status: string; uptimeSeconds: number }>();
    expect(body.status).toBe('ok');
    expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0);

    await app.close();
  });
});
