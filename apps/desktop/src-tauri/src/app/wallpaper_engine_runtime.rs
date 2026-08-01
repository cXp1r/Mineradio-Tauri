//! Wallpaper Engine Runtime 的 Tauri 生命周期装配。
//!
//! command 只传递用户意图；项目发现、Scene ownership 与恢复顺序都留在
//! `WallpaperEngineRuntime` Module 内。本模块只负责 Tauri 窗口几何、对话框结果和
//! Web DTO 映射，不触碰 Win32 实现细节。

use std::{
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use serde::{Deserialize, Serialize};
use tauri::{
    webview::{PageLoadEvent, PageLoadPayload},
    Manager, Webview,
};

use crate::{
    runtime::{
        full_desktop::FullDesktopMode,
        wallpaper_engine::{
            PhysicalRect, ProjectSourceKind, StartWallpaperSceneRequest, WallpaperEngineError,
            WallpaperEngineRuntime, WallpaperFullDesktopMode,
            WallpaperLibrarySnapshot as CoreLibrarySnapshot, WallpaperMediaRole,
            WallpaperMediaType, WallpaperProjectSummary as CoreProjectSummary,
            WallpaperRuntimeState,
        },
    },
    AppState,
};

const MEDIA_ORIGIN: &str = "http://mineradio-wallpaper.localhost";
const ACTIVE_RECONCILE_INTERVAL: Duration = Duration::from_secs(1);

#[derive(Debug, Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListWallpaperProjectsRequest {
    #[serde(default)]
    pub force_refresh: bool,
}

