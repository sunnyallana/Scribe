// Auto-updater bridge for the desktop shell.
//
// The Rust side (`updates.rs`) wraps `tauri-plugin-updater` so the
// SPA never touches signing material or endpoints directly. With no
// `plugins.updater` block in `tauri.conf.json` the underlying
// `app.updater().check()` returns an error which we surface verbatim;
// the release flow adds endpoint + pubkey at bundle time. See
// `apps/desktop/src-tauri/src/updates.rs` for the signing notes.

import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { log } from './debug';
import { invoke, isTauri } from './tauri';

export interface UpdateInfo {
  readonly available: boolean;
  readonly currentVersion: string;
  readonly latestVersion: string | null;
  readonly notes: string | null;
}

export function checkForUpdates(): Promise<UpdateInfo> {
  return invoke<UpdateInfo>('check_for_updates');
}

export function installUpdate(): Promise<void> {
  return invoke('install_update');
}

// Wait this long after mount before pinging the updater endpoint.
// Lets the SPA finish first paint + Yjs handshake before we spend any
// bandwidth on a check the user didn't ask for. Long enough that a
// short-lived navigation (user hit back to login) never triggers it.
const UPDATER_BOOT_DELAY_MS = 5_000;

/**
 * React hook: on mount inside Tauri, checks for a newer signed bundle
 * once and surfaces a toast with "Install & restart" when one is
 * available. No-op in the browser. Errors are logged at debug-level
 * only — in unsigned dev builds the underlying `app.updater().check()`
 * always errors, and we don't want to nag self-hosters who never
 * configured `plugins.updater` in `tauri.conf.json`.
 *
 * Safe to mount once at the routed root; the check fires exactly once
 * per app launch.
 */
export function useDesktopUpdater(): void {
  const { t } = useTranslation();
  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    const handle = window.setTimeout(() => {
      void (async () => {
        try {
          const info = await checkForUpdates();
          if (cancelled || !info.available || info.latestVersion === null) return;
          toast.info(t('updater.available', { version: info.latestVersion }), {
            description: info.notes ?? t('updater.installPrompt'),
            duration: Infinity,
            action: {
              label: t('updater.installAction'),
              onClick: () => {
                void installUpdate().catch((err: unknown) => {
                  log.api.warn('install_update failed', err);
                  toast.error(t('updater.installFailed'));
                });
              },
            },
          });
        } catch (err) {
          // Expected on unsigned dev builds: no updater endpoint
          // configured → `app.updater().check()` rejects. Log at
          // debug so we'd notice during a release smoke test but
          // never bother day-to-day users.
          log.api('updater check skipped', err);
        }
      })();
    }, UPDATER_BOOT_DELAY_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [t]);
}
