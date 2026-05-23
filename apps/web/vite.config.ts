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
    // Bind on every interface so a phone on the LAN (or a tunnel
    // like cloudflared / ngrok pointed at this port) can reach the
    // dev server. `localhost` would only bind to ::1 + 127.0.0.1.
    host: true,
    // Proxy `/api/*` (REST + WebSocket) to the Rust API so the
    // phone only needs to hit one origin. Without this, the SPA's
    // `VITE_API_URL` would have to be a separate tunnel and CORS +
    // mixed-content rules become painful.
    proxy: {
      '/api': {
        target: process.env.VITE_DEV_API_PROXY ?? 'http://127.0.0.1:3010',
        changeOrigin: true,
        // `ws: true` upgrades any path under /api that requests it,
        // covering /api/yjs/..., /api/compiles/.../stream, and the
        // /api/projects/.../voice signaling WS.
        ws: true,
      },
    },
    // Allow tunnel hostnames (cloudflared, ngrok, etc.) to talk to
    // the dev server. Without this Vite returns 403 with
    // "Blocked request" for unknown Host headers.
    allowedHosts: true,
  },
  build: {
    sourcemap: true,
    target: 'es2022',
  },
});