#[derive(Debug, Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WallpaperRuntimeStatusRequest {
    #[serde(default)]
    pub refresh: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartWallpaperSceneCommandRequest {
    pub project_id: String,
    pub fps: Option<u32>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StopWallpaperSceneCommandRequest {
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WallpaperDialogResult {
    pub ok: bool,
    pub canceled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub root_id: Option<String>,
}

impl WallpaperDialogResult {
    pub fn canceled() -> Self {
        Self {
            ok: true,
            canceled: true,
            root_id: None,
        }
    }

    fn imported(root_id: String) -> Self {
        Self {
            ok: true,
            canceled: false,
            root_id: Some(root_id),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WallpaperLibraryRootView {
    pub id: String,
    pub label: String,
    pub source: ProjectSourceKind,
    pub project_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WallpaperProjectView {
    pub id: String,
    pub title: String,
    pub project_type: String,
    pub media_type: Option<WallpaperMediaType>,
    pub playable: bool,
    pub engine_playable: bool,
    pub preview_only: bool,
    pub safety_mode: crate::runtime::wallpaper_engine::WallpaperSafetyMode,
    pub source: ProjectSourceKind,
    pub source_label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workshop_id: Option<String>,
    pub has_preview: bool,
    pub preview_animated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview_media_type: Option<WallpaperMediaType>,
    pub updated_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub media_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WallpaperLibraryView {
    pub projects: Vec<WallpaperProjectView>,
    pub roots: Vec<WallpaperLibraryRootView>,
    pub updated_at: u64,
    pub dynamic_count: usize,
    pub engine_playable_count: usize,
    pub preview_only_count: usize,
    pub scan_limited: bool,
}

fn stable_error(error: WallpaperEngineError) -> String {
    error.code().to_owned()
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::SystemTime::UNIX_EPOCH)
        .map(|value| u64::try_from(value.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

fn runtime_lock(
    runtime: &Arc<Mutex<WallpaperEngineRuntime>>,
) -> Result<std::sync::MutexGuard<'_, WallpaperEngineRuntime>, String> {
    runtime
        .lock()
        .map_err(|_| "WALLPAPER_ENGINE_STATE_UNAVAILABLE".to_owned())
}

fn media_url(project_id: &str, role: &str, revision: u64) -> String {
    format!("{MEDIA_ORIGIN}/project/{project_id}/{role}?revision={revision}")
}

fn project_view(project: &CoreProjectSummary) -> WallpaperProjectView {
    WallpaperProjectView {
        id: project.id.clone(),
        title: project.title.clone(),
        project_type: project.project_type.clone(),
        media_type: project.media_type,
        playable: project.playable,
        engine_playable: project.engine_playable,
        preview_only: project.preview_only,
        safety_mode: project.safety_mode,
        source: project.source,
        source_label: project.source_label.clone(),
        workshop_id: project.workshop_id.clone(),
        has_preview: project.has_preview,
        preview_animated: project.preview_animated,
        preview_media_type: project.preview_media_type,
        updated_at: project.updated_at,
        media_url: project
            .playable
            .then(|| media_url(&project.id, "media", project.updated_at)),
        preview_url: project
            .has_preview
            .then(|| media_url(&project.id, "preview", project.updated_at)),
    }
}

fn library_view(snapshot: CoreLibrarySnapshot) -> WallpaperLibraryView {
    WallpaperLibraryView {
        projects: snapshot.projects.iter().map(project_view).collect(),
        roots: snapshot
            .roots
            .into_iter()
            .map(|root| WallpaperLibraryRootView {
                id: root.id,
                label: root.label,
                source: root.source,
                project_count: root.project_count,
            })
            .collect(),
        updated_at: snapshot.updated_at,
        dynamic_count: snapshot.dynamic_count,
        engine_playable_count: snapshot.engine_playable_count,
        preview_only_count: snapshot.preview_only_count,
        scan_limited: snapshot.scan_limited,
    }
}

pub fn list_projects(
    runtime: &Arc<Mutex<WallpaperEngineRuntime>>,
    force: bool,
) -> Result<WallpaperLibraryView, String> {
    let snapshot = runtime_lock(runtime)?
        .list_projects(force)
        .map_err(stable_error)?;
    Ok(library_view(snapshot))
}

pub fn project_details(
    runtime: &Arc<Mutex<WallpaperEngineRuntime>>,
    id: &str,
) -> Result<Option<WallpaperProjectView>, String> {
    let runtime = runtime_lock(runtime)?;
    Ok(runtime.library().project_summary(id).map(project_view))
}

pub fn import_directory(
    runtime: &Arc<Mutex<WallpaperEngineRuntime>>,
    path: &Path,
) -> Result<WallpaperDialogResult, String> {
    let result = runtime_lock(runtime)?
        .library_mut()
        .add_manual_root(path)
        .map_err(|error| error.code().to_owned())?;
    Ok(WallpaperDialogResult::imported(result.root_id))
}

pub fn import_project_file(
    runtime: &Arc<Mutex<WallpaperEngineRuntime>>,
    path: &Path,
) -> Result<WallpaperDialogResult, String> {
    let result = runtime_lock(runtime)?
        .library_mut()
        .add_manual_project_file(path)
        .map_err(|error| error.code().to_owned())?;
    Ok(WallpaperDialogResult::imported(result.root_id))
}

pub fn remove_directory(
    runtime: &Arc<Mutex<WallpaperEngineRuntime>>,
    root_id: &str,
) -> Result<WallpaperLibraryView, String> {
    let mut runtime = runtime_lock(runtime)?;
    let removed = runtime
        .library_mut()
        .remove_manual_root(root_id)
        .map_err(|error| error.code().to_owned())?;
    if !removed {
        return Err("WALLPAPER_LIBRARY_ROOT_NOT_FOUND".to_owned());
    }
    let snapshot = runtime.list_projects(true).map_err(stable_error)?;
    Ok(library_view(snapshot))
}

pub fn runtime_status(
    runtime: &Arc<Mutex<WallpaperEngineRuntime>>,
    refresh: bool,
) -> Result<WallpaperRuntimeState, String> {
    let mut runtime = runtime_lock(runtime)?;
    if refresh {
        let _ = runtime.probe(true).map_err(stable_error)?;
    }
    runtime
        .reconcile_capture_status()
        .cloned()
        .map_err(stable_error)
}

pub fn start_scene(
    state: &AppState,
    request: StartWallpaperSceneCommandRequest,
    physical_bounds: PhysicalRect,
    full_desktop_mode: WallpaperFullDesktopMode,
) -> Result<WallpaperRuntimeState, String> {
    let mut runtime = runtime_lock(&state.wallpaper_engine)?;
    runtime
        .set_full_desktop_mode(full_desktop_mode)
        .map_err(stable_error)?;
    let started = runtime
        .start_scene(StartWallpaperSceneRequest {
            project_id: request.project_id,
            fps: request.fps,
            physical_bounds,
        })
        .map_err(stable_error)?;
    // 成功 session 的 epoch 必须在仍持有 runtime ownership 时提交；失败 start 不得让
    // 旧 WebView cleanup 失去关闭旧 active Scene 的权限。
    let _ = state
        .wallpaper_scene_epoch
        .fetch_add(1, Ordering::AcqRel)
        .wrapping_add(1);
    Ok(started.state)
}

pub fn stop_scene(
    runtime: &Arc<Mutex<WallpaperEngineRuntime>>,
    session_id: Option<&str>,
) -> Result<WallpaperRuntimeState, String> {
    runtime_lock(runtime)?
        .stop_scene(session_id)
        .map(|result| result.state)
        .map_err(stable_error)
}

pub fn recover(
    runtime: &Arc<Mutex<WallpaperEngineRuntime>>,
) -> Result<WallpaperRuntimeState, String> {
    runtime_lock(runtime)?
        .recover()
        .map(|result| result.state)
        .map_err(stable_error)
}

pub fn resolve_media_asset(
    runtime: &Arc<Mutex<WallpaperEngineRuntime>>,
    project_id: &str,
    role: WallpaperMediaRole,
) -> Result<crate::runtime::wallpaper_engine::WallpaperMediaAsset, String> {
    runtime_lock(runtime)?
        .library()
        .resolve_media_asset(project_id, role)
        .map_err(|error| error.code().to_owned())
}

pub fn resolve_media(
    state: &AppState,
    project_id: &str,
    role: WallpaperMediaRole,
) -> Result<crate::runtime::wallpaper_engine::WallpaperMediaAsset, String> {
    resolve_media_asset(&state.wallpaper_engine, project_id, role)
}

pub fn main_window_physical_bounds(app: &tauri::AppHandle) -> Result<PhysicalRect, String> {
    let window = app
        .get_webview_window(super::window_labels::MAIN)
        .ok_or_else(|| "WALLPAPER_ENGINE_HOST_UNAVAILABLE".to_owned())?;
    let position = window
        .inner_position()
        .map_err(|_| "WALLPAPER_ENGINE_BOUNDS_UNAVAILABLE".to_owned())?;
    let size = window
        .inner_size()
        .map_err(|_| "WALLPAPER_ENGINE_BOUNDS_UNAVAILABLE".to_owned())?;
    PhysicalRect {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
    }
    .validated()
    .ok_or_else(|| "WALLPAPER_ENGINE_BOUNDS_INVALID".to_owned())
}

pub fn full_desktop_mode(state: &AppState) -> Result<WallpaperFullDesktopMode, String> {
    let mode = state
        .full_desktop
        .lock()
        .map_err(|_| "WALLPAPER_ENGINE_FULL_DESKTOP_STATE_UNAVAILABLE".to_owned())?
        .snapshot()
        .effective_mode;
    Ok(map_full_desktop_mode(mode))
}

fn map_full_desktop_mode(mode: FullDesktopMode) -> WallpaperFullDesktopMode {
    match mode {
        FullDesktopMode::Disabled => WallpaperFullDesktopMode::Disabled,
        FullDesktopMode::Passive => WallpaperFullDesktopMode::Passive,
        FullDesktopMode::Interactive => WallpaperFullDesktopMode::Interactive,
    }
}

/// M6 切换前先同步 Wallpaper 的 z-order policy；进入 passive 必须先确认 exact Scene
/// 已关闭。失败时 M6 不得开始原生附着。
pub fn prepare_full_desktop_transition(
    state: &AppState,
    mode: FullDesktopMode,
) -> Result<(), String> {
    let mut runtime = runtime_lock(&state.wallpaper_engine)?;
    if mode == FullDesktopMode::Passive {
        let stopped = runtime.stop_scene(None).map_err(stable_error)?;
        if stopped.state.active || stopped.state.cleanup_required {
            return Err("WALLPAPER_ENGINE_PASSIVE_STOP_UNCONFIRMED".to_owned());
        }
    }
    runtime
        .set_full_desktop_mode(map_full_desktop_mode(mode))
        .map_err(stable_error)
}

pub fn rollback_full_desktop_transition(state: &AppState, mode: FullDesktopMode) {
    if let Ok(mut runtime) = state.wallpaper_engine.lock() {
        let _ = runtime.set_full_desktop_mode(map_full_desktop_mode(mode));
    }
}

/// 主窗口隐藏或最小化时释放 Scene；用户选择仍保留在 Web feature，恢复后显式创建
/// 新 session。
pub fn stop_for_window_deactivation(state: &AppState) -> Result<(), String> {
    let _permit = match state.enter_update_install_mutation() {
        Ok(permit) => permit,
        Err(_) => return Ok(()),
    };
    state.wallpaper_scene_epoch.fetch_add(1, Ordering::AcqRel);
    stop_for_window_deactivation_locked(state, None)
}

fn stop_for_window_deactivation_locked(
    state: &AppState,
    expected_epoch: Option<u64>,
) -> Result<(), String> {
    let mut runtime = runtime_lock(&state.wallpaper_engine)?;
    if !lifecycle_stop_epoch_matches(
        expected_epoch,
        state.wallpaper_scene_epoch.load(Ordering::Acquire),
    ) {
        return Ok(());
    }
    let stopped = runtime.stop_scene(None).map_err(stable_error)?;
    if stopped.state.active || stopped.state.cleanup_required {
        return Err("WALLPAPER_ENGINE_WINDOW_STOP_UNCONFIRMED".to_owned());
    }
    Ok(())
}

fn lifecycle_stop_epoch_matches(expected_epoch: Option<u64>, current_epoch: u64) -> bool {
    expected_epoch.is_none_or(|expected| expected == current_epoch)
}

fn page_load_requires_scene_stop(webview_label: &str, event: PageLoadEvent) -> bool {
    webview_label == super::window_labels::MAIN && event == PageLoadEvent::Started
}

fn process_failure_requires_scene_stop(kind: i32) -> bool {
    // WebView2: browser=0、render exited=1、render unresponsive=2、frame render exited=3。
    // utility/GPU/plugin 失败不代表主 renderer ownership 已失效。
    matches!(kind, 0..=3)
}

fn record_lifecycle_stop_error(app: &tauri::AppHandle, error: String) {
    app.state::<AppState>().diagnostics.record_runtime_error(
        crate::runtime::diagnostics::DiagnosticProbeKind::WallpaperEngine,
        now_ms(),
        error,
    );
}

/// WebView2 callback 位于 UI thread；exact Scene close 可能等待有界 native confirmation，
/// 因此统一交给后台 worker，避免 renderer failure callback 反向阻塞 WebView2。
pub fn schedule_stop_for_webview_failure(app: tauri::AppHandle) {
    let expected_epoch = app
        .state::<AppState>()
        .wallpaper_scene_epoch
        .load(Ordering::Acquire);
    let worker_app = app.clone();
    if std::thread::Builder::new()
        .name("mineradio-wallpaper-webview-stop".to_owned())
        .spawn(move || {
            let state = worker_app.state::<AppState>();
            let _permit = match state.enter_update_install_mutation() {
                Ok(permit) => permit,
                Err(_) => return,
            };
            if let Err(error) =
                stop_for_window_deactivation_locked(state.inner(), Some(expected_epoch))
            {
                record_lifecycle_stop_error(&worker_app, error);
            }
        })
        .is_err()
    {
        record_lifecycle_stop_error(
            &app,
            "WALLPAPER_ENGINE_LIFECYCLE_WORKER_UNAVAILABLE".to_owned(),
        );
    }
}

/// 安装 Windows WebView2 `ProcessFailed` owner。browser/render/frame exited 以及 renderer
/// unresponsive 都释放 Scene；GPU/utility failure 不触碰仍然健康的主 renderer。
#[cfg(windows)]
pub fn install_main_webview_process_failed_handler(
    window: &tauri::WebviewWindow,
) -> Result<(), String> {
    use webview2_com::{
        Microsoft::Web::WebView2::Win32::COREWEBVIEW2_PROCESS_FAILED_KIND_UNKNOWN_PROCESS_EXITED,
        ProcessFailedEventHandler,
    };

    let app = window.app_handle().clone();
    window
        .with_webview(move |platform_webview| unsafe {
            let core_webview = match platform_webview.controller().CoreWebView2() {
                Ok(core_webview) => core_webview,
                Err(_) => {
                    record_lifecycle_stop_error(
                        &app,
                        "WALLPAPER_ENGINE_PROCESS_FAILED_HOOK_UNAVAILABLE".to_owned(),
                    );
                    return;
                }
            };
            let callback_app = app.clone();
            let handler = ProcessFailedEventHandler::create(Box::new(move |_, args| {
                let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND_UNKNOWN_PROCESS_EXITED;
                let should_stop = match args {
                    Some(args) => {
                        args.ProcessFailedKind(&mut kind)?;
                        process_failure_requires_scene_stop(kind.0)
                    }
                    None => true,
                };
                if should_stop {
                    schedule_stop_for_webview_failure(callback_app.clone());
                }
                Ok(())
            }));
            let mut token = 0_i64;
            if core_webview
                .add_ProcessFailed(&handler, &mut token)
                .is_err()
            {
                record_lifecycle_stop_error(
                    &app,
                    "WALLPAPER_ENGINE_PROCESS_FAILED_HOOK_UNAVAILABLE".to_owned(),
                );
            }
        })
        .map_err(|_| "WALLPAPER_ENGINE_PROCESS_FAILED_HOOK_UNAVAILABLE".to_owned())
}

#[cfg(not(windows))]
pub fn install_main_webview_process_failed_handler(
    _window: &tauri::WebviewWindow,
) -> Result<(), String> {
    Ok(())
}

/// 除 Windows 原生 WebView2 `ProcessFailed` owner 外，再以每次主 WebView
/// navigation/reload 的 Started 事件作为保守恢复 seam：初始导航为空操作，后续
/// reload、崩溃恢复导航或显式跳转都先关闭 exact Scene，不复用旧 capture。
pub fn handle_main_webview_page_load(webview: &Webview, payload: &PageLoadPayload<'_>) {
    if !page_load_requires_scene_stop(webview.label(), payload.event()) {
        return;
    }
    schedule_stop_for_webview_failure(webview.app_handle().clone());
}

/// 真实退出在 M6 rollback 后调用。本函数先禁止新 intent，再执行 exact Scene close；
/// 失败时 core 保留 recovery journal，caller 决定是否取消退出。
pub fn dispose_before_exit(state: &AppState) -> Result<(), String> {
    stop_reconcile_watcher_for_shutdown(state);
    let mut runtime = runtime_lock(&state.wallpaper_engine)?;
    runtime.stop_accepting_intents();
    let stopped = runtime.dispose().map_err(stable_error)?;
    if stopped.state.active || stopped.state.cleanup_required {
        return Err("WALLPAPER_ENGINE_EXIT_STOP_UNCONFIRMED".to_owned());
    }
    Ok(())
}

/// 主窗口创建后安装 Windows Adapter，并在 M6 自动恢复前处理 exact-location journal。
pub fn recover_before_auto_resume(app: &tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    let mut runtime = runtime_lock(&state.wallpaper_engine)?;

    #[cfg(windows)]
    {
        let platform = crate::platform::TauriWallpaperEnginePlatform::for_main_window(app.clone())
            .map_err(|error| error.code().to_owned())?;
        runtime
            .install_platform(Box::new(platform))
            .map_err(stable_error)?;
    }

    #[cfg(not(windows))]
    {
        let _ = runtime.probe(false).map_err(stable_error)?;
    }

    runtime.recover().map(|_| ()).map_err(stable_error)
}

/// setup 不能因 Wallpaper Engine 缺失而失去主窗口；稳定错误进入诊断，journal 与
/// cleanupRequired 状态仍由 command 暴露给用户显式恢复。
pub fn initialize_after_main_window(app: &tauri::AppHandle) {
    if let Err(error) = recover_before_auto_resume(app) {
        app.state::<AppState>().diagnostics.record_runtime_error(
            crate::runtime::diagnostics::DiagnosticProbeKind::WallpaperEngine,
            now_ms(),
            error,
        );
    }
}

/// 启动 native health watcher。worker 仅在 active 且非 cleanupRequired 时取得 runtime
/// 锁；DWM/mute owner 退休后不依赖 Web polling 即可在一秒级进入重绑或可恢复状态。
pub fn start_reconcile_watcher_after_main_window(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    let Ok(mut watcher) = state.wallpaper_engine_watcher.lock() else {
        return;
    };
    if watcher.worker.is_some() || watcher.stop.is_some() {
        return;
    }
    let stop = Arc::new(AtomicBool::new(false));
    let worker_app = app.clone();
    let worker_stop = Arc::clone(&stop);
    let worker = std::thread::Builder::new()
        .name("mineradio-wallpaper-reconcile".to_owned())
        .spawn(move || loop {
            std::thread::park_timeout(ACTIVE_RECONCILE_INTERVAL);
            if worker_stop.load(Ordering::Acquire) {
                break;
            }
            let state = worker_app.state::<AppState>();
            let result = state
                .wallpaper_engine
                .lock()
                .map_err(|_| "WALLPAPER_ENGINE_STATE_UNAVAILABLE".to_owned())
                .and_then(|mut runtime| {
                    if worker_stop.load(Ordering::Acquire)
                        || !runtime.status().active
                        || runtime.status().cleanup_required
                    {
                        return Ok(());
                    }
                    runtime
                        .reconcile_capture_status()
                        .map(|_| ())
                        .map_err(stable_error)
                });
            if let Err(error) = result {
                state.diagnostics.record_runtime_error(
                    crate::runtime::diagnostics::DiagnosticProbeKind::WallpaperEngine,
                    now_ms(),
                    error,
                );
            }
        });
    match worker {
        Ok(worker) => {
            watcher.wake = Some(worker.thread().clone());
            watcher.stop = Some(stop);
            watcher.worker = Some(worker);
        }
        Err(error) => {
            state.diagnostics.record_runtime_error(
                crate::runtime::diagnostics::DiagnosticProbeKind::WallpaperEngine,
                now_ms(),
                format!("WALLPAPER_ENGINE_RECONCILE_WATCHER_FAILED: {error}"),
            );
        }
    }
}

// 由 #54 dormant native adapter 消费；普通 shutdown 继续使用既有无阻塞 reaper。
#[allow(dead_code)]
pub(crate) struct WallpaperWatcherInstallReceipt {
    was_running: bool,
    worker: Option<std::thread::JoinHandle<()>>,
}

#[allow(dead_code)]
impl WallpaperWatcherInstallReceipt {
    pub(crate) fn join_bounded(&mut self, timeout: Duration) -> Result<bool, String> {
        super::state::join_worker_bounded(
            &mut self.worker,
            timeout,
            "WALLPAPER_ENGINE_WATCHER_JOIN_PANICKED",
        )
    }

    pub(crate) fn restore(&self, app: &tauri::AppHandle) -> Result<(), String> {
        if self.worker.is_some() {
            return Err("WALLPAPER_ENGINE_WATCHER_JOIN_INCOMPLETE".to_owned());
        }
        if self.was_running {
            start_reconcile_watcher_after_main_window(app);
            let running = app
                .state::<AppState>()
                .wallpaper_engine_watcher
                .lock()
                .map(|watcher| watcher.worker.is_some())
                .unwrap_or(false);
            if !running {
                return Err("WALLPAPER_ENGINE_WATCHER_RESTART_FAILED".to_owned());
            }
        }
        Ok(())
    }
}

#[allow(dead_code)]
pub(crate) fn take_reconcile_watcher_for_update(
    state: &AppState,
) -> Result<WallpaperWatcherInstallReceipt, String> {
    let mut watcher = state
        .wallpaper_engine_watcher
        .lock()
        .map_err(|_| "WALLPAPER_ENGINE_WATCHER_STATE_UNAVAILABLE".to_owned())?;
    let was_running = watcher.worker.is_some() || watcher.stop.is_some();
    if let Some(stop) = watcher.stop.take() {
        stop.store(true, Ordering::Release);
    }
    if let Some(wake) = watcher.wake.take() {
        wake.unpark();
    }
    let worker = watcher.worker.take();
    Ok(WallpaperWatcherInstallReceipt {
        was_running,
        worker,
    })
}

/// shutdown 先撤销 watcher ownership 并唤醒 worker；worker 在再次取得 runtime 锁前复核
/// stop，因此不会与 exact Scene close 形成新的 mutation race。
pub fn stop_reconcile_watcher_for_shutdown(state: &AppState) {
    let worker = state
        .wallpaper_engine_watcher
        .lock()
        .ok()
        .and_then(|mut watcher| {
            if let Some(stop) = watcher.stop.take() {
                stop.store(true, Ordering::Release);
            }
            if let Some(wake) = watcher.wake.take() {
                wake.unpark();
            }
            watcher.worker.take()
        });
    if let Some(worker) = worker {
        let _ = std::thread::Builder::new()
            .name("mineradio-wallpaper-reconcile-reaper".to_owned())
            .spawn(move || {
                let _ = worker.join();
            });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::wallpaper_engine::{
        ProjectSourceKind, WallpaperMediaType, WallpaperSafetyMode,
    };

    #[test]
    fn project_view_exposes_only_registered_protocol_urls() {
        let project = CoreProjectSummary {
            id: "ab".repeat(12),
            title: "Fixture".to_owned(),
            project_type: "video".to_owned(),
            media_type: Some(WallpaperMediaType::Video),
            playable: true,
            engine_playable: false,
            preview_only: false,
            safety_mode: WallpaperSafetyMode::DirectMedia,
            source: ProjectSourceKind::Imported,
            source_label: "手动导入".to_owned(),
            workshop_id: None,
            has_preview: true,
            preview_animated: false,
            preview_media_type: Some(WallpaperMediaType::Image),
            media_animated: false,
            updated_at: 42,
        };

        let view = project_view(&project);
        assert_eq!(
            view.media_url.as_deref(),
            Some("http://mineradio-wallpaper.localhost/project/abababababababababababab/media?revision=42")
        );
        assert_eq!(
            view.preview_url.as_deref(),
            Some("http://mineradio-wallpaper.localhost/project/abababababababababababab/preview?revision=42")
        );
        assert!(view
            .media_url
            .as_deref()
            .is_some_and(|url| url.starts_with(MEDIA_ORIGIN)));
        let serialized = serde_json::to_value(&view).expect("预览 DTO 应可序列化");
        assert_eq!(serialized["previewMediaType"], "image");

        let mut without_preview = project;
        without_preview.has_preview = false;
        without_preview.preview_media_type = None;
        let serialized =
            serde_json::to_value(project_view(&without_preview)).expect("无预览 DTO 应可序列化");
        assert!(serialized.get("previewMediaType").is_none());
    }

    #[test]
    fn dialog_cancel_is_successful_and_non_mutating() {
        assert_eq!(
            WallpaperDialogResult::canceled(),
            WallpaperDialogResult {
                ok: true,
                canceled: true,
                root_id: None,
            }
        );
    }

    #[test]
    fn main_navigation_start_is_the_only_page_load_that_stops_scene() {
        assert!(page_load_requires_scene_stop(
            super::super::window_labels::MAIN,
            PageLoadEvent::Started,
        ));
        assert!(!page_load_requires_scene_stop(
            super::super::window_labels::MAIN,
            PageLoadEvent::Finished,
        ));
        assert!(!page_load_requires_scene_stop(
            super::super::window_labels::DESKTOP_LYRICS,
            PageLoadEvent::Started,
        ));
        for kind in 0..=3 {
            assert!(process_failure_requires_scene_stop(kind));
        }
        for kind in [4, 5, 6, 7, 8, 9] {
            assert!(!process_failure_requires_scene_stop(kind));
        }
    }

    #[test]
    fn delayed_webview_failure_stop_cannot_target_a_new_scene_epoch() {
        assert!(lifecycle_stop_epoch_matches(Some(7), 7));
        assert!(!lifecycle_stop_epoch_matches(Some(7), 8));
        assert!(lifecycle_stop_epoch_matches(None, 8));
    }
}
