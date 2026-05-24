import { Button } from '@scribe/ui';
import { AlertCircle, AlertTriangle, CheckCircle2, Info, Loader2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
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
  /** When false, chktex entries are hidden from the panel entirely
   *  and the lint section header disappears. Driven by the editor
   *  prefs `lintEnabled` toggle. */
  readonly lintEnabled?: boolean;
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

/** A grouped block of entries (engine vs lint), with a small
 *  section header and count. `tone="muted"` desaturates the lint
 *  block so it visually recedes — style nits are advisory, not
 *  blocking. */
function LogSection({
  label,
  count,
  entries,
  onJumpTo,
  tone = 'default',
}: {
  readonly label: string;
  readonly count: number;
  readonly entries: readonly CompileLogEntry[];
  readonly onJumpTo: (file: string, line: number) => void;
  readonly tone?: 'default' | 'muted';
}) {
  return (
    <section className="mb-2">
      <header className={`mb-1 flex items-center gap-2 px-2 text-[10px] font-semibold uppercase tracking-wide ${tone === 'muted' ? 'text-muted-foreground/80' : 'text-muted-foreground'}`}>
        <span>{label}</span>
        <span className="rounded bg-muted px-1.5 py-0.5 text-[9px] tabular-nums">{count}</span>
      </header>
      <ul className={`space-y-px font-mono text-xs ${tone === 'muted' ? 'opacity-90' : ''}`}>
        {entries.map((entry, idx) => {
          const Icon = LEVEL_ICON[entry.level];
          const colorClass = LEVEL_COLOR[entry.level];
          const canJump = entry.file !== undefined && entry.line !== undefined;
          return (
            <li
              key={`${entry.source ?? 'engine'}-${entry.level}-${idx.toString()}-${entry.line ?? ''}`}
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
    </section>
  );
}

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
  lintEnabled = true,
}: CompileLogProps) {
  const { t } = useTranslation();
  // Sticky "last known duration" so the time stays visible during a
  // subsequent compile (when `durationMs` is back to null on the
  // running job). We update on every non-null value so the latest
  // successful compile's duration is what gets shown while the next
  // one runs.
  const [stickyMs, setStickyMs] = useState<number | null>(null);
  const stickyMsRef = useRef<number | null>(null);
  useEffect(() => {
    if (durationMs !== null && durationMs !== undefined && durationMs !== stickyMsRef.current) {
      stickyMsRef.current = durationMs;
      setStickyMs(durationMs);
    }
  }, [durationMs]);
  // The current value to show: the live duration if present, else
  // the last one we saw. `isStale` lets us visually mark a stale
  // value (dim + parens) while a new compile runs.
  const displayedMs = durationMs ?? stickyMs;
  const isStale = (durationMs === null || durationMs === undefined) && stickyMs !== null;

  return (
    <div className="flex h-full flex-col border-t bg-background">
      <div className="flex items-center justify-between border-b px-3 py-2">
        <div className="flex items-center gap-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('compile.logTitle')}
          </h3>
          {displayedMs !== null ? (
            <span
              className={`text-xs tabular-nums ${isStale ? 'text-muted-foreground/60 italic' : 'text-muted-foreground'}`}
              title={isStale ? t('compile.lastDurationTitle') : undefined}
            >
              {isStale
                ? `(${(displayedMs / 1000).toFixed(2)}s)`
                : `${(displayedMs / 1000).toFixed(2)}s`}
            </span>
          ) : null}
          <StatusBadge status={status} />
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
        {(() => {
          // Split entries by source. Anything without a source (or
          // tagged tectonic/latexmk) is "compile output"; chktex
          // entries get their own section so style nits don't drown
          // out real engine warnings.
          const compileEntries = entries.filter((e) => e.source !== 'chktex');
          // When the user has turned the linter off in editor prefs,
          // we drop chktex entries from the rendered list entirely
          // — they stay in `entries` so flipping the toggle back on
          // shows them immediately without recompiling.
          const lintEntries = lintEnabled
            ? entries.filter((e) => e.source === 'chktex')
            : [];
          if (compileEntries.length === 0 && lintEntries.length === 0) {
            return (
              <p className="px-3 py-2 text-xs text-muted-foreground">
                {status === 'success' ? t('compile.noIssues') : t('compile.empty')}
              </p>
            );
          }
          return (
            <>
              {compileEntries.length > 0 ? (
                <LogSection
                  label={t('compile.sectionEngine')}
                  count={compileEntries.length}
                  entries={compileEntries}
                  onJumpTo={onJumpTo}
                />
              ) : null}
              {lintEntries.length > 0 ? (
                <LogSection
                  label={t('compile.sectionLint')}
                  count={lintEntries.length}
                  entries={lintEntries}
                  onJumpTo={onJumpTo}
                  tone="muted"
                />
              ) : null}
            </>
          );
        })()}
      </div>
    </div>
  );
}
