use super::settings::RuntimeSettingsStore;
use serde::{Deserialize, Serialize};
use std::{
    error::Error,
    fmt,
    fs::{self, Metadata, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Condvar, Mutex,
    },
};

pub const CACHE_DIRECTORY_NAME: &str = "cache";
pub const CACHE_FALLBACK_DIRECTORY_NAME: &str = "cache-fallback";
pub const CUSTOM_CACHE_APPLICATION_DIRECTORY_NAME: &str = "MineRadio";
pub const CACHE_OWNERSHIP_MARKER_NAME: &str = ".mineradio-cache-owned-v1";

static ATOMIC_FILE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CacheCategory {
    Audio,
    Images,
    Lyrics,
    Beatmaps,
    Temp,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CacheScanLimits {
    pub max_depth: usize,
    pub max_entries: u64,
}

impl Default for CacheScanLimits {
    fn default() -> Self {
        Self {
            max_depth: 32,
            max_entries: 100_000,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheCategoryUsage {
    pub category: CacheCategory,
    pub path: PathBuf,
    pub total_bytes: u64,
    pub file_count: u64,
    pub directory_count: u64,
    pub error_count: u64,
    pub skipped_link_count: u64,
    pub truncated: bool,
}

impl CacheCategoryUsage {
    fn empty(category: CacheCategory, path: PathBuf) -> Self {
        Self {
            category,
            path,
            total_bytes: 0,
            file_count: 0,
            directory_count: 0,
            error_count: 0,
            skipped_link_count: 0,
            truncated: false,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheSnapshot {
    pub configured_root: PathBuf,
    pub active_root: PathBuf,
    pub fallback_used: bool,
    pub fallback_reason: Option<String>,
    pub restart_required: bool,
    pub categories: Vec<CacheCategoryUsage>,
    pub total_bytes: u64,
    pub file_count: u64,
    pub directory_count: u64,
    pub error_count: u64,
    pub skipped_link_count: u64,
    pub truncated: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheClearResult {
    pub category: CacheCategory,
    pub path: PathBuf,
    pub removed_bytes: u64,
    pub removed_files: u64,
    pub removed_directories: u64,
    pub removed_links: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CacheRootValidation {
    Default,
    Usable {
        desired_root: PathBuf,
        effective_root: PathBuf,
    },
    Fallback {
        desired_root: Option<PathBuf>,
        reason: String,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheRootDecision {
    pub desired_root: Option<PathBuf>,
    pub effective_root: PathBuf,
    pub fallback_used: bool,
    pub fallback_reason: Option<String>,
    pub restart_required: bool,
}

pub fn decide_cache_root(
    current_root: &Path,
    default_root: &Path,
    fallback_root: &Path,
    validation: CacheRootValidation,
) -> CacheRootDecision {
    let (desired_root, effective_root, fallback_used, fallback_reason) = match validation {
        CacheRootValidation::Default => (None, default_root.to_path_buf(), false, None),
        CacheRootValidation::Usable {
            desired_root,
            effective_root,
        } => (Some(desired_root), effective_root, false, None),
        CacheRootValidation::Fallback {
            desired_root,
            reason,
        } => (
            desired_root,
            fallback_root.to_path_buf(),
            true,
            Some(reason),
        ),
    };
    CacheRootDecision {
        desired_root,
        restart_required: effective_root != current_root,
        effective_root,
        fallback_used,
        fallback_reason,
    }
}

#[derive(Debug)]
pub enum CacheRuntimeError {
    Io {
        operation: &'static str,
        path: PathBuf,
        source: io::Error,
    },
    UnsafeManagedPath {
        path: PathBuf,
        reason: String,
    },
    SettingsStore {
        operation: &'static str,
        reason: String,
    },
}

impl fmt::Display for CacheRuntimeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io {
                operation,
                path,
                source,
            } => write!(formatter, "{operation} {} 失败：{source}", path.display()),
            Self::UnsafeManagedPath { path, reason } => {
                write!(
                    formatter,
                    "拒绝操作非安全缓存路径 {}：{reason}",
                    path.display()
                )
            }
            Self::SettingsStore { operation, reason } => {
                write!(formatter, "{operation}失败：{reason}")
            }
        }
    }
}

impl Error for CacheRuntimeError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Io { source, .. } => Some(source),
            Self::UnsafeManagedPath { .. } => None,
            Self::SettingsStore { .. } => None,
        }
    }
}

#[derive(Default)]
struct RemovalStats {
    bytes: u64,
    files: u64,
    directories: u64,
    links: u64,
}

impl CacheSnapshot {
    pub fn usage(&self, category: CacheCategory) -> Option<&CacheCategoryUsage> {
        self.categories
            .iter()
            .find(|usage| usage.category == category)
    }

    fn recalculate_totals(&mut self) {
        self.total_bytes = 0;
        self.file_count = 0;
        self.directory_count = 0;
        self.error_count = 0;
        self.skipped_link_count = 0;
        self.truncated = false;
        for usage in &self.categories {
            self.total_bytes = self.total_bytes.saturating_add(usage.total_bytes);
            self.file_count = self.file_count.saturating_add(usage.file_count);
            self.directory_count = self.directory_count.saturating_add(usage.directory_count);
            self.error_count = self.error_count.saturating_add(usage.error_count);
            self.skipped_link_count = self
                .skipped_link_count
                .saturating_add(usage.skipped_link_count);
            self.truncated |= usage.truncated;
        }
    }
}

impl CacheCategory {
    pub const ALL: [Self; 5] = [
        Self::Audio,
        Self::Images,
        Self::Lyrics,
        Self::Beatmaps,
        Self::Temp,
    ];

    pub const fn directory_name(self) -> &'static str {
        match self {
            Self::Audio => "audio",
            Self::Images => "images",
            Self::Lyrics => "lyrics",
            Self::Beatmaps => "beatmaps",
            Self::Temp => "temp",
        }
    }
}

#[derive(Debug)]
pub struct CacheRuntime {
    default_root: PathBuf,
    fallback_root: PathBuf,
    root: PathBuf,
    settings: Arc<Mutex<RuntimeSettingsStore>>,
    scan_limits: CacheScanLimits,
    root_decision: CacheRootDecision,
    active_fallback_used: bool,
    active_fallback_reason: Option<String>,
    snapshots: Arc<CacheSnapshotCoordinator>,
    #[cfg(windows)]
    root_handle: Arc<WindowsStableDirectory>,
    #[cfg(test)]
    io_test_hooks: Arc<CacheIoTestHooks>,
}

#[derive(Clone, Debug)]
pub struct CacheScanRequest {
    plan: CacheScanPlan,
    state_generation: u64,
    observed_scan_generation: u64,
    snapshots: Arc<CacheSnapshotCoordinator>,
}

#[derive(Clone, Debug)]
struct CacheScanPlan {
    configured_root: PathBuf,
    active_root: PathBuf,
    fallback_used: bool,
    fallback_reason: Option<String>,
    restart_required: bool,
    scan_limits: CacheScanLimits,
    #[cfg(windows)]
    root_handle: Arc<WindowsStableDirectory>,
    #[cfg(test)]
    io_test_hooks: Arc<CacheIoTestHooks>,
}

struct CacheSnapshotCoordinator {
    state: Mutex<CacheSnapshotState>,
    scan_completed: Condvar,
    #[cfg(test)]
    scan_start_hook: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
}

#[derive(Debug)]
struct CacheSnapshotState {
    state_generation: u64,
    published_scan_generation: u64,
    scan_in_flight: bool,
    mutation_in_flight: bool,
    latest: CacheSnapshot,
}

impl fmt::Debug for CacheSnapshotCoordinator {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let state = self.state.lock().map_err(|_| fmt::Error)?;
        formatter
            .debug_struct("CacheSnapshotCoordinator")
            .field("state", &*state)
            .finish_non_exhaustive()
    }
}

impl CacheSnapshotCoordinator {
    fn new(plan: &CacheScanPlan) -> Self {
        Self {
            state: Mutex::new(CacheSnapshotState {
                state_generation: 0,
                published_scan_generation: 0,
                scan_in_flight: false,
                mutation_in_flight: false,
                latest: plan.empty_snapshot(),
            }),
            scan_completed: Condvar::new(),
            #[cfg(test)]
            scan_start_hook: Mutex::new(None),
        }
    }

    fn request(self: &Arc<Self>, plan: CacheScanPlan) -> CacheScanRequest {
        let state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        CacheScanRequest {
            plan,
            state_generation: state.state_generation,
            observed_scan_generation: state.published_scan_generation,
            snapshots: Arc::clone(self),
        }
    }

    fn latest(&self) -> CacheSnapshot {
        self.state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .latest
            .clone()
    }

    fn update_cheap_state(&self, plan: &CacheScanPlan) {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        state.state_generation = state.state_generation.saturating_add(1);
        let mut latest = state.latest.clone();
        latest.configured_root = plan.configured_root.clone();
        latest.active_root = plan.active_root.clone();
        latest.fallback_used = plan.fallback_used;
        latest.fallback_reason = plan.fallback_reason.clone();
        latest.restart_required = plan.restart_required;
        state.latest = latest;
        self.scan_completed.notify_all();
    }

    fn begin_mutation(&self) -> u64 {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        while state.scan_in_flight || state.mutation_in_flight {
            state = self
                .scan_completed
                .wait(state)
                .unwrap_or_else(|error| error.into_inner());
        }
        state.mutation_in_flight = true;
        state.state_generation = state.state_generation.saturating_add(1);
        state.state_generation
    }

    fn complete_clear(&self, generation: u64, category: CacheCategory, succeeded: bool) {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if succeeded && state.state_generation == generation {
            let replacement = CacheCategoryUsage::empty(
                category,
                state.latest.active_root.join(category.directory_name()),
            );
            if let Some(usage) = state
                .latest
                .categories
                .iter_mut()
                .find(|usage| usage.category == category)
            {
                *usage = replacement;
            }
            state.latest.recalculate_totals();
        }
        state.mutation_in_flight = false;
        self.scan_completed.notify_all();
    }

    #[cfg(test)]
    fn set_scan_start_hook(&self, hook: impl Fn() + Send + Sync + 'static) {
        *self
            .scan_start_hook
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = Some(Arc::new(hook));
    }

    #[cfg(test)]
    fn published_scan_generation(&self) -> u64 {
        self.state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .published_scan_generation
    }

    #[cfg(test)]
    fn invoke_scan_start_hook(&self) {
        let hook = self
            .scan_start_hook
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone();
        if let Some(hook) = hook {
            hook();
        }
    }
}

#[derive(Clone, Debug)]
pub struct CacheClearRequest {
    root: PathBuf,
    #[cfg(windows)]
    root_handle: Arc<WindowsStableDirectory>,
    category: CacheCategory,
    snapshots: Arc<CacheSnapshotCoordinator>,
    #[cfg(test)]
    io_test_hooks: Arc<CacheIoTestHooks>,
}

#[cfg(test)]
#[derive(Default)]
struct CacheIoTestHooks {
    scan_category_open: Mutex<CacheCategoryOpenHook>,
    clear_category_open: Mutex<CacheCategoryOpenHook>,
}

#[cfg(test)]
type CacheCategoryOpenHook = Option<(CacheCategory, Arc<dyn Fn() + Send + Sync>)>;

#[cfg(test)]
impl fmt::Debug for CacheIoTestHooks {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CacheIoTestHooks")
            .finish_non_exhaustive()
    }
}

#[cfg(test)]
impl CacheIoTestHooks {
    fn invoke_scan_category_open(&self, category: CacheCategory) {
        let hook = self
            .scan_category_open
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone();
        if let Some((expected, hook)) = hook {
            if expected == category {
                hook();
            }
        }
    }

    fn invoke_clear_category_open(&self, category: CacheCategory) {
        let hook = self
            .clear_category_open
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone();
        if let Some((expected, hook)) = hook {
            if expected == category {
                hook();
            }
        }
    }
}

#[derive(Clone, Copy)]
enum ManagedRootOwnership {
    TrustedApplicationData,
    UserSelectedParent,
}

impl CacheRuntime {
    pub fn for_app_data(
        app_data_dir: impl AsRef<Path>,
        settings: Arc<Mutex<RuntimeSettingsStore>>,
    ) -> Result<Self, CacheRuntimeError> {
        Self::with_settings_store(app_data_dir, settings)
    }

    #[cfg(test)]
    pub fn with_settings_path(
        app_data_dir: impl AsRef<Path>,
        settings_path: impl Into<PathBuf>,
    ) -> Result<Self, CacheRuntimeError> {
        let settings = Arc::new(Mutex::new(RuntimeSettingsStore::with_path(settings_path)));
        Self::with_settings_store(app_data_dir, settings)
    }

    #[cfg(test)]
    pub fn with_settings_path_and_limits(
        app_data_dir: impl AsRef<Path>,
        settings_path: impl Into<PathBuf>,
        scan_limits: CacheScanLimits,
    ) -> Result<Self, CacheRuntimeError> {
        let settings = Arc::new(Mutex::new(RuntimeSettingsStore::with_path(settings_path)));
        Self::with_settings_store_and_limits(app_data_dir, settings, scan_limits)
    }

    pub fn with_settings_store(
        app_data_dir: impl AsRef<Path>,
        settings: Arc<Mutex<RuntimeSettingsStore>>,
    ) -> Result<Self, CacheRuntimeError> {
        Self::with_settings_store_and_limits(app_data_dir, settings, CacheScanLimits::default())
    }

    fn with_settings_store_and_limits(
        app_data_dir: impl AsRef<Path>,
        settings: Arc<Mutex<RuntimeSettingsStore>>,
        scan_limits: CacheScanLimits,
    ) -> Result<Self, CacheRuntimeError> {
        let requested_default_root = app_data_dir.as_ref().join(CACHE_DIRECTORY_NAME);
        let requested_fallback_root = app_data_dir.as_ref().join(CACHE_FALLBACK_DIRECTORY_NAME);
        let default_root = ensure_managed_root(
            &requested_default_root,
            ManagedRootOwnership::TrustedApplicationData,
        )?;
        let fallback_root = ensure_managed_root(
            &requested_fallback_root,
            ManagedRootOwnership::TrustedApplicationData,
        )?;
        let desired_root = settings
            .lock()
            .map_err(|error| CacheRuntimeError::SettingsStore {
                operation: "读取原生设置",
                reason: error.to_string(),
            })?
            .snapshot()
            .cache_root;
        let validation = validate_desired_root(desired_root);
        let mut root_decision =
            decide_cache_root(&default_root, &default_root, &fallback_root, validation);
        let mut root = if root_decision.effective_root == default_root {
            default_root.clone()
        } else {
            let ownership = if root_decision.fallback_used {
                ManagedRootOwnership::TrustedApplicationData
            } else {
                ManagedRootOwnership::UserSelectedParent
            };
            match ensure_managed_root(&root_decision.effective_root, ownership) {
                Ok(root) => root,
                Err(error) => {
                    root_decision = decide_cache_root(
                        &default_root,
                        &default_root,
                        &fallback_root,
                        CacheRootValidation::Fallback {
                            desired_root: root_decision.desired_root.clone(),
                            reason: error.to_string(),
                        },
                    );
                    fallback_root.clone()
                }
            }
        };
        #[cfg(windows)]
        let root_handle = {
            let (retained_root, retained_handle) = retain_windows_selected_root_with(
                root,
                &default_root,
                &fallback_root,
                &mut root_decision,
                open_windows_managed_root,
            )?;
            root = retained_root;
            Arc::new(retained_handle)
        };
        let active_fallback_used = root_decision.fallback_used;
        let active_fallback_reason = root_decision.fallback_reason.clone();
        root_decision.effective_root = root.clone();
        root_decision.restart_required = false;
        #[cfg(test)]
        let io_test_hooks = Arc::new(CacheIoTestHooks::default());
        let initial_plan = CacheScanPlan {
            configured_root: root_decision
                .desired_root
                .clone()
                .unwrap_or_else(|| default_root.clone()),
            active_root: root.clone(),
            fallback_used: active_fallback_used,
            fallback_reason: active_fallback_reason.clone(),
            restart_required: false,
            scan_limits,
            #[cfg(windows)]
            root_handle: Arc::clone(&root_handle),
            #[cfg(test)]
            io_test_hooks: Arc::clone(&io_test_hooks),
        };
        Ok(Self {
            default_root,
            fallback_root,
            root,
            settings,
            scan_limits,
            root_decision,
            active_fallback_used,
            active_fallback_reason,
            snapshots: Arc::new(CacheSnapshotCoordinator::new(&initial_plan)),
            #[cfg(windows)]
            root_handle,
            #[cfg(test)]
            io_test_hooks,
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn default_root(&self) -> &Path {
        &self.default_root
    }

    pub fn fallback_root(&self) -> &Path {
        &self.fallback_root
    }

    pub fn root_decision(&self) -> &CacheRootDecision {
        &self.root_decision
    }

    pub fn plan_desired_root(&self, desired_root: Option<PathBuf>) -> CacheRootDecision {
        let validation = validate_desired_root(desired_root);
        decide_cache_root(
            &self.root,
            &self.default_root,
            &self.fallback_root,
            validation,
        )
    }

    pub fn set_desired_root(
        &mut self,
        desired_root: Option<PathBuf>,
    ) -> Result<CacheRootDecision, CacheRuntimeError> {
        let decision = self.plan_desired_root(desired_root.clone());
        self.settings
            .lock()
            .map_err(|error| CacheRuntimeError::SettingsStore {
                operation: "锁定原生设置",
                reason: error.to_string(),
            })?
            .set_cache_root(desired_root)
            .map_err(|error| CacheRuntimeError::SettingsStore {
                operation: "保存缓存目录",
                reason: error.to_string(),
            })?;
        self.root_decision = decision.clone();
        let plan = self.scan_plan();
        self.snapshots.update_cheap_state(&plan);
        Ok(decision)
    }

    pub fn snapshot(&self) -> CacheSnapshot {
        self.scan_request().execute()
    }

    pub fn latest_snapshot(&self) -> CacheSnapshot {
        self.snapshots.latest()
    }

    pub fn scan_request(&self) -> CacheScanRequest {
        self.snapshots.request(self.scan_plan())
    }

    fn scan_plan(&self) -> CacheScanPlan {
        CacheScanPlan {
            configured_root: self
                .root_decision
                .desired_root
                .clone()
                .unwrap_or_else(|| self.default_root.clone()),
            active_root: self.root.clone(),
            fallback_used: self.active_fallback_used,
            fallback_reason: self.active_fallback_reason.clone(),
            restart_required: self.root_decision.restart_required,
            scan_limits: self.scan_limits,
            #[cfg(windows)]
            root_handle: Arc::clone(&self.root_handle),
            #[cfg(test)]
            io_test_hooks: Arc::clone(&self.io_test_hooks),
        }
    }

    pub fn clear(&self, category: CacheCategory) -> Result<CacheClearResult, CacheRuntimeError> {
        self.clear_request(category).execute()
    }

    pub fn clear_request(&self, category: CacheCategory) -> CacheClearRequest {
        CacheClearRequest {
            root: self.root.clone(),
            #[cfg(windows)]
            root_handle: Arc::clone(&self.root_handle),
            category,
            snapshots: Arc::clone(&self.snapshots),
            #[cfg(test)]
            io_test_hooks: Arc::clone(&self.io_test_hooks),
        }
    }

    #[cfg(test)]
    fn set_scan_start_hook_for_test(&mut self, hook: impl Fn() + Send + Sync + 'static) {
        self.snapshots.set_scan_start_hook(hook);
    }

    #[cfg(test)]
    fn published_scan_generation_for_test(&self) -> u64 {
        self.snapshots.published_scan_generation()
    }

    #[cfg(test)]
    fn set_scan_category_open_hook_for_test(
        &mut self,
        category: CacheCategory,
        hook: impl Fn() + Send + Sync + 'static,
    ) {
        *self
            .io_test_hooks
            .scan_category_open
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = Some((category, Arc::new(hook)));
    }

    #[cfg(test)]
    fn set_clear_category_open_hook_for_test(
        &mut self,
        category: CacheCategory,
        hook: impl Fn() + Send + Sync + 'static,
    ) {
        *self
            .io_test_hooks
            .clear_category_open
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = Some((category, Arc::new(hook)));
    }
}

impl CacheClearRequest {
    pub fn execute(self) -> Result<CacheClearResult, CacheRuntimeError> {
        let snapshots = Arc::clone(&self.snapshots);
        let category = self.category;
        let generation = snapshots.begin_mutation();
        #[cfg(windows)]
        let result = clear_cache_category_windows(self);
        #[cfg(not(windows))]
        let result = self.execute_portable();
        snapshots.complete_clear(generation, category, result.is_ok());
        result
    }

    #[cfg(not(windows))]
    fn execute_portable(self) -> Result<CacheClearResult, CacheRuntimeError> {
        let category = self.category;
        verify_cache_root_ownership(&self.root)?;
        let target = self.root.join(category.directory_name());
        let metadata = match fs::symlink_metadata(&target) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                fs::create_dir_all(&target).map_err(|source| CacheRuntimeError::Io {
                    operation: "重建缓存分类目录",
                    path: target.clone(),
                    source,
                })?;
                return Ok(CacheClearResult {
                    category,
                    path: target,
                    removed_bytes: 0,
                    removed_files: 0,
                    removed_directories: 0,
                    removed_links: 0,
                });
            }
            Err(source) => {
                return Err(CacheRuntimeError::Io {
                    operation: "读取缓存分类目录",
                    path: target,
                    source,
                });
            }
        };
        if is_link_or_reparse_point(&metadata) {
            return Err(CacheRuntimeError::UnsafeManagedPath {
                path: target,
                reason: "分类根目录是符号链接、联接点或其他重解析点".to_string(),
            });
        }
        if !metadata.is_dir() {
            return Err(CacheRuntimeError::UnsafeManagedPath {
                path: target,
                reason: "分类根路径不是目录".to_string(),
            });
        }
        let canonical_target =
            canonicalize_for_display(&target).map_err(|source| CacheRuntimeError::Io {
                operation: "解析缓存分类目录",
                path: target.clone(),
                source,
            })?;
        if canonical_target == self.root || !canonical_target.starts_with(&self.root) {
            return Err(CacheRuntimeError::UnsafeManagedPath {
                path: canonical_target,
                reason: "分类目录不在受管缓存根目录内".to_string(),
            });
        }

        let mut stats = RemovalStats::default();
        remove_tree_without_following_links(&canonical_target, &mut stats)?;
        fs::create_dir_all(&canonical_target).map_err(|source| CacheRuntimeError::Io {
            operation: "重建缓存分类目录",
            path: canonical_target.clone(),
            source,
        })?;
        Ok(CacheClearResult {
            category,
            path: canonical_target,
            removed_bytes: stats.bytes,
            removed_files: stats.files,
            removed_directories: stats.directories,
            removed_links: stats.links,
        })
    }
}

impl CacheScanRequest {
    pub fn execute(self) -> CacheSnapshot {
        loop {
            let mut state = self
                .snapshots
                .state
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            if state.state_generation != self.state_generation {
                return state.latest.clone();
            }
            if state.published_scan_generation > self.observed_scan_generation {
                return state.latest.clone();
            }
            if state.scan_in_flight || state.mutation_in_flight {
                state = self
                    .snapshots
                    .scan_completed
                    .wait(state)
                    .unwrap_or_else(|error| error.into_inner());
                drop(state);
                continue;
            }
            state.scan_in_flight = true;
            drop(state);

            #[cfg(test)]
            self.snapshots.invoke_scan_start_hook();
            let snapshot = self.plan.execute();
            let mut state = self
                .snapshots
                .state
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            let result = if state.state_generation == self.state_generation {
                state.published_scan_generation = state.published_scan_generation.saturating_add(1);
                state.latest = snapshot;
                state.latest.clone()
            } else {
                state.latest.clone()
            };
            state.scan_in_flight = false;
            self.snapshots.scan_completed.notify_all();
            return result;
        }
    }
}

impl CacheScanPlan {
    fn empty_snapshot(&self) -> CacheSnapshot {
        CacheSnapshot {
            configured_root: self.configured_root.clone(),
            active_root: self.active_root.clone(),
            fallback_used: self.fallback_used,
            fallback_reason: self.fallback_reason.clone(),
            restart_required: self.restart_required,
            categories: CacheCategory::ALL
                .into_iter()
                .map(|category| {
                    CacheCategoryUsage::empty(
                        category,
                        self.active_root.join(category.directory_name()),
                    )
                })
                .collect(),
            total_bytes: 0,
            file_count: 0,
            directory_count: 0,
            error_count: 0,
            skipped_link_count: 0,
            truncated: false,
        }
    }

    fn execute(self) -> CacheSnapshot {
        let categories = CacheCategory::ALL
            .into_iter()
            .map(|category| self.scan_category(category))
            .collect::<Vec<_>>();
        let mut snapshot = CacheSnapshot {
            configured_root: self.configured_root,
            active_root: self.active_root.clone(),
            fallback_used: self.fallback_used,
            fallback_reason: self.fallback_reason,
            restart_required: self.restart_required,
            categories,
            total_bytes: 0,
            file_count: 0,
            directory_count: 0,
            error_count: 0,
            skipped_link_count: 0,
            truncated: false,
        };
        snapshot.recalculate_totals();
        snapshot
    }

    #[cfg(windows)]
    fn scan_category(&self, category: CacheCategory) -> CacheCategoryUsage {
        scan_cache_category_windows(self, category)
    }

    #[cfg(not(windows))]
    fn scan_category(&self, category: CacheCategory) -> CacheCategoryUsage {
        let root = self.active_root.join(category.directory_name());
        let mut usage = CacheCategoryUsage::empty(category, root.clone());
        let root_metadata = match fs::symlink_metadata(&root) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return usage,
            Err(_) => {
                usage.error_count = 1;
                return usage;
            }
        };
        if is_link_or_reparse_point(&root_metadata) {
            usage.skipped_link_count = 1;
            return usage;
        }
        if !root_metadata.is_dir() {
            usage.error_count = 1;
            return usage;
        }

        let mut stack = vec![(root, 0_usize)];
        let mut visited_entries = 0_u64;
        while let Some((directory, depth)) = stack.pop() {
            let entries = match fs::read_dir(&directory) {
                Ok(entries) => entries,
                Err(_) => {
                    usage.error_count = usage.error_count.saturating_add(1);
                    continue;
                }
            };
            for entry_result in entries {
                if visited_entries >= self.scan_limits.max_entries {
                    usage.truncated = true;
                    return usage;
                }
                visited_entries = visited_entries.saturating_add(1);
                let entry = match entry_result {
                    Ok(entry) => entry,
                    Err(_) => {
                        usage.error_count = usage.error_count.saturating_add(1);
                        continue;
                    }
                };
                let metadata = match fs::symlink_metadata(entry.path()) {
                    Ok(metadata) => metadata,
                    Err(_) => {
                        usage.error_count = usage.error_count.saturating_add(1);
                        continue;
                    }
                };
                if is_link_or_reparse_point(&metadata) {
                    usage.skipped_link_count = usage.skipped_link_count.saturating_add(1);
                } else if metadata.is_file() {
                    usage.file_count = usage.file_count.saturating_add(1);
                    usage.total_bytes = usage.total_bytes.saturating_add(metadata.len());
                } else if metadata.is_dir() {
                    usage.directory_count = usage.directory_count.saturating_add(1);
                    if depth < self.scan_limits.max_depth {
                        stack.push((entry.path(), depth + 1));
                    } else {
                        usage.truncated = true;
                    }
                }
            }
        }
        usage
    }
}

fn validate_desired_root(desired_root: Option<PathBuf>) -> CacheRootValidation {
    let Some(desired_root) = desired_root else {
        return CacheRootValidation::Default;
    };
    if desired_root.as_os_str().is_empty() {
        return CacheRootValidation::Fallback {
            desired_root: Some(desired_root),
            reason: "缓存目录不能为空".to_string(),
        };
    }
    if !desired_root.is_absolute() {
        return CacheRootValidation::Fallback {
            desired_root: Some(desired_root),
            reason: "缓存目录必须是绝对路径".to_string(),
        };
    }
    let effective_root = desired_root
        .join(CUSTOM_CACHE_APPLICATION_DIRECTORY_NAME)
        .join(CACHE_DIRECTORY_NAME);
    match ensure_managed_root(&effective_root, ManagedRootOwnership::UserSelectedParent) {
        Ok(effective_root) => CacheRootValidation::Usable {
            desired_root,
            effective_root,
        },
        Err(error) => CacheRootValidation::Fallback {
            desired_root: Some(desired_root),
            reason: error.to_string(),
        },
    }
}

fn ensure_managed_root(
    requested_root: &Path,
    ownership: ManagedRootOwnership,
) -> Result<PathBuf, CacheRuntimeError> {
    let absolute_root = if requested_root.is_absolute() {
        requested_root.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|source| CacheRuntimeError::Io {
                operation: "读取当前目录",
                path: requested_root.to_path_buf(),
                source,
            })?
            .join(requested_root)
    };
    fs::create_dir_all(&absolute_root).map_err(|source| CacheRuntimeError::Io {
        operation: "创建缓存根目录",
        path: absolute_root.clone(),
        source,
    })?;
    let metadata =
        fs::symlink_metadata(&absolute_root).map_err(|source| CacheRuntimeError::Io {
            operation: "读取缓存根目录",
            path: absolute_root.clone(),
            source,
        })?;
    if is_link_or_reparse_point(&metadata) {
        return Err(CacheRuntimeError::UnsafeManagedPath {
            path: absolute_root,
            reason: "缓存根目录是符号链接、联接点或其他重解析点".to_string(),
        });
    }
    if !metadata.is_dir() {
        return Err(CacheRuntimeError::UnsafeManagedPath {
            path: absolute_root,
            reason: "缓存根路径不是目录".to_string(),
        });
    }
    let root =
        canonicalize_for_display(&absolute_root).map_err(|source| CacheRuntimeError::Io {
            operation: "解析缓存根目录",
            path: absolute_root,
            source,
        })?;
    ensure_cache_root_ownership(&root, ownership)?;
    for category in CacheCategory::ALL {
        let category_path = root.join(category.directory_name());
        match fs::symlink_metadata(&category_path) {
            Ok(metadata) if is_link_or_reparse_point(&metadata) => {
                return Err(CacheRuntimeError::UnsafeManagedPath {
                    path: category_path,
                    reason: "缓存分类目录是符号链接、联接点或其他重解析点".to_string(),
                });
            }
            Ok(metadata) if !metadata.is_dir() => {
                return Err(CacheRuntimeError::UnsafeManagedPath {
                    path: category_path,
                    reason: "缓存分类根路径不是目录".to_string(),
                });
            }
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                fs::create_dir(&category_path).map_err(|source| CacheRuntimeError::Io {
                    operation: "创建缓存分类目录",
                    path: category_path,
                    source,
                })?;
            }
            Err(source) => {
                return Err(CacheRuntimeError::Io {
                    operation: "读取缓存分类目录",
                    path: category_path,
                    source,
                });
            }
        }
    }
    verify_root_is_writable(&root)?;
    Ok(root)
}

