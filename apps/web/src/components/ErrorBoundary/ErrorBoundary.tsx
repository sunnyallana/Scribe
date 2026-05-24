/**
 * Render-tree error boundary.
 *
 * React's auto-recovery is "unmount the whole tree and show nothing"
 * unless you have a boundary. We wrap two scopes:
 *
 *   • The app root — last-resort fallback. A render throw here used to
 *     leave the user staring at `<div id="root">` with no clue why.
 *   • Per-route — so a broken Project page doesn't take Dashboard
 *     down with it; a broken panel inside the editor doesn't kill the
 *     editor.
 *
 * The fallback UI shows the error message + a "Copy diagnostics"
 * button that puts a paste-friendly snapshot on the clipboard
 * (message, stack, component stack, location, build mode). That's the
 * single most useful thing a bug report can include.
 */

import { Button } from '@scribe/ui';
import { AlertTriangle, ClipboardCheck, RefreshCw } from 'lucide-react';
import { Component, type ErrorInfo, type PropsWithChildren, type ReactNode, useState } from 'react';

import { log } from '../../lib/debug';

interface Props {
  /** Human-readable label shown in the fallback ("editor", "dashboard"…).
   *  Lets the user know which part broke. */
  readonly scope: string;
  /** Optional override — return null to render nothing, a node to
   *  render custom UI. Default is `<DefaultFallback />` below. */
  readonly fallback?: (params: FallbackParams) => ReactNode;
  readonly children: ReactNode;
}

interface FallbackParams {
  readonly scope: string;
  readonly error: Error;
  readonly componentStack: string;
  readonly reset: () => void;
}

interface State {
  readonly error: Error | null;
  readonly componentStack: string;
}

export class ErrorBoundary extends Component<PropsWithChildren<Props>, State> {
  override state: State = { error: null, componentStack: '' };

  static getDerivedStateFromError(error: Error): State {
    return { error, componentStack: '' };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // ErrorInfo.componentStack is more useful than `error.stack` for
    // React errors — points to the component, not the minified runtime.
    this.setState({ error, componentStack: info.componentStack ?? '' });
    // Mirror to our categorised logger so the audit trail captures it.
    log.editor.error(`error boundary [${this.props.scope}]`, error, info.componentStack);
  }

  private readonly reset = () => {
    this.setState({ error: null, componentStack: '' });
  };

  override render(): ReactNode {
    if (this.state.error === null) return this.props.children;
    const params: FallbackParams = {
      scope: this.props.scope,
      error: this.state.error,
      componentStack: this.state.componentStack,
      reset: this.reset,
    };
    if (this.props.fallback !== undefined) {
      return this.props.fallback(params);
    }
    return <DefaultFallback {...params} />;
  }
}

function DefaultFallback({ scope, error, componentStack, reset }: FallbackParams) {
  const [copied, setCopied] = useState(false);
  const diagnostics = [
    `Scope: ${scope}`,
    `Message: ${error.message}`,
    `URL: ${typeof window !== 'undefined' ? window.location.href : '(no window)'}`,
    `User-Agent: ${typeof navigator !== 'undefined' ? navigator.userAgent : '(no navigator)'}`,
    `Mode: ${import.meta.env.MODE}`,
    '',
    'Stack:',
    error.stack ?? '(no stack)',
    '',
    'Component stack:',
    componentStack || '(no component stack)',
  ].join('\n');

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(diagnostics);
      setCopied(true);
      window.setTimeout(() => {
        setCopied(false);
      }, 2000);
    } catch {
      window.prompt('Copy diagnostics:', diagnostics);
    }
  };

  return (
    <div
      role="alert"
      className="flex h-full min-h-[200px] flex-col items-center justify-center gap-3 bg-background p-6 text-center text-sm"
    >
      <AlertTriangle className="h-8 w-8 text-destructive" aria-hidden="true" />
      <div className="space-y-1">
        <p className="text-base font-semibold text-foreground">The {scope} crashed.</p>
        <p className="max-w-md text-muted-foreground">
          A render-tree error stopped this view from drawing. The rest of the app is still usable.
          Copy the diagnostics if you want to file a bug.
        </p>
      </div>
      <pre className="max-w-xl overflow-auto rounded border bg-muted/40 p-2 text-left text-xs">
        {error.message}
      </pre>
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            void copy();
          }}
        >
          {copied ? (
            <>
              <ClipboardCheck className="h-3.5 w-3.5" aria-hidden="true" />
              Copied
            </>
          ) : (
            'Copy diagnostics'
          )}
        </Button>
        <Button size="sm" onClick={reset}>
          <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          Try again
        </Button>
      </div>
    </div>
  );
}
