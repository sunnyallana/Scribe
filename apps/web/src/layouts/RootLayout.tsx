import { useEffect } from 'react';
import { Outlet } from 'react-router-dom';
import { Toaster } from 'sonner';

import { useDeepLinkRouter } from '../lib/deepLinks';
import { useDesktopUpdater } from '../lib/desktopUpdates';
import { useAuthStore } from '../stores/auth';

export function RootLayout() {
  const initialize = useAuthStore((state) => state.initialize);
  // No-op in the browser; only fires inside the Tauri shell. Mounted at
  // the routed root so `scribe://invite/<token>` resolves to
  // `/invite/<token>` regardless of which page is currently rendered.
  useDeepLinkRouter();
  // Same shell-only contract: pings the updater once per launch (~5 s
  // after mount) and surfaces a toast when a signed bundle is newer
  // than the running version. Silent in the browser and in unsigned
  // dev builds.
  useDesktopUpdater();

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
