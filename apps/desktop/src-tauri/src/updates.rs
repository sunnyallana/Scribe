//! Auto-updater wrapper exposed to the SPA.
//!
//! The Tauri updater plugin is registered in `lib.rs` with no
//! endpoints baked into `tauri.conf.json`; release artefacts wire in
//! their own `endpoints` / `pubkey` via the plugin config at bundle
//! time. The signing flow lives outside this codebase:
//!
//!   1. Generate a keypair once: `pnpm --filter @scribe/desktop tauri signer generate -w private.key`
//!   2. Put the public key in `tauri.conf.json` under `plugins.updater.pubkey`
//!   3. Sign each released bundle: `pnpm tauri signer sign -k private.key path/to/bundle`
//!   4. Publish `latest.json` + signed artefacts to a static host
//!      (GitHub Releases is the canonical option)
//!
//! With no config wired up `app.updater().check()` returns a
//! `NotConfigured` error that we surface verbatim — the SPA shows it
//! in the toast so the user (or release engineer) knows why.

use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_updater::UpdaterExt;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub available: bool,
    pub current_version: String,
    pub latest_version: Option<String>,
    pub notes: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum UpdateError {
    #[error("updater error: {0}")]
    Updater(#[from] tauri_plugin_updater::Error),
}

impl serde::Serialize for UpdateError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

#[tauri::command]
pub async fn check_for_updates(app: AppHandle) -> Result<UpdateInfo, UpdateError> {
    let updater = app.updater()?;
    let current = app.package_info().version.to_string();
    match updater.check().await? {
        Some(update) => Ok(UpdateInfo {
            available: true,
            current_version: current,
            latest_version: Some(update.version.clone()),
            notes: update.body.clone(),
        }),
        None => Ok(UpdateInfo {
            available: false,
            current_version: current,
            latest_version: None,
            notes: None,
        }),
    }
}

#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), UpdateError> {
    let updater = app.updater()?;
    if let Some(update) = updater.check().await? {
        update
            .download_and_install(|_chunk, _total| {}, || {})
            .await?;
        // The plugin restarts the app after install on supported
        // platforms; on others the user re-launches manually.
    }
    Ok(())
}
