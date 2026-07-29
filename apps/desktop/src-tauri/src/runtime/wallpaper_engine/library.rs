//! Wallpaper Engine library discovery 与持久化。

use std::{
    collections::{HashMap, HashSet, VecDeque},
    fmt, fs,
    io::Write,
    path::{Path, PathBuf},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};

use super::project::{
    classify_project, revalidate_native_scene, stable_project_id, validate_pkgv_header,
    ClassifiedProject, NativeSceneTarget, ProjectError, ProjectSource, ProjectSourceKind,
    WallpaperMediaType, WallpaperProjectRecord, WallpaperProjectSummary,
};

const CONFIG_VERSION: u32 = 1;
const DEFAULT_MAX_MANUAL_ROOTS: usize = 32;
const DEFAULT_MAX_MANUAL_PACKAGES: usize = 64;
const DEFAULT_MAX_SCAN_ENTRIES: usize = 4_000;
const DEFAULT_MAX_SCAN_DEPTH: usize = 3;
const DEFAULT_SNAPSHOT_TTL: Duration = Duration::from_secs(30);

#[derive(Debug, Clone)]
pub struct WallpaperLibraryOptions {
    pub max_manual_roots: usize,
    pub max_manual_packages: usize,
    pub max_scan_entries: usize,
    pub max_scan_depth: usize,
    pub snapshot_ttl: Duration,
}

impl Default for WallpaperLibraryOptions {
    fn default() -> Self {
        Self {
            max_manual_roots: DEFAULT_MAX_MANUAL_ROOTS,
            max_manual_packages: DEFAULT_MAX_MANUAL_PACKAGES,
            max_scan_entries: DEFAULT_MAX_SCAN_ENTRIES,
            max_scan_depth: DEFAULT_MAX_SCAN_DEPTH,
            snapshot_ttl: DEFAULT_SNAPSHOT_TTL,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WallpaperManualRootSummary {
    pub id: String,
    pub label: String,
    pub source: ProjectSourceKind,
    pub project_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WallpaperImportResult {
    pub root_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WallpaperLibrarySnapshot {
    pub projects: Vec<WallpaperProjectSummary>,
    pub roots: Vec<WallpaperManualRootSummary>,
    pub updated_at: u64,
    pub dynamic_count: usize,
    pub engine_playable_count: usize,
    pub preview_only_count: usize,
    pub scan_limited: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WallpaperMediaRole {
    Media,
    Preview,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WallpaperMediaAsset {
    pub path: PathBuf,
    pub media_type: WallpaperMediaType,
    pub content_length: u64,
    pub revision: u64,
}

#[derive(Debug)]
pub enum WallpaperLibraryError {
    Io(std::io::Error),
    Encoding(serde_json::Error),
    UnsupportedConfigVersion(u32),
    Project(ProjectError),
    RootNotFound,
    RootContainsNoProject,
    ManualRootLimit,
    ManualPackageLimit,
    ProjectFileInvalid,
    ScenePackageInvalid,
    ProjectNotFound,
    MediaNotFound,
}

impl WallpaperLibraryError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Io(_) => "WALLPAPER_LIBRARY_IO_FAILED",
            Self::Encoding(_) => "WALLPAPER_LIBRARY_CONFIG_INVALID",
            Self::UnsupportedConfigVersion(_) => "WALLPAPER_LIBRARY_CONFIG_VERSION_UNSUPPORTED",
            Self::Project(error) => error.code(),
            Self::RootNotFound => "WALLPAPER_LIBRARY_ROOT_NOT_FOUND",
            Self::RootContainsNoProject => "WALLPAPER_LIBRARY_ROOT_EMPTY",
            Self::ManualRootLimit => "WALLPAPER_LIBRARY_ROOT_LIMIT",
            Self::ManualPackageLimit => "WALLPAPER_LIBRARY_PACKAGE_LIMIT",
            Self::ProjectFileInvalid => "WALLPAPER_LIBRARY_PROJECT_FILE_INVALID",
            Self::ScenePackageInvalid => "WALLPAPER_SCENE_PACKAGE_INVALID",
            Self::ProjectNotFound => "WALLPAPER_PROJECT_NOT_FOUND",
            Self::MediaNotFound => "WALLPAPER_MEDIA_NOT_FOUND",
        }
    }
}

impl fmt::Display for WallpaperLibraryError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}", self.code())
    }
}

impl std::error::Error for WallpaperLibraryError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(source) => Some(source),
            Self::Encoding(source) => Some(source),
            Self::Project(source) => Some(source),
            _ => None,
        }
    }
}

