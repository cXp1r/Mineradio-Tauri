//! Wallpaper Engine Windows Adapter composition。

mod discovery;
mod dwm_surface;
mod error;
mod identity;
mod location_mute;
mod scene;
mod trust;
mod wgc_sampler;

use crate::{
    app::window_labels,
    runtime::wallpaper_engine::{
        journal::WallpaperRecoveryJournal,
        ownership::{same_executable, validate_scene_replacement},
        PlatformAvailability, PlatformSceneRequest, PreparedScene, ProjectSource,
        ProjectSourceKind, SceneActivation, SceneCaptureObservation, SceneCloseConfirmation,
        SceneOwnership, ScenePropertyValue, WallpaperEnginePlatform, WallpaperFullDesktopMode,
        WallpaperPlatformError,
    },
};
use discovery::{
    discover_project_sources, discover_steam_library_roots,
    discover_wallpaper_engine_installations, DiscoveredProjectSourceKind,
    WallpaperEngineInstallation,
};
use dwm_surface::{DwmSurfaceOwner, DwmSurfaceRequest};
use error::{WindowsWallpaperError, WindowsWallpaperResult};
use identity::{find_exact_window, window_identity, WindowIdentity};
use location_mute::LocationMuteOwner;
use scene::{PreparedWindowsScene, SceneController, WindowsSceneOwnership, WindowsSceneRequest};
use serde_json::{Number, Value};
use tauri::{AppHandle, Manager};
use trust::{verify_official_executable, TrustedExecutable};
use wgc_sampler::WgcSamplerOwner;

#[derive(Clone, Debug)]
struct WindowsWallpaperProbe {
    installation: WallpaperEngineInstallation,
    executable: TrustedExecutable,
}

/// Windows 原生 owner；core 只看 `WallpaperEnginePlatform`。
pub struct WindowsWallpaperEngineAdapter {
    host: WindowIdentity,
    scene: SceneController,
    cached_probe: Option<WindowsWallpaperProbe>,
    prepared: Option<(PreparedScene, PreparedWindowsScene)>,
    active: Option<(SceneOwnership, WindowsSceneOwnership)>,
    observed_capture: Option<(SceneOwnership, WindowsSceneOwnership)>,
    location_mute: Option<LocationMuteOwner>,
    wgc_sampler: Option<WgcSamplerOwner>,
    dwm_surface: Option<DwmSurfaceOwner>,
    full_desktop_mode: WallpaperFullDesktopMode,
}

pub type TauriWallpaperEnginePlatform = WindowsWallpaperEngineAdapter;

impl WindowsWallpaperEngineAdapter {
    pub fn new(host: WindowIdentity) -> Self {
        Self {
            host,
            scene: SceneController,
            cached_probe: None,
            prepared: None,
            active: None,
            observed_capture: None,
            location_mute: None,
            wgc_sampler: None,
            dwm_surface: None,
            full_desktop_mode: WallpaperFullDesktopMode::Disabled,
        }
    }

    pub fn for_main_window(app: AppHandle) -> Result<Self, WallpaperPlatformError> {
        let window = app
            .get_webview_window(window_labels::MAIN)
            .ok_or_else(|| WallpaperPlatformError::new("WALLPAPER_ENGINE_HOST_UNAVAILABLE"))?;
        let handle = window
            .hwnd()
            .map_err(|_| WallpaperPlatformError::new("WALLPAPER_ENGINE_HOST_UNAVAILABLE"))?;
        let host = window_identity(handle.0 as windows_sys::Win32::Foundation::HWND)
            .map_err(platform_error)?;
        Ok(Self::new(host))
    }

    fn probe_windows(
        &mut self,
        force: bool,
    ) -> WindowsWallpaperResult<Option<WindowsWallpaperProbe>> {
        if !force {
            if let Some(cached) = &self.cached_probe {
                return Ok(Some(cached.clone()));
            }
        }
        let steam_roots = discover_steam_library_roots()?;
        let installations = discover_wallpaper_engine_installations(&steam_roots);
        if installations.is_empty() {
            self.cached_probe = None;
            return Ok(None);
        }
        let mut last_error = None;
        for installation in installations {
            match verify_official_executable(
                &installation.installation_root,
                &installation.executable,
            ) {
                Ok(executable) => {
                    let probe = WindowsWallpaperProbe {
                        installation,
                        executable,
                    };
                    self.cached_probe = Some(probe.clone());
                    return Ok(Some(probe));
                }
                Err(error) => last_error = Some(error),
            }
        }
        Err(last_error.unwrap_or_else(|| {
            WindowsWallpaperError::new(
                "WALLPAPER_ENGINE_SIGNATURE_INVALID",
                "Wallpaper Engine 安装无法通过信任校验",
            )
        }))
    }

