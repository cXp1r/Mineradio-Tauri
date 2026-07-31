//! Wallpaper Engine 的窄 Tauri transport Adapter。
//!
//! 文件选择、参数反序列化和 blocking worker 调度止于此处；command 不感知 Steam、
//! Win32、Scene HWND 或 recovery journal 的实现。

use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

use crate::{
    app::wallpaper_engine_runtime::{
        self, ListWallpaperProjectsRequest, StartWallpaperSceneCommandRequest,
        StopWallpaperSceneCommandRequest, WallpaperDialogResult, WallpaperLibraryView,
        WallpaperProjectView, WallpaperRuntimeStatusRequest,
    },
    runtime::wallpaper_engine::WallpaperRuntimeState,
    AppState,
};

fn ensure_library_mutable(state: &AppState) -> Result<(), String> {
    match &state.wallpaper_engine_init_error {
        Some(error) => Err(error.clone()),
        None => Ok(()),
    }
}

#[tauri::command]
pub async fn list_wallpaper_engine_projects(
    state: tauri::State<'_, AppState>,
    request: Option<ListWallpaperProjectsRequest>,
) -> Result<WallpaperLibraryView, String> {
    let runtime = state.wallpaper_engine.clone();
    let force = request.unwrap_or_default().force_refresh;
    tauri::async_runtime::spawn_blocking(move || {
        wallpaper_engine_runtime::list_projects(&runtime, force)
    })
    .await
    .map_err(|_| "WALLPAPER_ENGINE_WORKER_FAILED".to_owned())?
}

#[tauri::command]
pub fn get_wallpaper_engine_project_details(
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<Option<WallpaperProjectView>, String> {
    wallpaper_engine_runtime::project_details(&state.wallpaper_engine, &id)
}

#[tauri::command]
pub async fn choose_wallpaper_engine_directory(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<WallpaperDialogResult, String> {
    ensure_library_mutable(state.inner())?;
    let (tx, mut rx) = tauri::async_runtime::channel(1);
    app.dialog().file().pick_folder(move |selected| {
        let _ = tx.try_send(selected);
    });
    let selected = rx
        .recv()
        .await
        .ok_or_else(|| "WALLPAPER_LIBRARY_DIALOG_CLOSED".to_owned())?;
    let Some(selected) = selected else {
        return Ok(WallpaperDialogResult::canceled());
    };
    let path = selected
        .into_path()
        .map_err(|_| "WALLPAPER_LIBRARY_ROOT_INVALID".to_owned())?;
    let permit = state.enter_update_install_mutation()?;
    let runtime = state.wallpaper_engine.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        wallpaper_engine_runtime::import_directory(&runtime, &path)
    })
    .await
    .map_err(|_| "WALLPAPER_ENGINE_WORKER_FAILED".to_owned())?
}

#[tauri::command]
pub async fn choose_wallpaper_engine_project_file(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<WallpaperDialogResult, String> {
    ensure_library_mutable(state.inner())?;
    let (tx, mut rx) = tauri::async_runtime::channel(1);
    app.dialog()
        .file()
        .add_filter("Wallpaper Engine", &["json", "pkg", "pak"])
        .pick_file(move |selected| {
            let _ = tx.try_send(selected);
        });
    let selected = rx
        .recv()
        .await
        .ok_or_else(|| "WALLPAPER_LIBRARY_DIALOG_CLOSED".to_owned())?;
    let Some(selected) = selected else {
        return Ok(WallpaperDialogResult::canceled());
    };
    let path = selected
        .into_path()
        .map_err(|_| "WALLPAPER_LIBRARY_PROJECT_FILE_INVALID".to_owned())?;
    let permit = state.enter_update_install_mutation()?;
    let runtime = state.wallpaper_engine.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        wallpaper_engine_runtime::import_project_file(&runtime, &path)
    })
    .await
    .map_err(|_| "WALLPAPER_ENGINE_WORKER_FAILED".to_owned())?
}