impl From<std::io::Error> for WallpaperLibraryError {
    fn from(source: std::io::Error) -> Self {
        Self::Io(source)
    }
}

impl From<serde_json::Error> for WallpaperLibraryError {
    fn from(source: serde_json::Error) -> Self {
        Self::Encoding(source)
    }
}

impl From<ProjectError> for WallpaperLibraryError {
    fn from(source: ProjectError) -> Self {
        Self::Project(source)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedManualRoot {
    id: String,
    path: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WallpaperLibraryConfig {
    version: u32,
    manual_roots: Vec<PersistedManualRoot>,
    manual_project_files: Vec<PathBuf>,
}

impl Default for WallpaperLibraryConfig {
    fn default() -> Self {
        Self {
            version: CONFIG_VERSION,
            manual_roots: Vec::new(),
            manual_project_files: Vec::new(),
        }
    }
}

#[derive(Debug, Clone)]
struct ScanOutcome {
    projects: Vec<PathBuf>,
    limited: bool,
}

pub struct WallpaperLibrary {
    config_path: PathBuf,
    config: WallpaperLibraryConfig,
    options: WallpaperLibraryOptions,
    records: HashMap<String, WallpaperProjectRecord>,
    snapshot: Option<WallpaperLibrarySnapshot>,
    snapshot_created: Option<Instant>,
    root_project_counts: HashMap<String, usize>,
}

impl WallpaperLibrary {
    pub fn open(config_path: impl Into<PathBuf>) -> Result<Self, WallpaperLibraryError> {
        Self::open_with_options(config_path, WallpaperLibraryOptions::default())
    }

    pub fn open_with_options(
        config_path: impl Into<PathBuf>,
        options: WallpaperLibraryOptions,
    ) -> Result<Self, WallpaperLibraryError> {
        let config_path = config_path.into();
        recover_backup_if_needed(&config_path)?;
        let config = if config_path.exists() {
            let config =
                serde_json::from_slice::<WallpaperLibraryConfig>(&fs::read(&config_path)?)?;
            if config.version != CONFIG_VERSION {
                return Err(WallpaperLibraryError::UnsupportedConfigVersion(
                    config.version,
                ));
            }
            config
        } else {
            WallpaperLibraryConfig::default()
        };
        if config.manual_roots.len() > options.max_manual_roots
            || config.manual_project_files.len() > options.max_manual_packages
        {
            return Err(WallpaperLibraryError::UnsupportedConfigVersion(
                config.version,
            ));
        }
        Ok(Self {
            config_path,
            config,
            options,
            records: HashMap::new(),
            snapshot: None,
            snapshot_created: None,
            root_project_counts: HashMap::new(),
        })
    }

    pub fn manual_root_summaries(&self) -> Vec<WallpaperManualRootSummary> {
        self.config
            .manual_roots
            .iter()
            .map(|root| WallpaperManualRootSummary {
                id: root.id.clone(),
                label: root
                    .path
                    .file_name()
                    .and_then(|value| value.to_str())
                    .filter(|value| !value.is_empty())
                    .unwrap_or("导入目录")
                    .chars()
                    .take(160)
                    .collect(),
                source: ProjectSourceKind::Imported,
                project_count: self.root_project_counts.get(&root.id).copied().unwrap_or(0),
            })
            .collect()
    }

    pub fn add_manual_root(
        &mut self,
        root: &Path,
    ) -> Result<WallpaperImportResult, WallpaperLibraryError> {
        let canonical = fs::canonicalize(root).map_err(|_| WallpaperLibraryError::RootNotFound)?;
        if !canonical.is_dir() {
            return Err(WallpaperLibraryError::RootNotFound);
        }
        let scan = scan_manual_project_directories(&canonical, &self.options);
        if scan.projects.is_empty() {
            return Err(WallpaperLibraryError::RootContainsNoProject);
        }
        let root_id = stable_project_id(&canonical)?;
        if !self
            .config
            .manual_roots
            .iter()
            .any(|entry| entry.id == root_id)
        {
            if self.config.manual_roots.len() >= self.options.max_manual_roots {
                return Err(WallpaperLibraryError::ManualRootLimit);
            }
            self.config.manual_roots.push(PersistedManualRoot {
                id: root_id.clone(),
                path: canonical,
            });
            self.persist_config()?;
            self.invalidate_snapshot();
        }
        Ok(WallpaperImportResult { root_id })
    }

    pub fn add_manual_project_file(
        &mut self,
        file: &Path,
    ) -> Result<WallpaperImportResult, WallpaperLibraryError> {
        let canonical =
            fs::canonicalize(file).map_err(|_| WallpaperLibraryError::ProjectFileInvalid)?;
        if !canonical.is_file() {
            return Err(WallpaperLibraryError::ProjectFileInvalid);
        }
        if canonical
            .file_name()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.eq_ignore_ascii_case("project.json"))
        {
            return self.add_manual_root(
                canonical
                    .parent()
                    .ok_or(WallpaperLibraryError::ProjectFileInvalid)?,
            );
        }
        let extension = canonical
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        if !matches!(extension.to_ascii_lowercase().as_str(), "pkg" | "pak")
            || !validate_pkgv_header(&canonical)?
        {
            return Err(WallpaperLibraryError::ScenePackageInvalid);
        }
        let root = canonical
            .parent()
            .ok_or(WallpaperLibraryError::ProjectFileInvalid)?;
        let source = ProjectSource::new(root, ProjectSourceKind::Imported, "手动导入", false);
        let project = classify_project(root, &source, Some(&canonical))?
            .filter(|value| value.summary.engine_playable)
            .ok_or(WallpaperLibraryError::ScenePackageInvalid)?;
        let root_id = stable_project_id(root)?;
        let root_exists = self
            .config
            .manual_roots
            .iter()
            .any(|entry| entry.id == root_id);
        let package_exists = self
            .config
            .manual_project_files
            .iter()
            .any(|entry| path_key(entry) == path_key(&canonical));
        if !root_exists && self.config.manual_roots.len() >= self.options.max_manual_roots {
            return Err(WallpaperLibraryError::ManualRootLimit);
        }
        if !package_exists
            && self.config.manual_project_files.len() >= self.options.max_manual_packages
        {
            return Err(WallpaperLibraryError::ManualPackageLimit);
        }
        if !root_exists {
            self.config.manual_roots.push(PersistedManualRoot {
                id: root_id.clone(),
                path: project.record.project_root.clone(),
            });
        }
        if !package_exists {
            self.config.manual_project_files.push(canonical);
        }
        self.persist_config()?;
        self.invalidate_snapshot();
        Ok(WallpaperImportResult { root_id })
    }

    pub fn remove_manual_root(&mut self, root_id: &str) -> Result<bool, WallpaperLibraryError> {
        let removed_paths = self
            .config
            .manual_roots
            .iter()
            .filter(|entry| entry.id == root_id)
            .map(|entry| entry.path.clone())
            .collect::<Vec<_>>();
        if removed_paths.is_empty() {
            return Ok(false);
        }
        self.config.manual_roots.retain(|entry| entry.id != root_id);
        self.config.manual_project_files.retain(|file| {
            !removed_paths
                .iter()
                .any(|root| path_is_inside_by_key(root, file))
        });
        self.persist_config()?;
        self.root_project_counts.remove(root_id);
        self.invalidate_snapshot();
        Ok(true)
    }

    pub fn scan(
        &mut self,
        automatic_sources: &[ProjectSource],
        force: bool,
    ) -> Result<WallpaperLibrarySnapshot, WallpaperLibraryError> {
        if !force
            && self
                .snapshot_created
                .is_some_and(|created| created.elapsed() <= self.options.snapshot_ttl)
        {
            if let Some(snapshot) = &self.snapshot {
                return Ok(snapshot.clone());
            }
        }

        let mut sources = Vec::new();
        let mut seen_sources = HashSet::new();
        for source in automatic_sources {
            let key = path_key(&source.root);
            if !key.is_empty() && seen_sources.insert(key) {
                sources.push(source.clone());
            }
        }
        for root in &self.config.manual_roots {
            let key = path_key(&root.path);
            if !key.is_empty() && seen_sources.insert(key) {
                sources.push(ProjectSource::new(
                    &root.path,
                    ProjectSourceKind::Imported,
                    "手动导入",
                    false,
                ));
            }
        }

        let package_by_root = self
            .config
            .manual_project_files
            .iter()
            .filter_map(|file| file.parent().map(|root| (path_key(root), file.clone())))
            .collect::<HashMap<_, _>>();
        let mut project_sources = Vec::new();
        let mut seen_projects = HashSet::new();
        let mut scan_limited = false;
        for source in sources {
            let outcome = if source.direct {
                ScanOutcome {
                    projects: direct_project_directories(&source.root),
                    limited: false,
                }
            } else {
                scan_manual_project_directories(&source.root, &self.options)
            };
            scan_limited |= outcome.limited;
            for project_root in outcome.projects {
                let key = path_key(&project_root);
                if !key.is_empty() && seen_projects.insert(key) {
                    project_sources.push((project_root, source.clone()));
                }
            }
        }

        let mut classified = Vec::<ClassifiedProject>::new();
        for (project_root, source) in project_sources {
            let package = package_by_root
                .get(&path_key(&project_root))
                .map(PathBuf::as_path);
            if let Ok(Some(project)) = classify_project(&project_root, &source, package) {
                classified.push(project);
            }
        }
        classified.sort_by(|left, right| {
            right
                .summary
                .playable
                .cmp(&left.summary.playable)
                .then_with(|| {
                    right
                        .summary
                        .engine_playable
                        .cmp(&left.summary.engine_playable)
                })
                .then_with(|| left.summary.title.cmp(&right.summary.title))
        });
        self.records = classified
            .iter()
            .map(|project| (project.summary.id.clone(), project.record.clone()))
            .collect();
        self.root_project_counts = self
            .config
            .manual_roots
            .iter()
            .map(|root| {
                let count = classified
                    .iter()
                    .filter(|project| {
                        path_is_inside_by_key(&root.path, &project.record.project_root)
                    })
                    .count();
                (root.id.clone(), count)
            })
            .collect();
        let projects = classified
            .into_iter()
            .map(|project| project.summary)
            .collect::<Vec<_>>();
        let snapshot = WallpaperLibrarySnapshot {
            dynamic_count: projects
                .iter()
                .filter(|project| {
                    project.playable && project.media_type == Some(WallpaperMediaType::Video)
                })
                .count(),
            engine_playable_count: projects
                .iter()
                .filter(|project| project.engine_playable)
                .count(),
            preview_only_count: projects
                .iter()
                .filter(|project| project.preview_only)
                .count(),
            projects,
            roots: self.manual_root_summaries(),
            updated_at: unix_millis(),
            scan_limited,
        };
        self.snapshot = Some(snapshot.clone());
        self.snapshot_created = Some(Instant::now());
        Ok(snapshot)
    }

    pub fn snapshot(&self) -> Option<&WallpaperLibrarySnapshot> {
        self.snapshot.as_ref()
    }

    pub fn project_summary(&self, id: &str) -> Option<&WallpaperProjectSummary> {
        self.snapshot
            .as_ref()?
            .projects
            .iter()
            .find(|project| project.id == id)
    }

    pub fn native_scene_target(
        &self,
        id: &str,
    ) -> Result<NativeSceneTarget, WallpaperLibraryError> {
        let record = self
            .records
            .get(id)
            .ok_or(WallpaperLibraryError::ProjectNotFound)?;
        revalidate_native_scene(id, record).map_err(Into::into)
    }

    pub fn resolve_media_asset(
        &self,
        id: &str,
        role: WallpaperMediaRole,
    ) -> Result<WallpaperMediaAsset, WallpaperLibraryError> {
        let record = self
            .records
            .get(id)
            .ok_or(WallpaperLibraryError::ProjectNotFound)?;
        let candidate = match role {
            WallpaperMediaRole::Media => record.media.as_ref(),
            WallpaperMediaRole::Preview => record.preview.as_ref(),
        }
        .ok_or(WallpaperLibraryError::MediaNotFound)?;
        let root = fs::canonicalize(&record.project_root)?;
        let path = fs::canonicalize(candidate)?;
        if !path.starts_with(root) {
            return Err(WallpaperLibraryError::MediaNotFound);
        }
        let metadata = fs::metadata(&path)?;
        if !metadata.is_file() || metadata.len() == 0 {
            return Err(WallpaperLibraryError::MediaNotFound);
        }
        let extension = path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        let media_type = match extension.as_str() {
            "jpg" | "jpeg" | "png" | "webp" | "gif" => WallpaperMediaType::Image,
            "mp4" | "webm" | "m4v" | "mov" => WallpaperMediaType::Video,
            _ => return Err(WallpaperLibraryError::MediaNotFound),
        };
        let revision = metadata
            .modified()
            .ok()
            .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
            .map(|value| u64::try_from(value.as_millis()).unwrap_or(u64::MAX))
            .unwrap_or(0);
        Ok(WallpaperMediaAsset {
            path,
            media_type,
            content_length: metadata.len(),
            revision,
        })
    }

    fn persist_config(&self) -> Result<(), WallpaperLibraryError> {
        let mut payload = serde_json::to_vec_pretty(&self.config)?;
        payload.push(b'\n');
        persist_bytes_transactionally(&self.config_path, &payload)?;
        Ok(())
    }

    fn invalidate_snapshot(&mut self) {
        self.snapshot = None;
        self.snapshot_created = None;
        self.records.clear();
    }
}

fn direct_project_directories(container: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(container) else {
        return Vec::new();
    };
    entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let path = entry.path();
            (entry.file_type().ok()?.is_dir() && path.join("project.json").is_file())
                .then_some(path)
        })
        .collect()
}