    fn stop_capture_resources(&mut self) -> WindowsWallpaperResult<()> {
        let mut first_error = None;
        if let Some(sampler) = self.wgc_sampler.as_mut() {
            match sampler.stop() {
                Ok(()) => self.wgc_sampler = None,
                Err(error) => first_error = Some(error),
            }
        }
        if let Some(surface) = self.dwm_surface.as_mut() {
            match surface.stop() {
                Ok(()) => self.dwm_surface = None,
                Err(error) if first_error.is_none() => first_error = Some(error),
                Err(_) => {}
            }
        }
        if let Some(owner) = self.location_mute.as_mut() {
            match owner.stop() {
                Ok(()) => self.location_mute = None,
                Err(error) if first_error.is_none() => first_error = Some(error),
                Err(_) => {}
            }
        }
        first_error.map_or(Ok(()), Err)
    }

    fn activate_current_capture(&mut self) -> WindowsWallpaperResult<SceneActivation> {
        let (_, prepared) = self.prepared.clone().ok_or_else(|| {
            WindowsWallpaperError::new(
                "WALLPAPER_ENGINE_PLATFORM_CONTRACT_INVALID",
                "缺少已准备的 Scene",
            )
        })?;
        let (_, ownership) = self.active.clone().ok_or_else(|| {
            WindowsWallpaperError::new(
                "WALLPAPER_ENGINE_OWNERSHIP_MISMATCH",
                "缺少 active Scene ownership",
            )
        })?;
        self.scene.apply_location_mute(&prepared, &ownership)?;
        let mut mute_owner =
            LocationMuteOwner::start_confirmed(prepared.clone(), ownership.clone())?;
        let surface = match DwmSurfaceOwner::start(DwmSurfaceRequest {
            host: self.host.clone(),
            source: ownership.window.clone(),
            desktop_icon_layering: self.full_desktop_mode == WallpaperFullDesktopMode::Interactive,
        }) {
            Ok(surface) => surface,
            Err(error) => {
                let _ = mute_owner.stop();
                return Err(error);
            }
        };
        let surface_status = surface.status();
        let sampler = WgcSamplerOwner::start_for_surface(surface.surface_window_handle());
        let sampler_status = sampler.status();
        let source_id = ownership.window.source_id();
        self.location_mute = Some(mute_owner);
        self.dwm_surface = Some(surface);
        self.wgc_sampler = Some(sampler);
        Ok(SceneActivation {
            source_id,
            source_window_aligned: true,
            dwm_surface_ready: surface_status.ready,
            glass_sampler_ready: sampler_status.ready,
            audio_muted: self
                .location_mute
                .as_ref()
                .is_some_and(|owner| owner.status().ready),
        })
    }

    fn trusted_recovery_executable(
        &mut self,
        expected: &crate::runtime::wallpaper_engine::ExecutableIdentity,
    ) -> Result<TrustedExecutable, WallpaperPlatformError> {
        let probe = self
            .probe_windows(true)
            .map_err(platform_error)?
            .ok_or_else(|| WallpaperPlatformError::new("WALLPAPER_ENGINE_NOT_INSTALLED"))?;
        let actual = core_executable(&probe.executable);
        if !same_executable(expected, &actual) {
            return Err(WallpaperPlatformError::new(
                "WALLPAPER_ENGINE_RECOVERY_IDENTITY_UNPROVEN",
            ));
        }
        Ok(probe.executable)
    }
}

impl WallpaperEnginePlatform for WindowsWallpaperEngineAdapter {
    fn probe(&mut self, force: bool) -> Result<PlatformAvailability, WallpaperPlatformError> {
        match self.probe_windows(force).map_err(platform_error)? {
            Some(probe) => Ok(PlatformAvailability {
                available: true,
                executable_name: probe
                    .executable
                    .canonical_path
                    .file_name()
                    .map(|value| value.to_string_lossy().into_owned()),
                reason: None,
            }),
            None => Ok(PlatformAvailability::unavailable(
                "WALLPAPER_ENGINE_NOT_INSTALLED",
            )),
        }
    }

