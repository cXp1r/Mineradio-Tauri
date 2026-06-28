mod commands;
mod paths;
mod sidecar;
mod updater;

use std::sync::Mutex;

#[derive(serde::Serialize, Clone)]
pub struct RuntimeConfig {
    pub sidecar_base_url: String,
    pub app_data_dir: String,
    pub app_version: String,
    pub schema_version: String,
}

#[derive(Default)]
pub struct DesktopLyricsRuntimeState {
    pub latest_payload: Option<serde_json::Value>,
    pub click_through: bool,
}

pub struct AppState {
    pub config: RuntimeConfig,
    pub desktop_lyrics: Mutex<DesktopLyricsRuntimeState>,
}

impl AppState {
    pub fn new(
        sidecar_base_url: String,
        app_data_dir: String,
        app_version: String,
        schema_version: String,
    ) -> Self {
        Self {
            config: RuntimeConfig {
                sidecar_base_url,
                app_data_dir,
                app_version,
                schema_version,
            },
            desktop_lyrics: Mutex::new(DesktopLyricsRuntimeState {
                latest_payload: None,
                click_through: true,
            }),
        }
    }
}

pub fn run() {
    let app_data_dir = paths::resolve_app_data_dir();
    let log_dir = paths::resolve_log_dir();
    let app_version = env!("CARGO_PKG_VERSION").to_string();
    let schema_version = "0.1.0".to_string();

    let port = sidecar::allocate_port();
    let base_url = format!("http://127.0.0.1:{}", port);

    let state = AppState::new(
        base_url.clone(),
        app_data_dir.to_string_lossy().to_string(),
        app_version.clone(),
        schema_version.clone(),
    );

    let setup_app_version = app_version.clone();
    let setup_app_data = app_data_dir.clone();
    let setup_log_dir = log_dir.clone();

    tauri::Builder::default()
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            commands::get_runtime_config,
            commands::window_minimize,
            commands::window_toggle_maximize,
            commands::window_toggle_fullscreen,
            commands::window_close,
            commands::open_external,
            commands::export_json_file,
            commands::import_json_file,
            commands::desktop_lyrics_show_window,
            commands::desktop_lyrics_close_window,
            commands::desktop_lyrics_set_click_through,
            commands::desktop_lyrics_move_by,
            commands::desktop_lyrics_update_payload,
            commands::desktop_lyrics_overlay_ready
        ])
        .setup(move |_app| {
            let cmd = sidecar::build_sidecar_command(
                port,
                &setup_app_data,
                &setup_log_dir,
                &setup_app_version,
            );
            // NOTE: spawn + health-wait are best-effort. This setup closure only
            // runs under a real `tauri::Builder` app (`tauri dev`), never from
            // cargo tests (tests call only the pure module functions).
            match sidecar::spawn_sidecar(cmd) {
                Ok(_child) => {
                    if let Err(e) =
                        sidecar::wait_for_health(&base_url, std::time::Duration::from_secs(2))
                    {
                        eprintln!("sidecar health wait failed: {}", e);
                    }
                }
                Err(e) => {
                    eprintln!("sidecar spawn failed: {}", e);
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to run Mineradio Tauri shell");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_state_new_builds_config() {
        let s = AppState::new(
            "http://127.0.0.1:1".into(),
            "/data".into(),
            "0.1.0".into(),
            "0.1.0".into(),
        );
        assert_eq!(s.config.sidecar_base_url, "http://127.0.0.1:1");
        assert_eq!(s.config.app_data_dir, "/data");
        assert_eq!(s.config.app_version, "0.1.0");
        assert_eq!(s.config.schema_version, "0.1.0");
        let lyrics = s.desktop_lyrics.lock().expect("desktop lyrics state");
        assert!(lyrics.latest_payload.is_none());
        assert!(lyrics.click_through);
    }
}
