import { resolve } from 'node:path';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  // Resolve VITE_* env vars from the monorepo root so a single .env serves
  // both server and web in dev.
  envDir: resolve(import.meta.dirname, '..', '..'),
  resolve: {
    alias: {
      '@': resolve(import.meta.dirname, 'src'),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    sourcemap: true,
    target: 'es2022',
  },
});
