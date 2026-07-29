//! Wallpaper Engine 的 transport-neutral 核心。
//!
//! 此模块不依赖 Tauri 或 Win32。平台相关发现、进程与窗口操作通过
//! [`WallpaperEnginePlatform`] 注入。

pub mod journal;
pub mod library;
pub mod ownership;
pub mod policy;
pub mod project;

use std::{collections::BTreeMap, fmt, path::PathBuf};

use serde::{Deserialize, Serialize};

#[allow(unused_imports)]
pub use journal::{
    FileWallpaperRecoveryJournalStore, WallpaperRecoveryJournal, WallpaperRecoveryJournalStore,
};
#[allow(unused_imports)]
pub use library::{
    WallpaperImportResult, WallpaperLibrary, WallpaperLibrarySnapshot, WallpaperManualRootSummary,
    WallpaperMediaAsset, WallpaperMediaRole,
};
#[allow(unused_imports)]
pub use ownership::{ExecutableIdentity, OwnedProcessIdentity, SceneOwnership, WindowIdentity};
#[allow(unused_imports)]
pub use policy::{PhysicalRect, WallpaperFullDesktopMode};
#[allow(unused_imports)]
pub use project::{
    NativeSceneTarget, ProjectSource, ProjectSourceKind, ScenePropertyValue, WallpaperMediaType,
    WallpaperProjectSummary, WallpaperSafetyMode,
};

