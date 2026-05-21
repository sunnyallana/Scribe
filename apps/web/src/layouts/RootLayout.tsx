import { useEffect } from 'react';
import { Outlet } from 'react-router-dom';
import { Toaster } from 'sonner';

import { useAuthStore } from '../stores/auth';

export function RootLayout() {
  const initialize = useAuthStore((state) => state.initialize);

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