fn ensure_cache_root_ownership(
    root: &Path,
    ownership: ManagedRootOwnership,
) -> Result<(), CacheRuntimeError> {
    let marker = root.join(CACHE_OWNERSHIP_MARKER_NAME);
    match fs::symlink_metadata(&marker) {
        Ok(metadata) if is_link_or_reparse_point(&metadata) || !metadata.is_file() => {
            return Err(CacheRuntimeError::UnsafeManagedPath {
                path: marker,
                reason: "缓存所有权标记不是普通文件".to_string(),
            });
        }
        Ok(_) => return Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(source) => {
            return Err(CacheRuntimeError::Io {
                operation: "读取缓存所有权标记",
                path: marker,
                source,
            });
        }
    }

    if matches!(ownership, ManagedRootOwnership::UserSelectedParent) {
        let mut entries = fs::read_dir(root).map_err(|source| CacheRuntimeError::Io {
            operation: "检查用户缓存目录所有权",
            path: root.to_path_buf(),
            source,
        })?;
        if entries.next().is_some() {
            return Err(CacheRuntimeError::UnsafeManagedPath {
                path: root.to_path_buf(),
                reason: "用户选择目录下的 MineRadio/cache 已存在内容但缺少所有权标记".to_string(),
            });
        }
    }

    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&marker)
        .map_err(|source| CacheRuntimeError::Io {
            operation: "创建缓存所有权标记",
            path: marker.clone(),
            source,
        })?;
    file.write_all(b"MineRadio cache ownership v1\n")
        .map_err(|source| CacheRuntimeError::Io {
            operation: "写入缓存所有权标记",
            path: marker,
            source,
        })
}

