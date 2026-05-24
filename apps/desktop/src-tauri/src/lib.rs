use std::sync::Arc;

use tauri::menu::{Menu, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_deep_link::DeepLinkExt;

mod compile;
mod db;
mod sync;
// The updater plugin requires `plugins.updater` (with a real pubkey)
// in tauri.conf.json — that's a release-flow chore. We keep
// `updates.rs` in tree so the SPA adapter has a target once a key is
// generated, but don't compile it until the plugin is wired up.
#[allow(dead_code)]
mod updates;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    init_tracing();

    let compile_registry = Arc::new(compile::CompileRegistry::new());

    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_deep_link::init())
        .manage(compile_registry)
        .invoke_handler(tauri::generate_handler![
            compile::start_compile,
            compile::cancel_compile,
            compile::compile_prepare_workdir,
            compile::compile_read_pdf_base64,
            db::db_list_projects,
            db::db_get_project,
            db::db_upsert_project,
            db::db_touch_project,
            db::db_list_files,
            db::db_read_file,
            db::db_upsert_file,
            db::db_write_file_content,
            db::db_remove_file,
            db::db_append_yjs_update,
            db::db_load_yjs_updates,
            db::db_pending_yjs_updates,
            db::db_mark_yjs_pushed,
            db::db_get_sync_state,
            db::db_set_sync_state,
            sync::sync_pending_summary,
            sync::sync_list_dirty_files,
            sync::sync_apply_remote_files,
            sync::sync_apply_remote_content,
            sync::sync_mark_file_clean,
            sync::sync_resolve_make_copy,
        ])
        .on_menu_event(|app, event| {
            if let Err(err) = app.emit("menu", event.id().0.clone()) {
                tracing::warn!(?err, "failed to forward menu event to webview");
            }
        })
        .setup(|app| {
            // DB lives in `app_local_data_dir`. Pool init is async, so
            // we block on the Tauri runtime — `setup` itself is sync.
            let handle = app.handle().clone();
            let db = tauri::async_runtime::block_on(async {
                db::init(&handle).await
            })
            .map_err(|e| Box::<dyn std::error::Error>::from(e.to_string()))?;
            app.manage(db);

            // Forward every `scribe://...` URL to the SPA as a single
            // `deep-link` event. Routing is a TS concern.
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    if let Err(err) = handle.emit("deep-link", url.to_string()) {
                        tracing::warn!(?err, "failed to forward deep link to webview");
                    }
                }
            });

            let menu = build_app_menu(app.handle())?;
            app.set_menu(menu)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn init_tracing() {
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info,scribe_desktop_lib=debug"));
    let _ = tracing_subscriber::fmt().with_env_filter(filter).try_init();
}

fn build_app_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let file_new = MenuItemBuilder::with_id("file.new", "New Project")
        .accelerator("CmdOrCtrl+N")
        .build(app)?;
    let file_open = MenuItemBuilder::with_id("file.open", "Open Project…")
        .accelerator("CmdOrCtrl+O")
        .build(app)?;
    let file_save = MenuItemBuilder::with_id("file.save", "Save")
        .accelerator("CmdOrCtrl+S")
        .build(app)?;
    let file_close = MenuItemBuilder::with_id("file.close", "Close Window")
        .accelerator("CmdOrCtrl+W")
        .build(app)?;
    let file_menu = SubmenuBuilder::new(app, "File")
        .item(&file_new)
        .item(&file_open)
        .separator()
        .item(&file_save)
        .separator()
        .item(&file_close)
        .item(&PredefinedMenuItem::quit(app, None)?)
        .build()?;

    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .item(&PredefinedMenuItem::undo(app, None)?)
        .item(&PredefinedMenuItem::redo(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::cut(app, None)?)
        .item(&PredefinedMenuItem::copy(app, None)?)
        .item(&PredefinedMenuItem::paste(app, None)?)
        .item(&PredefinedMenuItem::select_all(app, None)?)
        .build()?;

    let view_command_palette = MenuItemBuilder::with_id("view.commandPalette", "Command Palette")
        .accelerator("CmdOrCtrl+Shift+P")
        .build(app)?;
    let view_toggle_pdf =
        MenuItemBuilder::with_id("view.togglePdf", "Toggle PDF Preview").build(app)?;
    let view_toggle_outline =
        MenuItemBuilder::with_id("view.toggleOutline", "Toggle Outline").build(app)?;
    let view_menu = SubmenuBuilder::new(app, "View")
        .item(&view_command_palette)
        .separator()
        .item(&view_toggle_pdf)
        .item(&view_toggle_outline)
        .separator()
        .item(&PredefinedMenuItem::fullscreen(app, None)?)
        .build()?;

    let project_compile = MenuItemBuilder::with_id("project.compile", "Compile")
        .accelerator("CmdOrCtrl+Enter")
        .build(app)?;
    let project_share = MenuItemBuilder::with_id("project.share", "Share…").build(app)?;
    let project_export = MenuItemBuilder::with_id("project.export", "Export…").build(app)?;
    let project_menu = SubmenuBuilder::new(app, "Project")
        .item(&project_compile)
        .separator()
        .item(&project_share)
        .item(&project_export)
        .build()?;

    let tools_ai_palette = MenuItemBuilder::with_id("tools.aiPalette", "AI Command Palette")
        .accelerator("CmdOrCtrl+Shift+A")
        .build(app)?;
    let tools_lint = MenuItemBuilder::with_id("tools.lint", "Run chktex Lint").build(app)?;
    let tools_settings = MenuItemBuilder::with_id("tools.settings", "Settings…")
        .accelerator("CmdOrCtrl+,")
        .build(app)?;
    let tools_menu = SubmenuBuilder::new(app, "Tools")
        .item(&tools_ai_palette)
        .item(&tools_lint)
        .separator()
        .item(&tools_settings)
        .build()?;

    let help_docs = MenuItemBuilder::with_id("help.docs", "Documentation").build(app)?;
    let help_keyboard =
        MenuItemBuilder::with_id("help.keyboard", "Keyboard Shortcuts").build(app)?;
    let help_check_updates =
        MenuItemBuilder::with_id("help.checkUpdates", "Check for Updates…").build(app)?;
    let help_about = MenuItemBuilder::with_id("help.about", "About Scribe").build(app)?;
    let help_menu = SubmenuBuilder::new(app, "Help")
        .item(&help_docs)
        .item(&help_keyboard)
        .item(&help_check_updates)
        .separator()
        .item(&help_about)
        .build()?;

    MenuBuilder::new(app)
        .items(&[
            &file_menu,
            &edit_menu,
            &view_menu,
            &project_menu,
            &tools_menu,
            &help_menu,
        ])
        .build()
}
