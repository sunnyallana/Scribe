import { ThemeProvider } from '@scribe/ui';
import { QueryClientProvider } from '@tanstack/react-query';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';

import '@scribe/ui/styles.css';
import './i18n';
import { queryClient } from './lib/queryClient';
import { router } from './router';

const rootElement = document.getElementById('root');
if (rootElement === null) {
  throw new Error('Missing #root element in index.html');
}

// NOTE: StrictMode is disabled because it double-invokes effects in dev,
// which makes the Yjs provider lifecycle in `useYjsDoc` create and
// immediately destroy Provider A before Provider B takes over. The
// async-IIFE guard handles cancellation correctly, but the editor's
// y-codemirror.next binding can end up pointing at Y.Text from the
// destroyed provider — which is why live updates from the WS never
// reach the editor view. Re-enable once `useYjsDoc` is refactored to
// share a single Y.Doc across the double-mount.
createRoot(rootElement).render(
  <QueryClientProvider client={queryClient}>
    <ThemeProvider>
      <RouterProvider router={router} />
    </ThemeProvider>
  </QueryClientProvider>,
);
