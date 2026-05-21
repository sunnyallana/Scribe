import { Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { supabase } from '../../lib/supabase';

import { AuthCardLayout } from './AuthCardLayout';

export function AuthCallbackPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    const url = new URL(window.location.href);
    const code = url.searchParams.get('code');
    const errorDescription = url.searchParams.get('error_description');
    if (errorDescription !== null) {
      setErrorMessage(errorDescription);
      return;
    }

    const finalize = async () => {
      if (code !== null) {
        const { error } = await supabase.auth.exchangeCodeForSession(code);
        if (error !== null) {
          setErrorMessage(error.message);
          return;
        }
      }
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (session === null) {
        setErrorMessage('Session not found');
        return;
      }
      void navigate('/dashboard', { replace: true });
    };

    void finalize();
  }, [navigate]);

  return (
    <AuthCardLayout title={t('auth.verifyingSession')}>
      {errorMessage === null ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" aria-hidden="true" />
          <span className="sr-only">{t('common.loading')}</span>
        </div>
      ) : (
        <p className="text-center text-sm text-destructive">
          {t('auth.callbackError', { message: errorMessage })}
        </p>
      )}
    </AuthCardLayout>
  );
}