fn scan_manual_project_directories(root: &Path, options: &WallpaperLibraryOptions) -> ScanOutcome {
    if !root.is_dir() {
        return ScanOutcome {
            projects: Vec::new(),
            limited: false,
        };
    }
    if root.join("project.json").is_file() {
        return ScanOutcome {
            projects: vec![root.to_path_buf()],
            limited: false,
        };
    }
    let known_containers = [
        root.join("steamapps/workshop/content/431960"),
        root.join("steamapps/common/wallpaper_engine/projects/myprojects"),
    ];
    let known = known_containers
        .iter()
        .flat_map(|container| direct_project_directories(container))
        .collect::<Vec<_>>();
    if !known.is_empty() {
        return ScanOutcome {
            projects: known,
            limited: false,
        };
    }

    let mut projects = Vec::new();
    let mut queue = VecDeque::from([(root.to_path_buf(), 0_usize)]);
    let mut visited = 0_usize;
    let mut limited = false;
    while let Some((directory, depth)) = queue.pop_front() {
        let Ok(entries) = fs::read_dir(directory) else {
            continue;
        };
        for entry in entries.filter_map(Result::ok) {
            if visited >= options.max_scan_entries {
                limited = true;
                break;
            }
            visited += 1;
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.')
                || matches!(
                    name.to_ascii_lowercase().as_str(),
                    "node_modules" | "cache" | "temp" | "tmp"
                )
                || !entry.file_type().is_ok_and(|kind| kind.is_dir())
            {
                continue;
            }
            let child = entry.path();
            if child.join("project.json").is_file() {
                projects.push(child);
            } else if depth + 1 < options.max_scan_depth {
                queue.push_back((child, depth + 1));
            }
        }
        if limited {
            break;
        }
    }
    ScanOutcome { projects, limited }
}