use journal::{WallpaperJournalError, WallpaperRecoveryPhase};
use library::WallpaperLibraryError;
use ownership::{
    new_session_id, same_executable, scene_location, validate_scene_ownership,
    validate_scene_replacement, OwnershipError,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WallpaperRuntimePhase {
    Idle,
    Starting,
    Active,
    Stopping,
    CleanupRequired,
    Unavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WallpaperCaptureMode {
    None,
    DwmThumbnail,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WallpaperRuntimeState {
    pub available: bool,
    pub phase: WallpaperRuntimePhase,
    pub pending: bool,
    pub active: bool,
    pub project_id: String,
    pub session_id: String,
    pub source_id: String,
    pub capture_mode: WallpaperCaptureMode,
    pub source_window_aligned: bool,
    pub dwm_surface_ready: bool,
    pub glass_sampler_ready: bool,
    pub audio_muted: bool,
    pub cleanup_required: bool,
    pub full_desktop_mode: WallpaperFullDesktopMode,
    pub generation: u64,
    pub last_error: Option<String>,
}

impl Default for WallpaperRuntimeState {
    fn default() -> Self {
        Self {
            available: false,
            phase: WallpaperRuntimePhase::Unavailable,
            pending: false,
            active: false,
            project_id: String::new(),
            session_id: String::new(),
            source_id: String::new(),
            capture_mode: WallpaperCaptureMode::None,
            source_window_aligned: false,
            dwm_surface_ready: false,
            glass_sampler_ready: false,
            audio_muted: false,
            cleanup_required: false,
            full_desktop_mode: WallpaperFullDesktopMode::Disabled,
            generation: 0,
            last_error: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StartWallpaperSceneRequest {
    pub project_id: String,
    pub fps: Option<u32>,
    pub physical_bounds: PhysicalRect,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PlatformSceneRequest {
    pub generation: u64,
    pub project_id: String,
    pub session_id: String,
    pub location: String,
    pub project_file: PathBuf,
    pub scene_package: PathBuf,
    pub mute_properties: BTreeMap<String, ScenePropertyValue>,
    pub physical_bounds: PhysicalRect,
    pub fps: u32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PreparedScene {
    pub request: PlatformSceneRequest,
    pub executable: ExecutableIdentity,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SceneActivation {
    pub source_id: String,
    pub source_window_aligned: bool,
    pub dwm_surface_ready: bool,
    pub glass_sampler_ready: bool,
    pub audio_muted: bool,
}

/// 平台对当前 exact Scene 与 capture owner 的只读观测。
///
/// `ownership` 可以是同一唯一 location 下经重新验证的新 HWND generation；core 只有在
/// journal 先持久化该 identity 后，才会请求平台重新绑定 capture。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SceneCaptureObservation {
    pub ownership: SceneOwnership,
    pub activation: SceneActivation,
    pub rebind_required: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SceneCloseConfirmation {
    pub observed: Option<SceneOwnership>,
    pub location_closed: bool,
    pub resources_released: bool,
    /// 平台已对唯一 location 做过有界关闭/缺失观察，确认没有 exact title + executable
    /// HWND 遗留。该证据可清理 Opening 或 Active journal，不能由一次即时查询代替。
    pub source_absence_confirmed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlatformAvailability {
    pub available: bool,
    pub executable_name: Option<String>,
    pub reason: Option<String>,
}

impl PlatformAvailability {
    pub fn unavailable(reason: impl Into<String>) -> Self {
        Self {
            available: false,
            executable_name: None,
            reason: Some(reason.into()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WallpaperPlatformError {
    code: String,
}

impl WallpaperPlatformError {
    pub fn new(code: impl Into<String>) -> Self {
        let code = code.into();
        let code = if code.starts_with("WALLPAPER_") {
            code
        } else {
            "WALLPAPER_ENGINE_PLATFORM_FAILED".to_owned()
        };
        Self { code }
    }

    pub fn unsupported() -> Self {
        Self::new("WALLPAPER_ENGINE_UNSUPPORTED")
    }

    pub fn code(&self) -> &str {
        &self.code
    }
}

impl fmt::Display for WallpaperPlatformError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}", self.code)
    }
}

impl std::error::Error for WallpaperPlatformError {}

pub trait WallpaperEnginePlatform: Send {
    fn probe(&mut self, force: bool) -> Result<PlatformAvailability, WallpaperPlatformError>;

    fn discover_project_sources(&mut self) -> Result<Vec<ProjectSource>, WallpaperPlatformError>;

    fn prepare_scene(
        &mut self,
        request: &PlatformSceneRequest,
    ) -> Result<PreparedScene, WallpaperPlatformError>;

    fn open_scene_location(
        &mut self,
        prepared: &PreparedScene,
    ) -> Result<SceneOwnership, WallpaperPlatformError>;

    fn activate_scene(
        &mut self,
        prepared: &PreparedScene,
        ownership: &SceneOwnership,
    ) -> Result<SceneActivation, WallpaperPlatformError>;

    fn observe_scene_capture(
        &mut self,
        ownership: &SceneOwnership,
    ) -> Result<SceneCaptureObservation, WallpaperPlatformError>;

    fn rebind_scene_capture(
        &mut self,
        ownership: &SceneOwnership,
    ) -> Result<SceneActivation, WallpaperPlatformError>;

    fn deactivate_scene_resources(
        &mut self,
        ownership: &SceneOwnership,
    ) -> Result<(), WallpaperPlatformError>;

    fn close_scene_location(
        &mut self,
        ownership: &SceneOwnership,
    ) -> Result<SceneCloseConfirmation, WallpaperPlatformError>;

    fn recover_scene_location(
        &mut self,
        journal: &WallpaperRecoveryJournal,
    ) -> Result<SceneCloseConfirmation, WallpaperPlatformError>;

    fn set_full_desktop_mode(
        &mut self,
        mode: WallpaperFullDesktopMode,
    ) -> Result<(), WallpaperPlatformError>;
}

#[derive(Default)]
pub struct UnsupportedWallpaperEnginePlatform;

impl WallpaperEnginePlatform for UnsupportedWallpaperEnginePlatform {
    fn probe(&mut self, _force: bool) -> Result<PlatformAvailability, WallpaperPlatformError> {
        Ok(PlatformAvailability::unavailable(
            "WALLPAPER_ENGINE_UNSUPPORTED",
        ))
    }

    fn discover_project_sources(&mut self) -> Result<Vec<ProjectSource>, WallpaperPlatformError> {
        Ok(Vec::new())
    }

    fn prepare_scene(
        &mut self,
        _request: &PlatformSceneRequest,
    ) -> Result<PreparedScene, WallpaperPlatformError> {
        Err(WallpaperPlatformError::unsupported())
    }

    fn open_scene_location(
        &mut self,
        _prepared: &PreparedScene,
    ) -> Result<SceneOwnership, WallpaperPlatformError> {
        Err(WallpaperPlatformError::unsupported())
    }

    fn activate_scene(
        &mut self,
        _prepared: &PreparedScene,
        _ownership: &SceneOwnership,
    ) -> Result<SceneActivation, WallpaperPlatformError> {
        Err(WallpaperPlatformError::unsupported())
    }

    fn observe_scene_capture(
        &mut self,
        _ownership: &SceneOwnership,
    ) -> Result<SceneCaptureObservation, WallpaperPlatformError> {
        Err(WallpaperPlatformError::unsupported())
    }

    fn rebind_scene_capture(
        &mut self,
        _ownership: &SceneOwnership,
    ) -> Result<SceneActivation, WallpaperPlatformError> {
        Err(WallpaperPlatformError::unsupported())
    }

    fn deactivate_scene_resources(
        &mut self,
        _ownership: &SceneOwnership,
    ) -> Result<(), WallpaperPlatformError> {
        Err(WallpaperPlatformError::unsupported())
    }

    fn close_scene_location(
        &mut self,
        _ownership: &SceneOwnership,
    ) -> Result<SceneCloseConfirmation, WallpaperPlatformError> {
        Err(WallpaperPlatformError::unsupported())
    }

    fn recover_scene_location(
        &mut self,
        _journal: &WallpaperRecoveryJournal,
    ) -> Result<SceneCloseConfirmation, WallpaperPlatformError> {
        Err(WallpaperPlatformError::unsupported())
    }

    fn set_full_desktop_mode(
        &mut self,
        mode: WallpaperFullDesktopMode,
    ) -> Result<(), WallpaperPlatformError> {
        if mode == WallpaperFullDesktopMode::Disabled {
            Ok(())
        } else {
            Err(WallpaperPlatformError::unsupported())
        }
    }
}

#[derive(Debug)]
pub enum WallpaperEngineError {
    Library(WallpaperLibraryError),
    Journal(WallpaperJournalError),
    Ownership(OwnershipError),
    Platform(WallpaperPlatformError),
    RuntimeDisposed,
    InvalidBounds,
    Unavailable,
    SessionMismatch,
    StartSuperseded,
    CleanupRequired(String),
    PlatformContractInvalid,
}

impl WallpaperEngineError {
    pub fn code(&self) -> &str {
        match self {
            Self::Library(error) => error.code(),
            Self::Journal(error) => error.code(),
            Self::Ownership(error) => error.code(),
            Self::Platform(error) => error.code(),
            Self::RuntimeDisposed => "WALLPAPER_ENGINE_RUNTIME_DISPOSED",
            Self::InvalidBounds => "WALLPAPER_ENGINE_BOUNDS_INVALID",
            Self::Unavailable => "WALLPAPER_ENGINE_NOT_INSTALLED",
            Self::SessionMismatch => "WALLPAPER_ENGINE_SESSION_MISMATCH",
            Self::StartSuperseded => "WALLPAPER_ENGINE_START_SUPERSEDED",
            Self::CleanupRequired(_) => "WALLPAPER_ENGINE_CLEANUP_REQUIRED",
            Self::PlatformContractInvalid => "WALLPAPER_ENGINE_PLATFORM_CONTRACT_INVALID",
        }
    }
}

impl fmt::Display for WallpaperEngineError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}", self.code())
    }
}

impl std::error::Error for WallpaperEngineError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Library(source) => Some(source),
            Self::Journal(source) => Some(source),
            Self::Ownership(source) => Some(source),
            Self::Platform(source) => Some(source),
            _ => None,
        }
    }
}

impl From<WallpaperLibraryError> for WallpaperEngineError {
    fn from(source: WallpaperLibraryError) -> Self {
        Self::Library(source)
    }
}

impl From<WallpaperJournalError> for WallpaperEngineError {
    fn from(source: WallpaperJournalError) -> Self {
        Self::Journal(source)
    }
}

impl From<OwnershipError> for WallpaperEngineError {
    fn from(source: OwnershipError) -> Self {
        Self::Ownership(source)
    }
}

impl From<WallpaperPlatformError> for WallpaperEngineError {
    fn from(source: WallpaperPlatformError) -> Self {
        Self::Platform(source)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WallpaperStartResult {
    pub state: WallpaperRuntimeState,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WallpaperStopResult {
    pub stopped: bool,
    pub state: WallpaperRuntimeState,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WallpaperRecoveryResult {
    pub recovered: bool,
    pub state: WallpaperRuntimeState,
}

#[derive(Debug, Clone)]
struct ActiveScene {
    project_id: String,
    ownership: SceneOwnership,
    activation: Option<SceneActivation>,
}

#[derive(Debug, Clone)]
struct PendingScene {
    generation: u64,
    project_id: String,
    session_id: String,
}

pub struct WallpaperEngineRuntime {
    library: WallpaperLibrary,
    platform: Box<dyn WallpaperEnginePlatform>,
    journal_store: Box<dyn WallpaperRecoveryJournalStore>,
    active_journal: Option<WallpaperRecoveryJournal>,
    active_scene: Option<ActiveScene>,
    pending_scene: Option<PendingScene>,
    state: WallpaperRuntimeState,
    generation: u64,
    disposed: bool,
    accepting_intents: bool,
}

impl WallpaperEngineRuntime {
    pub fn new(
        library: WallpaperLibrary,
        journal_store: Box<dyn WallpaperRecoveryJournalStore>,
    ) -> Self {
        Self::with_platform(
            library,
            journal_store,
            Box::<UnsupportedWallpaperEnginePlatform>::default(),
        )
    }

    pub fn with_platform(
        library: WallpaperLibrary,
        journal_store: Box<dyn WallpaperRecoveryJournalStore>,
        platform: Box<dyn WallpaperEnginePlatform>,
    ) -> Self {
        Self {
            library,
            platform,
            journal_store,
            active_journal: None,
            active_scene: None,
            pending_scene: None,
            state: WallpaperRuntimeState::default(),
            generation: 0,
            disposed: false,
            accepting_intents: true,
        }
    }

    pub fn install_platform(
        &mut self,
        platform: Box<dyn WallpaperEnginePlatform>,
    ) -> Result<(), WallpaperEngineError> {
        if self.disposed {
            return Err(WallpaperEngineError::RuntimeDisposed);
        }
        if self.active_scene.is_some() || self.pending_scene.is_some() {
            return Err(WallpaperEngineError::CleanupRequired(
                "WALLPAPER_ENGINE_PLATFORM_REPLACE_BUSY".to_owned(),
            ));
        }
        self.platform = platform;
        self.probe(false)?;
        Ok(())
    }

    pub fn library(&self) -> &WallpaperLibrary {
        &self.library
    }

    pub fn library_mut(&mut self) -> &mut WallpaperLibrary {
        &mut self.library
    }

    pub fn status(&self) -> &WallpaperRuntimeState {
        &self.state
    }

    /// 刷新 active Scene 的实时 capture/mute health，并在同一 exact location 内安全
    /// 重绑已经换代的 HWND。该方法不扫描或接管其他 location。
    pub fn reconcile_capture_status(
        &mut self,
    ) -> Result<&WallpaperRuntimeState, WallpaperEngineError> {
        if self.pending_scene.is_some()
            || self.state.cleanup_required
            || self.state.phase != WallpaperRuntimePhase::Active
        {
            return Ok(&self.state);
        }
        let Some(active) = self.active_scene.clone() else {
            return Ok(&self.state);
        };
        let observation = match self.platform.observe_scene_capture(&active.ownership) {
            Ok(value) => value,
            Err(error) => {
                self.retain_active_for_cleanup(active, error.code())?;
                return Ok(&self.state);
            }
        };
        if validate_scene_replacement(&active.ownership, &observation.ownership).is_err() {
            self.retain_active_for_cleanup(active, "WALLPAPER_ENGINE_CAPTURE_OWNERSHIP_MISMATCH")?;
            return Ok(&self.state);
        }

        let ownership_changed = observation.ownership != active.ownership;
        if ownership_changed {
            let mut journal = self
                .active_journal
                .clone()
                .ok_or(WallpaperEngineError::PlatformContractInvalid)?;
            journal.mark_rebound(observation.ownership.clone())?;
            // crash consistency：必须先持久化 replacement identity，再让平台把 capture
            // 绑定到新 HWND generation。
            self.journal_store.write_before_mutation(&journal)?;
            self.active_journal = Some(journal);
            if let Some(current) = self.active_scene.as_mut() {
                current.ownership = observation.ownership.clone();
            }
        }

        let needs_rebind = ownership_changed
            || observation.rebind_required
            || !capture_activation_is_complete(&observation.activation);
        let activation = if needs_rebind {
            match self.platform.rebind_scene_capture(&observation.ownership) {
                Ok(value) => value,
                Err(error) => {
                    let current = self.active_scene.clone().unwrap_or(active);
                    self.retain_active_for_cleanup(current, error.code())?;
                    return Ok(&self.state);
                }
            }
        } else {
            observation.activation
        };
        if !capture_activation_is_complete(&activation) {
            let current = self.active_scene.clone().unwrap_or(active);
            self.retain_active_for_cleanup(current, "WALLPAPER_ENGINE_ACTIVATION_INCOMPLETE")?;
            return Ok(&self.state);
        }
        if let Some(current) = self.active_scene.as_mut() {
            current.activation = Some(activation.clone());
        }
        self.state.source_id = activation.source_id;
        self.state.capture_mode = WallpaperCaptureMode::DwmThumbnail;
        self.state.source_window_aligned = activation.source_window_aligned;
        self.state.dwm_surface_ready = activation.dwm_surface_ready;
        self.state.glass_sampler_ready = activation.glass_sampler_ready;
        self.state.audio_muted = activation.audio_muted;
        self.state.last_error = None;
        Ok(&self.state)
    }

    pub fn recovery_journal_version(&self) -> Option<u32> {
        self.active_journal.as_ref().map(|journal| journal.version)
    }

    pub fn recovery_phase(&self) -> Option<WallpaperRecoveryPhase> {
        self.active_journal.as_ref().map(|journal| journal.phase)
    }

    pub fn probe(&mut self, force: bool) -> Result<PlatformAvailability, WallpaperEngineError> {
        let availability = self.platform.probe(force)?;
        self.state.available = availability.available;
        if self.active_scene.is_none()
            && self.pending_scene.is_none()
            && !self.state.cleanup_required
        {
            self.state.phase = if availability.available {
                WallpaperRuntimePhase::Idle
            } else {
                WallpaperRuntimePhase::Unavailable
            };
        }
        if !availability.available {
            self.state.last_error = availability.reason.clone();
        } else if !self.state.cleanup_required {
            self.state.last_error = None;
        }
        Ok(availability)
    }

    pub fn list_projects(
        &mut self,
        force: bool,
    ) -> Result<WallpaperLibrarySnapshot, WallpaperEngineError> {
        let _ = self.probe(force)?;
        let sources = self.platform.discover_project_sources()?;
        self.library.scan(&sources, force).map_err(Into::into)
    }

    pub fn start_scene(
        &mut self,
        request: StartWallpaperSceneRequest,
    ) -> Result<WallpaperStartResult, WallpaperEngineError> {
        if self.disposed || !self.accepting_intents {
            return Err(WallpaperEngineError::RuntimeDisposed);
        }
        if request.physical_bounds.validated().is_none() {
            return Err(WallpaperEngineError::InvalidBounds);
        }
        if self.active_scene.is_none() {
            if let Some(journal) = self.journal_store.load()? {
                self.active_journal = Some(journal.clone());
                self.apply_cleanup_state(&journal, "WALLPAPER_ENGINE_RECOVERY_REQUIRED");
                return Err(WallpaperEngineError::CleanupRequired(
                    "WALLPAPER_ENGINE_RECOVERY_REQUIRED".to_owned(),
                ));
            }
        }
        let availability = self.probe(false)?;
        if !availability.available {
            return Err(WallpaperEngineError::Unavailable);
        }
        let target = self.library.native_scene_target(&request.project_id)?;
        self.generation = self.generation.wrapping_add(1).max(1);
        let generation = self.generation;
        let session_id = new_session_id()?;
        let location = scene_location(&session_id)?;
        self.pending_scene = Some(PendingScene {
            generation,
            project_id: request.project_id.clone(),
            session_id: session_id.clone(),
        });
        self.state.phase = WallpaperRuntimePhase::Starting;
        self.state.pending = true;
        self.state.generation = generation;
        self.state.project_id = request.project_id.clone();
        self.state.session_id = session_id.clone();
        self.state.last_error = None;

        let platform_request =
            platform_scene_request(generation, session_id, location, request, target);
        let prepared = match self.platform.prepare_scene(&platform_request) {
            Ok(value) => value,
            Err(error) => {
                self.clear_pending_to_idle(Some(error.code().to_owned()));
                return Err(error.into());
            }
        };
        if prepared.request != platform_request
            || !same_executable(&prepared.executable, &prepared.executable)
        {
            self.clear_pending_to_idle(Some(
                WallpaperEngineError::PlatformContractInvalid
                    .code()
                    .to_owned(),
            ));
            return Err(WallpaperEngineError::PlatformContractInvalid);
        }
        self.ensure_start_current(generation)?;

        if self.active_scene.is_some() {
            if let Err(error) = self.close_active_scene(false) {
                self.pending_scene = None;
                self.state.pending = false;
                if !self.state.cleanup_required {
                    if let Some(active) = self.active_scene.clone() {
                        self.retain_active_for_cleanup(active, error.code())?;
                    }
                }
                return Err(error);
            }
            self.ensure_start_current(generation)?;
        }

        let mut journal = WallpaperRecoveryJournal::opening(
            generation,
            &prepared.request.project_id,
            &prepared.request.session_id,
            prepared.executable.clone(),
        )?;
        if let Err(error) = self.journal_store.write_before_mutation(&journal) {
            self.clear_pending_to_idle(Some(error.code().to_owned()));
            return Err(error.into());
        }
        self.active_journal = Some(journal.clone());

        let ownership = match self.platform.open_scene_location(&prepared) {
            Ok(value) => value,
            Err(error) => {
                self.enter_cleanup_required(
                    journal,
                    None,
                    error.code(),
                    prepared.request.project_id.clone(),
                )?;
                return Err(WallpaperEngineError::CleanupRequired(
                    error.code().to_owned(),
                ));
            }
        };
        if validate_scene_ownership(&journal.expected, &ownership).is_err() {
            self.enter_cleanup_required(
                journal,
                None,
                "WALLPAPER_ENGINE_OWNERSHIP_MISMATCH",
                prepared.request.project_id.clone(),
            )?;
            return Err(WallpaperEngineError::CleanupRequired(
                "WALLPAPER_ENGINE_OWNERSHIP_MISMATCH".to_owned(),
            ));
        }
        journal.mark_active(ownership.clone())?;
        let opened_scene = ActiveScene {
            project_id: prepared.request.project_id.clone(),
            ownership: ownership.clone(),
            activation: None,
        };
        if let Err(error) = self.journal_store.write_before_mutation(&journal) {
            let reason = error.code().to_owned();
            self.enter_cleanup_required(
                journal,
                Some(opened_scene),
                &reason,
                prepared.request.project_id.clone(),
            )?;
            return Err(WallpaperEngineError::CleanupRequired(reason));
        }
        self.active_journal = Some(journal.clone());
        self.active_scene = Some(opened_scene);

        let activation = match self.platform.activate_scene(&prepared, &ownership) {
            Ok(value)
                if value.source_window_aligned && value.dwm_surface_ready && value.audio_muted =>
            {
                value
            }
            Ok(_) => {
                let error = WallpaperPlatformError::new("WALLPAPER_ENGINE_ACTIVATION_INCOMPLETE");
                self.close_active_scene(true)?;
                self.state.last_error = Some(error.code().to_owned());
                return Err(error.into());
            }
            Err(error) => {
                self.close_active_scene(true)?;
                self.state.last_error = Some(error.code().to_owned());
                return Err(error.into());
            }
        };
        self.ensure_start_current(generation)?;
        if let Some(active) = self.active_scene.as_mut() {
            active.activation = Some(activation.clone());
        }
        self.pending_scene = None;
        self.state = WallpaperRuntimeState {
            available: true,
            phase: WallpaperRuntimePhase::Active,
            pending: false,
            active: true,
            project_id: prepared.request.project_id,
            session_id: ownership.session_id,
            source_id: activation.source_id,
            capture_mode: WallpaperCaptureMode::DwmThumbnail,
            source_window_aligned: activation.source_window_aligned,
            dwm_surface_ready: activation.dwm_surface_ready,
            glass_sampler_ready: activation.glass_sampler_ready,
            audio_muted: activation.audio_muted,
            cleanup_required: false,
            full_desktop_mode: self.state.full_desktop_mode,
            generation,
            last_error: None,
        };
        Ok(WallpaperStartResult {
            state: self.state.clone(),
        })
    }

    pub fn stop_scene(
        &mut self,
        expected_session_id: Option<&str>,
    ) -> Result<WallpaperStopResult, WallpaperEngineError> {
        if let Some(expected) = expected_session_id.filter(|value| !value.is_empty()) {
            let matches = self
                .active_scene
                .as_ref()
                .is_some_and(|active| active.ownership.session_id == expected);
            if !matches {
                return Ok(WallpaperStopResult {
                    stopped: false,
                    state: self.state.clone(),
                    reason: Some(WallpaperEngineError::SessionMismatch.code().to_owned()),
                });
            }
        }
        if self.active_scene.is_none() {
            if self.active_journal.is_some() || self.state.cleanup_required {
                return Err(WallpaperEngineError::CleanupRequired(
                    "WALLPAPER_ENGINE_RECOVERY_REQUIRED".to_owned(),
                ));
            }
            self.pending_scene = None;
            self.state.pending = false;
            self.state.active = false;
            self.state.phase = if self.state.available {
                WallpaperRuntimePhase::Idle
            } else {
                WallpaperRuntimePhase::Unavailable
            };
            return Ok(WallpaperStopResult {
                stopped: true,
                state: self.state.clone(),
                reason: None,
            });
        }
        self.generation = self.generation.wrapping_add(1).max(1);
        self.state.generation = self.generation;
        self.close_active_scene(true)?;
        Ok(WallpaperStopResult {
            stopped: true,
            state: self.state.clone(),
            reason: None,
        })
    }

    pub fn recover(&mut self) -> Result<WallpaperRecoveryResult, WallpaperEngineError> {
        if self.active_scene.is_some() {
            if self.state.cleanup_required && self.pending_scene.is_none() {
                self.generation = self.generation.wrapping_add(1).max(1);
                self.state.generation = self.generation;
                self.close_active_scene(true)?;
                return Ok(WallpaperRecoveryResult {
                    recovered: true,
                    state: self.state.clone(),
                });
            }
            return Err(WallpaperEngineError::CleanupRequired(
                "WALLPAPER_ENGINE_RECOVERY_BUSY".to_owned(),
            ));
        }
        if self.pending_scene.is_some() {
            return Err(WallpaperEngineError::CleanupRequired(
                "WALLPAPER_ENGINE_RECOVERY_BUSY".to_owned(),
            ));
        }
        let Some(mut journal) = self.journal_store.load()? else {
            self.active_journal = None;
            self.state.cleanup_required = false;
            self.state.active = false;
            self.state.pending = false;
            self.state.phase = if self.state.available {
                WallpaperRuntimePhase::Idle
            } else {
                WallpaperRuntimePhase::Unavailable
            };
            return Ok(WallpaperRecoveryResult {
                recovered: false,
                state: self.state.clone(),
            });
        };
        self.active_journal = Some(journal.clone());
        self.apply_cleanup_state(&journal, "WALLPAPER_ENGINE_RECOVERY_REQUIRED");
        let confirmation = match self.platform.recover_scene_location(&journal) {
            Ok(value) => value,
            Err(error) => {
                journal.mark_cleanup_required(error.code());
                self.journal_store.write_before_mutation(&journal)?;
                self.active_journal = Some(journal);
                self.state.last_error = Some(error.code().to_owned());
                return Err(WallpaperEngineError::CleanupRequired(
                    error.code().to_owned(),
                ));
            }
        };
        if !recovery_confirmation_is_complete(&journal.expected, &confirmation) {
            journal.mark_cleanup_required("WALLPAPER_ENGINE_RECOVERY_OWNERSHIP_MISMATCH");
            self.journal_store.write_before_mutation(&journal)?;
            self.active_journal = Some(journal);
            self.state.last_error = Some("WALLPAPER_ENGINE_RECOVERY_OWNERSHIP_MISMATCH".to_owned());
            return Err(WallpaperEngineError::CleanupRequired(
                "WALLPAPER_ENGINE_RECOVERY_OWNERSHIP_MISMATCH".to_owned(),
            ));
        }
        self.journal_store.clear()?;
        self.active_journal = None;
        self.reset_inactive_state();
        Ok(WallpaperRecoveryResult {
            recovered: true,
            state: self.state.clone(),
        })
    }

    pub fn set_full_desktop_mode(
        &mut self,
        mode: WallpaperFullDesktopMode,
    ) -> Result<(), WallpaperEngineError> {
        self.platform.set_full_desktop_mode(mode)?;
        self.state.full_desktop_mode = mode;
        Ok(())
    }

    pub fn stop_accepting_intents(&mut self) {
        self.accepting_intents = false;
    }

    pub fn dispose(&mut self) -> Result<WallpaperStopResult, WallpaperEngineError> {
        self.accepting_intents = false;
        if self.disposed && self.active_scene.is_none() && !self.state.cleanup_required {
            return Ok(WallpaperStopResult {
                stopped: true,
                state: self.state.clone(),
                reason: None,
            });
        }
        let result = self.stop_scene(None);
        self.disposed = true;
        result
    }

    fn ensure_start_current(&self, generation: u64) -> Result<(), WallpaperEngineError> {
        let current = self.pending_scene.as_ref().is_some_and(|pending| {
            pending.generation == generation
                && pending.project_id == self.state.project_id
                && pending.session_id == self.state.session_id
        });
        if self.generation != generation || !current || self.disposed {
            return Err(WallpaperEngineError::StartSuperseded);
        }
        Ok(())
    }

    fn close_active_scene(&mut self, stopping: bool) -> Result<(), WallpaperEngineError> {
        let Some(active) = self.active_scene.clone() else {
            return Ok(());
        };
        if stopping {
            self.pending_scene = None;
        }
        self.state.phase = WallpaperRuntimePhase::Stopping;
        self.state.pending = false;
        let close_result = self.platform.close_scene_location(&active.ownership);
        let confirmation = match close_result {
            Ok(value) => value,
            Err(error) => {
                return self.fail_active_cleanup(active, error.code());
            }
        };
        if !location_close_is_exact(&active.ownership, &confirmation) {
            return self.fail_active_cleanup(active, "WALLPAPER_ENGINE_WINDOW_CLOSE_FAILED");
        }
        if let Err(error) = self.platform.deactivate_scene_resources(&active.ownership) {
            let reason = error.code().to_owned();
            return self.fail_active_cleanup(active, &reason);
        }
        if let Err(error) = self.journal_store.clear() {
            let reason = error.code().to_owned();
            return self.fail_active_cleanup(active, &reason);
        }
        self.active_journal = None;
        self.active_scene = None;
        if stopping {
            self.pending_scene = None;
        }
        self.reset_inactive_state();
        if !stopping {
            if let Some(pending) = &self.pending_scene {
                self.state.phase = WallpaperRuntimePhase::Starting;
                self.state.pending = true;
                self.state.project_id = pending.project_id.clone();
                self.state.session_id = pending.session_id.clone();
                self.state.generation = pending.generation;
            }
        }
        Ok(())
    }

    fn fail_active_cleanup<T>(
        &mut self,
        active: ActiveScene,
        reason: &str,
    ) -> Result<T, WallpaperEngineError> {
        self.retain_active_for_cleanup(active, reason)?;
        Err(WallpaperEngineError::CleanupRequired(reason.to_owned()))
    }

    fn retain_active_for_cleanup(
        &mut self,
        active: ActiveScene,
        reason: &str,
    ) -> Result<(), WallpaperEngineError> {
        let mut journal = self
            .active_journal
            .clone()
            .unwrap_or_else(|| WallpaperRecoveryJournal {
                version: journal::WALLPAPER_RECOVERY_JOURNAL_VERSION,
                generation: self.generation,
                project_id: active.project_id.clone(),
                session_id: active.ownership.session_id.clone(),
                location: active.ownership.location.clone(),
                phase: WallpaperRecoveryPhase::Active,
                expected: active.ownership.clone(),
                last_error: None,
                updated_at: 0,
            });
        journal.mark_cleanup_required(reason);
        self.active_journal = Some(journal.clone());
        self.active_scene = Some(active);
        self.pending_scene = None;
        self.apply_cleanup_state(&journal, reason);
        self.journal_store.write_before_mutation(&journal)?;
        Ok(())
    }

    fn enter_cleanup_required(
        &mut self,
        mut journal: WallpaperRecoveryJournal,
        active: Option<ActiveScene>,
        reason: &str,
        project_id: String,
    ) -> Result<(), WallpaperEngineError> {
        journal.mark_cleanup_required(reason);
        self.active_journal = Some(journal.clone());
        self.active_scene = active;
        self.pending_scene = None;
        self.apply_cleanup_state(&journal, reason);
        self.state.project_id = project_id;
        // 外部 mutation 已发生时，先让当前进程拥有可恢复状态；持久化失败仍保留此前
        // Opening/Active journal，下一次启动可按唯一 location fail-closed 清理。
        self.journal_store.write_before_mutation(&journal)?;
        Ok(())
    }

    fn apply_cleanup_state(&mut self, journal: &WallpaperRecoveryJournal, reason: &str) {
        self.state.phase = WallpaperRuntimePhase::CleanupRequired;
        self.state.pending = false;
        self.state.active = self.active_scene.is_some();
        self.state.project_id = journal.project_id.clone();
        self.state.session_id = journal.session_id.clone();
        self.state.cleanup_required = true;
        self.state.last_error = Some(reason.to_owned());
        self.state.capture_mode = WallpaperCaptureMode::None;
        self.state.source_window_aligned = false;
        self.state.dwm_surface_ready = false;
        self.state.glass_sampler_ready = false;
        self.state.audio_muted = false;
    }

    fn clear_pending_to_idle(&mut self, error: Option<String>) {
        self.pending_scene = None;
        self.state.pending = false;
        self.state.active = self.active_scene.is_some();
        if let Some(active) = &self.active_scene {
            self.state.phase = WallpaperRuntimePhase::Active;
            self.state.project_id = active.project_id.clone();
            self.state.session_id = active.ownership.session_id.clone();
            self.state.cleanup_required = false;
            if let Some(activation) = &active.activation {
                self.state.source_id = activation.source_id.clone();
                self.state.capture_mode = WallpaperCaptureMode::DwmThumbnail;
                self.state.source_window_aligned = activation.source_window_aligned;
                self.state.dwm_surface_ready = activation.dwm_surface_ready;
                self.state.glass_sampler_ready = activation.glass_sampler_ready;
                self.state.audio_muted = activation.audio_muted;
            } else {
                self.state.source_id.clear();
                self.state.capture_mode = WallpaperCaptureMode::None;
                self.state.source_window_aligned = false;
                self.state.dwm_surface_ready = false;
                self.state.glass_sampler_ready = false;
                self.state.audio_muted = false;
            }
        } else if self.state.available {
            self.state.phase = WallpaperRuntimePhase::Idle;
            self.state.project_id.clear();
            self.state.session_id.clear();
        } else {
            self.state.phase = WallpaperRuntimePhase::Unavailable;
            self.state.project_id.clear();
            self.state.session_id.clear();
        }
        self.state.last_error = error;
    }

    fn reset_inactive_state(&mut self) {
        let full_desktop_mode = self.state.full_desktop_mode;
        let available = self.state.available;
        self.state = WallpaperRuntimeState {
            available,
            phase: if available {
                WallpaperRuntimePhase::Idle
            } else {
                WallpaperRuntimePhase::Unavailable
            },
            full_desktop_mode,
            generation: self.generation,
            ..WallpaperRuntimeState::default()
        };
    }
}

fn capture_activation_is_complete(activation: &SceneActivation) -> bool {
    activation.source_window_aligned && activation.dwm_surface_ready && activation.audio_muted
}

fn platform_scene_request(
    generation: u64,
    session_id: String,
    location: String,
    request: StartWallpaperSceneRequest,
    target: NativeSceneTarget,
) -> PlatformSceneRequest {
    PlatformSceneRequest {
        generation,
        project_id: request.project_id,
        session_id,
        location,
        project_file: target.project_file,
        scene_package: target.scene_package,
        mute_properties: target.mute_properties,
        physical_bounds: request.physical_bounds,
        fps: request.fps.unwrap_or(60).clamp(15, 240),
    }
}

fn location_close_is_exact(
    expected: &SceneOwnership,
    confirmation: &SceneCloseConfirmation,
) -> bool {
    confirmation.location_closed
        && confirmation
            .observed
            .as_ref()
            .is_some_and(|observed| validate_scene_ownership(expected, observed).is_ok())
}

fn recovery_confirmation_is_complete(
    expected: &SceneOwnership,
    confirmation: &SceneCloseConfirmation,
) -> bool {
    confirmation.resources_released
        && confirmation.location_closed
        && ((confirmation.source_absence_confirmed && confirmation.observed.is_none())
            || location_close_is_exact(expected, confirmation))
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::PathBuf,
        sync::{Arc, Mutex},
        time::SystemTime,
    };

    use super::{
        journal::{WallpaperJournalError, WallpaperRecoveryJournal, WallpaperRecoveryJournalStore},
        library::WallpaperLibrary,
        ownership::{ExecutableIdentity, SceneOwnership, WindowIdentity},
        policy::PhysicalRect,
        project::ProjectSource,
        recovery_confirmation_is_complete, PlatformAvailability, PlatformSceneRequest,
        PreparedScene, SceneActivation, SceneCaptureObservation, SceneCloseConfirmation,
        StartWallpaperSceneRequest, WallpaperEnginePlatform, WallpaperEngineRuntime,
        WallpaperPlatformError,
    };

    #[derive(Default)]
    struct MemoryJournal {
        value: Option<WallpaperRecoveryJournal>,
        write_count: usize,
        fail_write_at: Option<usize>,
        fail_clear: bool,
    }

    impl MemoryJournal {
        fn fail_on_write(write_number: usize) -> Self {
            Self {
                value: None,
                write_count: 0,
                fail_write_at: Some(write_number),
                fail_clear: false,
            }
        }

        fn fail_on_clear() -> Self {
            Self {
                value: None,
                write_count: 0,
                fail_write_at: None,
                fail_clear: true,
            }
        }
    }

    impl WallpaperRecoveryJournalStore for Arc<Mutex<MemoryJournal>> {
        fn load(&mut self) -> Result<Option<WallpaperRecoveryJournal>, WallpaperJournalError> {
            Ok(self.lock().expect("journal 锁应可用").value.clone())
        }

        fn write_before_mutation(
            &mut self,
            journal: &WallpaperRecoveryJournal,
        ) -> Result<(), WallpaperJournalError> {
            let mut store = self.lock().expect("journal 锁应可用");
            store.write_count += 1;
            if store.fail_write_at == Some(store.write_count) {
                return Err(std::io::Error::other("fixture journal write failure").into());
            }
            store.value = Some(journal.clone());
            Ok(())
        }

        fn clear(&mut self) -> Result<(), WallpaperJournalError> {
            let mut store = self.lock().expect("journal 锁应可用");
            if store.fail_clear {
                store.fail_clear = false;
                return Err(std::io::Error::other("fixture journal clear failure").into());
            }
            store.value = None;
            Ok(())
        }
    }

    fn test_path(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "mineradio-m7-runtime-{label}-{}-{}-library.json",
            std::process::id(),
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .expect("系统时间应有效")
                .as_nanos()
        ))
    }

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new(label: &str) -> Self {
            let path = test_path(label).with_extension("fixture");
            fs::create_dir_all(&path).expect("应创建 runtime fixture");
            Self(path)
        }

        fn add_scene(&self, name: &str) -> PathBuf {
            let root = self.0.join(name);
            fs::create_dir_all(&root).expect("应创建 Scene 目录");
            fs::write(root.join("scene.pkg"), b"PKGV0001payload").expect("应写入 Scene 包");
            fs::write(
                root.join("project.json"),
                format!(r#"{{"title":"{name}","type":"scene","file":"scene.pkg"}}"#),
            )
            .expect("应写入 Scene manifest");
            root
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[derive(Default)]
    struct FakeCapture {
        retired: bool,
        replacement_handle: Option<u64>,
        rebind_error: bool,
        active_ownership: Option<SceneOwnership>,
    }

    struct FakePlatform {
        events: Arc<Mutex<Vec<String>>>,
        capture: Arc<Mutex<FakeCapture>>,
        next_handle: u64,
        close_failures_remaining: usize,
        ownership_mismatch: bool,
        recovery_absence_confirmed: bool,
        prepare_failure_project: Option<String>,
        activation_failure_project: Option<String>,
    }

    impl FakePlatform {
        fn new(events: Arc<Mutex<Vec<String>>>) -> Self {
            Self {
                events,
                capture: Arc::new(Mutex::new(FakeCapture::default())),
                next_handle: 100,
                close_failures_remaining: 0,
                ownership_mismatch: false,
                recovery_absence_confirmed: false,
                prepare_failure_project: None,
                activation_failure_project: None,
            }
        }

        fn with_close_failure(events: Arc<Mutex<Vec<String>>>) -> Self {
            Self {
                events,
                capture: Arc::new(Mutex::new(FakeCapture::default())),
                next_handle: 100,
                close_failures_remaining: 1,
                ownership_mismatch: false,
                recovery_absence_confirmed: false,
                prepare_failure_project: None,
                activation_failure_project: None,
            }
        }

        fn with_ownership_mismatch(events: Arc<Mutex<Vec<String>>>) -> Self {
            Self {
                events,
                capture: Arc::new(Mutex::new(FakeCapture::default())),
                next_handle: 100,
                close_failures_remaining: 0,
                ownership_mismatch: true,
                recovery_absence_confirmed: false,
                prepare_failure_project: None,
                activation_failure_project: None,
            }
        }

        fn with_capture(events: Arc<Mutex<Vec<String>>>, capture: Arc<Mutex<FakeCapture>>) -> Self {
            Self {
                events,
                capture,
                next_handle: 100,
                close_failures_remaining: 0,
                ownership_mismatch: false,
                recovery_absence_confirmed: false,
                prepare_failure_project: None,
                activation_failure_project: None,
            }
        }

        fn with_recovery_absence(events: Arc<Mutex<Vec<String>>>) -> Self {
            Self {
                events,
                capture: Arc::new(Mutex::new(FakeCapture::default())),
                next_handle: 100,
                close_failures_remaining: 0,
                ownership_mismatch: false,
                recovery_absence_confirmed: true,
                prepare_failure_project: None,
                activation_failure_project: None,
            }
        }

        fn with_prepare_failure_for(events: Arc<Mutex<Vec<String>>>, project_id: String) -> Self {
            Self {
                events,
                capture: Arc::new(Mutex::new(FakeCapture::default())),
                next_handle: 100,
                close_failures_remaining: 0,
                ownership_mismatch: false,
                recovery_absence_confirmed: false,
                prepare_failure_project: Some(project_id),
                activation_failure_project: None,
            }
        }

        fn with_activation_failure_for(
            events: Arc<Mutex<Vec<String>>>,
            project_id: String,
        ) -> Self {
            Self {
                events,
                capture: Arc::new(Mutex::new(FakeCapture::default())),
                next_handle: 100,
                close_failures_remaining: 0,
                ownership_mismatch: false,
                recovery_absence_confirmed: false,
                prepare_failure_project: None,
                activation_failure_project: Some(project_id),
            }
        }

        fn executable() -> ExecutableIdentity {
            ExecutableIdentity {
                canonical_path: PathBuf::from(r"C:\Steam\wallpaper64.exe"),
                file_size: 42,
                modified_unix_millis: 8,
            }
        }

        fn note(&self, value: impl Into<String>) {
            self.events
                .lock()
                .expect("events 锁应可用")
                .push(value.into());
        }
    }

    impl WallpaperEnginePlatform for FakePlatform {
        fn probe(&mut self, _force: bool) -> Result<PlatformAvailability, WallpaperPlatformError> {
            Ok(PlatformAvailability {
                available: true,
                executable_name: Some("wallpaper64.exe".to_owned()),
                reason: None,
            })
        }

        fn discover_project_sources(
            &mut self,
        ) -> Result<Vec<ProjectSource>, WallpaperPlatformError> {
            Ok(Vec::new())
        }

        fn prepare_scene(
            &mut self,
            request: &PlatformSceneRequest,
        ) -> Result<PreparedScene, WallpaperPlatformError> {
            self.note(format!("prepare:{}", request.project_id));
            if self.prepare_failure_project.as_deref() == Some(request.project_id.as_str()) {
                return Err(WallpaperPlatformError::new(
                    "WALLPAPER_ENGINE_PREPARE_FAILED",
                ));
            }
            Ok(PreparedScene {
                request: request.clone(),
                executable: Self::executable(),
            })
        }

        fn open_scene_location(
            &mut self,
            prepared: &PreparedScene,
        ) -> Result<SceneOwnership, WallpaperPlatformError> {
            self.note(format!("open:{}", prepared.request.project_id));
            self.next_handle += 1;
            let executable = prepared.executable.clone();
            let mut ownership = SceneOwnership {
                session_id: prepared.request.session_id.clone(),
                location: prepared.request.location.clone(),
                executable: executable.clone(),
                window: Some(WindowIdentity {
                    handle: self.next_handle,
                    process_id: 50,
                    process_created_unix_millis: 900,
                    executable,
                    title: prepared.request.location.clone(),
                }),
                launched_process: None,
            };
            if self.ownership_mismatch {
                ownership
                    .window
                    .as_mut()
                    .expect("fake 应有 window")
                    .executable
                    .file_size += 1;
            }
            self.capture
                .lock()
                .expect("capture 锁应可用")
                .active_ownership = Some(ownership.clone());
            Ok(ownership)
        }

        fn activate_scene(
            &mut self,
            prepared: &PreparedScene,
            _ownership: &SceneOwnership,
        ) -> Result<SceneActivation, WallpaperPlatformError> {
            self.note(format!("activate:{}", prepared.request.project_id));
            if self.activation_failure_project.as_deref()
                == Some(prepared.request.project_id.as_str())
            {
                return Err(WallpaperPlatformError::new(
                    "WALLPAPER_ENGINE_ACTIVATION_FAILED",
                ));
            }
            Ok(SceneActivation {
                source_id: format!("window:{}:0", self.next_handle),
                source_window_aligned: true,
                dwm_surface_ready: true,
                glass_sampler_ready: false,
                audio_muted: true,
            })
        }

        fn observe_scene_capture(
            &mut self,
            ownership: &SceneOwnership,
        ) -> Result<SceneCaptureObservation, WallpaperPlatformError> {
            let capture = self.capture.lock().expect("capture 锁应可用");
            let mut observed = ownership.clone();
            if let Some(handle) = capture.replacement_handle {
                let window = observed.window.as_mut().expect("active Scene 应有 window");
                window.handle = handle;
                window.process_id += 1;
                window.process_created_unix_millis += 1;
            }
            let healthy = !capture.retired && capture.replacement_handle.is_none();
            Ok(SceneCaptureObservation {
                ownership: observed.clone(),
                activation: SceneActivation {
                    source_id: observed
                        .window
                        .as_ref()
                        .map(|window| format!("window:{}:0", window.handle))
                        .unwrap_or_default(),
                    source_window_aligned: healthy,
                    dwm_surface_ready: healthy,
                    glass_sampler_ready: false,
                    audio_muted: healthy,
                },
                rebind_required: !healthy,
            })
        }

        fn rebind_scene_capture(
            &mut self,
            ownership: &SceneOwnership,
        ) -> Result<SceneActivation, WallpaperPlatformError> {
            self.note(format!("rebind:{}", ownership.session_id));
            let mut capture = self.capture.lock().expect("capture 锁应可用");
            capture.active_ownership = Some(ownership.clone());
            if capture.rebind_error {
                return Err(WallpaperPlatformError::new(
                    "WALLPAPER_ENGINE_DWM_REBIND_FAILED",
                ));
            }
            capture.retired = false;
            capture.replacement_handle = None;
            Ok(SceneActivation {
                source_id: ownership
                    .window
                    .as_ref()
                    .map(|window| format!("window:{}:0", window.handle))
                    .unwrap_or_default(),
                source_window_aligned: true,
                dwm_surface_ready: true,
                glass_sampler_ready: false,
                audio_muted: true,
            })
        }

        fn deactivate_scene_resources(
            &mut self,
            ownership: &SceneOwnership,
        ) -> Result<(), WallpaperPlatformError> {
            self.note(format!("deactivate:{}", ownership.session_id));
            Ok(())
        }

        fn close_scene_location(
            &mut self,
            ownership: &SceneOwnership,
        ) -> Result<SceneCloseConfirmation, WallpaperPlatformError> {
            if self
                .capture
                .lock()
                .expect("capture 锁应可用")
                .active_ownership
                .as_ref()
                != Some(ownership)
            {
                return Err(WallpaperPlatformError::new(
                    "WALLPAPER_ENGINE_OWNERSHIP_MISMATCH",
                ));
            }
            self.note(format!("close:{}", ownership.session_id));
            if let Some(window) = &ownership.window {
                self.note(format!("close-window:{}", window.handle));
            }
            let location_closed = self.close_failures_remaining == 0;
            self.close_failures_remaining = self.close_failures_remaining.saturating_sub(1);
            Ok(SceneCloseConfirmation {
                observed: Some(ownership.clone()),
                location_closed,
                resources_released: true,
                source_absence_confirmed: false,
            })
        }

        fn recover_scene_location(
            &mut self,
            journal: &WallpaperRecoveryJournal,
        ) -> Result<SceneCloseConfirmation, WallpaperPlatformError> {
            self.note(format!("recover:{}", journal.session_id));
            if self.recovery_absence_confirmed {
                return Ok(SceneCloseConfirmation {
                    observed: None,
                    location_closed: true,
                    resources_released: true,
                    source_absence_confirmed: true,
                });
            }
            let mut observed = journal.expected.clone();
            if observed.window.is_none() {
                let executable = observed.executable.clone();
                observed.window = Some(WindowIdentity {
                    handle: 999,
                    process_id: 50,
                    process_created_unix_millis: 900,
                    executable,
                    title: observed.location.clone(),
                });
            }
            Ok(SceneCloseConfirmation {
                observed: Some(observed),
                location_closed: true,
                resources_released: true,
                source_absence_confirmed: false,
            })
        }

        fn set_full_desktop_mode(
            &mut self,
            mode: super::WallpaperFullDesktopMode,
        ) -> Result<(), WallpaperPlatformError> {
            self.note(format!("desktop:{mode:?}"));
            Ok(())
        }
    }

    fn scene_request(project_id: String) -> StartWallpaperSceneRequest {
        StartWallpaperSceneRequest {
            project_id,
            fps: Some(60),
            physical_bounds: PhysicalRect {
                x: 0,
                y: 0,
                width: 1_280,
                height: 720,
            },
        }
    }

    #[test]
    fn idle_dispose_is_idempotent_success() {
        let library = WallpaperLibrary::open(test_path("idle-dispose")).expect("应创建库");
        let journal = Arc::new(Mutex::new(MemoryJournal::default()));
        let mut runtime = WallpaperEngineRuntime::new(library, Box::new(journal));

        let first = runtime.dispose().expect("首次 idle dispose 应成功");
        let second = runtime.dispose().expect("重复 dispose 应成功");
        assert!(first.stopped);
        assert!(second.stopped);
        assert!(!first.state.active);
        assert!(!second.state.cleanup_required);
    }

    #[test]
    fn opening_recovery_accepts_a_verified_missing_source_without_fabricating_hwnd() {
        let session_id = "b".repeat(24);
        let expected = SceneOwnership {
            session_id: session_id.clone(),
            location: format!("Mineradio Wallpaper {session_id}"),
            executable: FakePlatform::executable(),
            window: None,
            launched_process: None,
        };
        let confirmation = SceneCloseConfirmation {
            observed: None,
            location_closed: true,
            resources_released: true,
            source_absence_confirmed: true,
        };
        assert!(recovery_confirmation_is_complete(&expected, &confirmation));

        let mut active_expected = expected.clone();
        active_expected.window = Some(WindowIdentity {
            handle: 8,
            process_id: 9,
            process_created_unix_millis: 10,
            executable: active_expected.executable.clone(),
            title: active_expected.location.clone(),
        });
        assert!(recovery_confirmation_is_complete(
            &active_expected,
            &confirmation,
        ));
    }

    #[test]
    fn startup_recovery_clears_an_active_journal_after_bounded_location_absence() {
        let directory = TestDirectory::new("active-recovery-absence");
        let root = directory.add_scene("missing");
        let config = directory.0.join("library.json");
        let mut library = WallpaperLibrary::open(config.clone()).expect("应打开库");
        library.add_manual_root(&root).expect("应导入 Scene");
        let id = library.scan(&[], true).expect("应扫描 Scene").projects[0]
            .id
            .clone();
        let journal = Arc::new(Mutex::new(MemoryJournal::default()));
        let events = Arc::new(Mutex::new(Vec::new()));
        let mut runtime = WallpaperEngineRuntime::with_platform(
            library,
            Box::new(Arc::clone(&journal)),
            Box::new(FakePlatform::new(Arc::clone(&events))),
        );
        runtime
            .start_scene(scene_request(id))
            .expect("Scene 应启动并写入 Active journal");
        assert!(journal
            .lock()
            .expect("journal 锁应可用")
            .value
            .as_ref()
            .and_then(|value| value.expected.window.as_ref())
            .is_some());
        drop(runtime);

        let library = WallpaperLibrary::open(config).expect("下次启动应重开库");
        let mut recovered_runtime = WallpaperEngineRuntime::with_platform(
            library,
            Box::new(Arc::clone(&journal)),
            Box::new(FakePlatform::with_recovery_absence(Arc::clone(&events))),
        );
        let recovered = recovered_runtime
            .recover()
            .expect("bounded exact-location absence 应完成恢复");

        assert!(recovered.recovered);
        assert!(!recovered.state.active);
        assert!(!recovered.state.cleanup_required);
        assert!(journal.lock().expect("journal 锁应可用").value.is_none());
    }

    #[test]
    fn replacement_closes_old_exact_location_before_opening_new_one() {
        let directory = TestDirectory::new("switch");
        let first_root = directory.add_scene("first");
        let second_root = directory.add_scene("second");
        let config = directory.0.join("library.json");
        let mut library = WallpaperLibrary::open(config).expect("应打开库");
        library
            .add_manual_root(&first_root)
            .expect("应导入第一个 Scene");
        library
            .add_manual_root(&second_root)
            .expect("应导入第二个 Scene");
        let snapshot = library.scan(&[], true).expect("应扫描 Scene");
        let first_id = snapshot
            .projects
            .iter()
            .find(|project| project.title == "first")
            .expect("应有 first")
            .id
            .clone();
        let second_id = snapshot
            .projects
            .iter()
            .find(|project| project.title == "second")
            .expect("应有 second")
            .id
            .clone();
        let events = Arc::new(Mutex::new(Vec::new()));
        let journal = Arc::new(Mutex::new(MemoryJournal::default()));
        let mut runtime = WallpaperEngineRuntime::with_platform(
            library,
            Box::new(journal),
            Box::new(FakePlatform::new(Arc::clone(&events))),
        );

        let first = runtime
            .start_scene(scene_request(first_id))
            .expect("首个 Scene 应启动");
        let second = runtime
            .start_scene(scene_request(second_id.clone()))
            .expect("替换 Scene 应启动");
        assert_ne!(first.state.session_id, second.state.session_id);
        assert_eq!(second.state.project_id, second_id);

        let events = events.lock().expect("events 锁应可用");
        let first_close = events
            .iter()
            .position(|event| event == &format!("close:{}", first.state.session_id))
            .expect("应关闭旧 location");
        let second_open = events
            .iter()
            .position(|event| event == &format!("open:{}", second_id))
            .expect("应打开新 location");
        assert!(first_close < second_open, "旧 location 必须先确认关闭");
    }

    #[test]
    fn failed_replacement_prepare_preserves_the_observable_active_scene() {
        let directory = TestDirectory::new("prepare-failure-preserves-active");
        let first_root = directory.add_scene("first");
        let second_root = directory.add_scene("second");
        let mut library =
            WallpaperLibrary::open(directory.0.join("library.json")).expect("应打开库");
        library.add_manual_root(&first_root).expect("应导入 first");
        library
            .add_manual_root(&second_root)
            .expect("应导入 second");
        let snapshot = library.scan(&[], true).expect("应扫描 Scene");
        let first_id = snapshot
            .projects
            .iter()
            .find(|project| project.title == "first")
            .expect("应找到 first")
            .id
            .clone();
        let second_id = snapshot
            .projects
            .iter()
            .find(|project| project.title == "second")
            .expect("应找到 second")
            .id
            .clone();
        let journal = Arc::new(Mutex::new(MemoryJournal::default()));
        let events = Arc::new(Mutex::new(Vec::new()));
        let mut runtime = WallpaperEngineRuntime::with_platform(
            library,
            Box::new(journal),
            Box::new(FakePlatform::with_prepare_failure_for(
                Arc::clone(&events),
                second_id.clone(),
            )),
        );
        let active = runtime
            .start_scene(scene_request(first_id.clone()))
            .expect("first Scene 应启动")
            .state;

        runtime
            .start_scene(scene_request(second_id))
            .expect_err("second prepare 应失败");
        let restored = runtime.status();

        assert!(restored.active);
        assert!(!restored.pending);
        assert_eq!(restored.phase, super::WallpaperRuntimePhase::Active);
        assert_eq!(restored.project_id, first_id);
        assert_eq!(restored.session_id, active.session_id);
        assert_eq!(restored.source_id, active.source_id);
        assert!(restored.source_window_aligned);
        assert!(restored.dwm_surface_ready);
        assert!(restored.audio_muted);
    }

    #[test]
    fn activation_failure_closes_the_new_scene_and_leaves_recovery_available() {
        let directory = TestDirectory::new("activation-failure-clears-pending");
        let root = directory.add_scene("activation-fails");
        let mut library =
            WallpaperLibrary::open(directory.0.join("library.json")).expect("应打开库");
        library.add_manual_root(&root).expect("应导入 Scene");
        let id = library.scan(&[], true).expect("应扫描 Scene").projects[0]
            .id
            .clone();
        let journal = Arc::new(Mutex::new(MemoryJournal::default()));
        let events = Arc::new(Mutex::new(Vec::new()));
        let mut runtime = WallpaperEngineRuntime::with_platform(
            library,
            Box::new(Arc::clone(&journal)),
            Box::new(FakePlatform::with_activation_failure_for(
                Arc::clone(&events),
                id.clone(),
            )),
        );

        runtime
            .start_scene(scene_request(id))
            .expect_err("activation 应失败");
        let failed = runtime.status().clone();
        assert!(!failed.pending);
        assert!(!failed.active);
        assert!(!failed.cleanup_required);
        assert_eq!(failed.phase, super::WallpaperRuntimePhase::Idle);
        assert!(journal.lock().expect("journal 锁应可用").value.is_none());

        let recovered = runtime.recover().expect("失败后的显式 recovery 不应 busy");
        assert!(!recovered.recovered);
        assert!(!recovered.state.pending);
    }

    #[test]
    fn replacement_close_failure_cancels_pending_and_allows_exact_recovery_retry() {
        let directory = TestDirectory::new("replacement-close-recovery");
        let first_root = directory.add_scene("first");
        let second_root = directory.add_scene("second");
        let mut library =
            WallpaperLibrary::open(directory.0.join("library.json")).expect("应打开库");
        library.add_manual_root(&first_root).expect("应导入 first");
        library
            .add_manual_root(&second_root)
            .expect("应导入 second");
        let snapshot = library.scan(&[], true).expect("应扫描 Scene");
        let first_id = snapshot
            .projects
            .iter()
            .find(|project| project.title == "first")
            .expect("应找到 first")
            .id
            .clone();
        let second_id = snapshot
            .projects
            .iter()
            .find(|project| project.title == "second")
            .expect("应找到 second")
            .id
            .clone();
        let journal = Arc::new(Mutex::new(MemoryJournal::default()));
        let events = Arc::new(Mutex::new(Vec::new()));
        let mut runtime = WallpaperEngineRuntime::with_platform(
            library,
            Box::new(Arc::clone(&journal)),
            Box::new(FakePlatform::with_close_failure(Arc::clone(&events))),
        );
        let active = runtime
            .start_scene(scene_request(first_id.clone()))
            .expect("first Scene 应启动")
            .state;

        runtime
            .start_scene(scene_request(second_id))
            .expect_err("old exact Scene 首次 close 应失败");
        let failed = runtime.status().clone();
        assert!(failed.active);
        assert!(failed.cleanup_required);
        assert!(!failed.pending, "失败的 replacement intent 必须取消");
        assert_eq!(failed.project_id, first_id);
        assert_eq!(failed.session_id, active.session_id);

        let recovered = runtime.recover().expect("应重试 old exact Scene cleanup");
        assert!(recovered.recovered);
        assert!(!recovered.state.active);
        assert!(!recovered.state.pending);
        assert!(!recovered.state.cleanup_required);
        assert!(journal.lock().expect("journal 锁应可用").value.is_none());
    }

    #[test]
    fn opening_journal_write_failure_aborts_pending_before_platform_mutation() {
        let directory = TestDirectory::new("opening-journal-write-failure");
        let root = directory.add_scene("opening-write-fails");
        let mut library =
            WallpaperLibrary::open(directory.0.join("library.json")).expect("应打开库");
        library.add_manual_root(&root).expect("应导入 Scene");
        let id = library.scan(&[], true).expect("应扫描 Scene").projects[0]
            .id
            .clone();
        let journal = Arc::new(Mutex::new(MemoryJournal::fail_on_write(1)));
        let events = Arc::new(Mutex::new(Vec::new()));
        let mut runtime = WallpaperEngineRuntime::with_platform(
            library,
            Box::new(Arc::clone(&journal)),
            Box::new(FakePlatform::new(Arc::clone(&events))),
        );

        runtime
            .start_scene(scene_request(id))
            .expect_err("Opening journal write 应失败");
        let failed = runtime.status().clone();
        assert!(!failed.pending);
        assert!(!failed.active);
        assert!(!failed.cleanup_required);
        assert_eq!(failed.phase, super::WallpaperRuntimePhase::Idle);
        assert!(!events
            .lock()
            .expect("events 锁应可用")
            .iter()
            .any(|event| event.starts_with("open:")));
        assert!(
            !runtime
                .recover()
                .expect("失败后不应 recovery busy")
                .recovered
        );
    }

    #[test]
    fn active_journal_write_failure_retains_exact_ownership_for_explicit_recovery() {
        let directory = TestDirectory::new("active-journal-write-failure");
        let root = directory.add_scene("active-write-fails");
        let mut library =
            WallpaperLibrary::open(directory.0.join("library.json")).expect("应打开库");
        library.add_manual_root(&root).expect("应导入 Scene");
        let id = library.scan(&[], true).expect("应扫描 Scene").projects[0]
            .id
            .clone();
        let journal = Arc::new(Mutex::new(MemoryJournal::fail_on_write(2)));
        let events = Arc::new(Mutex::new(Vec::new()));
        let mut runtime = WallpaperEngineRuntime::with_platform(
            library,
            Box::new(Arc::clone(&journal)),
            Box::new(FakePlatform::new(Arc::clone(&events))),
        );

        runtime
            .start_scene(scene_request(id))
            .expect_err("Active journal write 应失败");
        let failed = runtime.status().clone();
        assert!(
            failed.active,
            "已打开的 exact Scene 必须保留 cleanup ownership"
        );
        assert!(failed.cleanup_required);
        assert!(!failed.pending);
        assert_eq!(failed.phase, super::WallpaperRuntimePhase::CleanupRequired);
        assert!(journal
            .lock()
            .expect("journal 锁应可用")
            .value
            .as_ref()
            .and_then(|value| value.expected.window.as_ref())
            .is_some());

        let recovered = runtime.recover().expect("显式 recovery 应关闭 exact Scene");
        assert!(recovered.recovered);
        assert!(!recovered.state.active);
        assert!(!recovered.state.cleanup_required);
    }

    #[test]
    fn cleanup_journal_write_failure_still_exposes_retryable_active_ownership() {
        let directory = TestDirectory::new("cleanup-journal-write-failure");
        let root = directory.add_scene("cleanup-write-fails");
        let mut library =
            WallpaperLibrary::open(directory.0.join("library.json")).expect("应打开库");
        library.add_manual_root(&root).expect("应导入 Scene");
        let id = library.scan(&[], true).expect("应扫描 Scene").projects[0]
            .id
            .clone();
        let journal = Arc::new(Mutex::new(MemoryJournal::fail_on_write(3)));
        let events = Arc::new(Mutex::new(Vec::new()));
        let mut runtime = WallpaperEngineRuntime::with_platform(
            library,
            Box::new(Arc::clone(&journal)),
            Box::new(FakePlatform::with_close_failure(Arc::clone(&events))),
        );
        let active = runtime
            .start_scene(scene_request(id))
            .expect("Scene 应启动")
            .state;

        runtime
            .stop_scene(Some(&active.session_id))
            .expect_err("close 与 cleanup journal write 应失败");
        let failed = runtime.status().clone();
        assert!(failed.active);
        assert!(failed.cleanup_required);
        assert!(!failed.pending);

        let recovered = runtime
            .recover()
            .expect("内存 ownership 应允许再次 cleanup");
        assert!(recovered.recovered);
        assert!(!recovered.state.cleanup_required);
    }

    #[test]
    fn journal_clear_failure_keeps_cleanup_retryable_after_exact_close() {
        let directory = TestDirectory::new("journal-clear-failure");
        let root = directory.add_scene("clear-fails");
        let mut library =
            WallpaperLibrary::open(directory.0.join("library.json")).expect("应打开库");
        library.add_manual_root(&root).expect("应导入 Scene");
        let id = library.scan(&[], true).expect("应扫描 Scene").projects[0]
            .id
            .clone();
        let journal = Arc::new(Mutex::new(MemoryJournal::fail_on_clear()));
        let events = Arc::new(Mutex::new(Vec::new()));
        let mut runtime = WallpaperEngineRuntime::with_platform(
            library,
            Box::new(Arc::clone(&journal)),
            Box::new(FakePlatform::new(Arc::clone(&events))),
        );
        let active = runtime
            .start_scene(scene_request(id))
            .expect("Scene 应启动")
            .state;

        runtime
            .stop_scene(Some(&active.session_id))
            .expect_err("首次 journal clear 应失败");
        let failed = runtime.status().clone();
        assert!(failed.active);
        assert!(failed.cleanup_required);
        assert!(!failed.pending);

        let recovered = runtime.recover().expect("再次 clear 应完成 exact cleanup");
        assert!(recovered.recovered);
        assert!(!recovered.state.active);
        assert!(!recovered.state.cleanup_required);
        assert!(journal.lock().expect("journal 锁应可用").value.is_none());
    }

    #[test]
    fn targeted_stop_mismatch_preserves_the_active_session() {
        let directory = TestDirectory::new("targeted-stop");
        let root = directory.add_scene("target");
        let mut library =
            WallpaperLibrary::open(directory.0.join("library.json")).expect("应打开库");
        library.add_manual_root(&root).expect("应导入 Scene");
        let id = library.scan(&[], true).expect("应扫描 Scene").projects[0]
            .id
            .clone();
        let events = Arc::new(Mutex::new(Vec::new()));
        let journal = Arc::new(Mutex::new(MemoryJournal::default()));
        let mut runtime = WallpaperEngineRuntime::with_platform(
            library,
            Box::new(journal),
            Box::new(FakePlatform::new(Arc::clone(&events))),
        );
        let active = runtime
            .start_scene(scene_request(id))
            .expect("Scene 应启动");

        let result = runtime
            .stop_scene(Some("ffffffffffffffffffffffff"))
            .expect("mismatch 应作为非破坏结果返回");
        assert!(!result.stopped);
        assert!(result.state.active);
        assert_eq!(result.state.session_id, active.state.session_id);
        assert!(!events
            .lock()
            .expect("events 锁应可用")
            .iter()
            .any(|event| event.starts_with("close:")));
    }

    #[test]
    fn failed_close_keeps_active_journal_for_next_startup_recovery() {
        let directory = TestDirectory::new("cleanup-recovery");
        let root = directory.add_scene("recoverable");
        let config = directory.0.join("library.json");
        let mut library = WallpaperLibrary::open(&config).expect("应打开库");
        library.add_manual_root(&root).expect("应导入 Scene");
        let id = library.scan(&[], true).expect("应扫描 Scene").projects[0]
            .id
            .clone();
        let journal = Arc::new(Mutex::new(MemoryJournal::default()));
        let events = Arc::new(Mutex::new(Vec::new()));
        let mut runtime = WallpaperEngineRuntime::with_platform(
            library,
            Box::new(Arc::clone(&journal)),
            Box::new(FakePlatform::with_close_failure(Arc::clone(&events))),
        );
        let active = runtime
            .start_scene(scene_request(id))
            .expect("Scene 应启动");
        let error = runtime
            .stop_scene(Some(&active.state.session_id))
            .expect_err("未确认 HWND 消失时不得伪装 stopped");
        assert_eq!(error.code(), "WALLPAPER_ENGINE_CLEANUP_REQUIRED");
        assert!(runtime.status().active);
        assert!(runtime.status().cleanup_required);
        assert!(journal.lock().expect("journal 锁应可用").value.is_some());
        let failed_close_events = events.lock().expect("events 锁应可用").clone();
        assert!(failed_close_events
            .iter()
            .any(|event| event == &format!("close:{}", active.state.session_id)));
        assert!(
            !failed_close_events
                .iter()
                .any(|event| event == &format!("deactivate:{}", active.state.session_id)),
            "close 未确认时不得提前释放 DWM/WGC 可重试资源"
        );
        drop(runtime);

        let library = WallpaperLibrary::open(config).expect("下次启动应重开库");
        let mut recovered_runtime = WallpaperEngineRuntime::with_platform(
            library,
            Box::new(Arc::clone(&journal)),
            Box::new(FakePlatform::new(Arc::clone(&events))),
        );
        let recovered = recovered_runtime.recover().expect("exact recovery 应成功");
        assert!(recovered.recovered);
        assert!(!recovered.state.cleanup_required);
        assert!(journal.lock().expect("journal 锁应可用").value.is_none());
        assert!(
            !recovered_runtime
                .recover()
                .expect("重复 recovery 应幂等")
                .recovered
        );
    }

    #[test]
    fn explicit_recovery_retries_an_active_cleanup_required_session() {
        let directory = TestDirectory::new("active-cleanup-retry");
        let root = directory.add_scene("retryable");
        let mut library =
            WallpaperLibrary::open(directory.0.join("library.json")).expect("应打开库");
        library.add_manual_root(&root).expect("应导入 Scene");
        let id = library.scan(&[], true).expect("应扫描 Scene").projects[0]
            .id
            .clone();
        let journal = Arc::new(Mutex::new(MemoryJournal::default()));
        let events = Arc::new(Mutex::new(Vec::new()));
        let mut runtime = WallpaperEngineRuntime::with_platform(
            library,
            Box::new(Arc::clone(&journal)),
            Box::new(FakePlatform::with_close_failure(Arc::clone(&events))),
        );
        let active = runtime
            .start_scene(scene_request(id))
            .expect("Scene 应启动");

        runtime
            .stop_scene(Some(&active.state.session_id))
            .expect_err("第一次 close 未确认时应进入 cleanupRequired");
        let recovered = runtime
            .recover()
            .expect("显式 recovery 应重试 active exact session");

        assert!(recovered.recovered);
        assert!(!recovered.state.active);
        assert!(!recovered.state.cleanup_required);
        assert!(journal.lock().expect("journal 锁应可用").value.is_none());
        let events = events.lock().expect("events 锁应可用");
        assert_eq!(
            events
                .iter()
                .filter(|event| event == &&format!("close:{}", active.state.session_id))
                .count(),
            2,
            "recovery 必须只重试当前 exact session"
        );
        assert!(events
            .iter()
            .any(|event| event == &format!("deactivate:{}", active.state.session_id)));
    }

    #[test]
    fn retired_capture_is_reconciled_without_leaving_stale_ready_state() {
        let directory = TestDirectory::new("capture-retired");
        let root = directory.add_scene("retired");
        let mut library =
            WallpaperLibrary::open(directory.0.join("library.json")).expect("应打开库");
        library.add_manual_root(&root).expect("应导入 Scene");
        let id = library.scan(&[], true).expect("应扫描 Scene").projects[0]
            .id
            .clone();
        let journal = Arc::new(Mutex::new(MemoryJournal::default()));
        let events = Arc::new(Mutex::new(Vec::new()));
        let capture = Arc::new(Mutex::new(FakeCapture::default()));
        let mut runtime = WallpaperEngineRuntime::with_platform(
            library,
            Box::new(journal),
            Box::new(FakePlatform::with_capture(
                Arc::clone(&events),
                Arc::clone(&capture),
            )),
        );
        let active = runtime
            .start_scene(scene_request(id))
            .expect("Scene 应启动");
        capture.lock().expect("capture 锁应可用").retired = true;

        let reconciled = runtime
            .reconcile_capture_status()
            .expect("退休 surface 应在同一 exact session 内重建")
            .clone();

        assert!(reconciled.active);
        assert!(reconciled.dwm_surface_ready);
        assert!(!reconciled.cleanup_required);
        assert_eq!(reconciled.session_id, active.state.session_id);
        assert!(events
            .lock()
            .expect("events 锁应可用")
            .iter()
            .any(|event| event == &format!("rebind:{}", active.state.session_id)));
    }

    #[test]
    fn hwnd_generation_rebind_updates_journal_before_future_exact_stop() {
        let directory = TestDirectory::new("capture-generation");
        let root = directory.add_scene("generation");
        let mut library =
            WallpaperLibrary::open(directory.0.join("library.json")).expect("应打开库");
        library.add_manual_root(&root).expect("应导入 Scene");
        let id = library.scan(&[], true).expect("应扫描 Scene").projects[0]
            .id
            .clone();
        let journal = Arc::new(Mutex::new(MemoryJournal::default()));
        let events = Arc::new(Mutex::new(Vec::new()));
        let capture = Arc::new(Mutex::new(FakeCapture::default()));
        let mut runtime = WallpaperEngineRuntime::with_platform(
            library,
            Box::new(Arc::clone(&journal)),
            Box::new(FakePlatform::with_capture(
                Arc::clone(&events),
                Arc::clone(&capture),
            )),
        );
        let started = runtime
            .start_scene(scene_request(id))
            .expect("Scene 应启动");
        capture.lock().expect("capture 锁应可用").replacement_handle = Some(777);

        let reconciled = runtime
            .reconcile_capture_status()
            .expect("合法新 generation 应重绑")
            .clone();
        assert_eq!(reconciled.source_id, "window:777:0");
        assert_eq!(
            journal
                .lock()
                .expect("journal 锁应可用")
                .value
                .as_ref()
                .and_then(|journal| journal.expected.window.as_ref())
                .map(|window| window.handle),
            Some(777),
            "capture mutation 前必须持久化 replacement identity"
        );

        runtime
            .stop_scene(Some(&started.state.session_id))
            .expect("后续 stop 必须使用新 exact HWND");
        assert!(events
            .lock()
            .expect("events 锁应可用")
            .iter()
            .any(|event| event == "close-window:777"));
    }

    #[test]
    fn failed_capture_rebind_clears_health_and_retains_exact_recovery_evidence() {
        let directory = TestDirectory::new("capture-rebind-failed");
        let root = directory.add_scene("failed");
        let mut library =
            WallpaperLibrary::open(directory.0.join("library.json")).expect("应打开库");
        library.add_manual_root(&root).expect("应导入 Scene");
        let id = library.scan(&[], true).expect("应扫描 Scene").projects[0]
            .id
            .clone();
        let journal = Arc::new(Mutex::new(MemoryJournal::default()));
        let events = Arc::new(Mutex::new(Vec::new()));
        let capture = Arc::new(Mutex::new(FakeCapture {
            retired: false,
            replacement_handle: None,
            rebind_error: false,
            active_ownership: None,
        }));
        let mut runtime = WallpaperEngineRuntime::with_platform(
            library,
            Box::new(Arc::clone(&journal)),
            Box::new(FakePlatform::with_capture(events, Arc::clone(&capture))),
        );
        runtime
            .start_scene(scene_request(id))
            .expect("Scene 应启动");
        {
            let mut capture = capture.lock().expect("capture 锁应可用");
            capture.retired = true;
            capture.rebind_error = true;
        }

        let reconciled = runtime
            .reconcile_capture_status()
            .expect("health failure 应作为可诊断状态返回")
            .clone();

        assert!(reconciled.active, "exact Scene 尚未确认关闭");
        assert!(reconciled.cleanup_required);
        assert!(!reconciled.dwm_surface_ready);
        assert!(!reconciled.glass_sampler_ready);
        assert!(!reconciled.audio_muted);
        assert_eq!(reconciled.capture_mode, super::WallpaperCaptureMode::None);
        assert!(journal.lock().expect("journal 锁应可用").value.is_some());
        runtime
            .recover()
            .expect("显式 recovery 应能关闭保留的 exact session");
        assert!(journal.lock().expect("journal 锁应可用").value.is_none());
    }

    #[test]
    fn replacement_that_disappears_during_rebind_still_uses_new_exact_cleanup_identity() {
        let directory = TestDirectory::new("capture-rebind-race");
        let root = directory.add_scene("race");
        let mut library =
            WallpaperLibrary::open(directory.0.join("library.json")).expect("应打开库");
        library.add_manual_root(&root).expect("应导入 Scene");
        let id = library.scan(&[], true).expect("应扫描 Scene").projects[0]
            .id
            .clone();
        let journal = Arc::new(Mutex::new(MemoryJournal::default()));
        let events = Arc::new(Mutex::new(Vec::new()));
        let capture = Arc::new(Mutex::new(FakeCapture::default()));
        let mut runtime = WallpaperEngineRuntime::with_platform(
            library,
            Box::new(Arc::clone(&journal)),
            Box::new(FakePlatform::with_capture(
                Arc::clone(&events),
                Arc::clone(&capture),
            )),
        );
        runtime
            .start_scene(scene_request(id))
            .expect("Scene 应启动");
        {
            let mut capture = capture.lock().expect("capture 锁应可用");
            capture.replacement_handle = Some(888);
            capture.rebind_error = true;
        }

        let failed = runtime
            .reconcile_capture_status()
            .expect("rebind race 应转为可恢复状态")
            .clone();
        assert!(failed.cleanup_required);
        assert_eq!(
            journal
                .lock()
                .expect("journal 锁应可用")
                .value
                .as_ref()
                .and_then(|journal| journal.expected.window.as_ref())
                .map(|window| window.handle),
            Some(888)
        );

        runtime
            .recover()
            .expect("rebind 失败后仍必须能清理已采用的新 exact identity");
        assert!(events
            .lock()
            .expect("events 锁应可用")
            .iter()
            .any(|event| event == "close-window:888"));
    }

    #[test]
    fn untrusted_opened_window_enters_cleanup_required_without_closing_it() {
        let directory = TestDirectory::new("ownership-mismatch");
        let root = directory.add_scene("mismatch");
        let mut library =
            WallpaperLibrary::open(directory.0.join("library.json")).expect("应打开库");
        library.add_manual_root(&root).expect("应导入 Scene");
        let id = library.scan(&[], true).expect("应扫描 Scene").projects[0]
            .id
            .clone();
        let journal = Arc::new(Mutex::new(MemoryJournal::default()));
        let events = Arc::new(Mutex::new(Vec::new()));
        let mut runtime = WallpaperEngineRuntime::with_platform(
            library,
            Box::new(Arc::clone(&journal)),
            Box::new(FakePlatform::with_ownership_mismatch(Arc::clone(&events))),
        );

        let error = runtime
            .start_scene(scene_request(id))
            .expect_err("不可信窗口 identity 必须 fail closed");
        assert_eq!(error.code(), "WALLPAPER_ENGINE_CLEANUP_REQUIRED");
        assert!(runtime.status().cleanup_required);
        assert!(!runtime.status().active);
        assert!(journal.lock().expect("journal 锁应可用").value.is_some());
        assert!(
            !events
                .lock()
                .expect("events 锁应可用")
                .iter()
                .any(|event| event.starts_with("close:")),
            "未知 ownership 的 HWND 不得由 core 请求关闭"
        );
    }

    #[test]
    fn full_desktop_mode_is_committed_only_after_platform_acknowledges_it() {
        let library = WallpaperLibrary::open(test_path("desktop-mode")).expect("应创建库");
        let journal = Arc::new(Mutex::new(MemoryJournal::default()));
        let events = Arc::new(Mutex::new(Vec::new()));
        let mut runtime = WallpaperEngineRuntime::with_platform(
            library,
            Box::new(journal),
            Box::new(FakePlatform::new(Arc::clone(&events))),
        );
        runtime
            .set_full_desktop_mode(super::WallpaperFullDesktopMode::Interactive)
            .expect("平台应确认 interactive layering");
        assert_eq!(
            runtime.status().full_desktop_mode,
            super::WallpaperFullDesktopMode::Interactive
        );
        assert!(events
            .lock()
            .expect("events 锁应可用")
            .iter()
            .any(|event| event == "desktop:Interactive"));
    }
}
