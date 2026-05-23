import { Button } from '@scribe/ui';
import { AlertCircle, ArrowLeft, RotateCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';

interface PageErrorProps {
  /** Short, one-line summary. Defaults to `errors.somethingWentWrong`. */
  readonly title?: string;
  /** Detail line — usually the API error body or network message. */
  readonly description?: string;
  /** Optional retry callback. When present a "Try again" button
   *  appears next to the back link. */
  readonly onRetry?: () => void;
  /** Where the "back" button links to. Defaults to `/dashboard`.
   *  Pass `null` to suppress the back button entirely (used by
   *  pages that aren't reachable from the dashboard, e.g. invite
   *  accept). */
  readonly backTo?: string | null;
  /** Override for the back button label. Defaults to "Back to
   *  dashboard" (or whatever the i18n bundle says). */
  readonly backLabel?: string;
}

/**
 * Centered full-pane error display. Used as the top-level fallback
 * for any route-level data-fetch failure: project not found, dashboard
 * load failed, invite expired, etc. Replaces the old "tiny red
 * paragraph stuck in the top-left of a black void" treatment.
 *
 * Uses `text-foreground` so the typography flips with the theme —
 * white-on-black in dark mode, black-on-white in light mode — and
 * the surrounding wrapper uses `bg-background`, so an error
 * rendered inside `<AppShell><main>` looks deliberate, not broken.
 */
export function PageError({
  title,
  description,
  onRetry,
  backTo = '/dashboard',
  backLabel,
}: PageErrorProps) {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-full w-full items-center justify-center bg-background px-6 py-12 text-foreground">
      <div className="flex max-w-md flex-col items-center gap-4 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-destructive/15">
          <AlertCircle className="h-6 w-6 text-destructive" aria-hidden="true" />
        </div>
        <h1 className="text-lg font-semibold tracking-tight">
          {title ?? t('errors.somethingWentWrong')}
        </h1>
        {description !== undefined && description.length > 0 ? (
          <p className="break-words text-sm leading-relaxed text-muted-foreground">
            {description}
          </p>
        ) : null}
        <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
          {onRetry !== undefined ? (
            <Button size="sm" onClick={onRetry} className="gap-1.5">
              <RotateCw className="h-3.5 w-3.5" aria-hidden="true" />
              {t('common.tryAgain')}
            </Button>
          ) : null}
          {backTo !== null ? (
            <Button size="sm" variant="ghost" asChild className="gap-1.5">
              <Link to={backTo}>
                <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
                {backLabel ?? t('errors.backToDashboard')}
              </Link>
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
