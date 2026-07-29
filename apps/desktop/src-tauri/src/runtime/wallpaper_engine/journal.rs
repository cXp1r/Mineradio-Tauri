//! Wallpaper Engine recovery journal。

use std::{fmt, fs, path::PathBuf, time::UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use super::{
    library::persist_bytes_transactionally,
    ownership::{
        same_executable, scene_location, validate_scene_ownership, validate_scene_replacement,
        ExecutableIdentity, OwnershipError, SceneOwnership,
    },
    project::is_valid_project_id,
};

pub const WALLPAPER_RECOVERY_JOURNAL_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WallpaperRecoveryPhase {
    Opening,
    Active,
    CleanupRequired,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WallpaperRecoveryJournal {
    pub version: u32,
    pub generation: u64,
    pub project_id: String,
    pub session_id: String,
    pub location: String,
    pub phase: WallpaperRecoveryPhase,
    pub expected: SceneOwnership,
    pub last_error: Option<String>,
    pub updated_at: u64,
}

impl WallpaperRecoveryJournal {
    pub fn opening(
        generation: u64,
        project_id: impl Into<String>,
        session_id: impl Into<String>,
        executable: ExecutableIdentity,
    ) -> Result<Self, WallpaperJournalError> {
        let project_id = project_id.into();
        let session_id = session_id.into();
        if !is_valid_project_id(&project_id) || !same_executable(&executable, &executable) {
            return Err(WallpaperJournalError::InvalidSchema);
        }
        let location = scene_location(&session_id)?;
        let journal = Self {
            version: WALLPAPER_RECOVERY_JOURNAL_VERSION,
            generation,
            project_id,
            session_id: session_id.clone(),
            location: location.clone(),
            phase: WallpaperRecoveryPhase::Opening,
            expected: SceneOwnership {
                session_id,
                location,
                executable,
                window: None,
                launched_process: None,
            },
            last_error: None,
            updated_at: unix_millis(),
        };
        journal.validate()?;
        Ok(journal)
    }

    pub fn mark_active(&mut self, ownership: SceneOwnership) -> Result<(), WallpaperJournalError> {
        validate_scene_ownership(&self.expected, &ownership)?;
        self.expected = ownership;
        self.phase = WallpaperRecoveryPhase::Active;
        self.last_error = None;
        self.updated_at = unix_millis();
        self.validate()
    }

    /// 在同一 session/location 内原子推进到重新验证的 HWND generation。
    pub fn mark_rebound(&mut self, ownership: SceneOwnership) -> Result<(), WallpaperJournalError> {
        validate_scene_replacement(&self.expected, &ownership)?;
        self.expected = ownership;
        self.phase = WallpaperRecoveryPhase::Active;
        self.last_error = None;
        self.updated_at = unix_millis();
        self.validate()
    }

    pub fn mark_cleanup_required(&mut self, error: impl Into<String>) {
        self.phase = WallpaperRecoveryPhase::CleanupRequired;
        self.last_error = Some(error.into().chars().take(160).collect());
        self.updated_at = unix_millis();
    }

    pub fn validate(&self) -> Result<(), WallpaperJournalError> {
        if self.version != WALLPAPER_RECOVERY_JOURNAL_VERSION {
            return Err(WallpaperJournalError::UnsupportedVersion(self.version));
        }
        if !is_valid_project_id(&self.project_id)
            || !is_valid_project_id(&self.session_id)
            || self.location != scene_location(&self.session_id)?
            || self.expected.session_id != self.session_id
            || self.expected.location != self.location
            || !same_executable(&self.expected.executable, &self.expected.executable)
        {
            return Err(WallpaperJournalError::InvalidSchema);
        }
        if self.phase == WallpaperRecoveryPhase::Active && self.expected.window.is_none() {
            return Err(WallpaperJournalError::InvalidSchema);
        }
        if let Some(window) = &self.expected.window {
            validate_scene_ownership(&self.expected, &self.expected)?;
            if window.title != self.location {
                return Err(WallpaperJournalError::InvalidSchema);
            }
        }
        Ok(())
    }
}

#[derive(Debug)]
pub enum WallpaperJournalError {
    Io(std::io::Error),
    Encoding(serde_json::Error),
    Ownership(OwnershipError),
    InvalidSchema,
    UnsupportedVersion(u32),
}

impl WallpaperJournalError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Io(_) => "WALLPAPER_ENGINE_JOURNAL_IO_FAILED",
            Self::Encoding(_) => "WALLPAPER_ENGINE_JOURNAL_INVALID",
            Self::Ownership(error) => error.code(),
            Self::InvalidSchema => "WALLPAPER_ENGINE_JOURNAL_SCHEMA_INVALID",
            Self::UnsupportedVersion(_) => "WALLPAPER_ENGINE_JOURNAL_VERSION_UNSUPPORTED",
        }
    }
}

impl fmt::Display for WallpaperJournalError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}", self.code())
    }
}

impl std::error::Error for WallpaperJournalError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(source) => Some(source),
            Self::Encoding(source) => Some(source),
            Self::Ownership(source) => Some(source),
            _ => None,
        }
    }
}

impl From<std::io::Error> for WallpaperJournalError {
    fn from(source: std::io::Error) -> Self {
        Self::Io(source)
    }
}

impl From<serde_json::Error> for WallpaperJournalError {
    fn from(source: serde_json::Error) -> Self {
        Self::Encoding(source)
    }
}

impl From<OwnershipError> for WallpaperJournalError {
    fn from(source: OwnershipError) -> Self {
        Self::Ownership(source)
    }
}

