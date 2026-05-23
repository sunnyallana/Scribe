import { Button } from '@scribe/ui';
import { AlertCircle, AlertTriangle, CheckCircle2, Info, Loader2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { CompileLogEntry } from '@scribe/compiler-client';
import type { CompileJobStatus } from '@scribe/shared';
import type { LucideIcon } from 'lucide-react';

interface CompileLogProps {
  readonly status: CompileJobStatus | 'idle';
  readonly entries: readonly CompileLogEntry[];
  readonly durationMs?: number | null;
  readonly errorMessage?: string | null;
  readonly onJumpTo: (file: string, line: number) => void;
  readonly onClose?: () => void;
}

const LEVEL_ICON: Record<CompileLogEntry['level'], LucideIcon> = {
  error: AlertCircle,
  warning: AlertTriangle,
  info: Info,
  debug: Info,
};

const LEVEL_COLOR: Record<CompileLogEntry['level'], string> = {
  error: 'text-destructive',
  warning: 'text-amber-500',
  info: 'text-muted-foreground',
  debug: 'text-muted-foreground/70',
};

function StatusBadge({ status }: { readonly status: CompileLogProps['status'] }) {
  const { t } = useTranslation();
  if (status === 'idle') {
    return <span className="text-xs text-muted-foreground">{t('compile.idle')}</span>;
  }
  if (status === 'queued' || status === 'running') {
    return (
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
        {t(`compile.status.${status}`)}
      </span>
    );
  }
  if (status === 'success') {
    return (
      <span className="flex items-center gap-1.5 text-xs text-emerald-600">
        <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
        {t('compile.status.success')}
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1.5 text-xs text-destructive">
      <AlertCircle className="h-3 w-3" aria-hidden="true" />
      {t(`compile.status.${status}`)}
    </span>
  );
}

export function CompileLog({
  status,
  entries,
  durationMs,
  errorMessage,
  onJumpTo,
  onClose,
}: CompileLogProps) {
  const { t } = useTranslation();
  return (
    <div className="flex h-full flex-col border-t bg-background">
      <div className="flex items-center justify-between border-b px-3 py-2">
        <div className="flex items-center gap-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('compile.logTitle')}
          </h3>
          <StatusBadge status={status} />
          {durationMs !== null && durationMs !== undefined ? (
            <span className="text-xs text-muted-foreground tabular-nums">
              {(durationMs / 1000).toFixed(2)}s
            </span>
          ) : null}
        </div>
        {onClose !== undefined ? (
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('common.close')}
            className="h-6 w-6"
            onClick={onClose}
          >
            <X className="h-3 w-3" aria-hidden="true" />
          </Button>
        ) : null}
      </div>
      <div className="scribe-scroll flex-1 overflow-auto p-2">
        {errorMessage !== null && errorMessage !== undefined ? (
          <p className="mb-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {errorMessage}
          </p>
        ) : null}
        {entries.length === 0 ? (
          <p className="px-3 py-2 text-xs text-muted-foreground">
            {status === 'success' ? t('compile.noIssues') : t('compile.empty')}
          </p>
        ) : (
          <ul className="space-y-px font-mono text-xs">
            {entries.map((entry, idx) => {
              const Icon = LEVEL_ICON[entry.level];
              const colorClass = LEVEL_COLOR[entry.level];
              const canJump = entry.file !== undefined && entry.line !== undefined;
              return (
                <li
                  key={`${entry.level}-${idx.toString()}-${entry.line ?? ''}`}
                  className="flex items-start gap-2 rounded px-2 py-1 hover:bg-muted/50"
                >
                  <Icon className={`mt-0.5 h-3 w-3 flex-shrink-0 ${colorClass}`} aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <p className={`break-words ${colorClass}`}>{entry.message}</p>
                    {canJump ? (
                      <button
                        type="button"
                        className="mt-0.5 text-[10px] text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground"
                        onClick={() => {
                          if (entry.file !== undefined && entry.line !== undefined) {
                            onJumpTo(entry.file, entry.line);
                          }
                        }}
                      >
                        {entry.file}:{entry.line}
                      </button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