    fn discover_project_sources(&mut self) -> Result<Vec<ProjectSource>, WallpaperPlatformError> {
        let roots = discover_steam_library_roots().map_err(platform_error)?;
        Ok(discover_project_sources(&roots)
            .into_iter()
            .map(|source| {
                let kind = match source.kind {
                    DiscoveredProjectSourceKind::Workshop => ProjectSourceKind::Workshop,
                    DiscoveredProjectSourceKind::Local => ProjectSourceKind::Local,
                };
                ProjectSource::new(source.root, kind, source.source_label, false)
            })
            .collect())
    }

    fn prepare_scene(
        &mut self,
        request: &PlatformSceneRequest,
    ) -> Result<PreparedScene, WallpaperPlatformError> {
        let probe = self
            .probe_windows(false)
            .map_err(platform_error)?
            .ok_or_else(|| WallpaperPlatformError::new("WALLPAPER_ENGINE_NOT_INSTALLED"))?;
        let windows_request = windows_request(request)?;
        let prepared = self
            .scene
            .prepare(&windows_request, &probe.installation)
            .map_err(platform_error)?;
        let core = PreparedScene {
            request: request.clone(),
            executable: core_executable(&prepared.executable),
        };
        self.prepared = Some((core.clone(), prepared));
        Ok(core)
    }

    fn open_scene_location(
        &mut self,
        prepared: &PreparedScene,
    ) -> Result<SceneOwnership, WallpaperPlatformError> {
        let (_, windows_prepared) = self
            .prepared
            .as_ref()
            .filter(|(core, _)| core == prepared)
            .ok_or_else(|| {
                WallpaperPlatformError::new("WALLPAPER_ENGINE_PLATFORM_CONTRACT_INVALID")
            })?;
        let windows_ownership = self
            .scene
            .open_location(windows_prepared)
            .map_err(platform_error)?;
        let ownership = core_ownership(&windows_ownership);
        self.active = Some((ownership.clone(), windows_ownership));
        self.observed_capture = None;
        Ok(ownership)
    }

    fn activate_scene(
        &mut self,
        prepared: &PreparedScene,
        ownership: &SceneOwnership,
    ) -> Result<SceneActivation, WallpaperPlatformError> {
        if self.full_desktop_mode == WallpaperFullDesktopMode::Passive {
            return Err(WallpaperPlatformError::new(
                "WALLPAPER_ENGINE_PASSIVE_MODE_ACTIVE",
            ));
        }
        let (_, windows_prepared) = self
            .prepared
            .as_ref()
            .filter(|(core, _)| core == prepared)
            .ok_or_else(|| {
                WallpaperPlatformError::new("WALLPAPER_ENGINE_PLATFORM_CONTRACT_INVALID")
            })?;
        let (_, windows_ownership) = self
            .active
            .as_ref()
            .filter(|(core, _)| core == ownership)
            .ok_or_else(|| WallpaperPlatformError::new("WALLPAPER_ENGINE_OWNERSHIP_MISMATCH"))?;
        let _ = (windows_prepared, windows_ownership);
        self.activate_current_capture().map_err(platform_error)
    }

    fn observe_scene_capture(
        &mut self,
        ownership: &SceneOwnership,
    ) -> Result<SceneCaptureObservation, WallpaperPlatformError> {
        let (_, active) = self
            .active
            .as_ref()
            .filter(|(core, _)| core == ownership)
            .cloned()
            .ok_or_else(|| WallpaperPlatformError::new("WALLPAPER_ENGINE_OWNERSHIP_MISMATCH"))?;
        let observed = find_exact_window(&active.location, &active.executable.canonical_path)
            .map_err(platform_error)?
            .ok_or_else(|| WallpaperPlatformError::new("WALLPAPER_ENGINE_SOURCE_MISSING"))?;
        let observed_windows = WindowsSceneOwnership {
            session_id: active.session_id.clone(),
            location: active.location.clone(),
            executable: active.executable.clone(),
            window: observed,
        };
        let observed_core = core_ownership(&observed_windows);
        validate_scene_replacement(ownership, &observed_core)
            .map_err(|_| WallpaperPlatformError::new("WALLPAPER_ENGINE_OWNERSHIP_MISMATCH"))?;
        let same_generation = &observed_core == ownership;
        let host = identity::verify_window_identity(&self.host).map_err(platform_error)?;
        let source_aligned = observed_windows.window.rect.aligned_with(host.rect, 2);
        let surface = self.dwm_surface.as_ref().map(DwmSurfaceOwner::status);
        let dwm_surface_ready = same_generation
            && source_aligned
            && surface
                .as_ref()
                .is_some_and(|status| status.ready && !status.retired && !status.stopped);
        let glass_sampler_ready = dwm_surface_ready
            && self
                .wgc_sampler
                .as_ref()
                .is_some_and(|sampler| sampler.status().ready);
        let audio_muted = same_generation
            && self.location_mute.as_ref().is_some_and(|owner| {
                let status = owner.status();
                status.ready && !status.stopped
            });
        let activation = SceneActivation {
            source_id: observed_windows.window.source_id(),
            source_window_aligned: same_generation && source_aligned,
            dwm_surface_ready,
            glass_sampler_ready,
            audio_muted,
        };
        self.observed_capture = Some((observed_core.clone(), observed_windows));
        Ok(SceneCaptureObservation {
            ownership: observed_core,
            rebind_required: !activation.source_window_aligned
                || !activation.dwm_surface_ready
                || !activation.audio_muted,
            activation,
        })
    }

