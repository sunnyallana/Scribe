import { ThemeProvider } from '@scribe/ui';
import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';

import '@scribe/ui/styles.css';
import './i18n';
import { ErrorBoundary } from './components/ErrorBoundary/ErrorBoundary';
import { queryClient } from './lib/queryClient';
import { router } from './router';

const rootElement = document.getElementById('root');
if (rootElement === null) {
  throw new Error('Missing #root element in index.html');
}

// StrictMode is back. The Yjs-provider lifecycle bug it was masking is
// resolved: we replaced `y-codemirror.next` with the custom binding in
// `packages/editor/src/extensions/yjs-binding.ts` and fixed the
// y-protocols sync-step-2 constant in `packages/yjs-provider/src/provider.ts`.
// The async-IIFE guard in `useYjsDoc` already handles the double-mount
// correctly, so StrictMode's verification doesn't break us anymore.
createRoot(rootElement).render(
  <StrictMode>
    <ErrorBoundary scope="app root">
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <RouterProvider router={router} />
        </ThemeProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
);