fn path_key(path: &Path) -> String {
    let candidate = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let mut value = candidate.to_string_lossy().replace('\\', "/");
    while value.ends_with('/') {
        value.pop();
    }
    value.make_ascii_lowercase();
    value
}

fn path_is_inside_by_key(root: &Path, target: &Path) -> bool {
    let root = path_key(root);
    let target = path_key(target);
    target == root
        || target
            .strip_prefix(&root)
            .is_some_and(|suffix| suffix.starts_with('/'))
}

fn unix_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| u64::try_from(value.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

fn backup_path(path: &Path) -> PathBuf {
    let mut value = path.as_os_str().to_os_string();
    value.push(".bak");
    PathBuf::from(value)
}

fn temporary_path(path: &Path) -> PathBuf {
    let mut value = path.as_os_str().to_os_string();
    value.push(format!(".{}.{}.tmp", std::process::id(), unix_millis()));
    PathBuf::from(value)
}

fn recover_backup_if_needed(path: &Path) -> Result<(), std::io::Error> {
    let backup = backup_path(path);
    if !path.exists() && backup.exists() {
        fs::rename(backup, path)?;
    }
    Ok(())
}

pub(crate) fn persist_bytes_transactionally(
    path: &Path,
    payload: &[u8],
) -> Result<(), std::io::Error> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)?;
    let temporary = temporary_path(path);
    let backup = backup_path(path);
    let result = (|| {
        let mut file = fs::File::create(&temporary)?;
        file.write_all(payload)?;
        file.sync_all()?;
        drop(file);
        if path.exists() {
            if backup.exists() {
                fs::remove_file(&backup)?;
            }
            fs::rename(path, &backup)?;
        }
        if let Err(error) = fs::rename(&temporary, path) {
            if !path.exists() && backup.exists() {
                let _ = fs::rename(&backup, path);
            }
            return Err(error);
        }
        if backup.exists() {
            fs::remove_file(&backup)?;
        }
        Ok(())
    })();
    if temporary.exists() {
        let _ = fs::remove_file(temporary);
    }
    result
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::PathBuf,
        time::{Duration, SystemTime},
    };

    use super::{WallpaperLibrary, WallpaperLibraryOptions, WallpaperMediaRole};
    use crate::runtime::wallpaper_engine::project::{
        ProjectSource, ProjectSourceKind, WallpaperMediaType,
    };

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new(label: &str) -> Self {
            let mut path = std::env::temp_dir();
            path.push(format!(
                "mineradio-m7-library-{label}-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(SystemTime::UNIX_EPOCH)
                    .expect("系统时间应有效")
                    .as_nanos()
            ));
            fs::create_dir_all(&path).expect("应创建 library 测试目录");
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn imported_root_is_persisted_and_exposed_without_raw_path() {
        let directory = TestDirectory::new("persist-root");
        let project = directory.0.join("project");
        fs::create_dir_all(&project).expect("应创建项目目录");
        fs::write(project.join("preview.jpg"), b"preview").expect("应写入预览");
        fs::write(
            project.join("project.json"),
            r#"{"title":"持久项目","type":"web","preview":"preview.jpg"}"#,
        )
        .expect("应写入 project.json");
        let config_path = directory.0.join("wallpaper-engine-library-v1.json");

        let mut library = WallpaperLibrary::open(&config_path).expect("应打开空库");
        let imported = library
            .add_manual_root(&project)
            .expect("有效项目根应可导入");
        assert_eq!(imported.root_id.len(), 24);

        let reopened = WallpaperLibrary::open(&config_path).expect("重启后应恢复库配置");
        let roots = reopened.manual_root_summaries();
        assert_eq!(roots.len(), 1);
        assert_eq!(roots[0].id, imported.root_id);
        assert_eq!(roots[0].label, "project");
        assert_eq!(roots[0].project_count, 0);

        let serialized = serde_json::to_value(&roots[0]).expect("root DTO 应可序列化");
        assert!(
            serialized.get("path").is_none(),
            "Web root DTO 不得暴露 raw path"
        );
    }

    #[test]
    fn manual_scan_stops_at_configured_entry_budget() {
        let directory = TestDirectory::new("bounded-scan");
        let nested = directory.0.join("one/two/project");
        fs::create_dir_all(&nested).expect("应创建嵌套项目");
        fs::write(nested.join("preview.jpg"), b"preview").expect("应写入预览");
        fs::write(
            nested.join("project.json"),
            r#"{"title":"预算外项目","type":"web","preview":"preview.jpg"}"#,
        )
        .expect("应写入 manifest");
        let options = WallpaperLibraryOptions {
            max_scan_entries: 0,
            snapshot_ttl: Duration::ZERO,
            ..WallpaperLibraryOptions::default()
        };
        let mut library =
            WallpaperLibrary::open_with_options(directory.0.join("library.json"), options)
                .expect("应打开 bounded library");
        let snapshot = library
            .scan(
                &[ProjectSource::new(
                    &directory.0,
                    ProjectSourceKind::Imported,
                    "测试源",
                    false,
                )],
                true,
            )
            .expect("bounded scan 应返回 snapshot");
        assert!(snapshot.scan_limited);
        assert!(snapshot.projects.is_empty());
    }

    #[test]
    fn snapshot_counts_projects_per_removable_root() {
        let directory = TestDirectory::new("root-count");
        let project = directory.0.join("project");
        fs::create_dir_all(&project).expect("应创建项目");
        fs::write(project.join("preview.jpg"), b"preview").expect("应写入预览");
        fs::write(
            project.join("project.json"),
            r#"{"title":"项目","type":"web","preview":"preview.jpg"}"#,
        )
        .expect("应写入 manifest");
        let mut library =
            WallpaperLibrary::open(directory.0.join("library.json")).expect("应打开 library");
        let imported = library.add_manual_root(&project).expect("应导入 root");
        let snapshot = library.scan(&[], true).expect("应扫描 root");
        assert_eq!(snapshot.roots[0].id, imported.root_id);
        assert_eq!(snapshot.roots[0].project_count, 1);
        assert!(library
            .remove_manual_root(&imported.root_id)
            .expect("应移除 root"));
        assert!(library.manual_root_summaries().is_empty());
    }

    #[test]
    fn registered_video_preview_resolves_as_bounded_protocol_asset() {
        let directory = TestDirectory::new("video-preview-asset");
        let project = directory.0.join("project");
        fs::create_dir_all(&project).expect("应创建 Scene 项目");
        fs::write(project.join("scene.pkg"), b"PKGV0001payload").expect("应写入 Scene 包");
        fs::write(project.join("preview.webm"), b"webm-preview").expect("应写入视频预览");
        fs::write(
            project.join("project.json"),
            r#"{"title":"视频预览","type":"scene","file":"scene.pkg","preview":"preview.webm"}"#,
        )
        .expect("应写入 project.json");

        let mut library =
            WallpaperLibrary::open(directory.0.join("library.json")).expect("应打开 library");
        library
            .add_manual_root(&project)
            .expect("应导入 Scene 项目");
        let snapshot = library.scan(&[], true).expect("应扫描 Scene 项目");
        let project_id = snapshot.projects[0].id.clone();
        let asset = library
            .resolve_media_asset(&project_id, WallpaperMediaRole::Preview)
            .expect("登记的视频预览应可解析为协议 asset");

        assert_eq!(asset.media_type, WallpaperMediaType::Video);
        assert_eq!(asset.content_length, b"webm-preview".len() as u64);
        assert_eq!(
            asset.path,
            fs::canonicalize(project.join("preview.webm")).expect("应规范化预览路径")
        );
    }
}