    fn rebind_scene_capture(
        &mut self,
        ownership: &SceneOwnership,
    ) -> Result<SceneActivation, WallpaperPlatformError> {
        let (previous, _) =
            self.active.as_ref().cloned().ok_or_else(|| {
                WallpaperPlatformError::new("WALLPAPER_ENGINE_OWNERSHIP_MISMATCH")
            })?;
        validate_scene_replacement(&previous, ownership)
            .map_err(|_| WallpaperPlatformError::new("WALLPAPER_ENGINE_OWNERSHIP_MISMATCH"))?;
        let (_, replacement) = self
            .observed_capture
            .take()
            .filter(|(observed, _)| observed == ownership)
            .ok_or_else(|| {
                WallpaperPlatformError::new("WALLPAPER_ENGINE_CAPTURE_OBSERVATION_STALE")
            })?;

        // 先采用已验证的新 generation；后续 capture 重建失败时，core/journal 仍能针对
        // exact replacement 执行显式 cleanup，绝不回退到已经失效的 HWND。
        self.active = Some((ownership.clone(), replacement));
        self.stop_capture_resources().map_err(platform_error)?;
        self.activate_current_capture().map_err(platform_error)
    }

    fn deactivate_scene_resources(
        &mut self,
        ownership: &SceneOwnership,
    ) -> Result<(), WallpaperPlatformError> {
        if self
            .active
            .as_ref()
            .is_some_and(|(core, _)| core != ownership)
        {
            return Err(WallpaperPlatformError::new(
                "WALLPAPER_ENGINE_OWNERSHIP_MISMATCH",
            ));
        }
        self.stop_capture_resources().map_err(platform_error)
    }

    fn close_scene_location(
        &mut self,
        ownership: &SceneOwnership,
    ) -> Result<SceneCloseConfirmation, WallpaperPlatformError> {
        let (_, windows_ownership) = self
            .active
            .as_ref()
            .filter(|(core, _)| core == ownership)
            .ok_or_else(|| WallpaperPlatformError::new("WALLPAPER_ENGINE_OWNERSHIP_MISMATCH"))?;
        let closed = self
            .scene
            .close_location(windows_ownership)
            .map_err(platform_error)?;
        Ok(SceneCloseConfirmation {
            observed: Some(ownership.clone()),
            location_closed: closed.location_closed,
            resources_released: self.dwm_surface.is_none() && self.wgc_sampler.is_none(),
            source_absence_confirmed: closed.source_absence_confirmed,
        })
    }

    fn recover_scene_location(
        &mut self,
        journal: &WallpaperRecoveryJournal,
    ) -> Result<SceneCloseConfirmation, WallpaperPlatformError> {
        let executable = self.trusted_recovery_executable(&journal.expected.executable)?;
        let observed = find_exact_window(&journal.location, &executable.canonical_path)
            .map_err(platform_error)?;
        if let (Some(expected), Some(actual)) = (&journal.expected.window, &observed) {
            if expected.handle != actual.handle
                || expected.process_id != actual.process.process_id
                || expected.process_created_unix_millis
                    != actual.process.process_created_unix_millis
                || expected.title != actual.title
            {
                return Err(WallpaperPlatformError::new(
                    "WALLPAPER_ENGINE_RECOVERY_IDENTITY_UNPROVEN",
                ));
            }
        }
        let closed = self
            .scene
            .recover_exact_location(&journal.location, &executable, observed.as_ref())
            .map_err(platform_error)?;
        self.stop_capture_resources().map_err(platform_error)?;
        let observed = observed
            .as_ref()
            .map(|window| core_ownership_with_window(journal, &executable, window));
        Ok(SceneCloseConfirmation {
            observed,
            location_closed: closed.location_closed,
            resources_released: true,
            source_absence_confirmed: closed.source_absence_confirmed,
        })
    }

