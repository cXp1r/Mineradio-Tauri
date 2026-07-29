mod app;
mod commands;
mod db;
mod paths;
mod platform;
mod runtime;
mod sidecar;
mod updater;

use std::{
    path::PathBuf,
    sync::{atomic::Ordering, Arc, Mutex},
    time::Duration,
};
use tauri::Manager;

pub use app::state::{
    AppState, DesktopLyricsPollerChild, DesktopLyricsRuntimeState, RuntimeConfig,
};

fn build_and_start_sidecar(
    state: &AppState,
    port: u16,
    app_data_dir: &std::path::Path,
    log_dir: &std::path::Path,
    app_version: &str,
    resource_dir: Option<&std::path::Path>,
) -> Result<(), sidecar::SidecarError> {
    if !state.sidecar_supervisor_running.load(Ordering::Acquire) {
        return Ok(());
    }
    let cmd = sidecar::build_sidecar_command_with_resource_dir(
        port,
        app_data_dir,
        log_dir,
        app_version,
        resource_dir,
    );
    let mut runtime = state
        .sidecar
        .lock()
        .map_err(|e| sidecar::SidecarError::Io(e.to_string()))?;
    // cleanup 先关闭 ownership 再取得同一把锁；锁内复核可避免退出期间重启出新 child。
    if !state.sidecar_supervisor_running.load(Ordering::Acquire) {
        return Ok(());
    }
    sidecar::spawn_sidecar_into_runtime(&mut runtime, cmd, Duration::from_secs(2))
}

fn start_sidecar_supervisor(
    app: tauri::AppHandle,
    port: u16,
    app_data_dir: PathBuf,
    log_dir: PathBuf,
    app_version: String,
    resource_dir: Option<PathBuf>,
) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(3));
        let state = app.state::<AppState>();
        if !state.sidecar_supervisor_running.load(Ordering::Acquire) {
            break;
        }
        let should_restart = match state.sidecar.lock() {
            Ok(mut runtime) => {
                sidecar::sidecar_runtime_child_exited(&mut runtime).unwrap_or_default()
            }
            Err(_) => false,
        };
        if !should_restart {
            let should_probe_health = match state.sidecar.lock() {
                Ok(runtime) => sidecar::sidecar_runtime_should_probe_health(&runtime),
                Err(_) => false,
            };
            if should_probe_health {
                if let Ok(health) = sidecar::wait_for_health(
                    &state.config.sidecar_base_url,
                    Duration::from_millis(500),
                ) {
                    if let Ok(mut runtime) = state.sidecar.lock() {
                        if sidecar::sidecar_runtime_should_probe_health(&runtime) {
                            sidecar::sidecar_runtime_mark_ready(
                                &mut runtime,
                                health,
                                sidecar::now_ms(),
                            );
                        }
                    }
                }
            }
            continue;
        }
        if let Ok(mut runtime) = state.sidecar.lock() {
            sidecar::sidecar_runtime_mark_restarting(&mut runtime);
        }
        let _ = build_and_start_sidecar(
            &state,
            port,
            &app_data_dir,
            &log_dir,
            &app_version,
            resource_dir.as_deref(),
        );
    });
}

fn updater_public_key_configured_from_plugin_config(
    plugins: &tauri::utils::config::PluginConfig,
) -> bool {
    plugins
        .0
        .get("updater")
        .and_then(|config| config.get("pubkey"))
        .and_then(|value| value.as_str())
        .map(updater::has_updater_public_key)
        .unwrap_or(false)
}

