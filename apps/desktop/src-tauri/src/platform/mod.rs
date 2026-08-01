//! 平台原生能力适配层。
//!
//! 领域 runtime 不得直接触碰 Win32；完整桌面模式只通过本模块安装的平台适配器执行。

#[cfg(windows)]
pub mod windows;

#[cfg(windows)]
pub use windows::wallpaper_engine::TauriWallpaperEnginePlatform;
#[cfg(windows)]
pub use windows::TauriFullDesktopPlatform;

#[cfg(not(windows))]
mod unsupported {
    use crate::runtime::{
        full_desktop::{
            Attachment, FullDesktopError, FullDesktopMode, FullDesktopPlatform, IconSnapshot,
            OwnerStatus, PlatformSnapshot, RecoveryJournal,
        },
        resources::ProcessIdentity,
    };

    /// 非 Windows 平台显式 fail-closed，不伪造桌面宿主能力。
    pub struct TauriFullDesktopPlatform;

    impl TauriFullDesktopPlatform {
        pub fn new(_app: tauri::AppHandle) -> Self {
            Self
        }
    }

    impl FullDesktopPlatform for TauriFullDesktopPlatform {
        fn supported(&self) -> bool {
            false
        }

        fn actual_main_desktop_child(
            &self,
            _snapshot: &PlatformSnapshot,
        ) -> Result<Option<bool>, FullDesktopError> {
            Ok(None)
        }

        fn current_owner_identity(&self) -> Result<ProcessIdentity, FullDesktopError> {
            Err(FullDesktopError::Unsupported)
        }

        fn owner_status(&self, _owner: ProcessIdentity) -> Result<OwnerStatus, FullDesktopError> {
            Err(FullDesktopError::Unsupported)
        }

        fn capture(
            &mut self,
            _mode: FullDesktopMode,
        ) -> Result<(PlatformSnapshot, IconSnapshot), FullDesktopError> {
            Err(FullDesktopError::Unsupported)
        }

        fn attach(
            &mut self,
            _mode: FullDesktopMode,
            _snapshot: &PlatformSnapshot,
            _icons_visible: bool,
            _interaction_locked: bool,
        ) -> Result<Attachment, FullDesktopError> {
            Err(FullDesktopError::Unsupported)
        }

        fn restore(
            &mut self,
            _snapshot: &PlatformSnapshot,
            _attachment: &Attachment,
        ) -> Result<(), FullDesktopError> {
            Err(FullDesktopError::Unsupported)
        }

        fn recover_stale(&mut self, _journal: &RecoveryJournal) -> Result<(), FullDesktopError> {
            Err(FullDesktopError::Unsupported)
        }

        fn validate_attachment(
            &mut self,
            _attachment: &Attachment,
        ) -> Result<(), FullDesktopError> {
            Err(FullDesktopError::Unsupported)
        }

        fn set_icons_visible(&mut self, _visible: bool) -> Result<(), FullDesktopError> {
            Err(FullDesktopError::Unsupported)
        }

        fn set_interaction_locked(&mut self, _locked: bool) -> Result<(), FullDesktopError> {
            Err(FullDesktopError::Unsupported)
        }
    }
}

#[cfg(not(windows))]
pub use unsupported::TauriFullDesktopPlatform;
