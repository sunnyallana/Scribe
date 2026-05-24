import { useEffect } from 'react';
import { Outlet } from 'react-router-dom';
import { Toaster } from 'sonner';

import { useDeepLinkRouter } from '../lib/deepLinks';
import { useAuthStore } from '../stores/auth';

export function RootLayout() {
  const initialize = useAuthStore((state) => state.initialize);
  // No-op in the browser; only fires inside the Tauri shell. Mounted at
  // the routed root so `scribe://invite/<token>` resolves to
  // `/invite/<token>` regardless of which page is currently rendered.
  useDeepLinkRouter();

  useEffect(() => {
    void initialize();
  }, [initialize]);

  return (
    <div className="min-h-screen bg-background text-foreground antialiased">
      <Outlet />
      <Toaster position="bottom-right" richColors closeButton />
    </div>
  );
}