#[cfg(not(windows))]
fn verify_cache_root_ownership(root: &Path) -> Result<(), CacheRuntimeError> {
    let marker = root.join(CACHE_OWNERSHIP_MARKER_NAME);
    let metadata = fs::symlink_metadata(&marker).map_err(|source| CacheRuntimeError::Io {
        operation: "验证缓存所有权标记",
        path: marker.clone(),
        source,
    })?;
    if is_link_or_reparse_point(&metadata) || !metadata.is_file() {
        return Err(CacheRuntimeError::UnsafeManagedPath {
            path: marker,
            reason: "缓存所有权标记无效".to_string(),
        });
    }
    Ok(())
}

fn verify_root_is_writable(root: &Path) -> Result<(), CacheRuntimeError> {
    let sequence = ATOMIC_FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let probe_path = root.join(format!(
        ".mineradio-cache-write-probe-{}-{sequence}",
        std::process::id()
    ));
    let mut probe = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&probe_path)
        .map_err(|source| CacheRuntimeError::Io {
            operation: "验证缓存根目录写权限",
            path: probe_path.clone(),
            source,
        })?;
    if let Err(source) = probe.write_all(b"mineradio-cache-probe") {
        let _ = fs::remove_file(&probe_path);
        return Err(CacheRuntimeError::Io {
            operation: "验证缓存根目录写权限",
            path: probe_path,
            source,
        });
    }
    drop(probe);
    fs::remove_file(&probe_path).map_err(|source| CacheRuntimeError::Io {
        operation: "清理缓存目录写权限探针",
        path: probe_path,
        source,
    })
}

#[cfg(windows)]
fn canonicalize_for_display(path: &Path) -> io::Result<PathBuf> {
    use std::{
        ffi::OsString,
        os::windows::ffi::{OsStrExt, OsStringExt},
    };

    let canonical = fs::canonicalize(path)?;
    let wide = canonical.as_os_str().encode_wide().collect::<Vec<_>>();
    const VERBATIM_PREFIX: [u16; 4] = [b'\\' as u16, b'\\' as u16, b'?' as u16, b'\\' as u16];
    const UNC_PREFIX: [u16; 4] = [b'U' as u16, b'N' as u16, b'C' as u16, b'\\' as u16];
    let display_wide =
        if wide.starts_with(&VERBATIM_PREFIX) && wide.get(4..8) == Some(UNC_PREFIX.as_slice()) {
            let mut output = vec![b'\\' as u16, b'\\' as u16];
            output.extend_from_slice(&wide[8..]);
            output
        } else if wide.starts_with(&VERBATIM_PREFIX) {
            wide[4..].to_vec()
        } else {
            wide
        };
    Ok(PathBuf::from(OsString::from_wide(&display_wide)))
}

#[cfg(not(windows))]
fn canonicalize_for_display(path: &Path) -> io::Result<PathBuf> {
    fs::canonicalize(path)
}

#[cfg(windows)]
fn retain_windows_selected_root_with<T>(
    selected_root: PathBuf,
    default_root: &Path,
    fallback_root: &Path,
    decision: &mut CacheRootDecision,
    mut retain: impl FnMut(&Path) -> Result<T, CacheRuntimeError>,
) -> Result<(PathBuf, T), CacheRuntimeError> {
    match retain(&selected_root) {
        Ok(retained) => Ok((selected_root, retained)),
        Err(error)
            if selected_root != default_root
                && selected_root != fallback_root
                && !decision.fallback_used =>
        {
            *decision = decide_cache_root(
                default_root,
                default_root,
                fallback_root,
                CacheRootValidation::Fallback {
                    desired_root: decision.desired_root.clone(),
                    reason: error.to_string(),
                },
            );
            let retained = retain(fallback_root)?;
            Ok((fallback_root.to_path_buf(), retained))
        }
        Err(error) => Err(error),
    }
}

#[cfg(windows)]
#[derive(Debug)]
struct WindowsStableDirectory {
    guard: std::os::windows::io::OwnedHandle,
    reader: std::os::windows::io::OwnedHandle,
    path: PathBuf,
}

#[cfg(windows)]
struct WindowsDirectoryEntry {
    name: std::ffi::OsString,
    attributes: u32,
    size: u64,
}

