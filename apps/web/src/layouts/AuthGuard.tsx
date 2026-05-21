import { Loader2 } from 'lucide-react';
import { Outlet } from 'react-router-dom';

import { useRequireAuth } from '../hooks/useRequireAuth';

export function AuthGuard() {
  const { isAuthenticated, isLoading } = useRequireAuth();

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        <span className="sr-only">Loading</span>
      </div>
    );
  }

  if (!isAuthenticated) return null;

  return <Outlet />;
}
