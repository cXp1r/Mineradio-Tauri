//! 窗口 command transport。
//!
//! 本文件刻意只保存冻结的 IPC DTO 与命令入口；原生窗口操作、显示器拓扑和
//! 事件合并均由 `runtime::window_adapter` 负责。

use crate::runtime::window_adapter;
use tauri::Manager;

pub use crate::runtime::window_contract::WindowStateSnapshot;

fn main_window(app: &tauri::AppHandle) -> Result<tauri::WebviewWindow, String> {
    app.get_webview_window(super::labels::MAIN)
        .ok_or_else(|| "main window not found".to_string())
}

#[tauri::command]
pub fn window_minimize(app: tauri::AppHandle) -> Result<(), String> {
    if crate::app::full_desktop_runtime::is_active(app.state::<crate::AppState>().inner()) {
        crate::app::full_desktop_runtime::transition_to_passive_for_minimize(&app)?;
        return Ok(());
    }
    window_adapter::minimize(&main_window(&app)?)
}

#[tauri::command]
pub fn window_toggle_maximize(app: tauri::AppHandle) -> Result<(), String> {
    if crate::app::full_desktop_runtime::is_active(app.state::<crate::AppState>().inner()) {
        return Ok(());
    }
    window_adapter::toggle_maximize(&main_window(&app)?)
}

#[tauri::command]
pub fn window_toggle_fullscreen(app: tauri::AppHandle) -> Result<(), String> {
    if crate::app::full_desktop_runtime::is_active(app.state::<crate::AppState>().inner()) {
        return Ok(());
    }
    window_adapter::toggle_fullscreen(&main_window(&app)?)
}

#[tauri::command]
pub fn window_close(app: tauri::AppHandle) -> Result<(), String> {
    window_adapter::request_close(&main_window(&app)?)
}

#[tauri::command]
pub fn get_window_state(app: tauri::AppHandle) -> Result<WindowStateSnapshot, String> {
    Ok(window_adapter::snapshot_for_webview_window(&main_window(
        &app,
    )?))
}
