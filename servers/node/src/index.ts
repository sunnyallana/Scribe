import { config as loadDotenv } from 'dotenv';

loadDotenv({ path: ['../.env', '.env'], quiet: true });

import { buildApp } from './app.js';
import { loadEnv } from './config.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const app = await buildApp(env);

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    process.exit(0);
  };

  process.on('SIGINT', (signal) => {
    void shutdown(signal);
  });
  process.on('SIGTERM', (signal) => {
    void shutdown(signal);
  });

  try {
    await app.listen({ port: env.PORT, host: env.HOST });
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

void main();
