import { Button } from '@scribe/ui';
import { AlertTriangle, ChevronsRight, FileText, Terminal } from 'lucide-react';
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { CompileLog } from '../../components/CompileLog/CompileLog';
import type { CompileSessionState } from '../../hooks/useCompileSession';

// PDFPreview pulls in pdfjs-dist (~150 KB) plus a worker bundle, so we
// keep it lazy — the preview panel only renders after a compile.
const PDFPreview = lazy(() =>
  import('../../components/PDFPreview/PDFPreview').then((m) => ({ default: m.PDFPreview })),
);

interface PreviewPanelProps {
  readonly compileSession: CompileSessionState;
  readonly highlight: {
    readonly page: number;
    readonly x: number;
    readonly y: number;
    readonly width?: number;
    readonly height?: number;
  } | null;
  readonly onInverseSync: (page: number, x: number, y: number) => void;
  readonly onJumpTo: (file: string, line: number) => void;
  /** Triggered by the in-panel collapse button. Wired by the parent
   *  workspace to the resizable-panel handle. Optional so this
   *  component still renders standalone (e.g. in tests). */
  readonly onCollapse?: () => void;
  /** Filename base for the in-toolbar "Download PDF" button. */
  readonly downloadFilename?: string;
}

type View = 'pdf' | 'log';

export function PreviewPanel({
  compileSession,
  highlight,
  onInverseSync,
  onJumpTo,
  onCollapse,
  downloadFilename,
}: PreviewPanelProps) {
  const { t } = useTranslation();
  const [view, setView] = useState<View>('pdf');

  const { entries, status, errorMessage } = compileSession;

  // Tally counts once; the auto-switch effect and the toolbar badge
  // both want them.
  const counts = useMemo(() => {
    let errors = 0;
    let warnings = 0;
    for (const e of entries) {
      if (e.level === 'error') errors += 1;
      else if (e.level === 'warning') warnings += 1;
    }
    return { errors, warnings };
  }, [entries]);

  const hasErrors = counts.errors > 0 || status === 'error' || errorMessage !== null;
  const hasWarnings = counts.warnings > 0;

  // Edge-triggered auto-switch: only flip view when `hasErrors`
  // *transitions*, never on every render. That way if the user clicks
  // back to PDF while errors are still present, we don't immediately
  // yank them back to the log.
  const prevHasErrors = useRef(hasErrors);
  useEffect(() => {
    if (!prevHasErrors.current && hasErrors) {
      setView('log');
    } else if (prevHasErrors.current && !hasErrors) {
      setView('pdf');
    }
    prevHasErrors.current = hasErrors;
  }, [hasErrors]);

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex items-center gap-1 border-b px-2 py-1">
        {onCollapse !== undefined ? (
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={onCollapse}
            aria-label={t('project.hidePreview')}
            title={t('project.hidePreview')}
          >
            <ChevronsRight className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
        ) : null}
        <div
          role="tablist"
          aria-label={t('compile.viewSwitcherLabel')}
          className="inline-flex rounded-md border bg-muted/30 p-0.5"
        >
          <Button
            role="tab"
            aria-selected={view === 'pdf'}
            variant={view === 'pdf' ? 'default' : 'ghost'}
            size="sm"
            className="h-6 gap-1.5 px-2 text-xs"
            onClick={() => { setView('pdf'); }}
          >
            <FileText className="h-3 w-3" aria-hidden="true" />
            {t('compile.viewPdf')}
          </Button>
          <Button
            role="tab"
            aria-selected={view === 'log'}
            variant={view === 'log' ? 'default' : 'ghost'}
            size="sm"
            className="relative h-6 gap-1.5 px-2 text-xs"
            onClick={() => { setView('log'); }}
          >
            <Terminal className="h-3 w-3" aria-hidden="true" />
            {t('compile.viewLog')}
            {/* Error badge takes priority over warning badge. */}
            {hasErrors ? (
              <span
                className="absolute -right-1 -top-1 inline-flex h-3.5 w-3.5 items-center justify-center rounded-full bg-destructive text-[9px] font-bold leading-none text-destructive-foreground"
                aria-label={t('compile.errorsBadge', { count: counts.errors })}
              >
                {counts.errors > 9 ? '9+' : counts.errors || '!'}
              </span>
            ) : hasWarnings ? (
              <span
                className="absolute -right-1 -top-1 inline-flex h-3.5 w-3.5 items-center justify-center rounded-full bg-amber-500 text-amber-50"
                aria-label={t('compile.warningsBadge', { count: counts.warnings })}
                title={t('compile.warningsBadge', { count: counts.warnings })}
              >
                <AlertTriangle className="h-2.5 w-2.5" aria-hidden="true" />
              </span>
            ) : null}
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1">
        {view === 'pdf' ? (
          <Suspense
            fallback={
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                {t('compile.loadingPdf')}
              </div>
            }
          >
            <PDFPreview
              url={compileSession.pdfUrl}
              compiling={compileSession.compiling}
              highlight={highlight}
              onInverseSync={onInverseSync}
              {...(downloadFilename !== undefined ? { downloadFilename } : {})}
            />
          </Suspense>
        ) : (
          <CompileLog
            status={compileSession.status}
            entries={entries}
            durationMs={compileSession.job?.durationMs ?? null}
            errorMessage={compileSession.errorMessage}
            onJumpTo={onJumpTo}
          />
        )}
      </div>
    </div>
  );
}
