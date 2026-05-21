import {
  type InviteDetails,
  inviteTokenSchema,
  type ServiceErrorCode,
} from '@scribe/shared';
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

function useInviteDetails(token: string | undefined) {
  return useQuery<InviteDetails, ApiError>({
    queryKey: ['invite', token],
    enabled: token !== undefined,
    queryFn: () => api.invites.details(inviteTokenSchema.parse(token)),
    retry: false,
  });
}

const ERROR_MESSAGES: Partial<Record<ServiceErrorCode, string>> = {
  invite_expired: 'invite.expired',
  not_found: 'invite.notFound',
  invite_consumed: 'invite.alreadyAccepted',
};

export function InviteAcceptPage() {
  const { t } = useTranslation();
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const { status, user } = useAuthStore();
  const { data: invite, isLoading, error } = useInviteDetails(token);
  const [accepting, setAccepting] = useState(false);

  const handleAccept = async () => {
    if (token === undefined) return;
    setAccepting(true);
    try {
      const result = await api.invites.accept(inviteTokenSchema.parse(token));
      toast.success(t('common.openProject'));
      void navigate(`/project/${result.projectId}`, { replace: true });
    } catch (err) {
      const apiErr = err instanceof ApiError ? err : null;
      toast.error(apiErr?.body.message ?? t('errors.generic'));
    } finally {
      setAccepting(false);
    }
  };

  if (isLoading) {
    return (
      <AuthCardLayout title={t('invite.loading')}>
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
      <AuthCardLayout title={t('invite.title')}>
        <p className="text-center text-sm text-destructive">{t(messageKey)}</p>
      </AuthCardLayout>
    );
  }

  if (invite === undefined) return null;

  const role = t(`members.roles.${invite.role}`);
  const description = t('invite.description', {
    inviter: invite.inviterDisplayName ?? 'A collaborator',
    project: invite.projectName,
    role,
  });

  if (status !== 'authenticated') {
    const target = `/invite/${invite.token}`;
    return (
      <AuthCardLayout title={invite.projectName} description={description}>
        <div className="space-y-2">
          <Button asChild className="w-full">
            <Link to={`/signup?from=${encodeURIComponent(target)}`}>
              {t('invite.signUpToAccept')}
            </Link>
          </Button>
          <Button asChild variant="outline" className="w-full">
            <Link to={`/login?from=${encodeURIComponent(target)}`}>
              {t('invite.signInToAccept')}
            </Link>
          </Button>
        </div>
      </AuthCardLayout>
    );
  }

  if (user !== null && invite.invitedEmail.toLowerCase() !== user.email?.toLowerCase()) {
    return (
      <AuthCardLayout title={t('invite.title')} description={description}>
        <p className="text-center text-sm text-destructive">
          {t('invite.wrongEmail', { email: invite.invitedEmail })}
        </p>
      </AuthCardLayout>
    );
  }

  return (
    <AuthCardLayout title={invite.projectName} description={description}>
      <Button
        className="w-full"
        disabled={accepting}
        onClick={() => {
          void handleAccept();
        }}
      >
        {accepting && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
        {t('invite.accept')}
      </Button>
    </AuthCardLayout>
  );
}
