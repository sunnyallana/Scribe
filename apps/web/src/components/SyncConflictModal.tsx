// Modal shown when the offline sync engine detects metadata
// collisions that exceed last-write-wins safety. The user picks per
// file: keep local, keep server, or save the local copy under a new
// path.
//
// The actual resolution logic lives in `syncManager` — this component
// is a thin chooser.

import { type ProjectId } from '@scribe/shared';
import { useState } from 'react';

import { type SyncConflict, syncManager } from '../lib/sync';

type Choice = 'local' | 'remote' | 'copy';

interface RowState {
  readonly choice: Choice | null;
  readonly resolving: boolean;
  readonly resolved: boolean;
  readonly error: string | null;
}

const INITIAL: RowState = { choice: null, resolving: false, resolved: false, error: null };

function suggestCopyPath(path: string): string {
  const dot = path.lastIndexOf('.');
  if (dot <= 0) return `${path}.local-conflict`;
  return `${path.slice(0, dot)}.local-conflict${path.slice(dot)}`;
}

export interface SyncConflictModalProps {
  readonly projectId: ProjectId;
  readonly conflicts: readonly SyncConflict[];
  readonly onAllResolved: () => void;
  readonly onClose: () => void;
}

export function SyncConflictModal({
  projectId,
  conflicts,
  onAllResolved,
  onClose,
}: SyncConflictModalProps) {
  const [rows, setRows] = useState<Record<string, RowState>>(
    () => Object.fromEntries(conflicts.map((c) => [c.fileId, INITIAL])),
  );

  function setRow(fileId: string, patch: Partial<RowState>): void {
    setRows((prev) => ({ ...prev, [fileId]: { ...(prev[fileId] ?? INITIAL), ...patch } }));
  }

  async function resolve(fileId: string, choice: Choice, path: string): Promise<void> {
    setRow(fileId, { choice, resolving: true, error: null });
    try {
      if (choice === 'local') {
        await syncManager.resolveKeepLocal(projectId, fileId);
      } else if (choice === 'remote') {
        await syncManager.resolveKeepRemote(projectId, fileId);
      } else {
        await syncManager.resolveMakeCopy(projectId, fileId, suggestCopyPath(path));
      }
      setRow(fileId, { resolving: false, resolved: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'resolution failed';
      setRow(fileId, { resolving: false, error: msg });
    }
  }

  const allResolved = conflicts.every((c) => rows[c.fileId]?.resolved === true);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/40">
      <div className="w-full max-w-2xl rounded border border-border bg-card p-6 text-card-foreground shadow-xl">
        <h2 className="mb-2 text-lg font-semibold">Sync conflicts</h2>
        <p className="mb-4 text-sm text-muted-foreground">
          These files changed both locally and on the server. Pick a resolution for each.
        </p>
        <ul className="max-h-[60vh] divide-y divide-border overflow-y-auto">
          {conflicts.map((c) => {
            const state = rows[c.fileId] ?? INITIAL;
            return (
              <li key={c.fileId} className="py-3">
                <div className="flex items-baseline justify-between">
                  <span className="font-mono text-sm">{c.path}</span>
                  {state.resolved && (
                    <span className="text-xs text-emerald-700 dark:text-emerald-400">
                      Resolved
                    </span>
                  )}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  local {c.localUpdatedAt} · remote {c.remoteUpdatedAt}
                </div>
                {!state.resolved && (
                  <div className="mt-2 flex gap-2">
                    <button
                      type="button"
                      disabled={state.resolving}
                      onClick={() => void resolve(c.fileId, 'local', c.path)}
                      className="rounded border border-border bg-background px-2 py-1 text-xs hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
                    >
                      Keep mine
                    </button>
                    <button
                      type="button"
                      disabled={state.resolving}
                      onClick={() => void resolve(c.fileId, 'remote', c.path)}
                      className="rounded border border-border bg-background px-2 py-1 text-xs hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
                    >
                      Keep server
                    </button>
                    <button
                      type="button"
                      disabled={state.resolving}
                      onClick={() => void resolve(c.fileId, 'copy', c.path)}
                      className="rounded border border-border bg-background px-2 py-1 text-xs hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
                    >
                      Save copy
                    </button>
                  </div>
                )}
                {state.error !== null && (
                  <div className="mt-1 text-xs text-destructive">{state.error}</div>
                )}
              </li>
            );
          })}
        </ul>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-border bg-background px-3 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground"
          >
            Close
          </button>
          <button
            type="button"
            disabled={!allResolved}
            onClick={() => {
              onAllResolved();
              onClose();
            }}
            className="rounded bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
