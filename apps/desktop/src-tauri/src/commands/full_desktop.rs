//! Full Desktop 的窄 transport adapter。
//!
//! command 只负责 Tauri 参数、持久化偏好与 core 调用，不接触任何原生窗口句柄。

use crate::{
    runtime::full_desktop::{FullDesktopMode, FullDesktopRuntimeState},
    AppState,
};

#[tauri::command]
pub fn get_full_desktop_runtime_state(
    state: tauri::State<'_, AppState>,
) -> Result<FullDesktopRuntimeState, String> {
    crate::app::full_desktop_runtime::snapshot(state.inner())
}

#[tauri::command]
pub fn set_full_desktop_mode(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    mode: FullDesktopMode,
) -> Result<FullDesktopRuntimeState, String> {
    let _permit = state.enter_update_install_mutation()?;
    crate::app::full_desktop_runtime::set_mode_and_persist(&app, state.inner(), mode)
}

#[tauri::command]
pub fn set_desktop_icons_visible(
    state: tauri::State<'_, AppState>,
    visible: bool,
) -> Result<FullDesktopRuntimeState, String> {
    let _permit = state.enter_update_install_mutation()?;
    crate::app::full_desktop_runtime::set_icons_visible(state.inner(), visible)
}

#[tauri::command]
pub fn set_full_desktop_interaction_locked(
    state: tauri::State<'_, AppState>,
    locked: bool,
) -> Result<FullDesktopRuntimeState, String> {
    let _permit = state.enter_update_install_mutation()?;
    crate::app::full_desktop_runtime::set_interaction_locked(state.inner(), locked)
}

#[tauri::command]
pub fn recover_full_desktop_runtime(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<FullDesktopRuntimeState, String> {
    let _permit = state.enter_update_install_mutation()?;
    crate::app::full_desktop_runtime::recover_explicitly(&app, state.inner())
}
