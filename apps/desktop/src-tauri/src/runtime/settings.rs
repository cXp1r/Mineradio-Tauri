//! Desktop Runtime 的单一原生设置所有者。

use crate::app::lifecycle::CloseBehavior;
use serde::{Deserialize, Serialize};
use std::{
    error::Error,
    fmt,
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

pub const RUNTIME_SETTINGS_FILE_NAME: &str = "runtime-settings.json";
pub const RUNTIME_SETTINGS_VERSION: u32 = 2;
pub const LEGACY_CACHE_SETTINGS_FILE_NAME: &str = "cache-settings.json";
const LEGACY_CACHE_SETTINGS_VERSION: u32 = 1;

static SETTINGS_WRITE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSettings {
    pub version: u32,
    pub close_behavior: CloseBehavior,
    pub cache_root: Option<PathBuf>,
    #[serde(default)]
    pub desktop_lyrics_bounds: Option<crate::runtime::window::WindowGeometry>,
    #[serde(default)]
    pub full_desktop_mode: crate::runtime::full_desktop::FullDesktopMode,
}

impl Default for RuntimeSettings {
    fn default() -> Self {
        Self {
            version: RUNTIME_SETTINGS_VERSION,
            close_behavior: CloseBehavior::Exit,
            cache_root: None,
            desktop_lyrics_bounds: None,
            full_desktop_mode: crate::runtime::full_desktop::FullDesktopMode::Disabled,
        }
    }
}

#[derive(Debug)]
pub struct RuntimeSettingsStore {
    path: PathBuf,
    settings: RuntimeSettings,
    diagnostics: Vec<RuntimeSettingsDiagnostic>,
    blocked_corrupt_primary: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeSettingsDiagnostic {
    pub source_path: PathBuf,
    pub preserved_path: Option<PathBuf>,
    pub message: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyCacheSettings {
    schema_version: u32,
    desired_root: Option<PathBuf>,
}

#[derive(Debug)]
pub enum RuntimeSettingsError {
    Io {
        operation: &'static str,
        path: PathBuf,
        source: io::Error,
    },
    Encoding {
        path: PathBuf,
        source: serde_json::Error,
    },
    CorruptFileNotPreserved {
        path: PathBuf,
        reason: String,
    },
}

impl fmt::Display for RuntimeSettingsError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io {
                operation,
                path,
                source,
            } => write!(formatter, "{operation} {} 失败：{source}", path.display()),
            Self::Encoding { path, source } => {
                write!(formatter, "编码原生设置 {} 失败：{source}", path.display())
            }
            Self::CorruptFileNotPreserved { path, reason } => write!(
                formatter,
                "拒绝覆盖尚未保留的损坏原生设置 {}：{reason}",
                path.display()
            ),
        }
    }
}

impl Error for RuntimeSettingsError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Io { source, .. } => Some(source),
            Self::Encoding { source, .. } => Some(source),
            Self::CorruptFileNotPreserved { .. } => None,
        }
    }
}

impl RuntimeSettingsStore {
    pub fn for_app_data(app_data_dir: impl AsRef<Path>) -> Self {
        let app_data_dir = app_data_dir.as_ref();
        Self::load_from_paths(
            app_data_dir.join(RUNTIME_SETTINGS_FILE_NAME),
            Some(app_data_dir.join(LEGACY_CACHE_SETTINGS_FILE_NAME)),
        )
    }

    pub fn with_path(path: impl Into<PathBuf>) -> Self {
        Self::load_from_paths(path.into(), None)
    }

