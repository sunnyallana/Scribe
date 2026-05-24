import { zodResolver } from '@hookform/resolvers/zod';
import {
  type InviteMemberInput,
  inviteMemberInputSchema,
  type InviteRole,
  type ProjectId,
  type ProjectMember,
} from '@scribe/shared';
import {
  Avatar,
  AvatarFallback,
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
} from '@scribe/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link2, Loader2, X } from 'lucide-react';
import { Controller, useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { api, type ApiError } from '../../lib/api';
import { useAuthStore } from '../../stores/auth';

import { ShareLinks } from './ShareLinks';

interface MembersPanelProps {
  readonly projectId: ProjectId;
}

// We expose editor + viewer to owners — the DB also supports `commenter`
// but the product is sticking to a 3-tier model (Owner / Editor / Viewer).
// Existing commenter rows still parse and render fine.
const INVITE_ROLES: readonly InviteRole[] = ['editor', 'viewer'];

function initials(member: ProjectMember): string {
  if (member.displayName !== null && member.displayName.trim() !== '') {
    return member.displayName
      .split(/\s+/)
      .map((part) => part[0])
      .filter((c): c is string => typeof c === 'string')
      .slice(0, 2)
      .join('')
      .toUpperCase();
  }
  return (member.email ?? '?').slice(0, 1).toUpperCase();
}

function inviteUrl(token: string): string {
  return `${window.location.origin}/invite/${token}`;
}

async function copyInviteLink(token: string, t: (k: string) => string): Promise<void> {
  const url = inviteUrl(token);
  try {
    await navigator.clipboard.writeText(url);
    toast.success(t('members.linkCopied'));
  } catch {
    // Fallback: prompt so the user can grab the URL manually if the
    // browser blocked clipboard access (older Safari, insecure context).
    window.prompt(t('members.copyLinkFallback'), url);
  }
}

export function MembersPanel({ projectId }: MembersPanelProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const currentUser = useAuthStore((state) => state.user);

  const { data: members, isLoading } = useQuery<ProjectMember[], ApiError>({
    queryKey: ['members', projectId],
    queryFn: () => api.members.list(projectId),
  });

  // The acting user is an owner if they appear in the members list with
  // role='owner'. We use this to gate the role-change + remove + invite UI.
  const isOwner = (members ?? []).some(
    (m) => m.userId !== null && m.userId === currentUser?.id && m.role === 'owner',
  );

  const inviteForm = useForm<InviteMemberInput>({
    resolver: zodResolver(inviteMemberInputSchema),
    defaultValues: { email: '', role: 'editor' },
  });

  const inviteMutation = useMutation<ProjectMember, ApiError, InviteMemberInput>({
    mutationFn: (input) => api.members.invite(projectId, input),
    onSuccess: async (member, variables) => {
      await queryClient.invalidateQueries({ queryKey: ['members', projectId] });
      inviteForm.reset({ email: '', role: 'editor' });
      const token = member.inviteToken ?? null;
      if (token !== null && token !== undefined) {
        // Auto-copy the link and toast with a "copy again" action so the
        // owner can paste-and-send without a second click.
        await copyInviteLink(token, t);
        toast.success(t('members.inviteSent', { email: variables.email }), {
          description: t('members.linkAutoCopied'),
          action: {
            label: t('members.copyLink'),
            onClick: () => {
              void copyInviteLink(token, t);
            },
          },
        });
      } else {
        toast.success(t('members.inviteSent', { email: variables.email }));
      }
    },
    onError: (error) => {
      toast.error(error.body.message);
    },
  });

  const removeMutation = useMutation<unknown, ApiError, ProjectMember>({
    mutationFn: (member) => api.members.remove(projectId, member.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['members', projectId] });
    },
    onError: (error) => {
      toast.error(error.body.message);
    },
  });

  const roleMutation = useMutation<
    ProjectMember,
    ApiError,
    { member: ProjectMember; role: InviteRole }
  >({
    mutationFn: ({ member, role }) => api.members.updateRole(projectId, member.id, { role }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['members', projectId] });
      toast.success(t('members.roleUpdated'));
    },
    onError: (error) => {
      toast.error(error.body.message);
    },
  });

  return (
    <div className="space-y-4">
      {isOwner ? (
        <form
          onSubmit={inviteForm.handleSubmit((values) => {
            inviteMutation.mutate(values);
          })}
          className="flex flex-wrap items-start gap-2"
          noValidate
        >
          <div className="flex-1 min-w-[200px] space-y-1">
            <Input
              type="email"
              placeholder={t('members.invitePlaceholder')}
              {...inviteForm.register('email')}
              aria-label={t('auth.email')}
            />
            {inviteForm.formState.errors.email !== undefined && (
              <p className="text-xs text-destructive">
                {inviteForm.formState.errors.email.message}
              </p>
            )}
          </div>
          <Controller
            control={inviteForm.control}
            name="role"
            render={({ field }) => (
              <Select value={field.value} onValueChange={field.onChange}>
                <SelectTrigger className="w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {INVITE_ROLES.map((role) => (
                    <SelectItem key={role} value={role}>
                      {t(`members.roles.${role}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          />
          <Button type="submit" disabled={inviteMutation.isPending}>
            {inviteMutation.isPending && (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            )}
            {t('members.inviteButton')}
          </Button>
        </form>
      ) : null}

      <ShareLinks projectId={projectId} isOwner={isOwner} />

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 2 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      ) : members === undefined || members.length === 0 ? (
        <p className="text-sm text-muted-foreground">—</p>
      ) : (
        <ul className="space-y-2">
          {members.map((member) => {
            const isSelf = member.userId !== null && member.userId === currentUser?.id;
            const isMemberOwner = member.role === 'owner';
            const canRemove = isOwner && !isMemberOwner && !isSelf;
            const canChangeRole = isOwner && !isMemberOwner && !isSelf;
            const hasInviteLink =
              member.pending && typeof member.inviteToken === 'string' && member.inviteToken !== '';
            return (
              <li key={member.id} className="flex items-center gap-3 rounded-md border p-2 text-sm">
                <Avatar className="h-8 w-8">
                  <AvatarFallback>{initials(member)}</AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">
                    {member.displayName ?? member.email ?? '—'}
                    {isSelf && (
                      <span className="ml-2 text-xs text-muted-foreground">
                        ({t('members.you')})
                      </span>
                    )}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {member.email}
                    {member.pending && (
                      <span className="ml-2 italic">· {t('members.pending')}</span>
                    )}
                  </p>
                </div>

                {canChangeRole ? (
                  <Select
                    value={member.role === 'commenter' ? 'editor' : member.role}
                    onValueChange={(next) => {
                      if (next === member.role) return;
                      roleMutation.mutate({ member, role: next as InviteRole });
                    }}
                  >
                    <SelectTrigger className="h-7 w-24 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {INVITE_ROLES.map((role) => (
                        <SelectItem key={role} value={role}>
                          {t(`members.roles.${role}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <span className="text-xs text-muted-foreground">
                    {t(`members.roles.${member.role}`)}
                  </span>
                )}

                {hasInviteLink &&
                member.inviteToken !== null &&
                member.inviteToken !== undefined ? (
                  <button
                    type="button"
                    onClick={() => {
                      void copyInviteLink(member.inviteToken ?? '', t);
                    }}
                    className="text-muted-foreground hover:text-foreground"
                    aria-label={t('members.copyLink')}
                    title={t('members.copyLink')}
                  >
                    <Link2 className="h-4 w-4" />
                  </button>
                ) : null}

                {canRemove && (
                  <button
                    type="button"
                    onClick={() => {
                      if (window.confirm(t('members.removeConfirm'))) {
                        removeMutation.mutate(member);
                      }
                    }}
                    className="text-muted-foreground hover:text-destructive"
                    aria-label={t('members.remove')}
                  >
                    <X className="h-4 w-4" />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