    fn set_full_desktop_mode(
        &mut self,
        mode: WallpaperFullDesktopMode,
    ) -> Result<(), WallpaperPlatformError> {
        if mode == WallpaperFullDesktopMode::Passive && self.dwm_surface.is_some() {
            return Err(WallpaperPlatformError::new(
                "WALLPAPER_ENGINE_PASSIVE_MODE_ACTIVE",
            ));
        }
        if let Some(surface) = &self.dwm_surface {
            surface
                .set_desktop_icon_layering(mode == WallpaperFullDesktopMode::Interactive)
                .map_err(platform_error)?;
        }
        self.full_desktop_mode = mode;
        Ok(())
    }
}

impl Drop for WindowsWallpaperEngineAdapter {
    fn drop(&mut self) {
        let _ = self.stop_capture_resources();
    }
}

fn windows_request(
    request: &PlatformSceneRequest,
) -> Result<WindowsSceneRequest, WallpaperPlatformError> {
    let mut mute_properties = std::collections::BTreeMap::new();
    for (key, value) in &request.mute_properties {
        let value = match value {
            ScenePropertyValue::Boolean(value) => Value::Bool(*value),
            ScenePropertyValue::Number(value) => Number::from_f64(*value)
                .map(Value::Number)
                .ok_or_else(|| WallpaperPlatformError::new("WALLPAPER_SCENE_PROPERTY_INVALID"))?,
            ScenePropertyValue::Text(value) => Value::String(value.clone()),
        };
        mute_properties.insert(key.clone(), value);
    }
    Ok(WindowsSceneRequest {
        generation: request.generation,
        project_id: request.project_id.clone(),
        session_id: request.session_id.clone(),
        location: request.location.clone(),
        project_file: request.project_file.clone(),
        scene_package: request.scene_package.clone(),
        mute_properties,
        physical_bounds: identity::PhysicalRect::new(
            request.physical_bounds.x,
            request.physical_bounds.y,
            request.physical_bounds.width as i32,
            request.physical_bounds.height as i32,
        )
        .map_err(platform_error)?,
    })
}

fn core_executable(
    value: &TrustedExecutable,
) -> crate::runtime::wallpaper_engine::ExecutableIdentity {
    crate::runtime::wallpaper_engine::ExecutableIdentity {
        canonical_path: value.canonical_path.clone(),
        file_size: value.file_size,
        modified_unix_millis: value.modified_unix_millis,
    }
}

fn core_ownership(value: &WindowsSceneOwnership) -> SceneOwnership {
    let executable = core_executable(&value.executable);
    SceneOwnership {
        session_id: value.session_id.clone(),
        location: value.location.clone(),
        executable: executable.clone(),
        window: Some(crate::runtime::wallpaper_engine::WindowIdentity {
            handle: value.window.handle,
            process_id: value.window.process.process_id,
            process_created_unix_millis: value.window.process.process_created_unix_millis,
            executable,
            title: value.window.title.clone(),
        }),
        launched_process: None,
    }
}

fn core_ownership_with_window(
    journal: &WallpaperRecoveryJournal,
    executable: &TrustedExecutable,
    window: &WindowIdentity,
) -> SceneOwnership {
    let executable = core_executable(executable);
    SceneOwnership {
        session_id: journal.session_id.clone(),
        location: journal.location.clone(),
        executable: executable.clone(),
        window: Some(crate::runtime::wallpaper_engine::WindowIdentity {
            handle: window.handle,
            process_id: window.process.process_id,
            process_created_unix_millis: window.process.process_created_unix_millis,
            executable,
            title: window.title.clone(),
        }),
        launched_process: None,
    }
}

fn platform_error(error: WindowsWallpaperError) -> WallpaperPlatformError {
    WallpaperPlatformError::new(error.code())
}