    pub fn snapshot(&self) -> RuntimeSettings {
        self.settings.clone()
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn diagnostics(&self) -> &[RuntimeSettingsDiagnostic] {
        &self.diagnostics
    }

    pub fn set_close_behavior(
        &mut self,
        behavior: CloseBehavior,
    ) -> Result<(), RuntimeSettingsError> {
        let mut next = self.settings.clone();
        next.close_behavior = behavior;
        self.persist(next)
    }

    pub fn set_cache_root(
        &mut self,
        cache_root: Option<PathBuf>,
    ) -> Result<(), RuntimeSettingsError> {
        let mut next = self.settings.clone();
        next.cache_root = cache_root;
        self.persist(next)
    }

    pub fn set_desktop_lyrics_bounds(
        &mut self,
        bounds: Option<crate::runtime::window::WindowGeometry>,
    ) -> Result<(), RuntimeSettingsError> {
        let mut next = self.settings.clone();
        next.desktop_lyrics_bounds = bounds;
        self.persist(next)
    }

    pub fn set_full_desktop_mode(
        &mut self,
        mode: crate::runtime::full_desktop::FullDesktopMode,
    ) -> Result<(), RuntimeSettingsError> {
        let mut next = self.settings.clone();
        next.full_desktop_mode = mode;
        self.persist(next)
    }

    fn persist(&mut self, next: RuntimeSettings) -> Result<(), RuntimeSettingsError> {
        if let Some(reason) = &self.blocked_corrupt_primary {
            return Err(RuntimeSettingsError::CorruptFileNotPreserved {
                path: self.path.clone(),
                reason: reason.clone(),
            });
        }
        write_settings_atomically(&self.path, &next)?;
        self.settings = next;
        Ok(())
    }

    fn load_from_paths(path: PathBuf, legacy_path: Option<PathBuf>) -> Self {
        let mut diagnostics = Vec::new();
        let mut blocked_corrupt_primary = None;
        let settings = match read_runtime_settings(&path) {
            SettingsRead::Loaded(settings) => settings,
            SettingsRead::Missing => {
                load_or_migrate_legacy(&path, legacy_path.as_deref(), &mut diagnostics)
            }
            SettingsRead::Failed(message) => {
                let preserved_path = match preserve_corrupt_primary(&path) {
                    Ok(path) => Some(path),
                    Err(error) => {
                        blocked_corrupt_primary = Some(error.to_string());
                        None
                    }
                };
                diagnostics.push(RuntimeSettingsDiagnostic {
                    source_path: path.clone(),
                    preserved_path,
                    message,
                });
                RuntimeSettings::default()
            }
        };
        Self {
            path,
            settings,
            diagnostics,
            blocked_corrupt_primary,
        }
    }
}

enum SettingsRead<T> {
    Missing,
    Loaded(T),
    Failed(String),
}

fn read_runtime_settings(path: &Path) -> SettingsRead<RuntimeSettings> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return SettingsRead::Missing,
        Err(error) => {
            return SettingsRead::Failed(format!("读取原生设置 {} 失败：{error}", path.display()));
        }
    };
    let mut settings = match serde_json::from_slice::<RuntimeSettings>(&bytes) {
        Ok(settings) => settings,
        Err(error) => {
            return SettingsRead::Failed(format!("原生设置 JSON 无效 {}：{error}", path.display()));
        }
    };
    // v1 没有完整桌面模式字段；反序列化默认值后仅在下一次正常持久化时写入 v2。
    if settings.version == 1 {
        settings.version = RUNTIME_SETTINGS_VERSION;
        return SettingsRead::Loaded(settings);
    }
    if settings.version != RUNTIME_SETTINGS_VERSION {
        return SettingsRead::Failed(format!(
            "不支持的原生设置版本 {}，当前版本为 {}",
            settings.version, RUNTIME_SETTINGS_VERSION
        ));
    }
    SettingsRead::Loaded(settings)
}

fn read_legacy_cache_settings(path: &Path) -> SettingsRead<Option<PathBuf>> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return SettingsRead::Missing,
        Err(error) => {
            return SettingsRead::Failed(format!(
                "读取旧缓存设置 {} 失败：{error}",
                path.display()
            ));
        }
    };
    let settings = match serde_json::from_slice::<LegacyCacheSettings>(&bytes) {
        Ok(settings) => settings,
        Err(error) => {
            return SettingsRead::Failed(format!(
                "旧缓存设置 JSON 无效 {}：{error}",
                path.display()
            ));
        }
    };
    if settings.schema_version != LEGACY_CACHE_SETTINGS_VERSION {
        return SettingsRead::Failed(format!(
            "不支持的旧缓存设置版本 {}，当前版本为 {}",
            settings.schema_version, LEGACY_CACHE_SETTINGS_VERSION
        ));
    }
    SettingsRead::Loaded(settings.desired_root)
}

