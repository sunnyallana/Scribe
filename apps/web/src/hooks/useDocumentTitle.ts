import { useEffect } from 'react';

/**
 * Set `document.title` to `"<title> · Scribe"` for the lifetime of the
 * calling component, restoring the previous title on unmount so a
 * route swap doesn't leave a stale title flashing for one frame.
 *
 * Pass `null` or an empty string to fall back to the static
 * `<title>` baked into `index.html` (the marketing line).
 */
const APP_SUFFIX = 'Scribe';

export function useDocumentTitle(title: string | null | undefined): void {
  useEffect(() => {
    const previous = document.title;
    if (title === null || title === undefined || title === '') {
      document.title = APP_SUFFIX;
    } else {
      document.title = `${title} · ${APP_SUFFIX}`;
    }
    return () => {
      document.title = previous;
    };
  }, [title]);
}
