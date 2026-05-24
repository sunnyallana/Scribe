import { type ServiceErrorCode, type SharePreview } from '@scribe/shared';
import { Button } from '@scribe/ui';
import { useQuery } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';

import { api, ApiError } from '../../lib/api';
import { useAuthStore } from '../../stores/auth';

import { AuthCardLayout } from './AuthCardLayout';

/** Landing page for /share/:token. Mirrors InviteAcceptPage but
 *  speaks to the share-link endpoints — no email pinning, so any
 *  signed-in user can redeem the link. */
function useSharePreview(token: string | undefined) {
  return useQuery<SharePreview, ApiError>({
    queryKey: ['share-preview', token],
    enabled: token !== undefined,
    queryFn: () => {
      if (token === undefined) throw new Error('no token');
      return api.shares.preview(token);
    },
    retry: false,
  });
}

const ERROR_MESSAGES: Partial<Record<ServiceErrorCode, string>> = {
  not_found: 'share.notFound',
  conflict: 'share.invalid',
};

export function SharePage() {
  const { t } = useTranslation();
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const { status } = useAuthStore();
  const { data: preview, isLoading, error } = useSharePreview(token);
  const [redeeming, setRedeeming] = useState(false);

  const handleAccept = async () => {
    if (token === undefined) return;
    setRedeeming(true);
    try {
      const result = await api.shares.redeem(token);
      toast.success(t('common.openProject'));
      void navigate(`/project/${result.projectId}`, { replace: true });
    } catch (err) {
      const apiErr = err instanceof ApiError ? err : null;
      toast.error(apiErr?.body.message ?? t('errors.generic'));
    } finally {
      setRedeeming(false);
    }
  };

  if (isLoading) {
    return (
      <AuthCardLayout title={t('share.loading')}>
        <div className="flex items-center justify-center py-8">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" aria-hidden="true" />
        </div>
      </AuthCardLayout>
    );
  }

  if (error !== null) {
    const code = error.body.code;
    const messageKey = ERROR_MESSAGES[code] ?? 'errors.generic';
    return (
      <AuthCardLayout title={t('share.title')}>
        <p className="text-center text-sm text-destructive">{t(messageKey)}</p>
      </AuthCardLayout>
    );
  }

  if (preview === undefined) return null;

  const role = t(`members.roles.${preview.role}`);
  const description = t('share.description', { project: preview.projectName, role });

  if (status !== 'authenticated') {
    const target = `/share/${token ?? ''}`;
    return (
      <AuthCardLayout title={preview.projectName} description={description}>
        <div className="space-y-2">
          <Button asChild className="w-full">
            <Link to={`/signup?from=${encodeURIComponent(target)}`}>{t('share.signUpToJoin')}</Link>
          </Button>
          <Button asChild variant="outline" className="w-full">
            <Link to={`/login?from=${encodeURIComponent(target)}`}>{t('share.signInToJoin')}</Link>
          </Button>
        </div>
      </AuthCardLayout>
    );
  }

  return (
    <AuthCardLayout title={preview.projectName} description={description}>
      <Button
        className="w-full"
        disabled={redeeming}
        onClick={() => {
          void handleAccept();
        }}
      >
        {redeeming && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
        {t('share.join')}
      </Button>
    </AuthCardLayout>
  );
}
