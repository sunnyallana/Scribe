/**
 * Centralized debug logger.
 *
 * Goals:
 *   • One place to flip diagnostics for the whole SPA.
 *   • Auto-on in `vite dev` (so a fresh `pnpm dev` shows everything),
 *     auto-off in `vite build` so production users never see noise in
 *     their console.
 *   • Runtime override via `localStorage.SCRIBE_DEBUG = "1"` (force on)
 *     or `localStorage.SCRIBE_DEBUG = "0"` (force off). Re-checked on
 *     each call so toggling is live — no reload needed.
 *   • Categorized helpers so filtering in DevTools is one regex:
 *     `[Scribe:yjs]`, `[Scribe:api]`, etc.
 *
 * Usage:
 *   import { log } from '@/lib/debug';
 *   log.yjs('ws open', { docId });
 *   log.api('PUT /api/files/...', { status: 200, ms: 142 });
 *   log.editor('mount with collab', { hasCollab: true });
 *
 * All categories share the same toggle. Want per-category? Use the
 * console's "Levels" filter alongside the category prefix — that's
 * what the prefix is there for.
 */

import { features } from './config';

function enabled(): boolean {
  // localStorage override wins (kept for backwards compat with the
  // pre-config-module flag name). The canonical knob is now
  // `SCRIBE_FEATURE_DEBUG_LOGGING` via `lib/config.ts`.
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem('SCRIBE_DEBUG') : null;
    if (raw === '1' || raw === 'true' || raw === 'on') return true;
    if (raw === '0' || raw === 'false' || raw === 'off') return false;
  } catch {
    // ignore — fall through to default
  }
  return features.debugLogging;
}

type Category = 'yjs' | 'api' | 'editor' | 'save' | 'role' | 'auth' | 'compile' | 'ws' | 'router';

/** Per-category color so the prefix pops in DevTools. CSS-in-console
 *  trick — Chrome/Firefox both honour `%c` format-string syntax. */
const COLORS: Record<Category, string> = {
  yjs: '#a855f7', // purple
  api: '#0ea5e9', // sky
  editor: '#22c55e', // green
  save: '#10b981', // emerald
  role: '#f97316', // orange
  auth: '#ec4899', // pink
  compile: '#eab308', // amber
  ws: '#06b6d4', // cyan
  router: '#64748b', // slate
};

function emit(
  level: 'debug' | 'info' | 'warn' | 'error',
  category: Category,
  ...rest: unknown[]
): void {
  if (!enabled()) return;
  const color = COLORS[category] ?? '#888';
  const tag = `%c[Scribe:${category}]`;
  const style = `color:${color};font-weight:600`;
  // Use console.debug/info/warn/error so DevTools' level filter works.
  // eslint-disable-next-line no-console
  (console[level] as (...args: unknown[]) => void)(tag, style, ...rest);
}

interface Logger {
  (...args: unknown[]): void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

function mkLogger(category: Category): Logger {
  const base = (...args: unknown[]) => {
    emit('debug', category, ...args);
  };
  const logger = base as Logger;
  logger.info = (...args) => {
    emit('info', category, ...args);
  };
  logger.warn = (...args) => {
    emit('warn', category, ...args);
  };
  logger.error = (...args) => {
    emit('error', category, ...args);
  };
  return logger;
}

/** Categorized loggers. Pick whichever fits the call site. */
export const log = {
  yjs: mkLogger('yjs'),
  api: mkLogger('api'),
  editor: mkLogger('editor'),
  save: mkLogger('save'),
  role: mkLogger('role'),
  auth: mkLogger('auth'),
  compile: mkLogger('compile'),
  ws: mkLogger('ws'),
  router: mkLogger('router'),
};

/** Programmatic toggle. Persists across reloads. */
export function setDebug(on: boolean): void {
  try {
    localStorage.setItem('SCRIBE_DEBUG', on ? '1' : '0');
  } catch {
    // localStorage unavailable; ignore.
  }
}

/** Reflect current state — handy from DevTools. */
export function debugEnabled(): boolean {
  return enabled();
}

// Expose to DevTools so a user can flip it without touching code:
//   window.__scribeDebug.on()  / .off() / .status()
if (typeof window !== 'undefined') {
  (window as unknown as { __scribeDebug?: unknown }).__scribeDebug = {
    on: () => {
      setDebug(true);
      console.warn('[Scribe] debug ON');
    },
    off: () => {
      setDebug(false);
      console.warn('[Scribe] debug OFF');
    },
    status: () => enabled(),
  };
}