#[cfg(windows)]
fn open_windows_handle(
    path: &Path,
    desired_access: u32,
    share_delete: bool,
) -> io::Result<std::os::windows::io::OwnedHandle> {
    use std::os::windows::{ffi::OsStrExt, io::FromRawHandle};
    use windows_sys::Win32::{
        Foundation::INVALID_HANDLE_VALUE,
        Storage::FileSystem::{
            CreateFileW, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
            FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
        },
    };

    let mut wide = path.as_os_str().encode_wide().collect::<Vec<_>>();
    if wide.contains(&0) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Windows 路径包含空字符",
        ));
    }
    wide.push(0);
    let mut share_mode = FILE_SHARE_READ | FILE_SHARE_WRITE;
    if share_delete {
        share_mode |= FILE_SHARE_DELETE;
    }
    // OPEN_REPARSE_POINT 只保证最终路径分量不会被解析；长期操作还必须保留本次打开的对象句柄。
    let handle = unsafe {
        CreateFileW(
            wide.as_ptr(),
            desired_access,
            share_mode,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: CreateFileW 成功后返回由当前函数独占的有效 HANDLE，交给 OwnedHandle 后只释放一次。
    Ok(unsafe { std::os::windows::io::OwnedHandle::from_raw_handle(handle.cast()) })
}

#[cfg(windows)]
fn windows_handle_relative(
    parent: &std::os::windows::io::OwnedHandle,
    name: &std::ffi::OsStr,
    desired_access: u32,
    expect_directory: bool,
    create_disposition: u32,
) -> io::Result<std::os::windows::io::OwnedHandle> {
    use std::{
        mem::size_of,
        os::windows::{
            ffi::OsStrExt,
            io::{AsRawHandle, FromRawHandle},
        },
        path::Component,
    };
    use windows_sys::{
        Wdk::{
            Foundation::OBJECT_ATTRIBUTES,
            Storage::FileSystem::{
                NtCreateFile, FILE_DIRECTORY_FILE, FILE_NON_DIRECTORY_FILE,
                FILE_OPEN_FOR_BACKUP_INTENT, FILE_OPEN_REPARSE_POINT, FILE_SYNCHRONOUS_IO_NONALERT,
            },
        },
        Win32::{
            Foundation::{RtlNtStatusToDosError, HANDLE, OBJ_CASE_INSENSITIVE, UNICODE_STRING},
            Storage::FileSystem::{FILE_SHARE_READ, FILE_SHARE_WRITE, SYNCHRONIZE},
            System::IO::IO_STATUS_BLOCK,
        },
    };

    let mut components = Path::new(name).components();
    if !matches!(components.next(), Some(Component::Normal(component)) if component == name)
        || components.next().is_some()
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Windows 相对路径必须是单一普通名称分量",
        ));
    }
    let mut wide = name.encode_wide().collect::<Vec<_>>();
    let byte_length = wide
        .len()
        .checked_mul(size_of::<u16>())
        .filter(|length| *length <= u16::MAX as usize)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "Windows 名称分量过长"))?;
    wide.push(0);
    let maximum_byte_length = wide
        .len()
        .checked_mul(size_of::<u16>())
        .filter(|length| *length <= u16::MAX as usize)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "Windows 名称分量过长"))?;
    let object_name = UNICODE_STRING {
        Length: byte_length as u16,
        MaximumLength: maximum_byte_length as u16,
        Buffer: wide.as_mut_ptr(),
    };
    let object_attributes = OBJECT_ATTRIBUTES {
        Length: size_of::<OBJECT_ATTRIBUTES>() as u32,
        RootDirectory: parent.as_raw_handle().cast(),
        ObjectName: &object_name,
        Attributes: OBJ_CASE_INSENSITIVE,
        SecurityDescriptor: std::ptr::null(),
        SecurityQualityOfService: std::ptr::null(),
    };
    let create_options = FILE_OPEN_REPARSE_POINT
        | FILE_OPEN_FOR_BACKUP_INTENT
        | FILE_SYNCHRONOUS_IO_NONALERT
        | if expect_directory {
            FILE_DIRECTORY_FILE
        } else {
            FILE_NON_DIRECTORY_FILE
        };
    let mut handle: HANDLE = std::ptr::null_mut();
    let mut io_status = IO_STATUS_BLOCK::default();
    // SAFETY: object_name、object_attributes、io_status 与名称缓冲区在调用期间均保持有效；
    // RootDirectory 来自仍存活的父目录 OwnedHandle，返回句柄由下方 OwnedHandle 接管。
    let status = unsafe {
        NtCreateFile(
            &mut handle,
            desired_access | SYNCHRONIZE,
            &object_attributes,
            &mut io_status,
            std::ptr::null(),
            0,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            create_disposition,
            create_options,
            std::ptr::null(),
            0,
        )
    };
    if status < 0 {
        let code = unsafe { RtlNtStatusToDosError(status) };
        return Err(io::Error::from_raw_os_error(code as i32));
    }
    if handle.is_null() {
        return Err(io::Error::other("Windows 相对打开成功但没有返回有效句柄"));
    }
    // SAFETY: NtCreateFile 已返回成功且 handle 非空，所有权尚未转移，交给 OwnedHandle 后只释放一次。
    Ok(unsafe { std::os::windows::io::OwnedHandle::from_raw_handle(handle.cast()) })
}

#[cfg(windows)]
fn open_windows_handle_relative(
    parent: &std::os::windows::io::OwnedHandle,
    name: &std::ffi::OsStr,
    desired_access: u32,
    expect_directory: bool,
) -> io::Result<std::os::windows::io::OwnedHandle> {
    use windows_sys::Wdk::Storage::FileSystem::FILE_OPEN;

    windows_handle_relative(parent, name, desired_access, expect_directory, FILE_OPEN)
}

#[cfg(windows)]
fn create_windows_directory_relative(
    parent: &std::os::windows::io::OwnedHandle,
    name: &std::ffi::OsStr,
) -> io::Result<std::os::windows::io::OwnedHandle> {
    use windows_sys::{
        Wdk::Storage::FileSystem::FILE_CREATE, Win32::Storage::FileSystem::FILE_READ_ATTRIBUTES,
    };

    windows_handle_relative(parent, name, FILE_READ_ATTRIBUTES, true, FILE_CREATE)
}

#[cfg(windows)]
fn windows_handle_attributes(handle: &std::os::windows::io::OwnedHandle) -> io::Result<u32> {
    use std::{mem::size_of, os::windows::io::AsRawHandle};
    use windows_sys::Win32::Storage::FileSystem::{
        FileAttributeTagInfo, GetFileInformationByHandleEx, FILE_ATTRIBUTE_TAG_INFO,
    };

    let mut info = FILE_ATTRIBUTE_TAG_INFO::default();
    let success = unsafe {
        GetFileInformationByHandleEx(
            handle.as_raw_handle().cast(),
            FileAttributeTagInfo,
            (&mut info as *mut FILE_ATTRIBUTE_TAG_INFO).cast(),
            size_of::<FILE_ATTRIBUTE_TAG_INFO>() as u32,
        )
    };
    if success == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(info.FileAttributes)
    }
}

#[cfg(windows)]
fn windows_handle_size(handle: &std::os::windows::io::OwnedHandle) -> io::Result<u64> {
    use std::{mem::size_of, os::windows::io::AsRawHandle};
    use windows_sys::Win32::Storage::FileSystem::{
        FileStandardInfo, GetFileInformationByHandleEx, FILE_STANDARD_INFO,
    };

    let mut info = FILE_STANDARD_INFO::default();
    let success = unsafe {
        GetFileInformationByHandleEx(
            handle.as_raw_handle().cast(),
            FileStandardInfo,
            (&mut info as *mut FILE_STANDARD_INFO).cast(),
            size_of::<FILE_STANDARD_INFO>() as u32,
        )
    };
    if success == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(info.EndOfFile.max(0) as u64)
    }
}

#[cfg(windows)]
fn windows_attributes_are_reparse(attributes: u32) -> bool {
    use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
    attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(windows)]
fn windows_attributes_are_directory(attributes: u32) -> bool {
    use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_DIRECTORY;
    attributes & FILE_ATTRIBUTE_DIRECTORY != 0
}

#[cfg(windows)]
fn open_windows_stable_entry_relative(
    parent: &WindowsStableDirectory,
    name: &std::ffi::OsStr,
    guard_access: u32,
    expect_directory: bool,
) -> io::Result<(WindowsStableDirectory, u32)> {
    use windows_sys::Win32::Storage::FileSystem::{FILE_LIST_DIRECTORY, FILE_READ_ATTRIBUTES};

    let path = parent.path.join(name);
    let guard_access = guard_access
        | FILE_READ_ATTRIBUTES
        | if expect_directory {
            FILE_LIST_DIRECTORY
        } else {
            0
        };
    let guard = open_windows_handle_relative(&parent.guard, name, guard_access, expect_directory)?;
    let attributes = windows_handle_attributes(&guard)?;
    let reader = guard.try_clone()?;
    Ok((
        WindowsStableDirectory {
            guard,
            reader,
            path,
        },
        attributes,
    ))
}

#[cfg(windows)]
fn enumerate_windows_directory(
    handle: &std::os::windows::io::OwnedHandle,
) -> io::Result<Vec<WindowsDirectoryEntry>> {
    use std::{mem::offset_of, os::windows::ffi::OsStringExt, os::windows::io::AsRawHandle};
    use windows_sys::Win32::{
        Foundation::ERROR_NO_MORE_FILES,
        Storage::FileSystem::{
            FileIdBothDirectoryInfo, FileIdBothDirectoryRestartInfo, GetFileInformationByHandleEx,
            FILE_ID_BOTH_DIR_INFO,
        },
    };

    // u64 backing 让 FILE_ID_BOTH_DIR_INFO 获得满足要求的对齐。
    let mut buffer = vec![0_u64; 8_192];
    let buffer_bytes = buffer.len() * std::mem::size_of::<u64>();
    let mut restart = true;
    let mut output = Vec::new();
    loop {
        let class = if restart {
            FileIdBothDirectoryRestartInfo
        } else {
            FileIdBothDirectoryInfo
        };
        restart = false;
        let success = unsafe {
            GetFileInformationByHandleEx(
                handle.as_raw_handle().cast(),
                class,
                buffer.as_mut_ptr().cast(),
                buffer_bytes as u32,
            )
        };
        if success == 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(ERROR_NO_MORE_FILES as i32) {
                break;
            }
            return Err(error);
        }

        let base = buffer.as_ptr().cast::<u8>();
        let mut offset = 0_usize;
        loop {
            if offset + offset_of!(FILE_ID_BOTH_DIR_INFO, FileName) > buffer_bytes {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "Windows 目录枚举返回越界条目",
                ));
            }
            let info = unsafe { &*base.add(offset).cast::<FILE_ID_BOTH_DIR_INFO>() };
            let name_byte_len = info.FileNameLength as usize;
            let name_offset = offset + offset_of!(FILE_ID_BOTH_DIR_INFO, FileName);
            if !name_byte_len.is_multiple_of(2) || name_offset + name_byte_len > buffer_bytes {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "Windows 目录枚举返回无效文件名",
                ));
            }
            let name = unsafe {
                std::ffi::OsString::from_wide(std::slice::from_raw_parts(
                    base.add(name_offset).cast::<u16>(),
                    name_byte_len / 2,
                ))
            };
            if name != "." && name != ".." {
                output.push(WindowsDirectoryEntry {
                    name,
                    attributes: info.FileAttributes,
                    size: info.EndOfFile.max(0) as u64,
                });
            }
            if info.NextEntryOffset == 0 {
                break;
            }
            let next = info.NextEntryOffset as usize;
            if next == 0 || offset + next >= buffer_bytes {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "Windows 目录枚举返回无效偏移",
                ));
            }
            offset += next;
        }
    }
    Ok(output)
}

#[cfg(windows)]
fn verify_windows_cache_marker(
    root: &WindowsStableDirectory,
) -> Result<std::os::windows::io::OwnedHandle, CacheRuntimeError> {
    use windows_sys::Win32::Storage::FileSystem::FILE_READ_ATTRIBUTES;

    let marker = root.path.join(CACHE_OWNERSHIP_MARKER_NAME);
    let handle = open_windows_handle_relative(
        &root.guard,
        std::ffi::OsStr::new(CACHE_OWNERSHIP_MARKER_NAME),
        FILE_READ_ATTRIBUTES,
        false,
    )
    .map_err(|source| CacheRuntimeError::Io {
        operation: "验证缓存所有权标记",
        path: marker.clone(),
        source,
    })?;
    let attributes =
        windows_handle_attributes(&handle).map_err(|source| CacheRuntimeError::Io {
            operation: "读取缓存所有权标记属性",
            path: marker.clone(),
            source,
        })?;
    if windows_attributes_are_reparse(attributes) || windows_attributes_are_directory(attributes) {
        return Err(CacheRuntimeError::UnsafeManagedPath {
            path: marker,
            reason: "缓存所有权标记无效".to_string(),
        });
    }
    Ok(handle)
}

#[cfg(windows)]
fn open_windows_managed_root(path: &Path) -> Result<WindowsStableDirectory, CacheRuntimeError> {
    use windows_sys::Win32::Storage::FileSystem::FILE_READ_ATTRIBUTES;

    let guard = open_windows_handle(path, FILE_READ_ATTRIBUTES, false).map_err(|source| {
        CacheRuntimeError::Io {
            operation: "打开受管缓存根目录句柄",
            path: path.to_path_buf(),
            source,
        }
    })?;
    let attributes = windows_handle_attributes(&guard).map_err(|source| CacheRuntimeError::Io {
        operation: "读取受管缓存根目录属性",
        path: path.to_path_buf(),
        source,
    })?;
    if windows_attributes_are_reparse(attributes) || !windows_attributes_are_directory(attributes) {
        return Err(CacheRuntimeError::UnsafeManagedPath {
            path: path.to_path_buf(),
            reason: "缓存根目录不是安全的普通目录".to_string(),
        });
    }
    let reader = guard.try_clone().map_err(|source| CacheRuntimeError::Io {
        operation: "复制受管缓存根目录句柄",
        path: path.to_path_buf(),
        source,
    })?;
    let root = WindowsStableDirectory {
        guard,
        reader,
        path: path.to_path_buf(),
    };
    drop(verify_windows_cache_marker(&root)?);
    Ok(root)
}

