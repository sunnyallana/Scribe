// Deep-link plumbing for the desktop shell.
//
// Rust forwards every `scribe://...` URL to the SPA as a `deep-link`
// event. This module subscribes once and routes to the matching SPA
// route. Currently only `scribe://invite/<token>` is wired — extend
// the `route()` switch as more public links land.

import { useEffect } from 'react';
import { type NavigateFunction, useNavigate } from 'react-router-dom';

import { isTauri, listen } from './tauri';

const SCHEME = 'scribe://';

function route(navigate: NavigateFunction, rawUrl: string): void {
  if (!rawUrl.startsWith(SCHEME)) return;
  const path = rawUrl.slice(SCHEME.length).replace(/^\/+/, '');
  const [head, ...rest] = path.split('/');
  switch (head) {
    case 'invite': {
      const token = rest.join('/');
      if (token.length === 0) return;
      navigate(`/invite/${token}`);
      return;
    }
    default:
      navigate(`/${path}`);
  }
}

/**
 * React hook: subscribes to `deep-link` events for the lifetime of
 * the host component and navigates the SPA accordingly. Mount once
 * inside the router (e.g. in `App.tsx` next to `<Routes>`).
 */
export function useDeepLinkRouter(): void {
  const navigate = useNavigate();
  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void listen<string>('deep-link', (url) => {
      route(navigate, url);
    }).then((fn) => {
      if (cancelled) {
        fn();
        return;
      }
      unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [navigate]);
}
