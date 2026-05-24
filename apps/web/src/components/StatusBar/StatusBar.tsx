import { Check, CircleDashed, FileWarning, Loader2, Users, Wifi, WifiOff } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

export type CompileStatusKind = 'idle' | 'queued' | 'running' | 'success' | 'error' | 'cancelled';

export type RoleKind = 'owner' | 'editor' | 'commenter' | 'viewer';

interface StatusBarProps {
  readonly path: string | null;
  readonly line: number;
  readonly column: number;
  readonly wordCount: number | null;
  readonly lastSavedAt: number | null;
  readonly saving: boolean;
  readonly collabSynced: boolean | null;
  readonly peerCount: number;
  readonly compileStatus: CompileStatusKind;
  /** Caller's role on this project. Status bar only renders a badge when
   *  the role is read-only (`viewer`/`commenter`) — owners and editors
   *  don't need the reminder. */
  readonly role: RoleKind | null;
}

function formatRelative(timestamp: number, now: number): string {
  const secs = Math.max(0, Math.round((now - timestamp) / 1000));
  if (secs < 5) return 'just now';
  if (secs < 60) return `${secs.toString()}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins.toString()}m ago`;
  const hrs = Math.round(mins / 60);
  return `${hrs.toString()}h ago`;
}

export function StatusBar({
  path,
  line,
  column,
  wordCount,
  lastSavedAt,
  saving,
  collabSynced,
  peerCount,
  compileStatus,
  role,
}: StatusBarProps) {
  const { t } = useTranslation();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => { setNow(Date.now()); }, 10000);
    return () => { window.clearInterval(id); };
  }, []);

  const saveLabel = (() => {
    if (saving) return t('status.saving');
    if (lastSavedAt === null) return t('status.unsaved');
    return t('status.savedAgo', { when: formatRelative(lastSavedAt, now) });
  })();

  const collabIcon = collabSynced === null ? null : collabSynced ? (
    <Wifi className="h-3 w-3 text-emerald-500" aria-hidden="true" />
  ) : (
    <WifiOff className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
  );

  return (
    <div className="flex h-6 items-center gap-3 border-t bg-muted/40 px-3 text-[10px] tabular-nums text-muted-foreground">
      <span className="truncate" title={path ?? undefined}>
        {path ?? t('compile.noFileSelected')}
      </span>
      <span aria-hidden="true">·</span>
      <span>
        {t('status.lineCol', { line, column })}
      </span>
      {wordCount !== null ? (
        <>
          <span aria-hidden="true">·</span>
          <span>{t('project.wordCount', { count: wordCount })}</span>
        </>
      ) : null}
      <span aria-hidden="true">·</span>
      <span>UTF-8</span>
      <span aria-hidden="true">·</span>
      <span className="flex items-center gap-1">
        {saving ? (
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
        ) : lastSavedAt !== null ? (
          <Check className="h-3 w-3 text-emerald-500" aria-hidden="true" />
        ) : (
          <CircleDashed className="h-3 w-3" aria-hidden="true" />
        )}
        {saveLabel}
      </span>
      {role === 'viewer' || role === 'commenter' ? (
        <>
          <span aria-hidden="true">·</span>
          <span className="rounded-sm border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 font-medium uppercase tracking-wide text-amber-700 dark:text-amber-300">
            {t(`members.roles.${role}`)} · {t('members.readOnly')}
          </span>
        </>
      ) : null}
      {collabIcon !== null ? (
        <>
          <span aria-hidden="true">·</span>
          <span className="flex items-center gap-1" aria-label={t('status.collab')}>
            {collabIcon}
            {collabSynced === true ? t('status.connected') : t('status.disconnected')}
            {peerCount > 0 ? (
              <span className="ml-1 flex items-center gap-0.5">
                <Users className="h-3 w-3" aria-hidden="true" />
                {peerCount.toString()}
              </span>
            ) : null}
          </span>
        </>
      ) : null}
      <span aria-hidden="true" className="ml-auto" />
      <CompileStatusBadge status={compileStatus} />
    </div>
  );
}

function CompileStatusBadge({ status }: { readonly status: CompileStatusKind }) {
  const { t } = useTranslation();
  if (status === 'idle') {
    return (
      <span className="flex items-center gap-1">
        <CircleDashed className="h-3 w-3" aria-hidden="true" />
        {t('compile.idle')}
      </span>
    );
  }
  if (status === 'queued' || status === 'running') {
    return (
      <span className="flex items-center gap-1 text-amber-500">
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
        {t(`compile.status.${status}`)}
      </span>
    );
  }
  if (status === 'success') {
    return (
      <span className="flex items-center gap-1 text-emerald-500">
        <Check className="h-3 w-3" aria-hidden="true" />
        {t('compile.status.success')}
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1 text-destructive">
      <FileWarning className="h-3 w-3" aria-hidden="true" />
      {t(`compile.status.${status}`)}
    </span>
  );
}
