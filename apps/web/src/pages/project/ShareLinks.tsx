import {
  type ProjectId,
  type ShareLink,
  type ShareRole,
} from '@scribe/shared';
import {
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@scribe/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Link2, Loader2, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { api, type ApiError } from '../../lib/api';

interface ShareLinksProps {
  readonly projectId: ProjectId;
  readonly isOwner: boolean;
}

const ROLE_OPTIONS: readonly ShareRole[] = ['viewer', 'commenter'];

/** Map a UI-friendly "Never / 24h / 7d / 30d" choice to either an
 *  ISO timestamp or undefined (= never expires). */
function expiryToIso(choice: ExpiryChoice): string | undefined {
  if (choice === 'never') return undefined;
  const hours = { '24h': 24, '7d': 24 * 7, '30d': 24 * 30 }[choice];
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

type ExpiryChoice = 'never' | '24h' | '7d' | '30d';
const EXPIRY_OPTIONS: readonly ExpiryChoice[] = ['never', '24h', '7d', '30d'];

function shareUrl(token: string): string {
  return `${window.location.origin}/share/${token}`;
}

async function copyShareLink(token: string, label: string): Promise<void> {
  const url = shareUrl(token);
  try {
    await navigator.clipboard.writeText(url);
    toast.success(label);
  } catch {
    // Fallback for non-secure contexts where the Clipboard API is blocked.
    window.prompt(label, url);
  }
}

export function ShareLinks({ projectId, isOwner }: ShareLinksProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [role, setRole] = useState<ShareRole>('viewer');
  const [expiry, setExpiry] = useState<ExpiryChoice>('never');

  // Only fetch the list for owners — non-owners shouldn't even see
  // that share links exist (matches the role-gated invite UI).
  const linksQuery = useQuery<ShareLink[], ApiError>({
    queryKey: ['share-links', projectId],
    queryFn: () => api.shares.list(projectId),
    enabled: isOwner,
  });

  const createMutation = useMutation<ShareLink, ApiError, void>({
    mutationFn: () =>
      api.shares.create(projectId, {
        role,
        ...(expiryToIso(expiry) !== undefined ? { expiresAt: expiryToIso(expiry)! } : {}),
      }),
    onSuccess: async (link) => {
      await queryClient.invalidateQueries({ queryKey: ['share-links', projectId] });
      await copyShareLink(link.token, t('share.linkAutoCopied'));
    },
    onError: (err) => { toast.error(err.body.message); },
  });

  const revokeMutation = useMutation<unknown, ApiError, ShareLink>({
    mutationFn: (link) => api.shares.revoke(link.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['share-links', projectId] });
      toast.success(t('share.revoked'));
    },
    onError: (err) => { toast.error(err.body.message); },
  });

  if (!isOwner) return null;

  const links = linksQuery.data ?? [];
  // Active = not revoked and not expired. We still show recently
  // revoked / expired ones for context, just disabled.
  const active = links.filter((l) => l.revokedAt === null && (l.expiresAt === null || new Date(l.expiresAt).getTime() > Date.now()));

  return (
    <section className="space-y-2 rounded-md border bg-muted/30 p-3">
      <header className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold">
          <Link2 className="h-3.5 w-3.5" aria-hidden="true" />
          {t('share.title')}
        </h3>
        <span className="text-xs text-muted-foreground">
          {t('share.activeCount', { count: active.length })}
        </span>
      </header>
      <p className="text-xs text-muted-foreground">{t('share.description')}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Select value={role} onValueChange={(v) => { setRole(v as ShareRole); }}>
          <SelectTrigger className="h-8 w-32 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ROLE_OPTIONS.map((r) => (
              <SelectItem key={r} value={r}>
                {t(`members.roles.${r}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={expiry} onValueChange={(v) => { setExpiry(v as ExpiryChoice); }}>
          <SelectTrigger className="h-8 w-32 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {EXPIRY_OPTIONS.map((opt) => (
              <SelectItem key={opt} value={opt}>
                {t(`share.expiry.${opt}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          type="button"
          size="sm"
          onClick={() => { createMutation.mutate(); }}
          disabled={createMutation.isPending}
          className="h-8 gap-1.5 text-xs"
        >
          {createMutation.isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          ) : null}
          {t('share.createLink')}
        </Button>
      </div>
      {links.length === 0 ? null : (
        <ul className="space-y-1 pt-1">
          {links.map((link) => {
            const isRevoked = link.revokedAt !== null;
            const isExpired = link.expiresAt !== null && new Date(link.expiresAt).getTime() <= Date.now();
            const dead = isRevoked || isExpired;
            return (
              <li
                key={link.id}
                className={`flex items-center gap-2 rounded border bg-background px-2 py-1.5 text-xs ${
                  dead ? 'opacity-50' : ''
                }`}
              >
                <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase">
                  {t(`members.roles.${link.role}`)}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-[10px]" title={shareUrl(link.token)}>
                  {shareUrl(link.token)}
                </span>
                <span className="text-[10px] text-muted-foreground">
                  {isRevoked
                    ? t('share.revokedLabel')
                    : isExpired
                      ? t('share.expiredLabel')
                      : link.expiresAt !== null
                        ? t('share.expiresOn', { date: new Date(link.expiresAt).toLocaleDateString() })
                        : t('share.expiry.never')}
                </span>
                {!dead ? (
                  <button
                    type="button"
                    onClick={() => { void copyShareLink(link.token, t('share.linkCopied')); }}
                    className="text-muted-foreground hover:text-foreground"
                    aria-label={t('share.copyLink')}
                    title={t('share.copyLink')}
                  >
                    <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                ) : null}
                {!isRevoked ? (
                  <button
                    type="button"
                    onClick={() => {
                      if (window.confirm(t('share.revokeConfirm'))) {
                        revokeMutation.mutate(link);
                      }
                    }}
                    className="text-muted-foreground hover:text-destructive"
                    aria-label={t('share.revoke')}
                    title={t('share.revoke')}
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
