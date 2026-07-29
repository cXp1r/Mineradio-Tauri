//! Diagnostics command transport。
//!
//! 保持 M5 IPC 名称、参数与返回结构不变；诊断 probe 组合和失败记录属于
//! `app::desktop_diagnostics` 的运行时职责。

use crate::{
    app::desktop_diagnostics,
    runtime::{
        diagnostics::DiagnosticsSnapshot,
        resources::{ResourceGovernanceSnapshot, SystemPurgeOutcome, TrimOutcome},
    },
    AppState,
};

#[tauri::command]
pub async fn get_desktop_diagnostics(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<DiagnosticsSnapshot, String> {
    Ok(desktop_diagnostics::snapshot(&app, state.inner()))
}

#[tauri::command]
pub fn get_resource_governance(state: tauri::State<'_, AppState>) -> ResourceGovernanceSnapshot {
    desktop_diagnostics::resource_governance(state.inner())
}

#[tauri::command]
pub fn trim_application_working_set(
    state: tauri::State<'_, AppState>,
    force: Option<bool>,
) -> Result<TrimOutcome, String> {
    desktop_diagnostics::trim_application_working_set(state.inner(), force)
}

#[tauri::command]
pub fn purge_system_memory(state: tauri::State<'_, AppState>) -> SystemPurgeOutcome {
    desktop_diagnostics::purge_system_memory(state.inner())
}
