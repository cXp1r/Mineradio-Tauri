use crate::{db, AppState};

fn database_unavailable(state: &AppState) -> String {
    state
        .db_init_error
        .clone()
        .unwrap_or_else(|| "database not initialized".to_string())
}

/// 一次读取全部 allowlist 偏好和迁移 journal，避免启动阶段逐 key IPC。
#[tauri::command]
pub fn get_preferences_snapshot(
    state: tauri::State<'_, AppState>,
) -> Result<db::PreferencesSnapshot, String> {
    let database = state
        .db
        .as_ref()
        .ok_or_else(|| database_unavailable(state.inner()))?;
    let database = database.lock().map_err(|error| error.to_string())?;
    db::get_preferences_snapshot(&database.conn).map_err(|error| error.to_string())
}

/// 只接受 typed allowlist mutation；校验和原子性由 db 模块统一负责。
#[tauri::command]
pub fn commit_preferences_transaction(
    state: tauri::State<'_, AppState>,
    request: db::PreferenceTransactionRequest,
) -> Result<db::PreferencesSnapshot, String> {
    let database = state
        .db
        .as_ref()
        .ok_or_else(|| database_unavailable(state.inner()))?;
    let database = database.lock().map_err(|error| error.to_string())?;
    db::commit_preferences_transaction(&database.conn, request).map_err(|error| error.to_string())
}

/// 批量推进 legacy-authoritative → copied → verified → committed journal。
#[tauri::command]
pub fn migrate_legacy_preferences(
    state: tauri::State<'_, AppState>,
    request: db::LegacyPreferencesMigrationRequest,
) -> Result<db::PreferencesSnapshot, String> {
    let database = state
        .db
        .as_ref()
        .ok_or_else(|| database_unavailable(state.inner()))?;
    let database = database.lock().map_err(|error| error.to_string())?;
    db::migrate_legacy_preferences(&database.conn, request).map_err(|error| error.to_string())
}
