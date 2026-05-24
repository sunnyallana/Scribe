import { Button } from '@scribe/ui';
import { AlertOctagon, ArrowLeft, RefreshCcw } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isRouteErrorResponse, useNavigate, useRouteError } from 'react-router-dom';

function describeError(err: unknown): { title: string; detail: string; stack: string | null } {
  if (isRouteErrorResponse(err)) {
    return {
      title: `${err.status.toString()} ${err.statusText}`,
      detail: typeof err.data === 'string' ? err.data : JSON.stringify(err.data ?? {}),
      stack: null,
    };
  }
  if (err instanceof Error) {
    return { title: err.name, detail: err.message, stack: err.stack ?? null };
  }
  return { title: 'Unexpected error', detail: String(err), stack: null };
}

export function ErrorPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const err = useRouteError();
  const [stackOpen, setStackOpen] = useState(false);
  const { title, detail, stack } = describeError(err);
  const isDev = import.meta.env.DEV;

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-lg space-y-5 rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex items-start gap-3">
          <div className="rounded-full bg-destructive/10 p-2 text-destructive">
            <AlertOctagon className="h-5 w-5" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-base font-semibold">{t('error.title')}</h1>
            <p className="text-sm text-muted-foreground">{t('error.subtitle')}</p>
          </div>
        </div>

        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 font-mono text-xs">
          <div className="font-semibold text-destructive">{title}</div>
          <div className="mt-1 break-words text-destructive/90">{detail}</div>
        </div>

        {isDev && stack !== null ? (
          <div className="space-y-1">
            <button
              type="button"
              className="text-xs text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground"
              onClick={() => {
                setStackOpen((v) => !v);
              }}
            >
              {stackOpen ? t('error.hideStack') : t('error.showStack')}
            </button>
            {stackOpen ? (
              <pre className="max-h-64 overflow-auto rounded border bg-muted/40 p-2 font-mono text-[10px] leading-snug text-muted-foreground">
                {stack}
              </pre>
            ) : null}
          </div>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <Button
            onClick={() => {
              window.location.reload();
            }}
            className="gap-1.5"
          >
            <RefreshCcw className="h-3.5 w-3.5" aria-hidden="true" />
            {t('error.reload')}
          </Button>
          <Button variant="outline" onClick={() => navigate('/dashboard')} className="gap-1.5">
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
            {t('error.toDashboard')}
          </Button>
        </div>
      </div>
    </div>
  );
}
