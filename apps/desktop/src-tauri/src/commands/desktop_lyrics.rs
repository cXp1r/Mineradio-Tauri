use crate::{runtime::desktop_lyrics, AppState};

pub use crate::runtime::desktop_lyrics::DesktopLyricsHotBounds;

#[tauri::command]
pub fn desktop_lyrics_show_window(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    desktop_lyrics::show_window(&app, state.inner())
}

#[tauri::command]
pub fn desktop_lyrics_close_window(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    desktop_lyrics::close_window(&app, state.inner())
}

#[tauri::command]
pub fn desktop_lyrics_set_click_through(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    click_through: bool,
) -> Result<(), String> {
    desktop_lyrics::set_click_through(&app, state.inner(), click_through)
}

#[tauri::command]
pub fn desktop_lyrics_set_hot_bounds(
    _app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    bounds: DesktopLyricsHotBounds,
) -> Result<(), String> {
    desktop_lyrics::set_hot_bounds(state.inner(), bounds)
}

#[tauri::command]
pub fn desktop_lyrics_move_by(app: tauri::AppHandle, dx: f64, dy: f64) -> Result<(), String> {
    desktop_lyrics::move_by(&app, dx, dy)
}

#[tauri::command]
pub fn desktop_lyrics_update_payload(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    payload: serde_json::Value,
) -> Result<(), String> {
    desktop_lyrics::update_payload(&app, state.inner(), payload)
}

#[tauri::command]
pub fn desktop_lyrics_overlay_ready(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    desktop_lyrics::overlay_ready(&app, state.inner())
}