#[cfg(windows)]
fn scan_cache_category_windows(
    plan: &CacheScanPlan,
    category: CacheCategory,
) -> CacheCategoryUsage {
    use windows_sys::Win32::Storage::FileSystem::FILE_READ_ATTRIBUTES;

    let category_path = plan.active_root.join(category.directory_name());
    let mut usage = CacheCategoryUsage::empty(category, category_path.clone());
    let root = plan.root_handle.as_ref();
    let root_attributes = match windows_handle_attributes(&root.guard) {
        Ok(attributes) => attributes,
        Err(_) => {
            usage.error_count = 1;
            return usage;
        }
    };
    if windows_attributes_are_reparse(root_attributes)
        || !windows_attributes_are_directory(root_attributes)
    {
        usage.error_count = 1;
        return usage;
    }
    let _marker = match verify_windows_cache_marker(root) {
        Ok(marker) => marker,
        Err(_) => {
            usage.error_count = 1;
            return usage;
        }
    };
    let (category_root, attributes) = match open_windows_stable_entry_relative(
        root,
        std::ffi::OsStr::new(category.directory_name()),
        FILE_READ_ATTRIBUTES,
        true,
    ) {
        Ok(value) => value,
        Err(error) if windows_error_is_not_found(&error) => return usage,
        Err(_) => {
            usage.error_count = 1;
            return usage;
        }
    };
    if windows_attributes_are_reparse(attributes) {
        usage.skipped_link_count = 1;
        return usage;
    }
    if !windows_attributes_are_directory(attributes) {
        usage.error_count = 1;
        return usage;
    }
    #[cfg(test)]
    plan.io_test_hooks.invoke_scan_category_open(category);

    let mut stack = vec![(category_root, 0_usize)];
    let mut visited_entries = 0_u64;
    while let Some((directory, depth)) = stack.pop() {
        let entries = match enumerate_windows_directory(&directory.reader) {
            Ok(entries) => entries,
            Err(_) => {
                usage.error_count = usage.error_count.saturating_add(1);
                continue;
            }
        };
        for entry in entries {
            if visited_entries >= plan.scan_limits.max_entries {
                usage.truncated = true;
                return usage;
            }
            visited_entries = visited_entries.saturating_add(1);
            if windows_attributes_are_reparse(entry.attributes) {
                usage.skipped_link_count = usage.skipped_link_count.saturating_add(1);
                continue;
            }
            if !windows_attributes_are_directory(entry.attributes) {
                usage.file_count = usage.file_count.saturating_add(1);
                usage.total_bytes = usage.total_bytes.saturating_add(entry.size);
                continue;
            }
            if depth >= plan.scan_limits.max_depth {
                usage.directory_count = usage.directory_count.saturating_add(1);
                usage.truncated = true;
                continue;
            }
            match open_windows_stable_entry_relative(
                &directory,
                &entry.name,
                FILE_READ_ATTRIBUTES,
                windows_attributes_are_directory(entry.attributes),
            ) {
                Ok((_child, child_attributes))
                    if windows_attributes_are_reparse(child_attributes) =>
                {
                    usage.skipped_link_count = usage.skipped_link_count.saturating_add(1);
                }
                Ok((child, child_attributes))
                    if windows_attributes_are_directory(child_attributes) =>
                {
                    usage.directory_count = usage.directory_count.saturating_add(1);
                    stack.push((child, depth + 1));
                }
                Ok((child, _)) => {
                    usage.file_count = usage.file_count.saturating_add(1);
                    match windows_handle_size(&child.guard) {
                        Ok(size) => usage.total_bytes = usage.total_bytes.saturating_add(size),
                        Err(_) => usage.error_count = usage.error_count.saturating_add(1),
                    }
                }
                Err(_) => usage.error_count = usage.error_count.saturating_add(1),
            }
        }
    }
    usage
}

#[cfg(windows)]
fn windows_error_is_not_found(error: &io::Error) -> bool {
    matches!(error.raw_os_error(), Some(2 | 3))
}

#[cfg(windows)]
fn delete_windows_handle(
    handle: &std::os::windows::io::OwnedHandle,
    path: &Path,
) -> Result<(), CacheRuntimeError> {
    use std::{mem::size_of, os::windows::io::AsRawHandle};
    use windows_sys::Win32::Storage::FileSystem::{
        FileDispositionInfo, FileDispositionInfoEx, SetFileInformationByHandle,
        FILE_DISPOSITION_FLAG_DELETE, FILE_DISPOSITION_FLAG_IGNORE_READONLY_ATTRIBUTE,
        FILE_DISPOSITION_FLAG_POSIX_SEMANTICS, FILE_DISPOSITION_INFO, FILE_DISPOSITION_INFO_EX,
    };

    let extended = FILE_DISPOSITION_INFO_EX {
        Flags: FILE_DISPOSITION_FLAG_DELETE
            | FILE_DISPOSITION_FLAG_POSIX_SEMANTICS
            | FILE_DISPOSITION_FLAG_IGNORE_READONLY_ATTRIBUTE,
    };
    let extended_success = unsafe {
        SetFileInformationByHandle(
            handle.as_raw_handle().cast(),
            FileDispositionInfoEx,
            (&extended as *const FILE_DISPOSITION_INFO_EX).cast(),
            size_of::<FILE_DISPOSITION_INFO_EX>() as u32,
        )
    };
    if extended_success != 0 {
        return Ok(());
    }

    let basic = FILE_DISPOSITION_INFO { DeleteFile: true };
    let basic_success = unsafe {
        SetFileInformationByHandle(
            handle.as_raw_handle().cast(),
            FileDispositionInfo,
            (&basic as *const FILE_DISPOSITION_INFO).cast(),
            size_of::<FILE_DISPOSITION_INFO>() as u32,
        )
    };
    if basic_success == 0 {
        Err(CacheRuntimeError::Io {
            operation: "通过句柄删除缓存条目",
            path: path.to_path_buf(),
            source: io::Error::last_os_error(),
        })
    } else {
        Ok(())
    }
}

#[cfg(windows)]
fn remove_windows_tree(
    directory: WindowsStableDirectory,
    stats: &mut RemovalStats,
) -> Result<(), CacheRuntimeError> {
    use windows_sys::Win32::Storage::FileSystem::{DELETE, FILE_READ_ATTRIBUTES};

    let entries =
        enumerate_windows_directory(&directory.reader).map_err(|source| CacheRuntimeError::Io {
            operation: "枚举待清理缓存目录句柄",
            path: directory.path.clone(),
            source,
        })?;
    for entry in entries {
        let child_path = directory.path.join(&entry.name);
        let (child, attributes) = open_windows_stable_entry_relative(
            &directory,
            &entry.name,
            DELETE | FILE_READ_ATTRIBUTES,
            windows_attributes_are_directory(entry.attributes),
        )
        .map_err(|source| CacheRuntimeError::Io {
            operation: "相对打开待清理缓存条目句柄",
            path: child_path.clone(),
            source,
        })?;
        if windows_attributes_are_reparse(attributes) {
            delete_windows_handle(&child.guard, &child_path)?;
            drop(child);
            stats.links = stats.links.saturating_add(1);
            continue;
        }
        if windows_attributes_are_directory(attributes) {
            remove_windows_tree(child, stats)?;
            continue;
        }
        let length = windows_handle_size(&child.guard).map_err(|source| CacheRuntimeError::Io {
            operation: "读取待清理缓存文件长度",
            path: child_path.clone(),
            source,
        })?;
        delete_windows_handle(&child.guard, &child_path)?;
        drop(child);
        stats.bytes = stats.bytes.saturating_add(length);
        stats.files = stats.files.saturating_add(1);
    }
    drop(directory.reader);
    delete_windows_handle(&directory.guard, &directory.path)?;
    drop(directory.guard);
    stats.directories = stats.directories.saturating_add(1);
    Ok(())
}

#[cfg(windows)]
fn create_windows_managed_directory(
    parent: &WindowsStableDirectory,
    name: &std::ffi::OsStr,
    display_path: &Path,
) -> Result<std::os::windows::io::OwnedHandle, CacheRuntimeError> {
    let handle = create_windows_directory_relative(&parent.guard, name).map_err(|source| {
        if source.kind() == io::ErrorKind::AlreadyExists {
            CacheRuntimeError::UnsafeManagedPath {
                path: display_path.to_path_buf(),
                reason: "缓存分类路径在操作期间被替换".to_string(),
            }
        } else {
            CacheRuntimeError::Io {
                operation: "相对重建缓存分类目录",
                path: display_path.to_path_buf(),
                source,
            }
        }
    })?;
    let attributes =
        windows_handle_attributes(&handle).map_err(|source| CacheRuntimeError::Io {
            operation: "验证重建缓存分类目录",
            path: display_path.to_path_buf(),
            source,
        })?;
    if windows_attributes_are_reparse(attributes) || !windows_attributes_are_directory(attributes) {
        return Err(CacheRuntimeError::UnsafeManagedPath {
            path: display_path.to_path_buf(),
            reason: "重建后的缓存分类目录不是安全的普通目录".to_string(),
        });
    }
    Ok(handle)
}

#[cfg(windows)]
fn clear_cache_category_windows(
    request: CacheClearRequest,
) -> Result<CacheClearResult, CacheRuntimeError> {
    use windows_sys::Win32::Storage::FileSystem::{DELETE, FILE_READ_ATTRIBUTES};

    let root = request.root_handle.as_ref();
    let root_attributes =
        windows_handle_attributes(&root.guard).map_err(|source| CacheRuntimeError::Io {
            operation: "读取受管缓存根目录属性",
            path: request.root.clone(),
            source,
        })?;
    if windows_attributes_are_reparse(root_attributes)
        || !windows_attributes_are_directory(root_attributes)
    {
        return Err(CacheRuntimeError::UnsafeManagedPath {
            path: request.root,
            reason: "缓存根目录不是安全的普通目录".to_string(),
        });
    }
    let _marker = verify_windows_cache_marker(root)?;
    let category_name = std::ffi::OsStr::new(request.category.directory_name());
    let target = root.path.join(category_name);
    let (category_root, attributes) = match open_windows_stable_entry_relative(
        root,
        category_name,
        DELETE | FILE_READ_ATTRIBUTES,
        true,
    ) {
        Ok(value) => value,
        Err(error) if windows_error_is_not_found(&error) => {
            drop(create_windows_managed_directory(
                root,
                category_name,
                &target,
            )?);
            return Ok(CacheClearResult {
                category: request.category,
                path: target,
                removed_bytes: 0,
                removed_files: 0,
                removed_directories: 0,
                removed_links: 0,
            });
        }
        Err(source) => {
            return Err(CacheRuntimeError::Io {
                operation: "打开缓存分类目录句柄",
                path: target,
                source,
            });
        }
    };
    if windows_attributes_are_reparse(attributes) {
        return Err(CacheRuntimeError::UnsafeManagedPath {
            path: target,
            reason: "分类根目录是符号链接、联接点或其他重解析点".to_string(),
        });
    }
    if !windows_attributes_are_directory(attributes) {
        return Err(CacheRuntimeError::UnsafeManagedPath {
            path: target,
            reason: "分类根路径不是目录".to_string(),
        });
    }
    #[cfg(test)]
    request
        .io_test_hooks
        .invoke_clear_category_open(request.category);

    let mut stats = RemovalStats::default();
    remove_windows_tree(category_root, &mut stats)?;
    drop(create_windows_managed_directory(
        root,
        category_name,
        &target,
    )?);
    Ok(CacheClearResult {
        category: request.category,
        path: target,
        removed_bytes: stats.bytes,
        removed_files: stats.files,
        removed_directories: stats.directories,
        removed_links: stats.links,
    })
}

#[cfg(not(windows))]
fn remove_tree_without_following_links(
    path: &Path,
    stats: &mut RemovalStats,
) -> Result<(), CacheRuntimeError> {
    let metadata = fs::symlink_metadata(path).map_err(|source| CacheRuntimeError::Io {
        operation: "读取待清理缓存条目",
        path: path.to_path_buf(),
        source,
    })?;
    if is_link_or_reparse_point(&metadata) {
        remove_link_without_following(path, &metadata)?;
        stats.links = stats.links.saturating_add(1);
        return Ok(());
    }
    if metadata.is_file() {
        let length = metadata.len();
        fs::remove_file(path).map_err(|source| CacheRuntimeError::Io {
            operation: "删除缓存文件",
            path: path.to_path_buf(),
            source,
        })?;
        stats.bytes = stats.bytes.saturating_add(length);
        stats.files = stats.files.saturating_add(1);
        return Ok(());
    }
    if !metadata.is_dir() {
        return Err(CacheRuntimeError::UnsafeManagedPath {
            path: path.to_path_buf(),
            reason: "缓存树中包含不支持的文件类型".to_string(),
        });
    }

    let entries = fs::read_dir(path).map_err(|source| CacheRuntimeError::Io {
        operation: "读取待清理缓存目录",
        path: path.to_path_buf(),
        source,
    })?;
    for entry_result in entries {
        let entry = entry_result.map_err(|source| CacheRuntimeError::Io {
            operation: "枚举待清理缓存目录",
            path: path.to_path_buf(),
            source,
        })?;
        remove_tree_without_following_links(&entry.path(), stats)?;
    }
    fs::remove_dir(path).map_err(|source| CacheRuntimeError::Io {
        operation: "删除缓存目录",
        path: path.to_path_buf(),
        source,
    })?;
    stats.directories = stats.directories.saturating_add(1);
    Ok(())
}

