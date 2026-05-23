import { useEffect, useState } from 'react';

/**
 * Subscribe to a CSS media query. Re-renders whenever the result of
 * `window.matchMedia(query).matches` flips. Safe to call from any
 * component — falls back to `false` during SSR / before the first
 * effect runs so the first paint matches a "wide screen" layout
 * (matches the existing CSS defaults that assume desktop).
 *
 * Example:
 *   const isMobile = useMediaQuery('(max-width: 768px)');
 */
export function useMediaQuery(query: string): boolean {
  // Initial state mirrors `matchMedia` once on mount so the first
  // committed render already has the correct value on the client.
  const [matches, setMatches] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mql = window.matchMedia(query);
    const onChange = (e: MediaQueryListEvent) => { setMatches(e.matches); };
    // Sync once on (re)mount in case the query changed between
    // render and effect.
    setMatches(mql.matches);
    // `addEventListener('change', …)` is the modern API; older
    // Safari only has `addListener`. Both are supported via the
    // type union below.
    mql.addEventListener('change', onChange);
    return () => { mql.removeEventListener('change', onChange); };
  }, [query]);

  return matches;
}
