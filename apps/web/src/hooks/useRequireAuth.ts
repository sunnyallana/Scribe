import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { useAuthStore } from '../stores/auth';

export function useRequireAuth(): { isAuthenticated: boolean; isLoading: boolean } {
  const { status } = useAuthStore();
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    if (status === 'unauthenticated') {
      void navigate(
        `/login?from=${encodeURIComponent(location.pathname + location.search)}`,
        { replace: true },
      );
    }
  }, [status, navigate, location.pathname, location.search]);

  return {
    isAuthenticated: status === 'authenticated',
    isLoading: status === 'initializing',
  };
}