#[cfg(not(windows))]
fn remove_link_without_following(
    path: &Path,
    _metadata: &Metadata,
) -> Result<(), CacheRuntimeError> {
    fs::remove_file(path).map_err(|source| CacheRuntimeError::Io {
        operation: "删除缓存链接",
        path: path.to_path_buf(),
        source,
    })
}

#[cfg(windows)]
fn is_link_or_reparse_point(metadata: &Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;

    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
    metadata.file_type().is_symlink()
        || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_link_or_reparse_point(metadata: &Metadata) -> bool {
    metadata.file_type().is_symlink()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{app::lifecycle::CloseBehavior, runtime::settings::RuntimeSettingsStore};
    use std::{
        fs,
        sync::{
            atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
            mpsc, Arc, Barrier,
        },
        time::Duration,
    };

    static TEST_DIRECTORY_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    struct TestDirectory {
        path: PathBuf,
    }

    impl TestDirectory {
        fn new(label: &str) -> Self {
            let sequence = TEST_DIRECTORY_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "mineradio-cache-runtime-{label}-{}-{sequence}",
                std::process::id()
            ));
            let _ = fs::remove_dir_all(&path);
            fs::create_dir_all(&path).expect("应创建缓存运行时测试目录");
            Self { path }
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn canonical_runtime_path(path: &Path) -> PathBuf {
        canonicalize_for_display(path).expect("测试路径应解析为运行时返回的最终路径")
    }

    #[cfg(windows)]
    fn create_directory_link(target: &Path, link: &Path) -> io::Result<()> {
        std::os::windows::fs::symlink_dir(target, link)
    }

    #[cfg(unix)]
    fn create_directory_link(target: &Path, link: &Path) -> io::Result<()> {
        std::os::unix::fs::symlink(target, link)
    }

    #[test]
    fn defaults_to_app_data_cache_and_creates_managed_categories() {
        let test_dir = TestDirectory::new("default-root");
        let settings_path = test_dir.path.join("settings/cache.json");

        let runtime = CacheRuntime::with_settings_path(&test_dir.path, settings_path)
            .expect("默认缓存运行时应初始化成功");

        assert_eq!(
            runtime.root(),
            canonical_runtime_path(&test_dir.path.join(CACHE_DIRECTORY_NAME))
        );
        for category in CacheCategory::ALL {
            assert!(runtime.root().join(category.directory_name()).is_dir());
        }
    }

    #[test]
    fn snapshot_reports_typed_usage_for_each_managed_category() {
        let test_dir = TestDirectory::new("snapshot-usage");
        let runtime = CacheRuntime::with_settings_path(
            &test_dir.path,
            test_dir.path.join("settings/cache.json"),
        )
        .expect("缓存运行时应初始化成功");
        let audio_root = runtime.root().join(CacheCategory::Audio.directory_name());
        fs::write(audio_root.join("first.mp3"), [1_u8, 2, 3]).expect("应写入音频缓存");
        fs::create_dir_all(audio_root.join("album")).expect("应创建嵌套缓存目录");
        fs::write(audio_root.join("album/second.mp3"), [4_u8; 5]).expect("应写入嵌套音频缓存");
        fs::write(
            runtime
                .root()
                .join(CacheCategory::Images.directory_name())
                .join("cover.webp"),
            [8_u8; 7],
        )
        .expect("应写入图片缓存");

        let snapshot = runtime.snapshot();
        let audio = snapshot
            .usage(CacheCategory::Audio)
            .expect("快照应包含音频分类");
        let images = snapshot
            .usage(CacheCategory::Images)
            .expect("快照应包含图片分类");

        assert_eq!(audio.total_bytes, 8);
        assert_eq!(audio.file_count, 2);
        assert_eq!(audio.directory_count, 1);
        assert_eq!(audio.error_count, 0);
        assert!(!audio.truncated);
        assert_eq!(images.total_bytes, 7);
        assert_eq!(snapshot.total_bytes, 15);
        assert_eq!(snapshot.file_count, 3);
        assert_eq!(snapshot.error_count, 0);
        assert_eq!(snapshot.configured_root, runtime.default_root());
        assert_eq!(snapshot.active_root, runtime.root());
        assert!(!snapshot.fallback_used);
        assert!(!snapshot.restart_required);
    }

    #[test]
    fn concurrent_snapshot_requests_share_one_native_scan_generation() {
        let test_dir = TestDirectory::new("single-flight-scan");
        let mut runtime = CacheRuntime::with_settings_path(
            &test_dir.path,
            test_dir.path.join("settings/cache.json"),
        )
        .expect("缓存运行时应初始化成功");
        fs::write(
            runtime
                .root()
                .join(CacheCategory::Audio.directory_name())
                .join("song.mp3"),
            [7_u8; 8],
        )
        .expect("应写入扫描样本");
        let release = Arc::new(Barrier::new(2));
        let release_worker = Arc::clone(&release);
        let (started_tx, started_rx) = mpsc::channel();
        runtime.set_scan_start_hook_for_test(move || {
            started_tx.send(()).expect("应通知扫描已开始");
            release_worker.wait();
        });

        let first_request = runtime.scan_request();
        let first = std::thread::spawn(move || first_request.execute());
        started_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("首次原生扫描应启动");
        let second_request = runtime.scan_request();
        let second = std::thread::spawn(move || second_request.execute());
        release.wait();

        let first_snapshot = first.join().expect("首次扫描线程");
        let second_snapshot = second.join().expect("合并扫描线程");
        assert_eq!(first_snapshot, second_snapshot);
        assert_eq!(runtime.published_scan_generation_for_test(), 1);
    }

    #[test]
    fn latest_snapshot_is_read_only_and_never_starts_native_io() {
        let test_dir = TestDirectory::new("cheap-latest-snapshot");
        let mut runtime = CacheRuntime::with_settings_path(
            &test_dir.path,
            test_dir.path.join("settings/cache.json"),
        )
        .expect("缓存运行时应初始化成功");
        fs::write(
            runtime
                .root()
                .join(CacheCategory::Images.directory_name())
                .join("cover.webp"),
            [5_u8; 11],
        )
        .expect("应写入扫描样本");
        let starts = Arc::new(AtomicUsize::new(0));
        let starts_for_hook = Arc::clone(&starts);
        runtime.set_scan_start_hook_for_test(move || {
            starts_for_hook.fetch_add(1, Ordering::SeqCst);
        });

        let initial = runtime.latest_snapshot();
        assert_eq!(initial.total_bytes, 0);
        assert_eq!(starts.load(Ordering::SeqCst), 0);

        let refreshed = runtime.snapshot();
        assert_eq!(refreshed.total_bytes, 11);
        assert_eq!(starts.load(Ordering::SeqCst), 1);
        assert_eq!(runtime.latest_snapshot(), refreshed);
        assert_eq!(starts.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn successful_clear_updates_the_published_snapshot_without_rescanning() {
        let test_dir = TestDirectory::new("clear-publishes-cheap-state");
        let mut runtime = CacheRuntime::with_settings_path(
            &test_dir.path,
            test_dir.path.join("settings/cache.json"),
        )
        .expect("缓存运行时应初始化成功");
        fs::write(
            runtime
                .root()
                .join(CacheCategory::Audio.directory_name())
                .join("song.mp3"),
            [3_u8; 17],
        )
        .expect("应写入待清理缓存");
        let starts = Arc::new(AtomicUsize::new(0));
        let starts_for_hook = Arc::clone(&starts);
        runtime.set_scan_start_hook_for_test(move || {
            starts_for_hook.fetch_add(1, Ordering::SeqCst);
        });
        assert_eq!(runtime.snapshot().total_bytes, 17);

        runtime
            .clear(CacheCategory::Audio)
            .expect("清理音频缓存应成功");

        let latest = runtime.latest_snapshot();
        assert_eq!(latest.total_bytes, 0);
        assert_eq!(
            latest
                .usage(CacheCategory::Audio)
                .expect("应包含音频分类")
                .file_count,
            0
        );
        assert_eq!(starts.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn stale_scan_result_never_overwrites_newer_cheap_runtime_state() {
        let test_dir = TestDirectory::new("stale-scan-publication");
        let mut runtime = CacheRuntime::with_settings_path(
            &test_dir.path,
            test_dir.path.join("settings/cache.json"),
        )
        .expect("缓存运行时应初始化成功");
        let release = Arc::new(Barrier::new(2));
        let release_worker = Arc::clone(&release);
        let block_once = Arc::new(AtomicBool::new(true));
        let block_once_worker = Arc::clone(&block_once);
        let (started_tx, started_rx) = mpsc::channel();
        runtime.set_scan_start_hook_for_test(move || {
            if block_once_worker.swap(false, Ordering::SeqCst) {
                started_tx.send(()).expect("应通知旧扫描已开始");
                release_worker.wait();
            }
        });

        let old_request = runtime.scan_request();
        let old_scan = std::thread::spawn(move || old_request.execute());
        started_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("旧扫描应启动");
        let selected_parent = test_dir.path.join("next-cache-parent");
        let decision = runtime
            .set_desired_root(Some(selected_parent.clone()))
            .expect("应更新缓存配置");
        assert!(decision.restart_required);
        release.wait();

        let stale_result = old_scan.join().expect("旧扫描线程");
        assert_eq!(stale_result.configured_root, selected_parent);
        assert!(stale_result.restart_required);
        assert_eq!(runtime.latest_snapshot(), stale_result);
        assert_eq!(runtime.published_scan_generation_for_test(), 0);

        let refreshed = runtime.snapshot();
        assert_eq!(refreshed.configured_root, selected_parent);
        assert!(refreshed.restart_required);
        assert_eq!(runtime.published_scan_generation_for_test(), 1);
    }

    #[test]
    fn snapshot_stops_at_the_configured_entry_limit() {
        let test_dir = TestDirectory::new("bounded-scan");
        let runtime = CacheRuntime::with_settings_path_and_limits(
            &test_dir.path,
            test_dir.path.join("settings/cache.json"),
            CacheScanLimits {
                max_depth: 8,
                max_entries: 2,
            },
        )
        .expect("缓存运行时应初始化成功");
        let audio_root = runtime.root().join(CacheCategory::Audio.directory_name());
        for index in 0..5 {
            fs::write(audio_root.join(format!("{index}.mp3")), [index as u8])
                .expect("应写入有界扫描测试缓存");
        }

        let snapshot = runtime.snapshot();
        let audio = snapshot
            .usage(CacheCategory::Audio)
            .expect("快照应包含音频分类");

        assert_eq!(audio.file_count, 2);
        assert!(audio.truncated);
        assert!(snapshot.truncated);
    }

    #[test]
    fn snapshot_records_unreadable_category_errors_without_aborting_other_categories() {
        let test_dir = TestDirectory::new("scan-errors");
        let runtime = CacheRuntime::with_settings_path(
            &test_dir.path,
            test_dir.path.join("settings/cache.json"),
        )
        .expect("缓存运行时应初始化成功");
        let lyrics_path = runtime.root().join(CacheCategory::Lyrics.directory_name());
        fs::remove_dir(&lyrics_path).expect("应移除空歌词缓存目录");
        fs::write(&lyrics_path, [1_u8]).expect("应创建无法作为目录扫描的条目");
        fs::write(
            runtime
                .root()
                .join(CacheCategory::Images.directory_name())
                .join("valid.webp"),
            [9_u8; 4],
        )
        .expect("应写入仍可扫描的图片缓存");

        let snapshot = runtime.snapshot();
        let lyrics = snapshot
            .usage(CacheCategory::Lyrics)
            .expect("快照应包含歌词分类");
        let images = snapshot
            .usage(CacheCategory::Images)
            .expect("快照应包含图片分类");

        assert_eq!(lyrics.error_count, 1);
        assert_eq!(images.file_count, 1);
        assert_eq!(images.total_bytes, 4);
        assert_eq!(snapshot.error_count, 1);
    }

    #[test]
    fn clear_removes_only_the_selected_managed_category_and_recreates_it() {
        let test_dir = TestDirectory::new("clear-category");
        let runtime = CacheRuntime::with_settings_path(
            &test_dir.path,
            test_dir.path.join("settings/cache.json"),
        )
        .expect("缓存运行时应初始化成功");
        let audio_root = runtime.root().join(CacheCategory::Audio.directory_name());
        let images_root = runtime.root().join(CacheCategory::Images.directory_name());
        fs::create_dir_all(audio_root.join("nested")).expect("应创建嵌套音频缓存");
        fs::write(audio_root.join("nested/song.mp3"), [3_u8; 9]).expect("应写入待清理音频缓存");
        fs::write(images_root.join("keep.webp"), [5_u8; 4]).expect("应写入保留的图片缓存");

        let result = runtime
            .clear(CacheCategory::Audio)
            .expect("清理受管音频缓存应成功");

        assert_eq!(result.category, CacheCategory::Audio);
        assert_eq!(result.removed_bytes, 9);
        assert_eq!(result.removed_files, 1);
        assert!(audio_root.is_dir());
        assert_eq!(
            fs::read_dir(&audio_root)
                .expect("应读取重建后的目录")
                .count(),
            0
        );
        assert!(images_root.join("keep.webp").is_file());
    }

    #[test]
    fn clear_request_owns_everything_needed_after_the_runtime_lock_is_released() {
        let test_dir = TestDirectory::new("owned-clear-request");
        let runtime = CacheRuntime::with_settings_path(
            &test_dir.path,
            test_dir.path.join("settings/cache.json"),
        )
        .expect("缓存运行时应初始化成功");
        let temp_root = runtime.root().join(CacheCategory::Temp.directory_name());
        fs::write(temp_root.join("stale.bin"), [4_u8; 6]).expect("应写入待清理缓存");
        let request = runtime.clear_request(CacheCategory::Temp);
        drop(runtime);

        let result = request.execute().expect("拥有型清理请求应可独立执行");

        assert_eq!(result.removed_bytes, 6);
        assert_eq!(result.removed_files, 1);
        assert!(temp_root.is_dir());
    }

    #[test]
    fn scan_and_clear_never_follow_a_managed_category_link() {
        let test_dir = TestDirectory::new("linked-category");
        let runtime = CacheRuntime::with_settings_path(
            &test_dir.path,
            test_dir.path.join("settings/cache.json"),
        )
        .expect("缓存运行时应初始化成功");
        let external = test_dir.path.join("external");
        fs::create_dir_all(&external).expect("应创建外部目录");
        fs::write(external.join("must-stay.bin"), [7_u8; 16]).expect("应写入外部文件");
        let temp_root = runtime.root().join(CacheCategory::Temp.directory_name());
        fs::remove_dir(&temp_root).expect("应移除空临时缓存目录");
        if create_directory_link(&external, &temp_root).is_err() {
            // Windows 未启用开发者模式时创建符号链接需要额外权限，此时跳过平台能力测试。
            return;
        }

        let usage = runtime
            .snapshot()
            .usage(CacheCategory::Temp)
            .cloned()
            .expect("快照应包含临时缓存分类");
        let clear_error = runtime
            .clear(CacheCategory::Temp)
            .expect_err("不得清理指向外部目录的分类链接");

        assert_eq!(usage.file_count, 0);
        assert_eq!(usage.total_bytes, 0);
        assert_eq!(usage.skipped_link_count, 1);
        assert!(matches!(
            clear_error,
            CacheRuntimeError::UnsafeManagedPath { .. }
        ));
        assert!(external.join("must-stay.bin").is_file());
    }

    #[test]
    fn nested_links_are_skipped_during_scan_and_unlinked_during_clear() {
        let test_dir = TestDirectory::new("nested-link");
        let runtime = CacheRuntime::with_settings_path(
            &test_dir.path,
            test_dir.path.join("settings/cache.json"),
        )
        .expect("缓存运行时应初始化成功");
        let external = test_dir.path.join("external-library");
        fs::create_dir_all(&external).expect("应创建外部目录");
        fs::write(external.join("must-stay.bin"), [2_u8; 32]).expect("应写入外部文件");
        let audio_root = runtime.root().join(CacheCategory::Audio.directory_name());
        let nested_link = audio_root.join("external-link");
        if create_directory_link(&external, &nested_link).is_err() {
            return;
        }

        let usage = runtime
            .snapshot()
            .usage(CacheCategory::Audio)
            .cloned()
            .expect("快照应包含音频分类");
        let clear = runtime
            .clear(CacheCategory::Audio)
            .expect("清理应只解除嵌套链接");

        assert_eq!(usage.total_bytes, 0);
        assert_eq!(usage.file_count, 0);
        assert_eq!(usage.skipped_link_count, 1);
        assert_eq!(clear.removed_links, 1);
        assert!(external.join("must-stay.bin").is_file());
    }

    #[cfg(windows)]
    #[test]
    fn windows_relative_open_stays_bound_to_the_original_parent_directory() {
        use windows_sys::Win32::Storage::FileSystem::{FILE_LIST_DIRECTORY, FILE_READ_ATTRIBUTES};

        let test_dir = TestDirectory::new("windows-relative-open");
        let parent_path = test_dir.path.join("managed-parent");
        let parked_parent = test_dir.path.join("parked-parent");
        fs::create_dir_all(&parent_path).expect("应创建原始父目录");
        fs::write(parent_path.join("same-name.bin"), [1_u8; 8]).expect("应写入原始目录样本");

        let parent = WindowsStableDirectory {
            guard: open_windows_handle(&parent_path, FILE_READ_ATTRIBUTES, true)
                .expect("应以允许重命名的方式打开父目录 guard"),
            reader: open_windows_handle(
                &parent_path,
                FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES,
                true,
            )
            .expect("应以允许重命名的方式打开父目录 reader"),
            path: parent_path.clone(),
        };
        fs::rename(&parent_path, &parked_parent).expect("应重命名已打开的父目录");
        fs::create_dir(&parent_path).expect("应在旧路径放置替换目录");
        fs::write(parent_path.join("same-name.bin"), [2_u8; 32]).expect("应写入替换目录样本");

        let (child, attributes) = open_windows_stable_entry_relative(
            &parent,
            std::ffi::OsStr::new("same-name.bin"),
            FILE_READ_ATTRIBUTES,
            false,
        )
        .expect("相对打开必须保持绑定原始父目录");

        assert!(!windows_attributes_are_directory(attributes));
        assert_eq!(
            windows_handle_size(&child.guard).expect("应读取原始文件长度"),
            8
        );
        assert_eq!(
            fs::metadata(parent_path.join("same-name.bin"))
                .expect("替换目录文件应保留")
                .len(),
            32
        );

        drop(child);
        drop(parent);
        fs::remove_dir_all(&parent_path).expect("应移除测试替换目录");
        fs::rename(&parked_parent, &parent_path).expect("应恢复原始父目录");
    }

    #[cfg(windows)]
    #[test]
    fn windows_runtime_keeps_the_initialized_root_when_its_path_is_replaced() {
        let test_dir = TestDirectory::new("windows-retained-cache-root");
        let runtime = CacheRuntime::with_settings_path(
            &test_dir.path,
            test_dir.path.join("settings/cache.json"),
        )
        .expect("缓存运行时应初始化成功");
        let root_path = runtime.root().to_path_buf();
        let parked_root = test_dir.path.join("parked-cache-root");
        let local_file = root_path.join("audio/nested/same-name.bin");
        fs::create_dir_all(local_file.parent().expect("本地文件应有父目录"))
            .expect("应创建本地缓存目录");
        fs::write(&local_file, [1_u8; 8]).expect("应写入本地缓存文件");

        let external_root = test_dir.path.join("external-cache-root");
        let external_file = external_root.join("audio/nested/same-name.bin");
        fs::create_dir_all(external_file.parent().expect("外部文件应有父目录"))
            .expect("应创建外部缓存目录");
        fs::write(
            external_root.join(CACHE_OWNERSHIP_MARKER_NAME),
            b"MineRadio cache ownership v1\n",
        )
        .expect("应创建外部所有权标记诱饵");
        fs::write(&external_file, [2_u8; 32]).expect("应写入外部文件");

        let root_swap_succeeded = fs::rename(&root_path, &parked_root).is_ok();
        if root_swap_succeeded {
            fs::rename(&external_root, &root_path).expect("应把旧缓存根路径替换为外部目录");
        }
        let visible_external_file = if root_swap_succeeded {
            root_path.join("audio/nested/same-name.bin")
        } else {
            external_file.clone()
        };

        let snapshot = runtime.snapshot();
        assert_eq!(
            snapshot
                .usage(CacheCategory::Audio)
                .expect("应包含音频分类")
                .total_bytes,
            8,
            "扫描必须继续绑定初始化时的缓存根"
        );
        runtime
            .clear(CacheCategory::Audio)
            .expect("清理必须继续绑定初始化时的缓存根");
        assert_eq!(
            fs::metadata(&visible_external_file)
                .expect("外部文件应保留")
                .len(),
            32
        );

        drop(runtime);
        if root_swap_succeeded {
            fs::rename(&root_path, &external_root).expect("应移走替换缓存根的外部目录");
            fs::rename(&parked_root, &root_path).expect("应恢复测试缓存根路径");
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_custom_root_handle_failure_uses_fallback_without_forgetting_configuration() {
        let default_root = PathBuf::from(r"C:\MineRadio\cache");
        let fallback_root = PathBuf::from(r"C:\MineRadio\cache-fallback");
        let desired_root = PathBuf::from(r"D:\MusicCache");
        let selected_root = desired_root
            .join(CUSTOM_CACHE_APPLICATION_DIRECTORY_NAME)
            .join(CACHE_DIRECTORY_NAME);
        let mut decision = decide_cache_root(
            &default_root,
            &default_root,
            &fallback_root,
            CacheRootValidation::Usable {
                desired_root: desired_root.clone(),
                effective_root: selected_root.clone(),
            },
        );
        let mut opened = Vec::new();

        let (active_root, retained_root) = retain_windows_selected_root_with(
            selected_root.clone(),
            &default_root,
            &fallback_root,
            &mut decision,
            |path| {
                opened.push(path.to_path_buf());
                if path == selected_root {
                    Err(CacheRuntimeError::UnsafeManagedPath {
                        path: path.to_path_buf(),
                        reason: "测试注入的移动磁盘消失".to_string(),
                    })
                } else {
                    Ok(path.to_path_buf())
                }
            },
        )
        .expect("自定义根句柄失败时应取得 fallback 根句柄");

        assert_eq!(active_root, fallback_root);
        assert_eq!(retained_root, fallback_root);
        assert_eq!(opened, vec![selected_root, fallback_root.clone()]);
        assert_eq!(
            decision.desired_root.as_deref(),
            Some(desired_root.as_path())
        );
        assert_eq!(decision.effective_root, fallback_root);
        assert!(decision.fallback_used);
        assert!(decision
            .fallback_reason
            .as_deref()
            .is_some_and(|reason| reason.contains("测试注入的移动磁盘消失")));
    }

    #[cfg(windows)]
    #[test]
    fn windows_scan_and_clear_hold_no_follow_handles_against_category_swap() {
        let test_dir = TestDirectory::new("windows-category-swap");
        let mut runtime = CacheRuntime::with_settings_path(
            &test_dir.path,
            test_dir.path.join("settings/cache.json"),
        )
        .expect("缓存运行时应初始化成功");
        let external = test_dir.path.join("external-library");
        let external_file = external.join("nested/same-name.bin");
        fs::create_dir_all(external_file.parent().expect("外部文件应有父目录"))
            .expect("应创建外部目录");
        fs::write(&external_file, [2_u8; 32]).expect("应写入外部文件");

        let probe_link = test_dir.path.join("link-capability-probe");
        if create_directory_link(&external, &probe_link).is_err() {
            return;
        }
        fs::remove_dir(&probe_link).expect("应移除链接能力探针");

        let audio_root = runtime.root().join(CacheCategory::Audio.directory_name());
        let local_file = audio_root.join("nested/same-name.bin");
        fs::create_dir_all(local_file.parent().expect("本地文件应有父目录"))
            .expect("应创建本地缓存目录");
        fs::write(&local_file, [1_u8; 8]).expect("应写入本地缓存文件");
        let scan_parked_root = runtime.root().join("audio-scan-parked");
        let scan_swap_succeeded = Arc::new(AtomicBool::new(false));
        let scan_swap_result = Arc::clone(&scan_swap_succeeded);
        let scan_audio_root = audio_root.clone();
        let scan_parked = scan_parked_root.clone();
        let scan_external = external.clone();
        runtime.set_scan_category_open_hook_for_test(CacheCategory::Audio, move || {
            if fs::rename(&scan_audio_root, &scan_parked).is_ok() {
                if create_directory_link(&scan_external, &scan_audio_root).is_ok() {
                    scan_swap_result.store(true, Ordering::SeqCst);
                } else {
                    let _ = fs::rename(&scan_parked, &scan_audio_root);
                }
            }
        });

        let scan = runtime.snapshot();
        assert_eq!(
            scan.usage(CacheCategory::Audio)
                .expect("应包含音频分类")
                .total_bytes,
            8
        );
        assert_eq!(
            fs::metadata(&external_file).expect("外部文件应保留").len(),
            32
        );
        if scan_swap_succeeded.load(Ordering::SeqCst) {
            fs::remove_dir(&audio_root).expect("应移除扫描交换链接");
            fs::rename(&scan_parked_root, &audio_root).expect("应恢复扫描缓存目录");
        }

        let clear_parked_root = runtime.root().join("audio-clear-parked");
        let clear_swap_succeeded = Arc::new(AtomicBool::new(false));
        let clear_swap_result = Arc::clone(&clear_swap_succeeded);
        let clear_audio_root = audio_root.clone();
        let clear_parked = clear_parked_root.clone();
        let clear_external = external.clone();
        runtime.set_clear_category_open_hook_for_test(CacheCategory::Audio, move || {
            if fs::rename(&clear_audio_root, &clear_parked).is_ok() {
                if create_directory_link(&clear_external, &clear_audio_root).is_ok() {
                    clear_swap_result.store(true, Ordering::SeqCst);
                } else {
                    let _ = fs::rename(&clear_parked, &clear_audio_root);
                }
            }
        });

        let clear_result = runtime.clear(CacheCategory::Audio);
        if clear_swap_succeeded.load(Ordering::SeqCst) {
            assert!(matches!(
                clear_result,
                Err(CacheRuntimeError::UnsafeManagedPath { .. })
            ));
            fs::remove_dir(&audio_root).expect("应移除清理交换链接");
            fs::create_dir(&audio_root).expect("应恢复空缓存分类目录");
            assert!(!clear_parked_root.exists());
        } else {
            clear_result.expect("未发生路径交换时清理应成功");
        }
        assert_eq!(
            fs::metadata(&external_file).expect("外部文件应保留").len(),
            32
        );
        assert!(audio_root.is_dir());
    }

    #[test]
    fn root_decision_is_pure_and_marks_only_effective_root_changes_for_restart() {
        let default_root = PathBuf::from("C:/MineRadio/cache");
        let fallback_root = PathBuf::from("C:/MineRadio/cache-fallback");
        let custom_root = PathBuf::from("D:/MineRadio-cache");

        let custom = decide_cache_root(
            &default_root,
            &default_root,
            &fallback_root,
            CacheRootValidation::Usable {
                desired_root: custom_root.clone(),
                effective_root: custom_root.clone(),
            },
        );
        let unavailable = decide_cache_root(
            &default_root,
            &default_root,
            &fallback_root,
            CacheRootValidation::Fallback {
                desired_root: Some(PathBuf::from("Z:/offline-cache")),
                reason: "目录当前不可用".to_string(),
            },
        );
        let reset = decide_cache_root(
            &custom_root,
            &default_root,
            &fallback_root,
            CacheRootValidation::Default,
        );

        assert_eq!(custom.effective_root, custom_root);
        assert!(!custom.fallback_used);
        assert!(custom.restart_required);
        assert_eq!(unavailable.effective_root, fallback_root);
        assert!(unavailable.fallback_used);
        assert!(unavailable.restart_required);
        assert_eq!(reset.desired_root, None);
        assert!(reset.restart_required);
    }

    #[test]
    fn desired_root_is_atomically_persisted_and_activated_on_next_start() {
        let test_dir = TestDirectory::new("persist-root");
        let settings_path = test_dir.path.join("settings/cache.json");
        let custom_root = test_dir.path.join("custom-cache");
        let mut runtime = CacheRuntime::with_settings_path(&test_dir.path, &settings_path)
            .expect("缓存运行时应初始化成功");

        let decision = runtime
            .set_desired_root(Some(custom_root.clone()))
            .expect("应原子持久化自定义缓存目录");

        assert!(decision.restart_required);
        assert!(!decision.fallback_used);
        assert_eq!(
            runtime.root(),
            canonical_runtime_path(&test_dir.path.join(CACHE_DIRECTORY_NAME))
        );
        let pending_snapshot = runtime.snapshot();
        assert_eq!(pending_snapshot.configured_root, custom_root);
        assert_eq!(pending_snapshot.active_root, runtime.root());
        assert!(pending_snapshot.restart_required);
        let persisted: serde_json::Value =
            serde_json::from_slice(&fs::read(&settings_path).expect("应读取缓存设置文件"))
                .expect("缓存设置应是完整 JSON");
        assert_eq!(
            persisted["version"],
            crate::runtime::settings::RUNTIME_SETTINGS_VERSION
        );
        assert_eq!(
            persisted["cacheRoot"],
            serde_json::Value::String(custom_root.to_string_lossy().into_owned())
        );

        let restarted = CacheRuntime::with_settings_path(&test_dir.path, &settings_path)
            .expect("重启时应装载自定义缓存目录");
        assert_eq!(
            restarted.root(),
            canonical_runtime_path(
                &custom_root
                    .join(CUSTOM_CACHE_APPLICATION_DIRECTORY_NAME)
                    .join(CACHE_DIRECTORY_NAME),
            )
        );
        assert!(!restarted.root_decision().restart_required);
        assert!(!restarted.root_decision().fallback_used);
    }

    #[test]
    fn cache_root_updates_share_one_native_document_without_losing_close_behavior() {
        let test_dir = TestDirectory::new("single-settings-owner");
        let settings_path = test_dir.path.join("settings/runtime-settings.json");
        let settings = Arc::new(Mutex::new(RuntimeSettingsStore::with_path(&settings_path)));
        settings
            .lock()
            .expect("原生设置锁")
            .set_close_behavior(CloseBehavior::Tray)
            .expect("应先保存托盘关闭策略");
        let cache_root = test_dir.path.join("custom-cache");
        let mut runtime = CacheRuntime::with_settings_store(&test_dir.path, Arc::clone(&settings))
            .expect("缓存运行时应使用统一原生设置");

        runtime
            .set_desired_root(Some(cache_root.clone()))
            .expect("应通过统一原生设置保存缓存目录");

        let snapshot = settings.lock().expect("原生设置锁").snapshot();
        assert_eq!(snapshot.close_behavior, CloseBehavior::Tray);
        assert_eq!(snapshot.cache_root, Some(cache_root));
        let persisted: serde_json::Value =
            serde_json::from_slice(&fs::read(&settings_path).expect("应读取统一原生设置"))
                .expect("统一原生设置应是完整 JSON");
        assert_eq!(persisted["closeBehavior"], "tray");
        assert!(persisted.get("cacheRoot").is_some());
        assert!(persisted.get("desiredRoot").is_none());
        assert!(persisted.get("schemaVersion").is_none());
    }

    #[test]
    fn user_selected_parent_never_claims_or_clears_existing_sibling_data() {
        let test_dir = TestDirectory::new("custom-parent-ownership");
        let settings_path = test_dir.path.join("settings/cache.json");
        let selected_parent = test_dir.path.join("Downloads");
        let personal_audio = selected_parent.join("audio/personal.flac");
        fs::create_dir_all(personal_audio.parent().expect("personal audio parent"))
            .expect("应创建用户已有 audio 目录");
        fs::write(&personal_audio, [9_u8; 8]).expect("应写入用户文件");
        let mut runtime = CacheRuntime::with_settings_path(&test_dir.path, &settings_path)
            .expect("缓存运行时应初始化成功");

        let decision = runtime
            .set_desired_root(Some(selected_parent.clone()))
            .expect("应把用户目录视为父目录");
        assert_eq!(
            decision.effective_root,
            canonical_runtime_path(
                &selected_parent
                    .join(CUSTOM_CACHE_APPLICATION_DIRECTORY_NAME)
                    .join(CACHE_DIRECTORY_NAME),
            )
        );

        let restarted = CacheRuntime::with_settings_path(&test_dir.path, &settings_path)
            .expect("重启后应使用 MineRadio 专属子目录");
        restarted
            .clear(CacheCategory::Audio)
            .expect("应只清理专属缓存分类");
        assert!(personal_audio.is_file());
    }

    #[test]
    fn preexisting_custom_cache_without_ownership_marker_is_rejected() {
        let test_dir = TestDirectory::new("custom-root-marker");
        let settings_path = test_dir.path.join("settings/cache.json");
        let selected_parent = test_dir.path.join("selected");
        let unmanaged_root = selected_parent
            .join(CUSTOM_CACHE_APPLICATION_DIRECTORY_NAME)
            .join(CACHE_DIRECTORY_NAME);
        fs::create_dir_all(unmanaged_root.join("audio")).expect("应创建未受管目录");
        fs::write(unmanaged_root.join("audio/personal.bin"), [1_u8; 4]).expect("应写入未受管文件");
        let mut runtime = CacheRuntime::with_settings_path(&test_dir.path, &settings_path)
            .expect("缓存运行时应初始化成功");

        let decision = runtime
            .set_desired_root(Some(selected_parent))
            .expect("不可接管时仍应持久化用户意图");

        assert!(decision.fallback_used);
        assert!(unmanaged_root.join("audio/personal.bin").is_file());
    }

    #[test]
    fn unavailable_desired_root_is_persisted_and_activates_fallback_on_next_start() {
        let test_dir = TestDirectory::new("fallback-root");
        let settings_path = test_dir.path.join("settings/cache.json");
        let unavailable_root = test_dir.path.join("not-a-directory");
        fs::write(&unavailable_root, b"file").expect("应创建不可作为缓存目录的文件");
        let mut runtime = CacheRuntime::with_settings_path(&test_dir.path, &settings_path)
            .expect("缓存运行时应初始化成功");

        let decision = runtime
            .set_desired_root(Some(unavailable_root.clone()))
            .expect("即使目标不可用也应持久化用户意图");

        assert!(decision.fallback_used);
        assert!(decision.fallback_reason.is_some());
        assert!(decision.restart_required);
        assert_eq!(decision.effective_root, runtime.fallback_root());

        let restarted = CacheRuntime::with_settings_path(&test_dir.path, &settings_path)
            .expect("重启时不可用目录应回退默认缓存目录");
        assert_eq!(restarted.root(), restarted.fallback_root());
        assert!(restarted.root_decision().fallback_used);
        assert_eq!(
            restarted.root_decision().desired_root.as_deref(),
            Some(unavailable_root.as_path())
        );
        let snapshot = restarted.snapshot();
        assert_eq!(snapshot.configured_root, unavailable_root);
        assert_eq!(snapshot.active_root, restarted.fallback_root());
        assert!(snapshot.fallback_used);
        assert!(snapshot.fallback_reason.is_some());
        assert!(!snapshot.restart_required);
    }

    #[test]
    fn corrupt_settings_use_the_default_root_without_aborting_cache_startup() {
        let test_dir = TestDirectory::new("corrupt-settings");
        let settings_path = test_dir.path.join("settings/cache.json");
        fs::create_dir_all(settings_path.parent().expect("设置路径应有父目录"))
            .expect("应创建设置目录");
        fs::write(&settings_path, b"{not-json").expect("应写入损坏设置");

        let runtime = CacheRuntime::with_settings_path(&test_dir.path, &settings_path)
            .expect("损坏设置不应阻断缓存运行时");
        let snapshot = runtime.snapshot();

        assert_eq!(runtime.root(), runtime.default_root());
        assert_eq!(snapshot.configured_root, runtime.default_root());
        assert!(!snapshot.fallback_used);
        assert!(snapshot.fallback_reason.is_none());
        let settings = runtime.settings.lock().expect("原生设置锁");
        assert!(settings
            .diagnostics()
            .iter()
            .any(|diagnostic| diagnostic.message.contains("JSON")));
        assert!(settings
            .diagnostics()
            .iter()
            .filter_map(|diagnostic| diagnostic.preserved_path.as_ref())
            .any(|path| path.is_file()));
    }

    #[test]
    fn atomic_settings_rewrite_replaces_the_previous_document_without_temp_residue() {
        let test_dir = TestDirectory::new("atomic-rewrite");
        let settings_path = test_dir.path.join("settings/cache.json");
        let settings_dir = settings_path.parent().expect("设置路径应有父目录");
        let mut runtime = CacheRuntime::with_settings_path(&test_dir.path, &settings_path)
            .expect("缓存运行时应初始化成功");
        runtime
            .set_desired_root(Some(test_dir.path.join("custom-cache")))
            .expect("首次设置应写入成功");

        runtime
            .set_desired_root(None)
            .expect("再次设置应原子替换已有文件");

        let persisted: serde_json::Value =
            serde_json::from_slice(&fs::read(&settings_path).expect("应读取替换后的缓存设置"))
                .expect("替换后仍应是完整 JSON");
        assert!(persisted["cacheRoot"].is_null());
        let temp_files = fs::read_dir(settings_dir)
            .expect("应读取设置目录")
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().contains(".tmp-"))
            .count();
        assert_eq!(temp_files, 0);
    }
}
