// Auto-updater bridge for the desktop shell.
//
// The Rust side (`updates.rs`) wraps `tauri-plugin-updater` so the
// SPA never touches signing material or endpoints directly. With no
// `plugins.updater` block in `tauri.conf.json` the underlying
// `app.updater().check()` returns an error which we surface verbatim;
// the release flow adds endpoint + pubkey at bundle time. See
// `apps/desktop/src-tauri/src/updates.rs` for the signing notes.

import { invoke } from './tauri';

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
  return invoke<void>('install_update');
}
