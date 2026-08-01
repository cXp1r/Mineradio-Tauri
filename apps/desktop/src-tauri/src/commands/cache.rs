use crate::{
    runtime::cache::{CacheCategory, CacheClearResult, CacheRootDecision, CacheSnapshot},
    AppState,
};
use std::path::PathBuf;
use tauri_plugin_dialog::DialogExt;

#[tauri::command]
pub async fn get_cache_snapshot(
    state: tauri::State<'_, AppState>,
) -> Result<CacheSnapshot, String> {
    let Some(cache) = &state.cache else {
        return Err(state
            .cache_init_error
            .clone()
            .unwrap_or_else(|| "cache runtime not initialized".to_string()));
    };
    let request = cache
        .lock()
        .map_err(|error| error.to_string())?
        .scan_request();
    tauri::async_runtime::spawn_blocking(move || request.execute())
        .await
        .map_err(|_| "CACHE_SCAN_WORKER_FAILED".to_string())
}

#[tauri::command]
pub async fn choose_cache_directory(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let (tx, mut rx) = tauri::async_runtime::channel(1);
    app.dialog().file().pick_folder(move |selected| {
        let _ = tx.try_send(selected);
    });
    let selected = rx
        .recv()
        .await
        .ok_or_else(|| "CACHE_DIRECTORY_DIALOG_CLOSED".to_string())?;
    let Some(selected) = selected else {
        return Ok(None);
    };
    let path = selected
        .into_path()
        .map_err(|_| "CACHE_DIRECTORY_INVALID_PATH".to_string())?;
    Ok(Some(path.to_string_lossy().to_string()))
}

#[tauri::command]
pub fn set_cache_root(
    state: tauri::State<'_, AppState>,
    path: Option<String>,
) -> Result<CacheRootDecision, String> {
    let Some(cache) = &state.cache else {
        return Err(state
            .cache_init_error
            .clone()
            .unwrap_or_else(|| "cache runtime not initialized".to_string()));
    };
    let desired = path.and_then(|value| {
        let trimmed = value.trim();
        (!trimmed.is_empty()).then(|| PathBuf::from(trimmed))
    });
    cache
        .lock()
        .map_err(|error| error.to_string())?
        .set_desired_root(desired)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn clear_cache_category(
    state: tauri::State<'_, AppState>,
    category: CacheCategory,
) -> Result<CacheClearResult, String> {
    let Some(cache) = &state.cache else {
        return Err(state
            .cache_init_error
            .clone()
            .unwrap_or_else(|| "cache runtime not initialized".to_string()));
    };
    let request = cache
        .lock()
        .map_err(|error| error.to_string())?
        .clear_request(category);
    tauri::async_runtime::spawn_blocking(move || request.execute())
        .await
        .map_err(|_| "CACHE_CLEAR_WORKER_FAILED".to_string())?
        .map_err(|error| error.to_string())
}
