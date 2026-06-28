//! Tauri command handlers for the Mineradio runtime shell.
//!
//! `export_json_file` and `import_json_file` are intentionally stubbed for this
//! phase; real dialog/filesystem wiring arrives in a later release-bundling
//! phase (see docs/migration/plans/05-tauri-runtime.md).

use crate::AppState;
use tauri::{Emitter, Manager, PhysicalPosition, Position, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

const DESKTOP_LYRICS_MAX_MOVE_DELTA: f64 = 4096.0;

pub mod labels {
    pub const MAIN: &str = "main";
    pub const DESKTOP_LYRICS: &str = "desktop-lyrics";
    pub const WALLPAPER: &str = "wallpaper";
    pub const LOGIN_NETEASE: &str = "login-netease";
    pub const LOGIN_QQ: &str = "login-qq";
}

#[tauri::command]
pub fn get_runtime_config(state: tauri::State<'_, AppState>) -> crate::RuntimeConfig {
    state.config.clone()
}

fn main_window(app: &tauri::AppHandle) -> Result<tauri::WebviewWindow, String> {
    app.get_webview_window(labels::MAIN)
        .ok_or_else(|| "main window not found".to_string())
}

pub fn desktop_lyrics_window_url() -> &'static str {
    "index.html?view=desktop-lyrics"
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DesktopLyricsLockIntent {
    pub ignore_cursor_events: bool,
}

pub fn desktop_lyrics_lock_intent(click_through: bool) -> DesktopLyricsLockIntent {
	DesktopLyricsLockIntent {
		ignore_cursor_events: click_through,
	}
}

pub fn desktop_lyrics_default_click_through() -> bool {
	true
}

pub fn desktop_lyrics_position_delta(dx: f64, dy: f64) -> Result<(i32, i32), String> {
    if !dx.is_finite() || !dy.is_finite() {
        return Err("DESKTOP_LYRICS_INVALID_MOVE_DELTA".into());
    }
    if dx.abs() > DESKTOP_LYRICS_MAX_MOVE_DELTA || dy.abs() > DESKTOP_LYRICS_MAX_MOVE_DELTA {
        return Err("DESKTOP_LYRICS_MOVE_DELTA_OUT_OF_RANGE".into());
    }
    Ok((dx.round() as i32, dy.round() as i32))
}

pub fn desktop_lyrics_next_position(
    current_x: i32,
    current_y: i32,
    dx: f64,
    dy: f64,
) -> Result<(i32, i32), String> {
    let (px, py) = desktop_lyrics_position_delta(dx, dy)?;
    let next_x = current_x
        .checked_add(px)
        .ok_or_else(|| "DESKTOP_LYRICS_POSITION_OVERFLOW".to_string())?;
    let next_y = current_y
        .checked_add(py)
        .ok_or_else(|| "DESKTOP_LYRICS_POSITION_OVERFLOW".to_string())?;
    Ok((next_x, next_y))
}

pub fn desktop_lyrics_cached_replay(
    latest_payload: Option<serde_json::Value>,
    click_through: bool,
) -> (Option<serde_json::Value>, bool) {
    (latest_payload, click_through)
}

pub fn desktop_lyrics_show_click_through_state() -> bool {
    desktop_lyrics_default_click_through()
}

fn desktop_lyrics_window(app: &tauri::AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(labels::DESKTOP_LYRICS)
}

fn ensure_desktop_lyrics_window(app: &tauri::AppHandle) -> Result<WebviewWindow, String> {
	if let Some(win) = desktop_lyrics_window(app) {
		return Ok(win);
	}

	let win = WebviewWindowBuilder::new(
		app,
		labels::DESKTOP_LYRICS,
		WebviewUrl::App(desktop_lyrics_window_url().into()),
    )
    .title("Mineradio Desktop Lyrics")
    .transparent(true)
    .decorations(false)
    .always_on_top(true)
    .resizable(false)
    .inner_size(760.0, 120.0)
    .position(80.0, 80.0)
	.skip_taskbar(true)
	.build()
	.map_err(|e| e.to_string())?;
	win.set_ignore_cursor_events(desktop_lyrics_default_click_through())
		.map_err(|e| e.to_string())?;
	Ok(win)
}

#[tauri::command]
pub fn window_minimize(app: tauri::AppHandle) -> Result<(), String> {
    let win = main_window(&app)?;
    win.minimize().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn window_toggle_maximize(app: tauri::AppHandle) -> Result<(), String> {
    let win = main_window(&app)?;
    if win.is_maximized().unwrap_or(false) {
        win.unmaximize().map_err(|e| e.to_string())?;
    } else {
        win.maximize().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn window_toggle_fullscreen(app: tauri::AppHandle) -> Result<(), String> {
    let win = main_window(&app)?;
    let fs = win.is_fullscreen().unwrap_or(false);
    win.set_fullscreen(!fs).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn window_close(app: tauri::AppHandle) -> Result<(), String> {
    let win = main_window(&app)?;
    win.close().map_err(|e| e.to_string())
}

pub fn is_openable_url(url: &str) -> bool {
    url.starts_with("http://") || url.starts_with("https://")
}

#[tauri::command]
pub fn open_external(url: String) -> Result<(), String> {
    if !is_openable_url(&url) {
        return Err("INVALID_URL".into());
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &url])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&url)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn export_json_file() -> Result<(), String> {
    Err("EXPORT_IMPORT_NOT_IMPLEMENTED".into())
}

#[tauri::command]
pub fn import_json_file() -> Result<(), String> {
    Err("EXPORT_IMPORT_NOT_IMPLEMENTED".into())
}

#[tauri::command]
pub fn desktop_lyrics_show_window(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
	let win = ensure_desktop_lyrics_window(&app)?;
    let click_through = desktop_lyrics_show_click_through_state();
    {
        let mut lyrics = state.desktop_lyrics.lock().map_err(|e| e.to_string())?;
        lyrics.click_through = click_through;
    }
	win.set_ignore_cursor_events(click_through)
		.map_err(|e| e.to_string())?;
	win.show().map_err(|e| e.to_string())?;
	win.set_focus().map_err(|e| e.to_string())?;
	Ok(())
}

#[tauri::command]
pub fn desktop_lyrics_close_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(win) = desktop_lyrics_window(&app) {
        win.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn desktop_lyrics_set_click_through(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    click_through: bool,
) -> Result<(), String> {
    let win = ensure_desktop_lyrics_window(&app)?;
    {
        let mut lyrics = state.desktop_lyrics.lock().map_err(|e| e.to_string())?;
        lyrics.click_through = click_through;
    }
    let intent = desktop_lyrics_lock_intent(click_through);
    win.set_ignore_cursor_events(intent.ignore_cursor_events)
        .map_err(|e| e.to_string())?;
    win.emit("desktop-lyrics-lock-changed", click_through)
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn desktop_lyrics_move_by(app: tauri::AppHandle, dx: f64, dy: f64) -> Result<(), String> {
    let win = ensure_desktop_lyrics_window(&app)?;
    let current = win.outer_position().map_err(|e| e.to_string())?;
    let (x, y) = desktop_lyrics_next_position(current.x, current.y, dx, dy)?;
    win.set_position(Position::Physical(PhysicalPosition {
        x,
        y,
    }))
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn desktop_lyrics_update_payload(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    payload: serde_json::Value,
) -> Result<(), String> {
    {
        let mut lyrics = state.desktop_lyrics.lock().map_err(|e| e.to_string())?;
        lyrics.latest_payload = Some(payload.clone());
    }
    let win = ensure_desktop_lyrics_window(&app)?;
    win.emit("desktop-lyrics-payload", payload)
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn desktop_lyrics_overlay_ready(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let Some(win) = desktop_lyrics_window(&app) else {
        return Ok(());
    };
    let (latest_payload, click_through) = {
        let lyrics = state.desktop_lyrics.lock().map_err(|e| e.to_string())?;
        desktop_lyrics_cached_replay(lyrics.latest_payload.clone(), lyrics.click_through)
    };
    if let Some(payload) = latest_payload {
        win.emit("desktop-lyrics-payload", payload)
            .map_err(|e| e.to_string())?;
    }
    win.emit("desktop-lyrics-lock-changed", click_through)
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn openable_url_accepts_http_and_https() {
        assert!(is_openable_url("http://example.com"));
        assert!(is_openable_url("https://example.com/path"));
    }

    #[test]
    fn openable_url_rejects_non_http_schemes() {
        assert!(!is_openable_url("file:///etc/passwd"));
        assert!(!is_openable_url("javascript:alert(1)"));
        assert!(!is_openable_url("ftp://example.com"));
        assert!(!is_openable_url(""));
        assert!(!is_openable_url("data:text/plain,hi"));
    }

    #[test]
    fn desktop_lyrics_window_url_points_to_overlay_route() {
        assert_eq!(
            desktop_lyrics_window_url(),
            "index.html?view=desktop-lyrics"
        );
    }

    #[test]
	fn desktop_lyrics_lock_intent_maps_to_ignore_cursor_events() {
		assert_eq!(desktop_lyrics_lock_intent(true).ignore_cursor_events, true);
		assert_eq!(desktop_lyrics_lock_intent(false).ignore_cursor_events, false);
	}

	#[test]
	fn desktop_lyrics_default_lock_starts_click_through() {
		assert_eq!(desktop_lyrics_default_click_through(), true);
	}

    #[test]
    fn desktop_lyrics_position_delta_rounds_to_physical_pixels() {
        assert_eq!(desktop_lyrics_position_delta(4.4, -2.6), Ok((4, -3)));
    }

    #[test]
    fn desktop_lyrics_position_delta_rejects_invalid_values() {
        assert!(desktop_lyrics_position_delta(f64::NAN, 0.0).is_err());
        assert!(desktop_lyrics_position_delta(f64::INFINITY, 0.0).is_err());
        assert!(desktop_lyrics_position_delta(4096.1, 0.0).is_err());
    }

    #[test]
    fn desktop_lyrics_next_position_rejects_overflow() {
        assert_eq!(desktop_lyrics_next_position(80, 80, 12.0, -3.0), Ok((92, 77)));
        assert!(desktop_lyrics_next_position(i32::MAX, 0, 1.0, 0.0).is_err());
        assert!(desktop_lyrics_next_position(i32::MIN, 0, -1.0, 0.0).is_err());
    }

    #[test]
    fn desktop_lyrics_cached_replay_keeps_latest_payload_and_lock() {
        let payload = serde_json::json!({ "enabled": true, "text": "cached" });
        let (latest, click_through) = desktop_lyrics_cached_replay(Some(payload.clone()), false);
        assert_eq!(latest, Some(payload));
        assert!(!click_through);
    }

    #[test]
    fn desktop_lyrics_show_click_through_state_matches_native_default() {
        assert_eq!(
            desktop_lyrics_show_click_through_state(),
            desktop_lyrics_default_click_through()
        );
    }
}
