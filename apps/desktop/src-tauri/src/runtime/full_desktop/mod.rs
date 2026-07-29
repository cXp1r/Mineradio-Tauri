//! 完整桌面模式的纯 Rust 核心。
//!
//! 此模块不认识 Tauri、命令或具体 Windows API。平台层只能通过小型 trait 安装，
//! 因此崩溃恢复、写前日志和状态机可在任何平台适配器之外独立验证。

pub mod reconcile;

use crate::runtime::resources::ProcessIdentity;
use serde::{Deserialize, Serialize};
use std::{
    error::Error,
    fmt,
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

pub const FULL_DESKTOP_RECOVERY_FILE_NAME: &str = "full-desktop-recovery.json";
pub const FULL_DESKTOP_RECOVERY_VERSION: u32 = 1;

static JOURNAL_WRITE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FullDesktopMode {
    #[default]
    Disabled,
    Passive,
    Interactive,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FullDesktopPhase {
    Disabled,
    Attaching,
    Passive,
    Interactive,
    Recovering,
    Detaching,
    RecoveryRequired,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowIdentity {
    pub handle: u64,
    pub parent_handle: u64,
    pub thread_id: u32,
    pub process: Option<ProcessIdentity>,
    pub class_name: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformSnapshot {
    pub windows: Vec<WindowIdentity>,
    /// 平台私有、但可 JSON 持久化的恢复数据。
    pub payload: serde_json::Value,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IconSnapshot {
    pub visible: bool,
    pub payload: serde_json::Value,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub id: String,
    pub generation: u64,
    #[serde(default)]
    pub pending: bool,
}

impl Attachment {
    fn pending(generation: u64) -> Self {
        Self {
            id: format!("pending-{generation}"),
            generation,
            pending: true,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum OwnerStatus {
    #[default]
    Dead,
    Live,
    Uncertain,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MutationCheckpoints {
    pub capture_committed: bool,
    pub attachment_committed: bool,
    pub icons_visibility_applied: bool,
    pub interaction_lock_applied: bool,
    pub rollback_started: bool,
    pub rollback_completed: bool,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryJournalMetadata {
    pub application_version: String,
    pub created_at_ms: u64,
    pub launch_nonce: String,
    #[serde(default)]
    pub checkpoints: MutationCheckpoints,
    /// 只持久化稳定低基数码，不写路径、Win32 文本或第三方 payload。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_failure_code: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryJournal {
    pub version: u32,
    /// v1 文件没有 metadata；serde default 让旧恢复材料仍可读并按既有安全路径处理。
    #[serde(default)]
    pub metadata: RecoveryJournalMetadata,
    pub owner: ProcessIdentity,
    pub mode: FullDesktopMode,
    pub platform_snapshot: PlatformSnapshot,
    pub icons: IconSnapshot,
    pub attachment: Attachment,
    pub icons_visible: bool,
    pub interaction_locked: bool,
    pub generation: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FullDesktopRuntimeState {
    pub phase: FullDesktopPhase,
    pub requested_mode: FullDesktopMode,
    pub effective_mode: FullDesktopMode,
    pub icons_visible: bool,
    pub interaction_locked: bool,
    pub recovery_required: bool,
    pub auto_resume_suppressed: bool,
    pub explorer_generation: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum FullDesktopError {
    PlatformUnavailable,
    Unsupported,
    RecoveryRequired,
    Platform(String),
    Journal(String),
    InvalidAttachment(String),
}

impl fmt::Display for FullDesktopError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::PlatformUnavailable => write!(formatter, "完整桌面平台适配器尚未安装"),
            Self::Unsupported => write!(formatter, "当前平台不支持完整桌面模式"),
            Self::RecoveryRequired => write!(formatter, "完整桌面模式需要先完成恢复"),
            Self::Platform(message) => write!(formatter, "完整桌面平台操作失败：{message}"),
            Self::Journal(message) => write!(formatter, "完整桌面恢复日志失败：{message}"),
            Self::InvalidAttachment(message) => {
                write!(formatter, "完整桌面附着校验失败：{message}")
            }
        }
    }
}

impl Error for FullDesktopError {}

impl FullDesktopError {
    pub const fn code(&self) -> &'static str {
        match self {
            Self::PlatformUnavailable => "PLATFORM_UNAVAILABLE",
            Self::Unsupported => "UNSUPPORTED",
            Self::RecoveryRequired => "RECOVERY_REQUIRED",
            Self::Platform(_) => "PLATFORM",
            Self::Journal(_) => "JOURNAL",
            Self::InvalidAttachment(_) => "INVALID_ATTACHMENT",
        }
    }
}

/// 平台层只承担原生操作；状态转换和持久化顺序必须留在 `FullDesktopRuntime`。
pub trait FullDesktopPlatform: Send {
    fn supported(&self) -> bool;
    /// 只读地确认主窗口当前 parent 是否仍是这次附着已验证的桌面宿主。实现不得
    /// 发现 Explorer、触发 reconcile、读取 journal 或执行任何原生 mutation。
    fn actual_main_desktop_child(
        &self,
        snapshot: &PlatformSnapshot,
    ) -> Result<Option<bool>, FullDesktopError>;
    fn current_owner_identity(&self) -> Result<ProcessIdentity, FullDesktopError>;
    fn owner_status(&self, owner: ProcessIdentity) -> Result<OwnerStatus, FullDesktopError>;
    fn capture(
        &mut self,
        mode: FullDesktopMode,
    ) -> Result<(PlatformSnapshot, IconSnapshot), FullDesktopError>;
    fn attach(
        &mut self,
        mode: FullDesktopMode,
        snapshot: &PlatformSnapshot,
        icons_visible: bool,
        interaction_locked: bool,
    ) -> Result<Attachment, FullDesktopError>;
    fn restore(
        &mut self,
        snapshot: &PlatformSnapshot,
        attachment: &Attachment,
    ) -> Result<(), FullDesktopError>;
    fn recover_stale(&mut self, journal: &RecoveryJournal) -> Result<(), FullDesktopError>;
    fn validate_attachment(&mut self, attachment: &Attachment) -> Result<(), FullDesktopError>;
    fn set_icons_visible(&mut self, visible: bool) -> Result<(), FullDesktopError>;
    fn set_interaction_locked(&mut self, locked: bool) -> Result<(), FullDesktopError>;
}

pub trait RecoveryJournalStore: Send {
    fn load(&mut self) -> Result<Option<RecoveryJournal>, FullDesktopError>;
    fn write_before_mutation(&mut self, journal: &RecoveryJournal) -> Result<(), FullDesktopError>;
    fn clear_after_verified_restore(&mut self) -> Result<(), FullDesktopError>;
}

/// 同进程状态机。调用者只需要持有这个深模块，不应自行执行平台 mutation。
pub struct FullDesktopRuntime {
    platform: Option<Box<dyn FullDesktopPlatform>>,
    journal_store: Box<dyn RecoveryJournalStore>,
    active_journal: Option<RecoveryJournal>,
    launch_nonce: Option<String>,
    launch_nonce_error: Option<String>,
    requested_mode: FullDesktopMode,
    effective_mode: FullDesktopMode,
    phase: FullDesktopPhase,
    generation: u64,
    explorer_generation: u64,
    platform_snapshot: Option<PlatformSnapshot>,
    attachment: Option<Attachment>,
    icons: Option<IconSnapshot>,
    icons_visible: bool,
    interaction_locked: bool,
    has_recovery_journal: bool,
    auto_resume_suppressed: bool,
    last_error: Option<String>,
    last_error_code: Option<&'static str>,
}

impl FullDesktopRuntime {
    pub fn new(journal_store: Box<dyn RecoveryJournalStore>) -> Self {
        Self::new_with_nonce_result(journal_store, new_launch_nonce())
    }

    fn new_with_nonce_result(
        journal_store: Box<dyn RecoveryJournalStore>,
        nonce: Result<String, FullDesktopError>,
    ) -> Self {
        let (launch_nonce, launch_nonce_error) = match nonce {
            Ok(nonce) => (Some(nonce), None),
            Err(error) => (None, Some(error.to_string())),
        };
        Self {
            platform: None,
            journal_store,
            active_journal: None,
            launch_nonce,
            launch_nonce_error,
            requested_mode: FullDesktopMode::Disabled,
            effective_mode: FullDesktopMode::Disabled,
            phase: FullDesktopPhase::Disabled,
            generation: 0,
            explorer_generation: 0,
            platform_snapshot: None,
            attachment: None,
            icons: None,
            icons_visible: true,
            interaction_locked: false,
            has_recovery_journal: false,
            auto_resume_suppressed: false,
            last_error: None,
            last_error_code: None,
        }
    }

    #[cfg(test)]
    fn new_for_test_with_nonce_failure(journal_store: Box<dyn RecoveryJournalStore>) -> Self {
        Self::new_with_nonce_result(
            journal_store,
            Err(FullDesktopError::Journal("测试系统熵不可用".into())),
        )
    }

    pub fn install_platform(&mut self, platform: Box<dyn FullDesktopPlatform>) {
        self.platform = Some(platform);
    }

    pub fn snapshot(&self) -> FullDesktopRuntimeState {
        FullDesktopRuntimeState {
            phase: self.phase,
            requested_mode: self.requested_mode,
            effective_mode: self.effective_mode,
            icons_visible: self.icons_visible,
            interaction_locked: self.interaction_locked,
            recovery_required: self.phase == FullDesktopPhase::RecoveryRequired,
            auto_resume_suppressed: self.auto_resume_suppressed,
            explorer_generation: self.explorer_generation,
            last_error: self.last_error.clone(),
        }
    }

    pub fn startup_recover(&mut self) -> Result<(), FullDesktopError> {
        let journal = match self.journal_store.load() {
            Ok(journal) => journal,
            Err(error) => {
                self.auto_resume_suppressed = true;
                self.has_recovery_journal = true;
                return self.fail_recovery(error);
            }
        };
        let Some(journal) = journal else {
            self.has_recovery_journal = false;
            return Ok(());
        };
        // 只要发现上一会话 journal，本次启动就禁止自动重新附着，避免 crash loop。
        self.auto_resume_suppressed = true;
        self.has_recovery_journal = true;
        self.active_journal = Some(journal.clone());
        if journal.version != FULL_DESKTOP_RECOVERY_VERSION {
            return self.fail_recovery(FullDesktopError::Journal(format!(
                "不支持恢复日志版本 {}",
                journal.version
            )));
        }
        let owner_status = match self
            .platform_mut()
            .and_then(|platform| platform.owner_status(journal.owner))
        {
            Ok(status) => status,
            Err(error) => return self.fail_recovery(error),
        };
        match owner_status {
            OwnerStatus::Dead => {
                self.phase = FullDesktopPhase::Recovering;
                if let Err(error) = self.mark_rollback_started() {
                    return self.fail_recovery(error);
                }
                if let Err(error) = self
                    .platform_mut()
                    .and_then(|platform| platform.recover_stale(&journal))
                {
                    return self.fail_recovery(error);
                }
                if let Err(error) = self.mark_rollback_completed() {
                    return self.fail_recovery(error);
                }
                if let Err(error) = self.journal_store.clear_after_verified_restore() {
                    return self.fail_recovery(error);
                }
                self.reset_disabled();
                Ok(())
            }
            OwnerStatus::Live | OwnerStatus::Uncertain => {
                self.fail_recovery(FullDesktopError::RecoveryRequired)
            }
        }
    }

    /// 显式恢复入口。当前进程的半完成 mutation 使用内存快照回滚；上一会话则复用
    /// 启动恢复的 owner 校验，绝不因用户点击而跳过身份验证。
    pub fn recover(&mut self) -> Result<FullDesktopRuntimeState, FullDesktopError> {
        if self.phase != FullDesktopPhase::RecoveryRequired {
            return Ok(self.snapshot());
        }
        if let (Some(snapshot), Some(attachment)) =
            (self.platform_snapshot.clone(), self.attachment.clone())
        {
            if let Err(error) = self.ensure_current_session_journal() {
                return self.fail_recovery(error);
            }
            self.phase = FullDesktopPhase::Recovering;
            if let Err(error) = self.mark_rollback_started() {
                return self.fail_recovery(error);
            }
            if let Err(error) = self
                .platform_mut()
                .and_then(|platform| platform.restore(&snapshot, &attachment))
            {
                return self.fail_recovery(error);
            }
            if let Err(error) = self.mark_rollback_completed() {
                return self.fail_recovery(error);
            }
            if let Err(error) = self.journal_store.clear_after_verified_restore() {
                return self.fail_recovery(error);
            }
            self.reset_disabled();
            return Ok(self.snapshot());
        }
        self.startup_recover()?;
        Ok(self.snapshot())
    }

    pub fn has_recovery_journal(&self) -> bool {
        self.has_recovery_journal
    }

    /// 只读诊断：不读取磁盘，也不会改变恢复状态。
    pub fn recovery_journal_version(&self) -> Option<u32> {
        self.active_journal.as_ref().map(|journal| journal.version)
    }

    /// 只读稳定错误码；命令层可在不解析本地化错误文本的情况下消费它。
    pub fn last_error_code(&self) -> Option<&'static str> {
        self.last_error_code
    }

    /// 只读 diagnostics seam。稳定附着与半附着恢复都复用首次 mutation 前捕获的
    /// 平台快照；任何快照缺失、平台缺失或原生读取失败都明确降级为 unavailable。
    pub fn actual_main_desktop_child(&self) -> Option<bool> {
        let snapshot = self.platform_snapshot.as_ref()?;
        self.platform
            .as_ref()?
            .actual_main_desktop_child(snapshot)
            .ok()
            .flatten()
    }

    pub fn request_mode(
        &mut self,
        mode: FullDesktopMode,
    ) -> Result<FullDesktopRuntimeState, FullDesktopError> {
        self.requested_mode = mode;
        if mode == FullDesktopMode::Disabled {
            self.disable_for_shutdown()?;
            return Ok(self.snapshot());
        }
        if self.phase == FullDesktopPhase::RecoveryRequired {
            return Err(FullDesktopError::RecoveryRequired);
        }
        if self.effective_mode == mode
            && matches!(
                self.phase,
                FullDesktopPhase::Passive | FullDesktopPhase::Interactive
            )
        {
            return Ok(self.snapshot());
        }
        if self.effective_mode != FullDesktopMode::Disabled {
            self.disable_for_shutdown()?;
        }
        self.enable(mode, false)?;
        Ok(self.snapshot())
    }

    pub fn disable_for_shutdown(&mut self) -> Result<(), FullDesktopError> {
        if self.phase == FullDesktopPhase::RecoveryRequired
            || (self.has_recovery_journal && self.attachment.is_none())
        {
            return Err(FullDesktopError::RecoveryRequired);
        }
        if self.effective_mode == FullDesktopMode::Disabled && self.attachment.is_none() {
            self.reset_disabled();
            return Ok(());
        }
        self.phase = FullDesktopPhase::Detaching;
        let snapshot = self
            .platform_snapshot
            .clone()
            .ok_or(FullDesktopError::RecoveryRequired)?;
        let attachment = self
            .attachment
            .clone()
            .ok_or(FullDesktopError::RecoveryRequired)?;
        if let Err(error) = self.ensure_current_session_journal() {
            return self.fail_recovery(error);
        }
        if let Err(error) = self.mark_rollback_started() {
            return self.fail_recovery(error);
        }
        if let Err(error) = self
            .platform_mut()
            .and_then(|platform| platform.restore(&snapshot, &attachment))
        {
            return self.fail_recovery(error);
        }
        if let Err(error) = self.mark_rollback_completed() {
            return self.fail_recovery(error);
        }
        if let Err(error) = self.journal_store.clear_after_verified_restore() {
            return self.fail_recovery(error);
        }
        self.reset_disabled();
        Ok(())
    }

    pub fn reconcile(&mut self) -> Result<FullDesktopRuntimeState, FullDesktopError> {
        if self.effective_mode == FullDesktopMode::Disabled {
            return Ok(self.snapshot());
        }
        let attachment = self
            .attachment
            .clone()
            .ok_or(FullDesktopError::RecoveryRequired)?;
        match self
            .platform_mut()
            .and_then(|platform| platform.validate_attachment(&attachment))
        {
            Ok(()) => return Ok(self.snapshot()),
            Err(error) if matches!(error, FullDesktopError::PlatformUnavailable) => {
                return self.fail_recovery(error);
            }
            Err(_) => {}
        }
        let mode = self.effective_mode;
        self.phase = FullDesktopPhase::Recovering;
        let snapshot = self
            .platform_snapshot
            .clone()
            .ok_or(FullDesktopError::RecoveryRequired)?;
        if let Err(error) = self.ensure_current_session_journal() {
            return self.fail_recovery(error);
        }
        if let Err(error) = self.mark_rollback_started() {
            return self.fail_recovery(error);
        }
        if let Err(error) = self
            .platform_mut()
            .and_then(|platform| platform.restore(&snapshot, &attachment))
        {
            return self.fail_recovery(error);
        }
        if let Err(error) = self.mark_rollback_completed() {
            return self.fail_recovery(error);
        }
        // Explorer 已失效时，旧 journal 必须保留到新的附着完成；否则新 attach 中断会丢失
        // 唯一的回滚材料。失败路径由 `enable(..., true)` 统一进入 recoveryRequired。
        self.enable(mode, true)?;
        self.explorer_generation = self.explorer_generation.wrapping_add(1);
        Ok(self.snapshot())
    }

    pub fn set_icons_visible(
        &mut self,
        visible: bool,
    ) -> Result<FullDesktopRuntimeState, FullDesktopError> {
        self.write_active_journal_before_mutation()?;
        if let Err(error) =
            self.with_live_attachment(|platform, _| platform.set_icons_visible(visible))
        {
            return self.fail_recovery(error);
        }
        self.icons_visible = visible;
        if let Err(error) = self.persist_active_journal_checkpoint(|journal| {
            journal.icons_visible = visible;
            journal.metadata.checkpoints.icons_visibility_applied = true;
        }) {
            return self.fail_recovery(error);
        }
        Ok(self.snapshot())
    }

    pub fn set_interaction_locked(
        &mut self,
        locked: bool,
    ) -> Result<FullDesktopRuntimeState, FullDesktopError> {
        self.write_active_journal_before_mutation()?;
        if let Err(error) =
            self.with_live_attachment(|platform, _| platform.set_interaction_locked(locked))
        {
            return self.fail_recovery(error);
        }
        self.interaction_locked = locked;
        if let Err(error) = self.persist_active_journal_checkpoint(|journal| {
            journal.interaction_locked = locked;
            journal.metadata.checkpoints.interaction_lock_applied = true;
        }) {
            return self.fail_recovery(error);
        }
        Ok(self.snapshot())
    }

    fn enable(
        &mut self,
        mode: FullDesktopMode,
        retain_journal_on_failure: bool,
    ) -> Result<(), FullDesktopError> {
        self.generation = self.generation.wrapping_add(1);
        let generation = self.generation;
        self.phase = FullDesktopPhase::Attaching;
        let launch_nonce =
            match self.launch_nonce.clone() {
                Some(nonce) => nonce,
                None => {
                    return self.enable_preflight_failure(
                        FullDesktopError::Journal(self.launch_nonce_error.clone().unwrap_or_else(
                            || "系统熵不可用，拒绝创建完整桌面恢复 journal".into(),
                        )),
                        retain_journal_on_failure,
                    );
                }
            };
        let icons_visible = self.icons_visible;
        let interaction_locked = self.interaction_locked;
        let supported = match self.platform_mut() {
            Ok(platform) => platform.supported(),
            Err(error) => return self.enable_preflight_failure(error, retain_journal_on_failure),
        };
        if !supported {
            return self.enable_preflight_failure(
                FullDesktopError::Unsupported,
                retain_journal_on_failure,
            );
        }
        let owner = match self
            .platform_mut()
            .and_then(|platform| platform.current_owner_identity())
        {
            Ok(owner) => owner,
            Err(error) => return self.enable_preflight_failure(error, retain_journal_on_failure),
        };
        let (snapshot, icons) = match self
            .platform_mut()
            .and_then(|platform| platform.capture(mode))
        {
            Ok(snapshot) => snapshot,
            Err(error) => return self.enable_preflight_failure(error, retain_journal_on_failure),
        };
        // Attach 是第一个会改变 Explorer/桌面的操作；其前必须存在可恢复日志。
        let pending = Attachment::pending(generation);
        let journal = RecoveryJournal {
            version: FULL_DESKTOP_RECOVERY_VERSION,
            metadata: RecoveryJournalMetadata {
                application_version: env!("CARGO_PKG_VERSION").to_string(),
                created_at_ms: now_ms(),
                launch_nonce,
                checkpoints: MutationCheckpoints {
                    capture_committed: true,
                    ..Default::default()
                },
                last_failure_code: None,
            },
            owner,
            mode,
            platform_snapshot: snapshot.clone(),
            icons: icons.clone(),
            attachment: pending.clone(),
            icons_visible,
            interaction_locked,
            generation,
        };
        if let Err(error) = self.journal_store.write_before_mutation(&journal) {
            if retain_journal_on_failure {
                return self.fail_recovery(error);
            }
            self.reset_disabled();
            return Err(error);
        }
        self.has_recovery_journal = true;
        self.active_journal = Some(journal.clone());
        // 从第一次 mutation 起保留内存恢复材料；即使 attach 在中途失败，显式恢复仍可
        // 使用同一快照回到普通顶层窗口。
        self.platform_snapshot = Some(snapshot.clone());
        self.icons = Some(icons.clone());
        self.attachment = Some(pending.clone());
        let attachment =
            match self
                .platform_mut()?
                .attach(mode, &snapshot, icons_visible, interaction_locked)
            {
                Ok(attachment) => attachment,
                Err(error) => {
                    // 即便平台报告 attach 失败，也强制请求恢复，避免半完成原生 mutation 留存。
                    if let Err(checkpoint_error) = self.mark_rollback_started() {
                        return self.fail_recovery(checkpoint_error);
                    }
                    let restore = self.platform_mut()?.restore(&snapshot, &pending);
                    if restore.is_ok() {
                        if let Err(checkpoint_error) = self.mark_rollback_completed() {
                            return self.fail_recovery(checkpoint_error);
                        }
                        if retain_journal_on_failure {
                            return self.fail_recovery(error);
                        }
                        self.journal_store.clear_after_verified_restore()?;
                        self.reset_disabled();
                        return Err(error);
                    }
                    return self.fail_recovery(restore.expect_err("恢复错误"));
                }
            };
        self.attachment = Some(attachment.clone());
        let mut committed = journal;
        committed.attachment = attachment.clone();
        committed.metadata.checkpoints.attachment_committed = true;
        // attach 成功后再次持久化真实 attachment；失败时立即恢复，日志仍保留供下次启动处理。
        if let Err(error) = self.journal_store.write_before_mutation(&committed) {
            if let Err(checkpoint_error) = self.mark_rollback_started() {
                return self.fail_recovery(checkpoint_error);
            }
            if self.platform_mut()?.restore(&snapshot, &attachment).is_ok() {
                if let Err(checkpoint_error) = self.mark_rollback_completed() {
                    return self.fail_recovery(checkpoint_error);
                }
                if retain_journal_on_failure {
                    return self.fail_recovery(error);
                }
                if let Err(clear_error) = self.journal_store.clear_after_verified_restore() {
                    return self.fail_recovery(clear_error);
                }
                self.reset_disabled();
                return Err(error);
            }
            return self.fail_recovery(error);
        }
        self.active_journal = Some(committed);
        if generation != self.generation {
            if let Err(error) = self.mark_rollback_started() {
                return self.fail_recovery(error);
            }
            let _ = self.platform_mut()?.restore(&snapshot, &attachment);
            return self.fail_recovery(FullDesktopError::InvalidAttachment(
                "过期 generation 不得提交完整桌面状态".into(),
            ));
        }
        self.platform_snapshot = Some(snapshot);
        self.icons = Some(icons);
        self.attachment = Some(attachment);
        self.effective_mode = mode;
        self.phase = match mode {
            FullDesktopMode::Passive => FullDesktopPhase::Passive,
            FullDesktopMode::Interactive => FullDesktopPhase::Interactive,
            FullDesktopMode::Disabled => FullDesktopPhase::Disabled,
        };
        self.last_error = None;
        Ok(())
    }

    fn with_live_attachment<T>(
        &mut self,
        action: impl FnOnce(&mut dyn FullDesktopPlatform, &Attachment) -> Result<T, FullDesktopError>,
    ) -> Result<T, FullDesktopError> {
        if self.effective_mode == FullDesktopMode::Disabled {
            return Err(FullDesktopError::RecoveryRequired);
        }
        let attachment = self
            .attachment
            .clone()
            .ok_or(FullDesktopError::RecoveryRequired)?;
        let platform = self.platform_mut()?;
        platform.validate_attachment(&attachment)?;
        action(platform, &attachment)
    }

    fn enable_preflight_failure<T>(
        &mut self,
        error: FullDesktopError,
        retain_journal_on_failure: bool,
    ) -> Result<T, FullDesktopError> {
        if retain_journal_on_failure {
            self.has_recovery_journal = true;
            return self.fail_recovery(error);
        }
        // 首次启用尚未执行任何平台 mutation；保持普通 disabled 语义，不制造恢复日志。
        self.phase = FullDesktopPhase::Disabled;
        Err(error)
    }

    fn write_active_journal_before_mutation(&mut self) -> Result<(), FullDesktopError> {
        self.ensure_current_session_journal()?;
        let journal = self
            .active_journal
            .clone()
            .ok_or(FullDesktopError::RecoveryRequired)?;
        self.journal_store.write_before_mutation(&journal)?;
        self.has_recovery_journal = true;
        Ok(())
    }

    fn persist_active_journal_checkpoint(
        &mut self,
        mutate: impl FnOnce(&mut RecoveryJournal),
    ) -> Result<(), FullDesktopError> {
        let mut journal = self
            .active_journal
            .clone()
            .ok_or(FullDesktopError::RecoveryRequired)?;
        mutate(&mut journal);
        self.journal_store.write_before_mutation(&journal)?;
        self.active_journal = Some(journal);
        self.has_recovery_journal = true;
        Ok(())
    }

    fn ensure_current_session_journal(&self) -> Result<(), FullDesktopError> {
        let nonce = self
            .launch_nonce
            .as_deref()
            .ok_or(FullDesktopError::RecoveryRequired)?;
        let journal = self
            .active_journal
            .as_ref()
            .ok_or(FullDesktopError::RecoveryRequired)?;
        if journal.metadata.launch_nonce.is_empty() || journal.metadata.launch_nonce != nonce {
            return Err(FullDesktopError::RecoveryRequired);
        }
        Ok(())
    }

    fn mark_rollback_started(&mut self) -> Result<(), FullDesktopError> {
        self.persist_active_journal_checkpoint(|journal| {
            journal.metadata.checkpoints.rollback_started = true;
            journal.metadata.checkpoints.rollback_completed = false;
        })
    }

    fn mark_rollback_completed(&mut self) -> Result<(), FullDesktopError> {
        self.persist_active_journal_checkpoint(|journal| {
            journal.metadata.checkpoints.rollback_completed = true;
        })
    }

    fn platform_mut(&mut self) -> Result<&mut (dyn FullDesktopPlatform + '_), FullDesktopError> {
        match self.platform.as_mut() {
            Some(platform) => Ok(platform.as_mut()),
            None => Err(FullDesktopError::PlatformUnavailable),
        }
    }

    fn fail_recovery<T>(&mut self, error: FullDesktopError) -> Result<T, FullDesktopError> {
        let error_code = error.code();
        self.phase = FullDesktopPhase::RecoveryRequired;
        self.last_error = Some(error.to_string());
        self.last_error_code = Some(error_code);
        // journal 已经拥有原生 mutation 时，尽力写入稳定失败码供下次启动诊断。
        // 若失败本身来自磁盘，二次写入失败也不能覆盖原始错误或清掉恢复责任。
        if self.has_recovery_journal && self.active_journal.is_some() {
            let _ = self.persist_active_journal_checkpoint(|journal| {
                journal.metadata.last_failure_code = Some(error_code.to_string());
            });
        }
        Err(error)
    }

    fn reset_disabled(&mut self) {
        self.effective_mode = FullDesktopMode::Disabled;
        self.phase = FullDesktopPhase::Disabled;
        self.platform_snapshot = None;
        self.attachment = None;
        self.icons = None;
        self.active_journal = None;
        self.has_recovery_journal = false;
        self.last_error = None;
        self.last_error_code = None;
    }
}

/// 默认文件实现。损坏日志会改名保留，拒绝静默覆盖，避免丢失唯一恢复证据。
pub struct FileRecoveryJournalStore {
    path: PathBuf,
    corrupt_blocked: Option<String>,
}

impl FileRecoveryJournalStore {
    pub fn for_app_data(app_data_dir: impl AsRef<Path>) -> Self {
        Self::with_path(app_data_dir.as_ref().join(FULL_DESKTOP_RECOVERY_FILE_NAME))
    }
    pub fn with_path(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            corrupt_blocked: None,
        }
    }
    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl RecoveryJournalStore for FileRecoveryJournalStore {
    fn load(&mut self) -> Result<Option<RecoveryJournal>, FullDesktopError> {
        if let Some(reason) = &self.corrupt_blocked {
            return Err(FullDesktopError::Journal(reason.clone()));
        }
        let bytes = match fs::read(&self.path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(journal_io("读取恢复日志", &self.path, error)),
        };
        match serde_json::from_slice(&bytes) {
            Ok(journal) => Ok(Some(journal)),
            Err(error) => {
                let preserved = preserve_corrupt(&self.path)
                    .map_err(|io| journal_io("保留损坏恢复日志", &self.path, io))?;
                self.corrupt_blocked = Some(format!(
                    "恢复日志无效，已保留至 {}：{error}",
                    preserved.display()
                ));
                Err(FullDesktopError::Journal(
                    self.corrupt_blocked.clone().expect("刚写入"),
                ))
            }
        }
    }
    fn write_before_mutation(&mut self, journal: &RecoveryJournal) -> Result<(), FullDesktopError> {
        if let Some(reason) = &self.corrupt_blocked {
            return Err(FullDesktopError::Journal(reason.clone()));
        }
        write_journal_atomically(&self.path, journal)
    }
    fn clear_after_verified_restore(&mut self) -> Result<(), FullDesktopError> {
        match fs::remove_file(&self.path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(journal_io("删除已恢复日志", &self.path, error)),
        }
    }
}

fn journal_io(operation: &'static str, path: &Path, source: io::Error) -> FullDesktopError {
    FullDesktopError::Journal(format!("{operation} {} 失败：{source}", path.display()))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn new_launch_nonce() -> Result<String, FullDesktopError> {
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes).map_err(|error| {
        FullDesktopError::Journal(format!("读取系统熵生成 launch nonce 失败：{error}"))
    })?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn preserve_corrupt(path: &Path) -> io::Result<PathBuf> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let sequence = JOURNAL_WRITE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let preserved = parent.join(format!(
        ".{}.corrupt-{}-{sequence}",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or(FULL_DESKTOP_RECOVERY_FILE_NAME),
        std::process::id()
    ));
    // forensic 副本只用于审计，原 primary 必须继续留在固定路径。否则下一进程会把
    // “主 journal 不存在”误当成无恢复责任，绕过 fail-closed 并覆盖未知原生状态。
    fs::copy(path, &preserved)?;
    Ok(preserved)
}
fn write_journal_atomically(
    path: &Path,
    journal: &RecoveryJournal,
) -> Result<(), FullDesktopError> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent).map_err(|error| journal_io("创建恢复日志目录", parent, error))?;
    let mut payload = serde_json::to_vec_pretty(journal)
        .map_err(|error| FullDesktopError::Journal(format!("编码恢复日志失败：{error}")))?;
    payload.push(b'\n');
    let sequence = JOURNAL_WRITE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(FULL_DESKTOP_RECOVERY_FILE_NAME);
    let temporary = parent.join(format!(".{name}.tmp-{}-{sequence}", std::process::id()));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|error| journal_io("创建恢复日志临时文件", &temporary, error))?;
    if let Err(error) = file.write_all(&payload).and_then(|_| file.sync_all()) {
        drop(file);
        let _ = fs::remove_file(&temporary);
        return Err(journal_io("写入恢复日志临时文件", &temporary, error));
    }
    drop(file);
    if let Err(error) = atomic_replace(&temporary, path) {
        let _ = fs::remove_file(&temporary);
        return Err(journal_io("原子替换恢复日志", path, error));
    }
    Ok(())
}
#[cfg(windows)]
fn atomic_replace(source: &Path, destination: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    if unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}
#[cfg(not(windows))]
fn atomic_replace(source: &Path, destination: &Path) -> io::Result<()> {
    fs::rename(source, destination)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        collections::VecDeque,
        sync::{Arc, Mutex},
    };

    #[derive(Default)]
    struct MemoryJournal {
        value: Option<RecoveryJournal>,
        history: Vec<RecoveryJournal>,
        writes: usize,
        fail_write: bool,
        fail_after_writes: Option<usize>,
        fail_clear: bool,
        clears: usize,
    }
    impl RecoveryJournalStore for Arc<Mutex<MemoryJournal>> {
        fn load(&mut self) -> Result<Option<RecoveryJournal>, FullDesktopError> {
            Ok(self.lock().expect("journal").value.clone())
        }
        fn write_before_mutation(
            &mut self,
            journal: &RecoveryJournal,
        ) -> Result<(), FullDesktopError> {
            let mut value = self.lock().expect("journal");
            if value.fail_write
                || value
                    .fail_after_writes
                    .is_some_and(|limit| value.writes >= limit)
            {
                return Err(FullDesktopError::Journal("disk full".into()));
            }
            value.writes += 1;
            value.value = Some(journal.clone());
            value.history.push(journal.clone());
            Ok(())
        }
        fn clear_after_verified_restore(&mut self) -> Result<(), FullDesktopError> {
            let mut value = self.lock().expect("journal");
            if value.fail_clear {
                return Err(FullDesktopError::Journal("clear failed".into()));
            }
            value.clears += 1;
            value.value = None;
            Ok(())
        }
    }
    #[derive(Default)]
    struct MockPlatform {
        unsupported: bool,
        actual_main_desktop_child: Option<bool>,
        attach: VecDeque<Result<Attachment, FullDesktopError>>,
        capture_results: VecDeque<Result<(PlatformSnapshot, IconSnapshot), FullDesktopError>>,
        restore_results: VecDeque<Result<(), FullDesktopError>>,
        validate_results: VecDeque<Result<(), FullDesktopError>>,
        recover_results: VecDeque<Result<(), FullDesktopError>>,
        icon_visibility_results: VecDeque<Result<(), FullDesktopError>>,
        interaction_lock_results: VecDeque<Result<(), FullDesktopError>>,
        restores: usize,
        recover: usize,
        owner: OwnerStatus,
        mutations: usize,
    }
    impl FullDesktopPlatform for MockPlatform {
        fn supported(&self) -> bool {
            !self.unsupported
        }
        fn actual_main_desktop_child(
            &self,
            _: &PlatformSnapshot,
        ) -> Result<Option<bool>, FullDesktopError> {
            Ok(self.actual_main_desktop_child)
        }
        fn current_owner_identity(&self) -> Result<ProcessIdentity, FullDesktopError> {
            Ok(ProcessIdentity {
                pid: 7,
                parent_pid: 1,
                creation_time_100ns: 2,
            })
        }
        fn owner_status(&self, _: ProcessIdentity) -> Result<OwnerStatus, FullDesktopError> {
            Ok(self.owner)
        }
        fn capture(
            &mut self,
            _: FullDesktopMode,
        ) -> Result<(PlatformSnapshot, IconSnapshot), FullDesktopError> {
            self.capture_results.pop_front().unwrap_or(Ok((
                PlatformSnapshot {
                    windows: vec![],
                    payload: serde_json::json!({}),
                },
                IconSnapshot {
                    visible: true,
                    payload: serde_json::json!({}),
                },
            )))
        }
        fn attach(
            &mut self,
            _: FullDesktopMode,
            _: &PlatformSnapshot,
            _: bool,
            _: bool,
        ) -> Result<Attachment, FullDesktopError> {
            self.mutations += 1;
            self.attach.pop_front().unwrap_or(Ok(Attachment {
                id: "a".into(),
                generation: 1,
                pending: false,
            }))
        }
        fn restore(
            &mut self,
            _: &PlatformSnapshot,
            _: &Attachment,
        ) -> Result<(), FullDesktopError> {
            self.restores += 1;
            self.restore_results.pop_front().unwrap_or(Ok(()))
        }
        fn recover_stale(&mut self, _: &RecoveryJournal) -> Result<(), FullDesktopError> {
            self.recover += 1;
            self.recover_results.pop_front().unwrap_or(Ok(()))
        }
        fn validate_attachment(&mut self, _: &Attachment) -> Result<(), FullDesktopError> {
            self.validate_results.pop_front().unwrap_or(Ok(()))
        }
        fn set_icons_visible(&mut self, _: bool) -> Result<(), FullDesktopError> {
            self.mutations += 1;
            self.icon_visibility_results.pop_front().unwrap_or(Ok(()))
        }
        fn set_interaction_locked(&mut self, _: bool) -> Result<(), FullDesktopError> {
            self.mutations += 1;
            self.interaction_lock_results.pop_front().unwrap_or(Ok(()))
        }
    }
    struct SharedPlatform(Arc<Mutex<MockPlatform>>);
    impl FullDesktopPlatform for SharedPlatform {
        fn supported(&self) -> bool {
            self.0.lock().expect("platform").supported()
        }
        fn actual_main_desktop_child(
            &self,
            snapshot: &PlatformSnapshot,
        ) -> Result<Option<bool>, FullDesktopError> {
            self.0
                .lock()
                .expect("platform")
                .actual_main_desktop_child(snapshot)
        }
        fn current_owner_identity(&self) -> Result<ProcessIdentity, FullDesktopError> {
            self.0.lock().expect("platform").current_owner_identity()
        }
        fn owner_status(&self, o: ProcessIdentity) -> Result<OwnerStatus, FullDesktopError> {
            self.0.lock().expect("platform").owner_status(o)
        }
        fn capture(
            &mut self,
            m: FullDesktopMode,
        ) -> Result<(PlatformSnapshot, IconSnapshot), FullDesktopError> {
            self.0.lock().expect("platform").capture(m)
        }
        fn attach(
            &mut self,
            m: FullDesktopMode,
            s: &PlatformSnapshot,
            i: bool,
            l: bool,
        ) -> Result<Attachment, FullDesktopError> {
            self.0.lock().expect("platform").attach(m, s, i, l)
        }
        fn restore(
            &mut self,
            s: &PlatformSnapshot,
            a: &Attachment,
        ) -> Result<(), FullDesktopError> {
            self.0.lock().expect("platform").restore(s, a)
        }
        fn recover_stale(&mut self, j: &RecoveryJournal) -> Result<(), FullDesktopError> {
            self.0.lock().expect("platform").recover_stale(j)
        }
        fn validate_attachment(&mut self, a: &Attachment) -> Result<(), FullDesktopError> {
            self.0.lock().expect("platform").validate_attachment(a)
        }
        fn set_icons_visible(&mut self, v: bool) -> Result<(), FullDesktopError> {
            self.0.lock().expect("platform").set_icons_visible(v)
        }
        fn set_interaction_locked(&mut self, v: bool) -> Result<(), FullDesktopError> {
            self.0.lock().expect("platform").set_interaction_locked(v)
        }
    }
    fn runtime(
        journal: Arc<Mutex<MemoryJournal>>,
        platform: Arc<Mutex<MockPlatform>>,
    ) -> FullDesktopRuntime {
        let mut runtime = FullDesktopRuntime::new(Box::new(journal));
        runtime.install_platform(Box::new(SharedPlatform(platform)));
        runtime
    }
    #[test]
    fn journal_failure_prevents_platform_mutation() {
        let journal = Arc::new(Mutex::new(MemoryJournal {
            fail_write: true,
            ..Default::default()
        }));
        let platform = Arc::new(Mutex::new(MockPlatform::default()));
        let mut runtime = runtime(journal, platform.clone());
        assert!(matches!(
            runtime.request_mode(FullDesktopMode::Passive),
            Err(FullDesktopError::Journal(_))
        ));
        assert_eq!(platform.lock().expect("platform").mutations, 0);
    }
    #[test]
    fn attach_failure_restores_captured_platform() {
        let journal = Arc::new(Mutex::new(MemoryJournal::default()));
        let platform = Arc::new(Mutex::new(MockPlatform {
            attach: VecDeque::from([Err(FullDesktopError::Platform("attach".into()))]),
            ..Default::default()
        }));
        let mut runtime = runtime(journal.clone(), platform.clone());
        assert!(runtime.request_mode(FullDesktopMode::Passive).is_err());
        assert_eq!(platform.lock().expect("platform").restores, 1);
        assert_eq!(journal.lock().expect("journal").clears, 1);
        assert_eq!(runtime.snapshot().phase, FullDesktopPhase::Disabled);
    }
    #[test]
    fn disable_is_idempotent_after_verified_restore() {
        let journal = Arc::new(Mutex::new(MemoryJournal::default()));
        let platform = Arc::new(Mutex::new(MockPlatform::default()));
        let mut runtime = runtime(journal, platform.clone());
        runtime.request_mode(FullDesktopMode::Passive).unwrap();
        runtime.disable_for_shutdown().unwrap();
        runtime.disable_for_shutdown().unwrap();
        assert_eq!(platform.lock().expect("platform").restores, 1);
        assert_eq!(runtime.snapshot().phase, FullDesktopPhase::Disabled);
    }
    #[test]
    fn live_owner_journal_refuses_startup_recovery() {
        let journal = Arc::new(Mutex::new(MemoryJournal {
            value: Some(RecoveryJournal {
                version: 1,
                metadata: RecoveryJournalMetadata::default(),
                owner: ProcessIdentity {
                    pid: 4,
                    parent_pid: 1,
                    creation_time_100ns: 2,
                },
                mode: FullDesktopMode::Passive,
                platform_snapshot: PlatformSnapshot {
                    windows: vec![],
                    payload: serde_json::json!({}),
                },
                icons: IconSnapshot {
                    visible: true,
                    payload: serde_json::json!({}),
                },
                attachment: Attachment::pending(1),
                icons_visible: true,
                interaction_locked: false,
                generation: 1,
            }),
            ..Default::default()
        }));
        let platform = Arc::new(Mutex::new(MockPlatform {
            owner: OwnerStatus::Live,
            ..Default::default()
        }));
        let mut runtime = runtime(journal, platform.clone());
        assert_eq!(
            runtime.startup_recover(),
            Err(FullDesktopError::RecoveryRequired)
        );
        assert_eq!(runtime.snapshot().phase, FullDesktopPhase::RecoveryRequired);
        assert_eq!(platform.lock().expect("platform").recover, 0);
    }
    #[test]
    fn dead_owner_journal_is_recovered_then_cleared() {
        let journal = Arc::new(Mutex::new(MemoryJournal {
            value: Some(RecoveryJournal {
                version: 1,
                metadata: RecoveryJournalMetadata::default(),
                owner: ProcessIdentity {
                    pid: 4,
                    parent_pid: 1,
                    creation_time_100ns: 2,
                },
                mode: FullDesktopMode::Passive,
                platform_snapshot: PlatformSnapshot {
                    windows: vec![],
                    payload: serde_json::json!({}),
                },
                icons: IconSnapshot {
                    visible: true,
                    payload: serde_json::json!({}),
                },
                attachment: Attachment::pending(1),
                icons_visible: true,
                interaction_locked: false,
                generation: 1,
            }),
            ..Default::default()
        }));
        let platform = Arc::new(Mutex::new(MockPlatform {
            owner: OwnerStatus::Dead,
            ..Default::default()
        }));
        let mut runtime = runtime(journal.clone(), platform.clone());
        runtime.startup_recover().unwrap();
        assert_eq!(platform.lock().expect("platform").recover, 1);
        assert_eq!(journal.lock().expect("journal").clears, 1);
    }

    #[test]
    fn discovering_a_stale_journal_suppresses_auto_resume_after_success_or_failure() {
        let journal = Arc::new(Mutex::new(MemoryJournal {
            value: Some(RecoveryJournal {
                version: 1,
                metadata: RecoveryJournalMetadata::default(),
                owner: ProcessIdentity {
                    pid: 4,
                    parent_pid: 1,
                    creation_time_100ns: 2,
                },
                mode: FullDesktopMode::Passive,
                platform_snapshot: PlatformSnapshot {
                    windows: vec![],
                    payload: serde_json::json!({}),
                },
                icons: IconSnapshot {
                    visible: true,
                    payload: serde_json::json!({}),
                },
                attachment: Attachment::pending(1),
                icons_visible: true,
                interaction_locked: false,
                generation: 1,
            }),
            ..Default::default()
        }));
        let platform = Arc::new(Mutex::new(MockPlatform {
            owner: OwnerStatus::Dead,
            ..Default::default()
        }));
        let mut runtime_success = runtime(journal, platform);
        runtime_success
            .startup_recover()
            .expect("dead owner should recover");
        assert!(runtime_success.snapshot().auto_resume_suppressed);

        let journal = Arc::new(Mutex::new(MemoryJournal {
            value: Some(RecoveryJournal {
                version: 1,
                metadata: RecoveryJournalMetadata::default(),
                owner: ProcessIdentity {
                    pid: 4,
                    parent_pid: 1,
                    creation_time_100ns: 2,
                },
                mode: FullDesktopMode::Passive,
                platform_snapshot: PlatformSnapshot {
                    windows: vec![],
                    payload: serde_json::json!({}),
                },
                icons: IconSnapshot {
                    visible: true,
                    payload: serde_json::json!({}),
                },
                attachment: Attachment::pending(1),
                icons_visible: true,
                interaction_locked: false,
                generation: 1,
            }),
            ..Default::default()
        }));
        let platform = Arc::new(Mutex::new(MockPlatform {
            owner: OwnerStatus::Dead,
            recover_results: VecDeque::from([Err(FullDesktopError::Platform(
                "restore stale".into(),
            ))]),
            ..Default::default()
        }));
        let mut runtime = runtime(journal, platform);
        assert!(runtime.startup_recover().is_err());
        let state = runtime.snapshot();
        assert!(state.auto_resume_suppressed);
        assert!(state.recovery_required);
    }

    #[test]
    fn half_attached_restore_failure_requires_explicit_memory_snapshot_recovery() {
        let journal = Arc::new(Mutex::new(MemoryJournal::default()));
        let platform = Arc::new(Mutex::new(MockPlatform {
            attach: VecDeque::from([Err(FullDesktopError::Platform("attach".into()))]),
            restore_results: VecDeque::from([
                Err(FullDesktopError::Platform("first restore".into())),
                Ok(()),
            ]),
            ..Default::default()
        }));
        let mut runtime = runtime(journal.clone(), platform.clone());
        assert!(runtime.request_mode(FullDesktopMode::Passive).is_err());
        assert!(runtime.snapshot().recovery_required);
        assert!(runtime.has_recovery_journal());
        runtime
            .recover()
            .expect("explicit recovery must use the preserved in-memory snapshot");
        let state = runtime.snapshot();
        assert_eq!(state.phase, FullDesktopPhase::Disabled);
        assert!(!state.recovery_required);
        assert!(!runtime.has_recovery_journal());
        assert_eq!(journal.lock().expect("journal").clears, 1);
        assert_eq!(platform.lock().expect("platform").restores, 2);
    }

    #[test]
    fn explorer_reconcile_reattaches_with_new_generation_but_reattach_failure_keeps_journal() {
        let journal = Arc::new(Mutex::new(MemoryJournal::default()));
        let platform = Arc::new(Mutex::new(MockPlatform {
            attach: VecDeque::from([
                Ok(Attachment {
                    id: "first".into(),
                    generation: 1,
                    pending: false,
                }),
                Err(FullDesktopError::Platform("reattach".into())),
            ]),
            validate_results: VecDeque::from([Err(FullDesktopError::Platform(
                "explorer changed".into(),
            ))]),
            restore_results: VecDeque::from([Ok(()), Ok(())]),
            ..Default::default()
        }));
        let mut runtime = runtime(journal.clone(), platform.clone());
        runtime.request_mode(FullDesktopMode::Passive).unwrap();
        assert!(runtime.reconcile().is_err());
        let state = runtime.snapshot();
        assert!(state.recovery_required);
        assert_ne!(state.phase, FullDesktopPhase::Disabled);
        assert!(runtime.has_recovery_journal());
        assert_eq!(journal.lock().expect("journal").clears, 0);
        assert_eq!(platform.lock().expect("platform").restores, 2);
    }

    #[test]
    fn explorer_validation_loss_restores_then_reattaches_with_new_generation() {
        let journal = Arc::new(Mutex::new(MemoryJournal::default()));
        let platform = Arc::new(Mutex::new(MockPlatform {
            validate_results: VecDeque::from([Err(FullDesktopError::Platform(
                "explorer changed".into(),
            ))]),
            ..Default::default()
        }));
        let mut runtime = runtime(journal.clone(), platform.clone());
        runtime.request_mode(FullDesktopMode::Interactive).unwrap();
        let state = runtime
            .reconcile()
            .expect("validated Explorer loss should reattach");
        assert_eq!(state.phase, FullDesktopPhase::Interactive);
        assert_eq!(state.effective_mode, FullDesktopMode::Interactive);
        assert_eq!(state.explorer_generation, 1);
        assert_eq!(platform.lock().expect("platform").restores, 1);
        assert_eq!(platform.lock().expect("platform").mutations, 2);
        assert_eq!(journal.lock().expect("journal").clears, 0);
    }

    #[test]
    fn explorer_reconcile_restore_failure_never_poses_as_disabled() {
        let journal = Arc::new(Mutex::new(MemoryJournal::default()));
        let platform = Arc::new(Mutex::new(MockPlatform {
            validate_results: VecDeque::from([Err(FullDesktopError::Platform(
                "explorer changed".into(),
            ))]),
            restore_results: VecDeque::from([Err(FullDesktopError::Platform(
                "rollback failed".into(),
            ))]),
            ..Default::default()
        }));
        let mut runtime = runtime(journal.clone(), platform);
        runtime.request_mode(FullDesktopMode::Passive).unwrap();
        assert!(runtime.reconcile().is_err());
        let state = runtime.snapshot();
        assert!(state.recovery_required);
        assert_ne!(state.phase, FullDesktopPhase::Disabled);
        assert!(runtime.has_recovery_journal());
        assert_eq!(journal.lock().expect("journal").clears, 0);
    }

    #[test]
    fn disable_refuses_recovery_required_state_without_claiming_disabled() {
        let journal = Arc::new(Mutex::new(MemoryJournal::default()));
        let platform = Arc::new(Mutex::new(MockPlatform {
            attach: VecDeque::from([Err(FullDesktopError::Platform("attach".into()))]),
            restore_results: VecDeque::from([Err(FullDesktopError::Platform(
                "rollback failed".into(),
            ))]),
            ..Default::default()
        }));
        let mut runtime = runtime(journal, platform);
        assert!(runtime.request_mode(FullDesktopMode::Passive).is_err());
        assert_eq!(
            runtime.disable_for_shutdown(),
            Err(FullDesktopError::RecoveryRequired)
        );
        let state = runtime.snapshot();
        assert!(state.recovery_required);
        assert_ne!(state.phase, FullDesktopPhase::Disabled);
        // effectiveMode 只陈述已验证完成的附着；半 attach 不得借此把 phase 伪装为 disabled。
        assert_eq!(state.effective_mode, FullDesktopMode::Disabled);
    }

    #[test]
    fn explorer_reconcile_capture_failure_enters_recovery_required_and_keeps_journal() {
        let journal = Arc::new(Mutex::new(MemoryJournal::default()));
        let platform = Arc::new(Mutex::new(MockPlatform {
            validate_results: VecDeque::from([Err(FullDesktopError::Platform(
                "explorer changed".into(),
            ))]),
            capture_results: VecDeque::from([
                Ok((
                    PlatformSnapshot {
                        windows: vec![],
                        payload: serde_json::json!({}),
                    },
                    IconSnapshot {
                        visible: true,
                        payload: serde_json::json!({}),
                    },
                )),
                Err(FullDesktopError::Platform(
                    "capture replacement explorer".into(),
                )),
            ]),
            ..Default::default()
        }));
        let mut runtime = runtime(journal.clone(), platform.clone());
        runtime.request_mode(FullDesktopMode::Passive).unwrap();
        assert!(runtime.reconcile().is_err());
        let state = runtime.snapshot();
        assert!(state.recovery_required);
        assert_eq!(state.phase, FullDesktopPhase::RecoveryRequired);
        assert!(runtime.has_recovery_journal());
        assert_eq!(journal.lock().expect("journal").clears, 0);
        assert_eq!(platform.lock().expect("platform").mutations, 1);
    }

    #[test]
    fn initial_preflight_failure_without_mutation_returns_to_disabled_without_journal() {
        let journal = Arc::new(Mutex::new(MemoryJournal::default()));
        let platform = Arc::new(Mutex::new(MockPlatform {
            unsupported: true,
            ..Default::default()
        }));
        let mut runtime = runtime(journal, platform);
        assert_eq!(
            runtime.request_mode(FullDesktopMode::Passive),
            Err(FullDesktopError::Unsupported)
        );
        let state = runtime.snapshot();
        assert_eq!(state.phase, FullDesktopPhase::Disabled);
        assert!(!state.recovery_required);
        assert!(!runtime.has_recovery_journal());
    }

    #[test]
    fn journal_checkpoints_are_persisted_in_mutation_order_with_session_metadata() {
        let journal = Arc::new(Mutex::new(MemoryJournal::default()));
        let platform = Arc::new(Mutex::new(MockPlatform::default()));
        let mut runtime = runtime(journal.clone(), platform);

        runtime.request_mode(FullDesktopMode::Passive).unwrap();
        runtime.set_icons_visible(false).unwrap();
        runtime.set_interaction_locked(true).unwrap();

        let history = &journal.lock().expect("journal").history;
        assert!(history[0].metadata.created_at_ms > 0);
        assert!(!history[0].metadata.launch_nonce.is_empty());
        assert_eq!(
            history[0].metadata.application_version,
            env!("CARGO_PKG_VERSION")
        );
        assert!(history[0].metadata.checkpoints.capture_committed);
        assert!(!history[0].metadata.checkpoints.attachment_committed);
        assert!(history[1].metadata.checkpoints.attachment_committed);
        assert!(
            history
                .last()
                .expect("checkpoint")
                .metadata
                .checkpoints
                .icons_visibility_applied
        );
        assert!(
            history
                .last()
                .expect("checkpoint")
                .metadata
                .checkpoints
                .interaction_lock_applied
        );
    }

    #[test]
    fn verified_shutdown_restore_records_rollback_start_and_completion_before_clear() {
        let journal = Arc::new(Mutex::new(MemoryJournal::default()));
        let platform = Arc::new(Mutex::new(MockPlatform::default()));
        let mut runtime = runtime(journal.clone(), platform);
        runtime.request_mode(FullDesktopMode::Passive).unwrap();
        runtime.disable_for_shutdown().unwrap();

        let journal = journal.lock().expect("journal");
        let rollback_start = journal
            .history
            .iter()
            .position(|entry| entry.metadata.checkpoints.rollback_started)
            .expect("restore 前必须持久化 rollbackStarted");
        let rollback_complete = journal
            .history
            .iter()
            .position(|entry| entry.metadata.checkpoints.rollback_completed)
            .expect("验证恢复后必须持久化 rollbackCompleted");
        assert!(rollback_start < rollback_complete);
        assert_eq!(journal.clears, 1);
    }

    #[test]
    fn legacy_v1_journal_without_metadata_deserializes_with_safe_checkpoint_defaults() {
        let journal: RecoveryJournal = serde_json::from_value(serde_json::json!({
            "version": 1,
            "owner": { "pid": 9, "parentPid": 1, "creationTime100ns": 2 },
            "mode": "passive",
            "platformSnapshot": { "windows": [], "payload": {} },
            "icons": { "visible": true, "payload": {} },
            "attachment": { "id": "legacy", "generation": 1, "pending": false },
            "iconsVisible": true,
            "interactionLocked": false,
            "generation": 1
        }))
        .expect("v1 journal must remain readable");
        assert_eq!(journal.metadata, RecoveryJournalMetadata::default());
        assert!(!journal.metadata.checkpoints.capture_committed);
        assert!(!journal.metadata.checkpoints.rollback_completed);
    }

    #[test]
    fn explicit_current_session_recovery_rejects_journal_with_different_launch_nonce() {
        let journal = Arc::new(Mutex::new(MemoryJournal::default()));
        let platform = Arc::new(Mutex::new(MockPlatform {
            attach: VecDeque::from([Err(FullDesktopError::Platform("attach".into()))]),
            restore_results: VecDeque::from([Err(FullDesktopError::Platform("rollback".into()))]),
            ..Default::default()
        }));
        let mut runtime = runtime(journal.clone(), platform);
        assert!(runtime.request_mode(FullDesktopMode::Passive).is_err());
        runtime
            .active_journal
            .as_mut()
            .expect("half attach keeps journal")
            .metadata
            .launch_nonce = "another-session".into();

        assert_eq!(runtime.recover(), Err(FullDesktopError::RecoveryRequired));
        assert!(runtime.snapshot().recovery_required);
        assert!(runtime.has_recovery_journal());
        assert_eq!(journal.lock().expect("journal").clears, 0);
    }

    #[test]
    fn entropy_failure_refuses_initial_enable_before_platform_mutation() {
        let journal = Arc::new(Mutex::new(MemoryJournal::default()));
        let platform = Arc::new(Mutex::new(MockPlatform::default()));
        let mut runtime =
            FullDesktopRuntime::new_for_test_with_nonce_failure(Box::new(journal.clone()));
        runtime.install_platform(Box::new(SharedPlatform(platform.clone())));

        assert!(matches!(
            runtime.request_mode(FullDesktopMode::Passive),
            Err(FullDesktopError::Journal(_))
        ));
        assert_eq!(runtime.snapshot().phase, FullDesktopPhase::Disabled);
        assert!(!runtime.has_recovery_journal());
        assert_eq!(platform.lock().expect("platform").mutations, 0);
    }

    #[test]
    fn corrupt_file_journal_stays_blocked_after_store_reopen() {
        let sequence = JOURNAL_WRITE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let directory = std::env::temp_dir().join(format!(
            "mineradio-corrupt-full-desktop-{}-{sequence}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&directory);
        fs::create_dir_all(&directory).expect("创建损坏 journal 测试目录");
        let path = directory.join(FULL_DESKTOP_RECOVERY_FILE_NAME);
        fs::write(&path, b"not-json").expect("写入损坏 journal");

        let mut first_process = FileRecoveryJournalStore::with_path(&path);
        assert!(first_process.load().is_err());
        assert!(
            path.exists(),
            "损坏 primary 必须保留以跨进程持续 fail-closed"
        );
        drop(first_process);

        let mut next_process = FileRecoveryJournalStore::with_path(&path);
        assert!(next_process.load().is_err());
        assert!(path.exists());
        assert!(fs::read_dir(&directory)
            .expect("读取 forensic 目录")
            .filter_map(Result::ok)
            .any(|entry| entry.file_name().to_string_lossy().contains(".corrupt-")));

        fs::remove_dir_all(&directory).expect("清理损坏 journal 测试目录");
    }

    #[test]
    fn native_icon_visibility_failure_enters_recovery_required_and_keeps_journal() {
        let journal = Arc::new(Mutex::new(MemoryJournal::default()));
        let platform = Arc::new(Mutex::new(MockPlatform {
            icon_visibility_results: VecDeque::from([Err(FullDesktopError::Platform(
                "图标可见性确认失败".into(),
            ))]),
            ..Default::default()
        }));
        let mut runtime = runtime(journal.clone(), platform);
        runtime.request_mode(FullDesktopMode::Passive).unwrap();

        assert!(runtime.set_icons_visible(false).is_err());
        assert_eq!(runtime.snapshot().phase, FullDesktopPhase::RecoveryRequired);
        assert!(runtime.has_recovery_journal());
        assert_eq!(runtime.last_error_code(), Some("PLATFORM"));
        assert_eq!(journal.lock().expect("journal").clears, 0);
        assert_eq!(
            journal
                .lock()
                .expect("journal")
                .value
                .as_ref()
                .and_then(|journal| journal.metadata.last_failure_code.as_deref()),
            Some("PLATFORM")
        );
    }

    #[test]
    fn native_interaction_lock_failure_enters_recovery_required_and_keeps_journal() {
        let journal = Arc::new(Mutex::new(MemoryJournal::default()));
        let platform = Arc::new(Mutex::new(MockPlatform {
            interaction_lock_results: VecDeque::from([Err(FullDesktopError::Platform(
                "交互锁确认失败".into(),
            ))]),
            ..Default::default()
        }));
        let mut runtime = runtime(journal.clone(), platform);
        runtime.request_mode(FullDesktopMode::Interactive).unwrap();

        assert!(runtime.set_interaction_locked(true).is_err());
        assert_eq!(runtime.snapshot().phase, FullDesktopPhase::RecoveryRequired);
        assert!(runtime.has_recovery_journal());
        assert_eq!(runtime.last_error_code(), Some("PLATFORM"));
        assert_eq!(journal.lock().expect("journal").clears, 0);
    }

    #[test]
    fn clear_failure_after_verified_restore_remains_recovery_required() {
        let journal = Arc::new(Mutex::new(MemoryJournal {
            fail_clear: true,
            ..Default::default()
        }));
        let platform = Arc::new(Mutex::new(MockPlatform::default()));
        let mut runtime = runtime(journal.clone(), platform);
        runtime.request_mode(FullDesktopMode::Passive).unwrap();
        assert!(runtime.disable_for_shutdown().is_err());
        assert!(runtime.snapshot().recovery_required);
        assert!(runtime.has_recovery_journal());
        assert_eq!(journal.lock().expect("journal").clears, 0);
    }

    #[test]
    fn post_icon_checkpoint_failure_after_native_mutation_is_recovery_required() {
        let journal = Arc::new(Mutex::new(MemoryJournal::default()));
        let platform = Arc::new(Mutex::new(MockPlatform::default()));
        let mut runtime = runtime(journal.clone(), platform);
        runtime.request_mode(FullDesktopMode::Passive).unwrap();
        journal.lock().expect("journal").fail_after_writes = Some(3);

        assert!(runtime.set_icons_visible(false).is_err());
        assert!(runtime.snapshot().recovery_required);
        assert!(runtime.has_recovery_journal());
    }

    #[test]
    fn recovery_diagnostics_are_read_only_and_use_stable_error_codes() {
        let journal = Arc::new(Mutex::new(MemoryJournal::default()));
        let platform = Arc::new(Mutex::new(MockPlatform {
            attach: VecDeque::from([Err(FullDesktopError::Platform("attach".into()))]),
            restore_results: VecDeque::from([Err(FullDesktopError::Platform("rollback".into()))]),
            ..Default::default()
        }));
        let mut runtime = runtime(journal.clone(), platform);
        assert!(runtime.request_mode(FullDesktopMode::Passive).is_err());
        let writes_before = journal.lock().expect("journal").writes;
        assert_eq!(runtime.recovery_journal_version(), Some(1));
        assert_eq!(runtime.last_error_code(), Some("PLATFORM"));
        assert_eq!(journal.lock().expect("journal").writes, writes_before);
    }

    #[test]
    fn desktop_child_diagnostic_is_unavailable_outside_a_stable_active_phase() {
        let journal = Arc::new(Mutex::new(MemoryJournal::default()));
        let platform = Arc::new(Mutex::new(MockPlatform {
            actual_main_desktop_child: Some(true),
            ..Default::default()
        }));
        let runtime = runtime(journal, platform);

        assert_eq!(runtime.actual_main_desktop_child(), None);
    }

    #[test]
    fn desktop_child_diagnostic_reports_platform_drift_without_mutation() {
        let journal = Arc::new(Mutex::new(MemoryJournal::default()));
        let platform = Arc::new(Mutex::new(MockPlatform {
            actual_main_desktop_child: Some(false),
            ..Default::default()
        }));
        let mut runtime = runtime(journal, platform.clone());
        runtime.request_mode(FullDesktopMode::Passive).unwrap();
        let mutations_before = platform.lock().expect("platform").mutations;

        assert_eq!(runtime.actual_main_desktop_child(), Some(false));
        assert_eq!(
            platform.lock().expect("platform").mutations,
            mutations_before
        );
    }

    #[test]
    fn desktop_child_diagnostic_uses_captured_host_during_half_attach_recovery() {
        let journal = Arc::new(Mutex::new(MemoryJournal::default()));
        let platform = Arc::new(Mutex::new(MockPlatform {
            actual_main_desktop_child: Some(true),
            attach: VecDeque::from([Err(FullDesktopError::Platform("attach".into()))]),
            restore_results: VecDeque::from([Err(FullDesktopError::Platform("rollback".into()))]),
            ..Default::default()
        }));
        let mut runtime = runtime(journal, platform.clone());

        assert!(runtime.request_mode(FullDesktopMode::Passive).is_err());
        assert_eq!(runtime.snapshot().phase, FullDesktopPhase::RecoveryRequired);
        let mutations_before = platform.lock().expect("platform").mutations;
        assert_eq!(runtime.actual_main_desktop_child(), Some(true));
        assert_eq!(
            platform.lock().expect("platform").mutations,
            mutations_before
        );
    }
}