fn load_or_migrate_legacy(
    runtime_path: &Path,
    legacy_path: Option<&Path>,
    diagnostics: &mut Vec<RuntimeSettingsDiagnostic>,
) -> RuntimeSettings {
    let Some(legacy_path) = legacy_path else {
        return RuntimeSettings::default();
    };
    let cache_root = match read_legacy_cache_settings(legacy_path) {
        SettingsRead::Missing => return RuntimeSettings::default(),
        SettingsRead::Loaded(cache_root) => cache_root,
        SettingsRead::Failed(message) => {
            diagnostics.push(RuntimeSettingsDiagnostic {
                source_path: legacy_path.to_path_buf(),
                preserved_path: Some(legacy_path.to_path_buf()),
                message,
            });
            return RuntimeSettings::default();
        }
    };
    let settings = RuntimeSettings {
        cache_root,
        ..RuntimeSettings::default()
    };
    if let Err(error) = write_settings_atomically(runtime_path, &settings) {
        diagnostics.push(RuntimeSettingsDiagnostic {
            source_path: legacy_path.to_path_buf(),
            preserved_path: Some(legacy_path.to_path_buf()),
            message: format!("迁移旧缓存设置失败：{error}"),
        });
    }
    settings
}

fn preserve_corrupt_primary(path: &Path) -> io::Result<PathBuf> {
    let parent = path
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let sequence = SETTINGS_WRITE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(RUNTIME_SETTINGS_FILE_NAME);
    let preserved_path = parent.join(format!(
        ".{file_name}.corrupt-{}-{sequence}",
        std::process::id()
    ));
    fs::rename(path, &preserved_path)?;
    Ok(preserved_path)
}

fn write_settings_atomically(
    settings_path: &Path,
    settings: &RuntimeSettings,
) -> Result<(), RuntimeSettingsError> {
    let parent = settings_path
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent).map_err(|source| RuntimeSettingsError::Io {
        operation: "创建原生设置目录",
        path: parent.to_path_buf(),
        source,
    })?;
    let mut payload =
        serde_json::to_vec_pretty(settings).map_err(|source| RuntimeSettingsError::Encoding {
            path: settings_path.to_path_buf(),
            source,
        })?;
    payload.push(b'\n');
    let sequence = SETTINGS_WRITE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let file_name = settings_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(RUNTIME_SETTINGS_FILE_NAME);
    let temporary_path = parent.join(format!(
        ".{file_name}.tmp-{}-{sequence}",
        std::process::id()
    ));
    let mut temporary = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary_path)
        .map_err(|source| RuntimeSettingsError::Io {
            operation: "创建原生设置临时文件",
            path: temporary_path.clone(),
            source,
        })?;
    let write_result = temporary
        .write_all(&payload)
        .and_then(|_| temporary.sync_all());
    drop(temporary);
    if let Err(source) = write_result {
        let _ = fs::remove_file(&temporary_path);
        return Err(RuntimeSettingsError::Io {
            operation: "写入原生设置临时文件",
            path: temporary_path,
            source,
        });
    }
    if let Err(source) = atomic_replace_file(&temporary_path, settings_path) {
        let _ = fs::remove_file(&temporary_path);
        return Err(RuntimeSettingsError::Io {
            operation: "原子替换原生设置",
            path: settings_path.to_path_buf(),
            source,
        });
    }
    Ok(())
}