#[tauri::command]
pub async fn remove_wallpaper_engine_directory(
    state: tauri::State<'_, AppState>,
    root_id: String,
) -> Result<WallpaperLibraryView, String> {
    ensure_library_mutable(state.inner())?;
    let permit = state.enter_update_install_mutation()?;
    let runtime = state.wallpaper_engine.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        wallpaper_engine_runtime::remove_directory(&runtime, &root_id)
    })
    .await
    .map_err(|_| "WALLPAPER_ENGINE_WORKER_FAILED".to_owned())?
}

#[tauri::command]
pub async fn get_wallpaper_engine_runtime_status(
    state: tauri::State<'_, AppState>,
    request: Option<WallpaperRuntimeStatusRequest>,
) -> Result<WallpaperRuntimeState, String> {
    let runtime = state.wallpaper_engine.clone();
    let refresh = request.unwrap_or_default().refresh;
    let permit = if refresh {
        Some(state.enter_update_install_mutation()?)
    } else {
        None
    };
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        wallpaper_engine_runtime::runtime_status(&runtime, refresh)
    })
    .await
    .map_err(|_| "WALLPAPER_ENGINE_WORKER_FAILED".to_owned())?
}

#[tauri::command]
pub async fn start_wallpaper_engine_scene(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    request: StartWallpaperSceneCommandRequest,
) -> Result<WallpaperRuntimeState, String> {
    let permit = state.enter_update_install_mutation()?;
    let transition = state.desktop_wallpaper_transition.clone();
    let worker_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        let state = worker_app.state::<AppState>();
        // Tauri 窗口查询可能需要 event-loop 协作，不能在持有跨 runtime transition owner
        // 时执行，否则主线程的 minimize/exit 路径可能反向等待同一把锁。
        let physical_bounds = wallpaper_engine_runtime::main_window_physical_bounds(&worker_app)?;
        let _transition = transition
            .lock()
            .map_err(|_| "DESKTOP_WALLPAPER_TRANSITION_UNAVAILABLE".to_owned())?;
        let lifecycle_phase = state
            .window_runtime
            .lock()
            .map_err(|_| "DESKTOP_RUNTIME_STATE_UNAVAILABLE".to_owned())?
            .snapshot()
            .lifecycle
            .phase;
        if matches!(
            lifecycle_phase,
            crate::app::lifecycle::LifecyclePhase::Exiting
                | crate::app::lifecycle::LifecyclePhase::Cleaned
        ) {
            return Err("WALLPAPER_ENGINE_RUNTIME_DISPOSED".to_owned());
        }
        let full_desktop_mode = wallpaper_engine_runtime::full_desktop_mode(state.inner())?;
        if full_desktop_mode == crate::runtime::wallpaper_engine::WallpaperFullDesktopMode::Passive
        {
            return Err("WALLPAPER_ENGINE_PASSIVE_MODE_ACTIVE".to_owned());
        }
        wallpaper_engine_runtime::start_scene(
            state.inner(),
            request,
            physical_bounds,
            full_desktop_mode,
        )
    })
    .await
    .map_err(|_| "WALLPAPER_ENGINE_WORKER_FAILED".to_owned())?
}

#[tauri::command]
pub async fn stop_wallpaper_engine_scene(
    state: tauri::State<'_, AppState>,
    request: Option<StopWallpaperSceneCommandRequest>,
) -> Result<WallpaperRuntimeState, String> {
    let permit = state.enter_update_install_mutation()?;
    let runtime = state.wallpaper_engine.clone();
    let session_id = request.and_then(|request| request.session_id);
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        wallpaper_engine_runtime::stop_scene(&runtime, session_id.as_deref())
    })
    .await
    .map_err(|_| "WALLPAPER_ENGINE_WORKER_FAILED".to_owned())?
}

#[tauri::command]
pub async fn recover_wallpaper_engine_runtime(
    state: tauri::State<'_, AppState>,
) -> Result<WallpaperRuntimeState, String> {
    let permit = state.enter_update_install_mutation()?;
    let runtime = state.wallpaper_engine.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        wallpaper_engine_runtime::recover(&runtime)
    })
    .await
    .map_err(|_| "WALLPAPER_ENGINE_WORKER_FAILED".to_owned())?
}