pub trait WallpaperRecoveryJournalStore: Send {
    fn load(&mut self) -> Result<Option<WallpaperRecoveryJournal>, WallpaperJournalError>;
    fn write_before_mutation(
        &mut self,
        journal: &WallpaperRecoveryJournal,
    ) -> Result<(), WallpaperJournalError>;
    fn clear(&mut self) -> Result<(), WallpaperJournalError>;
}

pub struct FileWallpaperRecoveryJournalStore {
    path: PathBuf,
}

impl FileWallpaperRecoveryJournalStore {
    pub fn with_path(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    pub fn for_app_data(app_data: impl Into<PathBuf>) -> Self {
        Self::with_path(app_data.into().join("wallpaper-engine-recovery-v1.json"))
    }

    pub fn path(&self) -> &std::path::Path {
        &self.path
    }
}

impl WallpaperRecoveryJournalStore for FileWallpaperRecoveryJournalStore {
    fn load(&mut self) -> Result<Option<WallpaperRecoveryJournal>, WallpaperJournalError> {
        recover_backup_if_needed(&self.path)?;
        if !self.path.exists() {
            return Ok(None);
        }
        let journal = serde_json::from_slice::<WallpaperRecoveryJournal>(&fs::read(&self.path)?)?;
        journal.validate()?;
        Ok(Some(journal))
    }

    fn write_before_mutation(
        &mut self,
        journal: &WallpaperRecoveryJournal,
    ) -> Result<(), WallpaperJournalError> {
        journal.validate()?;
        let mut payload = serde_json::to_vec_pretty(journal)?;
        payload.push(b'\n');
        persist_bytes_transactionally(&self.path, &payload)?;
        Ok(())
    }

    fn clear(&mut self) -> Result<(), WallpaperJournalError> {
        if self.path.exists() {
            fs::remove_file(&self.path)?;
        }
        let backup = backup_path(&self.path);
        if backup.exists() {
            fs::remove_file(backup)?;
        }
        Ok(())
    }
}

fn backup_path(path: &std::path::Path) -> PathBuf {
    let mut value = path.as_os_str().to_os_string();
    value.push(".bak");
    PathBuf::from(value)
}

fn recover_backup_if_needed(path: &std::path::Path) -> Result<(), std::io::Error> {
    let backup = backup_path(path);
    if !path.exists() && backup.exists() {
        fs::rename(backup, path)?;
    }
    Ok(())
}

fn unix_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| u64::try_from(value.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use std::{fs, path::PathBuf, time::SystemTime};

    use super::{
        FileWallpaperRecoveryJournalStore, WallpaperRecoveryJournal, WallpaperRecoveryJournalStore,
    };
    use crate::runtime::wallpaper_engine::ownership::ExecutableIdentity;

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new(label: &str) -> Self {
            let mut path = std::env::temp_dir();
            path.push(format!(
                "mineradio-m7-journal-{label}-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(SystemTime::UNIX_EPOCH)
                    .expect("系统时间应有效")
                    .as_nanos()
            ));
            fs::create_dir_all(&path).expect("应创建 journal 测试目录");
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn recovery_journal_round_trips_and_is_cleared_only_explicitly() {
        let directory = TestDirectory::new("round-trip");
        let path = directory.0.join("wallpaper-engine-recovery-v1.json");
        let executable = ExecutableIdentity {
            canonical_path: PathBuf::from(r"C:\Steam\wallpaper64.exe"),
            file_size: 42,
            modified_unix_millis: 8,
        };
        let journal = WallpaperRecoveryJournal::opening(
            9,
            "aaaaaaaaaaaaaaaaaaaaaaaa",
            "bbbbbbbbbbbbbbbbbbbbbbbb",
            executable,
        )
        .expect("有效 identity 应创建 journal");
        let mut store = FileWallpaperRecoveryJournalStore::with_path(&path);
        store
            .write_before_mutation(&journal)
            .expect("应原子写入 journal");

        let loaded = store
            .load()
            .expect("应读取 journal")
            .expect("journal 应存在");
        assert_eq!(loaded, journal);
        assert!(path.exists(), "读取不得清除恢复证据");

        store.clear().expect("明确成功恢复后应清除 journal");
        assert!(store.load().expect("清除后读取应成功").is_none());
    }

    #[test]
    fn unknown_journal_schema_is_retained_and_fails_closed() {
        let directory = TestDirectory::new("unknown-version");
        let path = directory.0.join("wallpaper-engine-recovery-v1.json");
        fs::write(
            &path,
            br#"{"version":99,"generation":1,"projectId":"aaaaaaaaaaaaaaaaaaaaaaaa","sessionId":"bbbbbbbbbbbbbbbbbbbbbbbb","location":"Mineradio Wallpaper bbbbbbbbbbbbbbbbbbbbbbbb","phase":"opening","expected":{"sessionId":"bbbbbbbbbbbbbbbbbbbbbbbb","location":"Mineradio Wallpaper bbbbbbbbbbbbbbbbbbbbbbbb","executable":{"canonicalPath":"C:\\Steam\\wallpaper64.exe","fileSize":42,"modifiedUnixMillis":8},"window":null,"launchedProcess":null},"lastError":null,"updatedAt":0}"#,
        )
        .expect("应写入未知版本 journal");
        let mut store = FileWallpaperRecoveryJournalStore::with_path(&path);
        let error = store.load().expect_err("未知 schema 不得被当作无 journal");
        assert_eq!(error.code(), "WALLPAPER_ENGINE_JOURNAL_VERSION_UNSUPPORTED");
        assert!(path.exists(), "未知 journal 必须保留给人工/新版本恢复");
    }
}