#[cfg(windows)]
fn atomic_replace_file(source: &Path, destination: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;

    const MOVEFILE_REPLACE_EXISTING: u32 = 0x0000_0001;
    const MOVEFILE_WRITE_THROUGH: u32 = 0x0000_0008;

    #[link(name = "Kernel32")]
    extern "system" {
        fn MoveFileExW(
            lp_existing_file_name: *const u16,
            lp_new_file_name: *const u16,
            dw_flags: u32,
        ) -> i32;
    }

    let source_wide: Vec<u16> = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let destination_wide: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let result = unsafe {
        MoveFileExW(
            source_wide.as_ptr(),
            destination_wide.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn atomic_replace_file(source: &Path, destination: &Path) -> io::Result<()> {
    fs::rename(source, destination)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        sync::atomic::{AtomicU64, Ordering},
    };

    static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    struct TestDirectory {
        path: PathBuf,
    }

    impl TestDirectory {
        fn new(label: &str) -> Self {
            let sequence = TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "mineradio-runtime-settings-{label}-{}-{sequence}",
                std::process::id()
            ));
            let _ = fs::remove_dir_all(&path);
            fs::create_dir_all(&path).expect("应创建测试目录");
            Self { path }
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    #[test]
    fn versioned_settings_round_trip_atomically_without_temp_residue() {
        let test_dir = TestDirectory::new("round-trip");
        let settings_path = test_dir.path.join("settings/runtime-settings.json");
        let cache_root = test_dir.path.join("custom-cache");
        let mut store = RuntimeSettingsStore::with_path(&settings_path);

        assert_eq!(store.snapshot(), RuntimeSettings::default());
        store
            .set_close_behavior(CloseBehavior::Tray)
            .expect("应持久化关闭行为");
        store
            .set_cache_root(Some(cache_root.clone()))
            .expect("应持久化缓存目录");

        let persisted: serde_json::Value =
            serde_json::from_slice(&fs::read(&settings_path).expect("应读取原生设置"))
                .expect("原生设置应是完整 JSON");
        assert_eq!(persisted["version"], RUNTIME_SETTINGS_VERSION);
        assert_eq!(persisted["closeBehavior"], "tray");
        assert_eq!(
            persisted["cacheRoot"],
            serde_json::Value::String(cache_root.to_string_lossy().into_owned())
        );

        let reloaded = RuntimeSettingsStore::with_path(&settings_path);
        assert_eq!(reloaded.snapshot().close_behavior, CloseBehavior::Tray);
        assert_eq!(reloaded.snapshot().cache_root, Some(cache_root));
        let temporary_count = fs::read_dir(settings_path.parent().expect("设置目录"))
            .expect("应读取设置目录")
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().contains(".tmp-"))
            .count();
        assert_eq!(temporary_count, 0);
    }

    #[test]
    fn desktop_lyrics_user_bounds_survive_runtime_restart() {
        let test_dir = TestDirectory::new("desktop-lyrics-bounds");
        let settings_path = test_dir.path.join(RUNTIME_SETTINGS_FILE_NAME);
        let bounds = crate::runtime::window::WindowGeometry {
            x: -1460,
            y: 420,
            width: 1180,
            height: 360,
        };
        let mut store = RuntimeSettingsStore::with_path(&settings_path);

        store
            .set_desktop_lyrics_bounds(Some(bounds))
            .expect("应持久化桌面歌词用户位置");

        let reopened = RuntimeSettingsStore::with_path(&settings_path);
        assert_eq!(reopened.snapshot().desktop_lyrics_bounds, Some(bounds));
    }

    #[test]
    fn full_desktop_mode_defaults_to_disabled_and_round_trips() {
        let test_dir = TestDirectory::new("full-desktop-mode");
        let settings_path = test_dir.path.join(RUNTIME_SETTINGS_FILE_NAME);
        let mut store = RuntimeSettingsStore::with_path(&settings_path);

        assert_eq!(
            store.snapshot().full_desktop_mode,
            crate::runtime::full_desktop::FullDesktopMode::Disabled
        );
        store
            .set_full_desktop_mode(crate::runtime::full_desktop::FullDesktopMode::Interactive)
            .expect("应持久化完整桌面模式");

        let reopened = RuntimeSettingsStore::with_path(&settings_path);
        assert_eq!(
            reopened.snapshot().full_desktop_mode,
            crate::runtime::full_desktop::FullDesktopMode::Interactive
        );
    }

    #[test]
    fn v1_settings_are_loaded_without_loss_and_upgraded_on_next_persist() {
        let test_dir = TestDirectory::new("v1-migration");
        let settings_path = test_dir.path.join(RUNTIME_SETTINGS_FILE_NAME);
        let cache_root = test_dir.path.join("legacy-cache");
        let bounds = crate::runtime::window::WindowGeometry {
            x: -1440,
            y: 260,
            width: 1120,
            height: 340,
        };
        fs::write(
            &settings_path,
            serde_json::to_vec_pretty(&serde_json::json!({
                "version": 1,
                "closeBehavior": "tray",
                "cacheRoot": cache_root,
                "desktopLyricsBounds": bounds,
            }))
            .expect("应编码 v1 原生设置"),
        )
        .expect("应写入 v1 原生设置");

        let mut store = RuntimeSettingsStore::with_path(&settings_path);
        let loaded = store.snapshot();
        assert_eq!(loaded.version, RUNTIME_SETTINGS_VERSION);
        assert_eq!(loaded.close_behavior, CloseBehavior::Tray);
        assert_eq!(loaded.cache_root.as_deref(), Some(cache_root.as_path()));
        assert_eq!(loaded.desktop_lyrics_bounds, Some(bounds));
        assert_eq!(
            loaded.full_desktop_mode,
            crate::runtime::full_desktop::FullDesktopMode::Disabled
        );
        let before_persist: serde_json::Value =
            serde_json::from_slice(&fs::read(&settings_path).expect("应读取 v1 设置"))
                .expect("v1 设置应保持完整 JSON");
        assert_eq!(before_persist["version"], 1);

        store
            .set_full_desktop_mode(crate::runtime::full_desktop::FullDesktopMode::Passive)
            .expect("应在下一次持久化升级 v1 设置");
        let persisted: serde_json::Value =
            serde_json::from_slice(&fs::read(&settings_path).expect("应读取升级后的设置"))
                .expect("升级后的设置应是完整 JSON");
        assert_eq!(persisted["version"], RUNTIME_SETTINGS_VERSION);
        assert_eq!(persisted["closeBehavior"], "tray");
        assert_eq!(
            persisted["cacheRoot"],
            serde_json::Value::String(cache_root.to_string_lossy().into_owned())
        );
        assert_eq!(persisted["desktopLyricsBounds"]["x"], -1440);
        assert_eq!(persisted["fullDesktopMode"], "passive");
    }

    #[test]
    fn legacy_cache_settings_are_migrated_once_into_the_single_native_store() {
        let test_dir = TestDirectory::new("legacy-cache-migration");
        let legacy_path = test_dir.path.join(LEGACY_CACHE_SETTINGS_FILE_NAME);
        let runtime_path = test_dir.path.join(RUNTIME_SETTINGS_FILE_NAME);
        let cache_root = test_dir.path.join("legacy-custom-cache");
        fs::write(
            &legacy_path,
            serde_json::to_vec_pretty(&serde_json::json!({
                "schemaVersion": 1,
                "desiredRoot": cache_root,
            }))
            .expect("应编码旧缓存设置"),
        )
        .expect("应写入旧缓存设置");

        let store = RuntimeSettingsStore::for_app_data(&test_dir.path);

        assert_eq!(store.snapshot().close_behavior, CloseBehavior::Exit);
        assert_eq!(
            store.snapshot().cache_root.as_deref(),
            Some(cache_root.as_path())
        );
        assert!(legacy_path.is_file());
        let migrated: RuntimeSettings =
            serde_json::from_slice(&fs::read(&runtime_path).expect("应写入统一原生设置"))
                .expect("迁移结果应可读取");
        assert_eq!(migrated, store.snapshot());

        fs::write(
            &legacy_path,
            br#"{"schemaVersion":1,"desiredRoot":"C:/must-not-win"}"#,
        )
        .expect("应修改仅用于验证的旧文件");
        let reloaded = RuntimeSettingsStore::for_app_data(&test_dir.path);
        assert_eq!(
            reloaded.snapshot().cache_root.as_deref(),
            Some(cache_root.as_path())
        );
    }

    #[test]
    fn corrupt_primary_is_preserved_and_defaults_do_not_block_startup_or_recovery() {
        let test_dir = TestDirectory::new("corrupt-primary");
        let settings_path = test_dir.path.join(RUNTIME_SETTINGS_FILE_NAME);
        let corrupt_bytes = b"{not-json";
        fs::write(&settings_path, corrupt_bytes).expect("应写入损坏原生设置");

        let mut store = RuntimeSettingsStore::for_app_data(&test_dir.path);

        assert_eq!(store.snapshot(), RuntimeSettings::default());
        assert_eq!(store.diagnostics().len(), 1);
        assert!(store.diagnostics()[0].message.contains("JSON"));
        let preserved_path = store.diagnostics()[0]
            .preserved_path
            .clone()
            .expect("损坏设置应保留为诊断副本");
        assert_eq!(
            fs::read(&preserved_path).expect("应读取损坏设置副本"),
            corrupt_bytes
        );
        assert!(!settings_path.exists());

        store
            .set_close_behavior(CloseBehavior::Tray)
            .expect("保留损坏副本后应允许写入新设置");
        let recovered = RuntimeSettingsStore::for_app_data(&test_dir.path);
        assert_eq!(recovered.snapshot().close_behavior, CloseBehavior::Tray);
        assert_eq!(
            fs::read(&preserved_path).expect("恢复后仍应保留损坏副本"),
            corrupt_bytes
        );
    }
}