pub fn run() {
    let app_data_dir = paths::resolve_app_data_dir();
    let log_dir = paths::resolve_log_dir();
    let app_version = env!("CARGO_PKG_VERSION").to_string();
    let schema_version = "0.1.0".to_string();
    let context = tauri::generate_context!();
    let updater_public_key_configured =
        updater_public_key_configured_from_plugin_config(&context.config().plugins);

    let port = sidecar::allocate_port();
    let base_url = format!("http://127.0.0.1:{}", port);
    let sidecar_log_path = sidecar::sidecar_log_path(&log_dir);

    // SQLite 本地存储初始化
    let (db_state, db_init_error) = match db::initialize(&app_data_dir) {
        Ok(s) => (Some(Mutex::new(s)), None),
        Err(e) => {
            let msg = format!(
                "db::initialize failed at {}: {:?}",
                app_data_dir.display(),
                e
            );
            eprintln!("{}", msg);
            (None, Some(msg))
        }
    };

    let runtime_settings = Arc::new(Mutex::new(
        runtime::settings::RuntimeSettingsStore::for_app_data(&app_data_dir),
    ));
    let (cache_state, cache_init_error) = match runtime::cache::CacheRuntime::for_app_data(
        &app_data_dir,
        Arc::clone(&runtime_settings),
    ) {
        Ok(runtime) => (Some(Arc::new(Mutex::new(runtime))), None),
        Err(error) => {
            let message = format!("cache runtime initialization failed: {error}");
            eprintln!("{message}");
            (None, Some(message))
        }
    };

    let state = AppState::new(
        base_url.clone(),
        app_data_dir.to_string_lossy().to_string(),
        app_version.clone(),
        schema_version.clone(),
        updater_public_key_configured,
        sidecar_log_path,
        db_state,
        db_init_error,
        cache_state,
        cache_init_error,
        runtime_settings,
    );

    let setup_app_version = app_version.clone();
    let setup_app_data = app_data_dir.clone();
    let setup_log_dir = log_dir.clone();
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            app::desktop_runtime::reactivate_main_window_for_single_instance(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .on_page_load(app::wallpaper_engine_runtime::handle_main_webview_page_load)
        .register_asynchronous_uri_scheme_protocol(
            "mineradio-wallpaper",
            |context, request, responder| {
                let app = context.app_handle().clone();
                let webview_label = context.webview_label().to_owned();
                tauri::async_runtime::spawn_blocking(move || {
                    let state = app.state::<AppState>();
                    let response = app::wallpaper_media_protocol::build_media_response(
                        &webview_label,
                        request,
                        |project_id, role| {
                            app::wallpaper_engine_runtime::resolve_media(
                                state.inner(),
                                project_id,
                                role,
                            )
                        },
                    );
                    responder.respond(response);
                });
            },
        )
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            commands::get_runtime_config,
            commands::get_sidecar_status,
            commands::get_database_status,
            commands::get_preferences_snapshot,
            commands::commit_preferences_transaction,
            commands::migrate_legacy_preferences,
            commands::get_desktop_diagnostics,
            commands::get_resource_governance,
            commands::trim_application_working_set,
            commands::purge_system_memory,
            commands::get_cache_snapshot,
            commands::choose_cache_directory,
            commands::set_cache_root,
            commands::clear_cache_category,
            commands::configure_global_hotkeys,
            commands::get_updater_status,
            commands::check_for_update,
            commands::install_update,
            commands::window_minimize,
            commands::window_toggle_maximize,
            commands::window_toggle_fullscreen,
            commands::window_close,
            commands::window_show,
            commands::application_exit,
            commands::get_window_state,
            commands::get_window_runtime_state,
            commands::set_close_behavior,
            commands::get_full_desktop_runtime_state,
            commands::set_full_desktop_mode,
            commands::set_desktop_icons_visible,
            commands::set_full_desktop_interaction_locked,
            commands::recover_full_desktop_runtime,
            commands::list_wallpaper_engine_projects,
            commands::get_wallpaper_engine_project_details,
            commands::choose_wallpaper_engine_directory,
            commands::choose_wallpaper_engine_project_file,
            commands::remove_wallpaper_engine_directory,
            commands::get_wallpaper_engine_runtime_status,
            commands::start_wallpaper_engine_scene,
            commands::stop_wallpaper_engine_scene,
            commands::recover_wallpaper_engine_runtime,
            commands::open_external,
            commands::export_json_file,
            commands::import_json_file,
            commands::desktop_lyrics_show_window,
            commands::desktop_lyrics_close_window,
            commands::desktop_lyrics_set_click_through,
            commands::desktop_lyrics_move_by,
            commands::desktop_lyrics_set_hot_bounds,
            commands::desktop_lyrics_update_payload,
            commands::desktop_lyrics_overlay_ready,
            commands::login_netease_show_window,
            commands::login_qq_show_window,
            commands::login_netease_complete,
            commands::login_qq_complete,
            commands::login_netease_close_window,
            commands::login_qq_close_window
        ])
        .setup(move |app| {
            // NOTE: spawn + health-wait are best-effort. This setup closure only
            // runs under a real `tauri::Builder` app (`tauri dev`), never from
            // cargo tests (tests call only the pure module functions).
            app::full_desktop_runtime::recover_before_main_window(app.handle())?;
            app::main_window::create_main_window(app.handle())?;
            app::wallpaper_engine_runtime::initialize_after_main_window(app.handle());
            app::wallpaper_engine_runtime::start_reconcile_watcher_after_main_window(app.handle());
            app::full_desktop_runtime::schedule_auto_resume_after_main_window(app.handle());
            app::full_desktop_runtime::sync_native_recovery_surfaces(app.handle());
            app::full_desktop_runtime::start_explorer_watcher_after_main_window(app.handle());
            let state = app.state::<AppState>();
            let close_behavior = state
                .window_runtime
                .lock()
                .map(|runtime| runtime.snapshot().lifecycle.close_behavior)
                .unwrap_or_default();
            if close_behavior == app::lifecycle::CloseBehavior::Tray {
                if let Err(error) = app::tray::ensure_main_tray(app.handle()) {
                    state.diagnostics.record_runtime_error(
                        runtime::diagnostics::DiagnosticProbeKind::Tray,
                        sidecar::now_ms(),
                        format!("persisted tray initialization failed: {error}"),
                    );
                }
            }
            let setup_resource_dir = app.path().resource_dir().ok();
            if let Err(e) = build_and_start_sidecar(
                &state,
                port,
                &setup_app_data,
                &setup_log_dir,
                &setup_app_version,
                setup_resource_dir.as_deref(),
            ) {
                let mut runtime = state.sidecar.lock().map_err(|lock| lock.to_string())?;
                if runtime.child.is_none() {
                    sidecar::sidecar_runtime_mark_start_failed(&mut runtime, &e);
                }
            }
            start_sidecar_supervisor(
                app.handle().clone(),
                port,
                setup_app_data.clone(),
                setup_log_dir.clone(),
                setup_app_version.clone(),
                setup_resource_dir.clone(),
            );
            Ok(())
        })
        .on_window_event(app::desktop_runtime::handle_window_event)
        .build(context)
        .expect("failed to build MineRadio-Tauri shell");
    app.run(app::desktop_runtime::handle_run_event);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stopped_supervisor_cannot_start_a_new_sidecar_child() {
        let settings_path = std::env::temp_dir().join(format!(
            "mineradio-stopped-supervisor-settings-{}.json",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&settings_path);
        let state = AppState::new(
            "http://127.0.0.1:1".into(),
            "/data".into(),
            "0.1.0".into(),
            "0.1.0".into(),
            false,
            PathBuf::from("/logs/sidecar-runtime.log"),
            None,
            None,
            None,
            None,
            Arc::new(Mutex::new(
                runtime::settings::RuntimeSettingsStore::with_path(&settings_path),
            )),
        );
        state
            .sidecar_supervisor_running
            .store(false, Ordering::Release);

        assert!(build_and_start_sidecar(
            &state,
            1,
            std::path::Path::new("/data"),
            std::path::Path::new("/logs"),
            "0.1.0",
            None,
        )
        .is_ok());
        assert!(state.sidecar.lock().expect("sidecar state").child.is_none());
        let _ = std::fs::remove_file(settings_path);
    }

    #[test]
    fn updater_public_key_config_is_read_from_tauri_plugin_config() {
        let empty = tauri::utils::config::PluginConfig(Default::default());
        assert!(!updater_public_key_configured_from_plugin_config(&empty));

        let mut plugins = std::collections::HashMap::new();
        plugins.insert(
            "updater".to_string(),
            serde_json::json!({ "endpoints": ["https://example.test/latest.json"], "pubkey": "   " }),
        );
        assert!(!updater_public_key_configured_from_plugin_config(
            &tauri::utils::config::PluginConfig(plugins)
        ));

        let mut plugins = std::collections::HashMap::new();
        plugins.insert(
            "updater".to_string(),
            serde_json::json!({ "endpoints": ["https://example.test/latest.json"], "pubkey": "base64-public-key" }),
        );
        assert!(updater_public_key_configured_from_plugin_config(
            &tauri::utils::config::PluginConfig(plugins)
        ));
    }
}
