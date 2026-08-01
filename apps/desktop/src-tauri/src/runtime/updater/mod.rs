use std::{
    collections::VecDeque,
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex},
};

use semver::Version;
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

pub(crate) mod auto_check;
pub(crate) mod cache;
pub(crate) mod download;
#[cfg(feature = "updater-smoke")]
pub(crate) mod draft_source;
pub(crate) mod github_source;
pub(crate) mod install_attempt;
pub(crate) mod managed_fs;
pub(crate) mod nsis_install;
pub(crate) mod policy;
pub(crate) mod provenance;
pub(crate) mod quiescence;
pub(crate) mod startup_reconciliation;
pub(crate) mod web_quiescence_handshake;

use auto_check::{AutomaticCheckOutcome, SystemUpdateTime, UpdateTime, SUCCESS_INTERVAL_MILLIS};
use cache::{CacheRecoveryFault, CacheRecoveryOutcome, UpdateStartupRecovery};
use download::{
    InstallerDownloadError, InstallerDownloadEvent, InstallerDownloadEvents,
    InstallerDownloadFailureStage, InstallerDownloader, VerifiedInstallerArtifact,
    VerifiedInstallerPlan, PUBLIC_PROGRESS_INTERVAL_MS,
};
use policy::{
    MemoryUpdatePolicyStore, NativeUpdatePolicyStore, UpdatePolicyQuarantine, UpdatePolicyReminder,
    UpdatePolicySnapshot, UpdatePolicyStore, UpdatePolicyStoreError,
};
use provenance::{ReleaseCandidateId, VerifiedReleaseEvidence};

const REMIND_LATER_MILLIS: u64 = 24 * 60 * 60 * 1_000;
pub(crate) const WEB_RECONCILIATION_REQUIRED_FAULT: &str =
    "UPDATE_WEB_QUIESCENCE_RECONCILIATION_REQUIRED";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum UpdatePhase {
    Disabled,
    Idle,
    RecoveringCache,
    Checking,
    Current,
    Available,
    Downloading,
    Verifying,
    ReadyToInstall,
    PreparingInstall,
    Installing,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCandidateView {
    pub id: String,
    pub version: String,
    pub notes: Vec<String>,
    pub published_at: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum UpdateOperationKind {
    CacheRevalidation,
    Check,
    Download,
    Verify,
    Install,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateOperationView {
    pub id: String,
    pub kind: UpdateOperationKind,
    pub received_bytes: u64,
    pub total_bytes: Option<u64>,
    pub cancellable: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum UpdateFaultStage {
    Check,
    Download,
    Verify,
    Cache,
    Quiesce,
    Install,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateFaultView {
    pub stage: UpdateFaultStage,
    pub code: String,
    pub retryable: bool,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSnapshot {
    pub revision: u64,
    pub phase: UpdatePhase,
    pub current_version: String,
    pub candidate: Option<UpdateCandidateView>,
    pub operation: Option<UpdateOperationView>,
    pub fault: Option<UpdateFaultView>,
    pub checked_at: Option<u64>,
    pub remind_after: Option<u64>,
    pub skipped_version: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum UpdateIntent {
    CheckNow,
    Download { candidate_id: String },
    CancelDownload { operation_id: String },
    RemindLater { candidate_id: String },
    SkipVersion { candidate_id: String },
    InstallAndRestart { candidate_id: String },
    OpenRelease { candidate_id: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateDispatchRequest {
    pub expected_revision: u64,
    pub intent: UpdateIntent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum UpdateReceipt {
    Accepted,
    StaleCandidate,
    StaleOperation,
    InvalidOrder,
    PolicyBlocked,
    RuntimeUnavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum UpdateInstallOutcome {
    InstallerSpawned,
    RecoveryCompleted,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct UpdateInstallFault {
    stage: UpdateFaultStage,
    code: String,
    retryable: bool,
    message: String,
    recovery_required: bool,
}

impl UpdateInstallFault {
    pub(crate) fn new(
        stage: UpdateFaultStage,
        code: impl Into<String>,
        retryable: bool,
        message: impl Into<String>,
        recovery_required: bool,
    ) -> Self {
        Self {
            stage,
            code: code.into(),
            retryable,
            message: message.into(),
            recovery_required,
        }
    }
}

pub(crate) trait UpdateInstaller: Send + Sync {
    fn install_exact<'a>(
        &'a self,
        candidate_id: String,
        artifact: VerifiedInstallerArtifact,
        started_at: u64,
    ) -> Pin<Box<dyn Future<Output = Result<UpdateInstallOutcome, UpdateInstallFault>> + Send + 'a>>;

    fn retry_recovery(
        &self,
        updated_at: u64,
    ) -> Pin<Box<dyn Future<Output = Result<UpdateInstallOutcome, UpdateInstallFault>> + Send + '_>>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct VerifiedAssetLocator {
    repository: String,
    tag: String,
    asset_name: String,
}

impl VerifiedAssetLocator {
    fn from_evidence(evidence: &VerifiedReleaseEvidence) -> Self {
        Self {
            repository: evidence.repository().to_owned(),
            tag: evidence.tag().to_owned(),
            asset_name: evidence.installer_name().to_owned(),
        }
    }

    fn canonical_url(&self) -> String {
        format!(
            "https://github.com/{}/releases/download/{}/{}",
            self.repository, self.tag, self.asset_name
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum NormalizedReleaseTrust {
    Verified {
        evidence: Box<VerifiedReleaseEvidence>,
        asset_locator: VerifiedAssetLocator,
    },
    #[cfg(test)]
    Fake,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NormalizedRelease {
    candidate_id: ReleaseCandidateId,
    version: String,
    notes: Vec<String>,
    published_at: Option<String>,
    trust: NormalizedReleaseTrust,
}

impl NormalizedRelease {
    #[cfg(test)]
    pub fn new<I, N>(
        candidate_id: impl Into<String>,
        version: impl Into<String>,
        notes: I,
        published_at: Option<&str>,
    ) -> Self
    where
        I: IntoIterator<Item = N>,
        N: Into<String>,
    {
        Self::from_candidate_id(
            ReleaseCandidateId::fake(candidate_id),
            version,
            notes,
            published_at,
            NormalizedReleaseTrust::Fake,
        )
    }

    pub(crate) fn from_verified<I, N>(
        evidence: VerifiedReleaseEvidence,
        notes: I,
        published_at: Option<&str>,
    ) -> Self
    where
        I: IntoIterator<Item = N>,
        N: Into<String>,
    {
        let candidate_id = evidence.candidate_id().clone();
        let version = evidence.version().to_owned();
        let asset_locator = VerifiedAssetLocator::from_evidence(&evidence);
        Self::from_candidate_id(
            candidate_id,
            version,
            notes,
            published_at,
            NormalizedReleaseTrust::Verified {
                evidence: Box::new(evidence),
                asset_locator,
            },
        )
    }

    fn from_candidate_id<I, N>(
        candidate_id: ReleaseCandidateId,
        version: impl Into<String>,
        notes: I,
        published_at: Option<&str>,
        trust: NormalizedReleaseTrust,
    ) -> Self
    where
        I: IntoIterator<Item = N>,
        N: Into<String>,
    {
        Self {
            candidate_id,
            version: version.into(),
            notes: notes.into_iter().map(Into::into).collect(),
            published_at: published_at.map(str::to_owned),
            trust,
        }
    }

    pub(crate) fn verified_asset_url(&self) -> Option<String> {
        match &self.trust {
            NormalizedReleaseTrust::Verified { asset_locator, .. } => {
                Some(asset_locator.canonical_url())
            }
            #[cfg(test)]
            NormalizedReleaseTrust::Fake => None,
        }
    }

    fn verified_installer_plan(&self) -> Option<VerifiedInstallerPlan> {
        match &self.trust {
            NormalizedReleaseTrust::Verified {
                evidence,
                asset_locator,
            } => Some(VerifiedInstallerPlan::new(
                self.candidate_id.clone(),
                asset_locator.canonical_url(),
                evidence.as_ref().clone(),
            )),
            #[cfg(test)]
            NormalizedReleaseTrust::Fake => None,
        }
    }

    pub(crate) fn release_page_url(&self) -> Option<String> {
        match &self.trust {
            NormalizedReleaseTrust::Verified { evidence, .. } => Some(format!(
                "https://github.com/{}/releases/tag/{}",
                evidence.repository(),
                evidence.tag()
            )),
            #[cfg(test)]
            NormalizedReleaseTrust::Fake => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateSourceError {
    pub code: String,
    pub retryable: bool,
    pub message: String,
}

pub struct CheckRequest {
    pub current_version: String,
}

pub trait UpdateSource: Send + Sync {
    fn check(
        &self,
        request: CheckRequest,
    ) -> Pin<
        Box<dyn Future<Output = Result<Option<NormalizedRelease>, UpdateSourceError>> + Send + '_>,
    >;
}

pub trait UpdateSnapshotSink: Send + Sync {
    fn publish(&self, snapshot: UpdateSnapshot);
}

#[derive(Default)]
struct NoopSnapshotSink;

impl UpdateSnapshotSink for NoopSnapshotSink {
    fn publish(&self, _snapshot: UpdateSnapshot) {}
}

struct DisabledUpdateSource;

impl UpdateSource for DisabledUpdateSource {
    fn check(
        &self,
        _request: CheckRequest,
    ) -> Pin<
        Box<dyn Future<Output = Result<Option<NormalizedRelease>, UpdateSourceError>> + Send + '_>,
    > {
        Box::pin(async {
            Err(UpdateSourceError {
                code: "UPDATE_RUNTIME_DISABLED".into(),
                retryable: false,
                message: "此构建未启用官方更新能力".into(),
            })
        })
    }
}

#[derive(Debug, Clone)]
struct PendingCheck {
    operation_id: String,
    previous_phase: UpdatePhase,
    trigger: CheckTrigger,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CheckTrigger {
    Manual,
    Automatic,
}

#[derive(Debug, Clone)]
struct PendingCacheRecovery {
    operation_id: String,
    claimed: bool,
}

#[derive(Clone)]
struct ClaimedDownload {
    operation_id: String,
    candidate_id: ReleaseCandidateId,
    plan: VerifiedInstallerPlan,
    cancellation: CancellationToken,
    completion: CancellationToken,
}

#[derive(Debug)]
struct ActiveDownload {
    operation_id: String,
    candidate_id: ReleaseCandidateId,
    plan: VerifiedInstallerPlan,
    cancellation: CancellationToken,
    completion: CancellationToken,
    claimed: bool,
    cancel_requested: bool,
    internal_received_bytes: u64,
    last_progress_commit_ms: u64,
}

#[derive(Clone)]
struct ClaimedInstall {
    operation_id: String,
    candidate_id: ReleaseCandidateId,
    artifact: VerifiedInstallerArtifact,
    recovery_required: bool,
}

#[derive(Debug)]
struct ActiveInstall {
    operation_id: String,
    candidate_id: ReleaseCandidateId,
    artifact: VerifiedInstallerArtifact,
    claimed: bool,
    recovery_required: bool,
}

#[derive(Debug)]
struct UpdateState {
    snapshot: UpdateSnapshot,
    normalized_candidate: Option<NormalizedRelease>,
    next_operation: u64,
    pending_cache_recovery: Option<PendingCacheRecovery>,
    pending_check: Option<PendingCheck>,
    active_download: Option<ActiveDownload>,
    active_install: Option<ActiveInstall>,
    quarantined_candidate: Option<ReleaseCandidateId>,
    verified_artifact: Option<VerifiedInstallerArtifact>,
    verified_metadata_digest: Option<String>,
    cache_cleanup_blocked: bool,
    policy: UpdatePolicySnapshot,
}

impl UpdateState {
    fn with_phase(current_version: impl Into<String>, phase: UpdatePhase) -> Self {
        Self {
            snapshot: UpdateSnapshot {
                revision: 0,
                phase,
                current_version: current_version.into(),
                candidate: None,
                operation: None,
                fault: None,
                checked_at: None,
                remind_after: None,
                skipped_version: None,
            },
            normalized_candidate: None,
            next_operation: 1,
            pending_cache_recovery: None,
            pending_check: None,
            active_download: None,
            active_install: None,
            quarantined_candidate: None,
            verified_artifact: None,
            verified_metadata_digest: None,
            cache_cleanup_blocked: false,
            policy: UpdatePolicySnapshot::default(),
        }
    }

    fn hydrate_policy(&mut self, policy: UpdatePolicySnapshot) {
        self.snapshot.checked_at = policy.last_successful_check_at;
        self.snapshot.remind_after = policy.remind.as_ref().map(|remind| remind.until);
        self.snapshot.skipped_version = policy.skipped_version.clone();
        self.quarantined_candidate = policy
            .quarantine
            .as_ref()
            .and_then(|value| ReleaseCandidateId::parse(value.candidate_id.clone()));
        self.policy = policy;
    }

    fn clear_candidate_for_policy(&mut self, phase: UpdatePhase) {
        self.snapshot.phase = phase;
        self.snapshot.candidate = None;
        self.normalized_candidate = None;
        self.verified_artifact = None;
        self.verified_metadata_digest = None;
    }

    fn finish_policy_failure(
        &mut self,
        expected_revision: u64,
        error: &UpdatePolicyStoreError,
    ) -> Option<UpdateSnapshot> {
        if self.snapshot.revision != expected_revision {
            return None;
        }
        self.snapshot.fault = Some(UpdateFaultView {
            stage: UpdateFaultStage::Cache,
            code: error.code().into(),
            retryable: false,
            message: "无法持久化本机更新策略".into(),
        });
        self.snapshot.revision += 1;
        Some(self.snapshot.clone())
    }

    fn initialize_cache_recovery(&mut self) {
        let operation_id = format!("cache-revalidation-{}", self.next_operation);
        self.next_operation += 1;
        self.pending_cache_recovery = Some(PendingCacheRecovery {
            operation_id: operation_id.clone(),
            claimed: false,
        });
        self.snapshot.phase = UpdatePhase::RecoveringCache;
        self.snapshot.operation = Some(UpdateOperationView {
            id: operation_id,
            kind: UpdateOperationKind::CacheRevalidation,
            received_bytes: 0,
            total_bytes: None,
            cancellable: false,
        });
        self.snapshot.fault = None;
    }

    fn claim_cache_recovery(&mut self) -> Option<PendingCacheRecovery> {
        let pending = self.pending_cache_recovery.as_mut()?;
        if pending.claimed {
            return None;
        }
        pending.claimed = true;
        Some(pending.clone())
    }

    fn rearm_web_reconciliation_cache_recovery(&mut self) -> Option<UpdateSnapshot> {
        if self.snapshot.phase != UpdatePhase::Idle
            || !self.cache_cleanup_blocked
            || self.snapshot.operation.is_some()
            || self.pending_cache_recovery.is_some()
            || !self.snapshot.fault.as_ref().is_some_and(|fault| {
                fault.stage == UpdateFaultStage::Cache
                    && fault.code == WEB_RECONCILIATION_REQUIRED_FAULT
            })
        {
            return None;
        }
        self.initialize_cache_recovery();
        self.snapshot.revision += 1;
        Some(self.snapshot.clone())
    }

    fn begin_check(&mut self, trigger: CheckTrigger) -> UpdateSnapshot {
        let operation_id = format!("check-{}", self.next_operation);
        self.next_operation += 1;
        let previous_phase = self.snapshot.phase;
        self.pending_check = Some(PendingCheck {
            operation_id: operation_id.clone(),
            previous_phase,
            trigger,
        });
        self.snapshot.phase = UpdatePhase::Checking;
        self.snapshot.operation = Some(UpdateOperationView {
            id: operation_id,
            kind: UpdateOperationKind::Check,
            received_bytes: 0,
            total_bytes: None,
            cancellable: false,
        });
        self.snapshot.fault = None;
        self.snapshot.revision += 1;
        self.snapshot.clone()
    }

    fn begin_download(&mut self, plan: VerifiedInstallerPlan) -> UpdateSnapshot {
        let operation_id = format!("download-{}", self.next_operation);
        self.next_operation += 1;
        let candidate_id = plan.candidate_id().clone();
        let cancellation = CancellationToken::new();
        let completion = CancellationToken::new();
        self.active_download = Some(ActiveDownload {
            operation_id: operation_id.clone(),
            candidate_id,
            plan,
            cancellation,
            completion,
            claimed: false,
            cancel_requested: false,
            internal_received_bytes: 0,
            last_progress_commit_ms: 0,
        });
        self.snapshot.phase = UpdatePhase::Downloading;
        self.snapshot.operation = Some(UpdateOperationView {
            id: operation_id,
            kind: UpdateOperationKind::Download,
            received_bytes: 0,
            total_bytes: None,
            cancellable: true,
        });
        self.snapshot.fault = None;
        self.snapshot.revision += 1;
        self.snapshot.clone()
    }

    fn claim_download(&mut self) -> Option<ClaimedDownload> {
        let active = self.active_download.as_mut()?;
        if active.claimed {
            return None;
        }
        active.claimed = true;
        Some(ClaimedDownload {
            operation_id: active.operation_id.clone(),
            candidate_id: active.candidate_id.clone(),
            plan: active.plan.clone(),
            cancellation: active.cancellation.clone(),
            completion: active.completion.clone(),
        })
    }

    fn begin_install(&mut self) -> Option<UpdateSnapshot> {
        let candidate = self.normalized_candidate.as_ref()?;
        let artifact = self.verified_artifact.as_ref()?;
        if artifact.candidate_id() != &candidate.candidate_id {
            return None;
        }
        let operation_id = format!("install-{}", self.next_operation);
        self.next_operation += 1;
        self.active_install = Some(ActiveInstall {
            operation_id: operation_id.clone(),
            candidate_id: candidate.candidate_id.clone(),
            artifact: artifact.clone(),
            claimed: false,
            recovery_required: false,
        });
        self.snapshot.phase = UpdatePhase::PreparingInstall;
        self.snapshot.operation = Some(UpdateOperationView {
            id: operation_id,
            kind: UpdateOperationKind::Install,
            received_bytes: 0,
            total_bytes: None,
            cancellable: false,
        });
        self.snapshot.fault = None;
        self.snapshot.revision += 1;
        Some(self.snapshot.clone())
    }

    fn claim_install(&mut self) -> Option<ClaimedInstall> {
        let active = self.active_install.as_mut()?;
        if active.claimed {
            return None;
        }
        active.claimed = true;
        Some(ClaimedInstall {
            operation_id: active.operation_id.clone(),
            candidate_id: active.candidate_id.clone(),
            artifact: active.artifact.clone(),
            recovery_required: active.recovery_required,
        })
    }

    fn finish_install(
        &mut self,
        claimed: &ClaimedInstall,
        result: Result<UpdateInstallOutcome, UpdateInstallFault>,
    ) -> Option<UpdateSnapshot> {
        let active = self.active_install.as_ref()?;
        if active.operation_id != claimed.operation_id
            || active.candidate_id != claimed.candidate_id
            || self
                .snapshot
                .operation
                .as_ref()
                .map(|operation| operation.id.as_str())
                != Some(claimed.operation_id.as_str())
        {
            return None;
        }

        match result {
            Ok(UpdateInstallOutcome::InstallerSpawned) => {
                self.snapshot.phase = UpdatePhase::Installing;
                self.snapshot.operation = None;
                self.snapshot.fault = None;
                self.active_install = None;
            }
            Ok(UpdateInstallOutcome::RecoveryCompleted) => {
                self.snapshot.phase = UpdatePhase::ReadyToInstall;
                self.snapshot.operation = None;
                // 保留触发 rollback 的稳定 fault，便于用户理解安装为何没有启动。
                self.active_install = None;
            }
            Err(fault) if fault.recovery_required => {
                self.snapshot.phase = UpdatePhase::PreparingInstall;
                self.snapshot.fault = Some(UpdateFaultView {
                    stage: fault.stage,
                    code: fault.code,
                    retryable: fault.retryable,
                    message: fault.message,
                });
                if let Some(active) = self.active_install.as_mut() {
                    active.claimed = false;
                    active.recovery_required = true;
                }
            }
            Err(fault) => {
                self.snapshot.phase = UpdatePhase::ReadyToInstall;
                self.snapshot.operation = None;
                self.snapshot.fault = Some(UpdateFaultView {
                    stage: fault.stage,
                    code: fault.code,
                    retryable: fault.retryable,
                    message: fault.message,
                });
                self.active_install = None;
            }
        }
        self.snapshot.revision += 1;
        Some(self.snapshot.clone())
    }

    fn finish_interrupted_install(&mut self, claimed: &ClaimedInstall) -> Option<UpdateSnapshot> {
        let active = self.active_install.as_mut()?;
        if active.operation_id != claimed.operation_id
            || active.candidate_id != claimed.candidate_id
            || self
                .snapshot
                .operation
                .as_ref()
                .map(|operation| operation.id.as_str())
                != Some(claimed.operation_id.as_str())
        {
            return None;
        }
        active.claimed = false;
        active.recovery_required = true;
        self.snapshot.phase = UpdatePhase::PreparingInstall;
        self.snapshot.fault = Some(UpdateFaultView {
            stage: UpdateFaultStage::Quiesce,
            code: "UPDATE_INSTALL_INTERRUPTED".into(),
            retryable: true,
            message: "安装准备被中断，正在等待 exact rollback 恢复".into(),
        });
        self.snapshot.revision += 1;
        Some(self.snapshot.clone())
    }

    fn apply_download_event(
        &mut self,
        operation_id: &str,
        candidate_id: &ReleaseCandidateId,
        event: InstallerDownloadEvent,
    ) -> (bool, Option<UpdateSnapshot>) {
        let Some(active) = self.active_download.as_mut() else {
            return (false, None);
        };
        if active.operation_id != operation_id || &active.candidate_id != candidate_id {
            return (false, None);
        }
        let operation_matches = self
            .snapshot
            .operation
            .as_ref()
            .is_some_and(|operation| operation.id == operation_id);
        if !operation_matches {
            return (false, None);
        }

        let mut should_commit = false;
        match event {
            InstallerDownloadEvent::Opened {
                total_bytes: _,
                elapsed_ms: _,
            } => {
                if active.cancel_requested || self.snapshot.phase != UpdatePhase::Downloading {
                    return (false, None);
                }
                active.internal_received_bytes = 0;
            }
            InstallerDownloadEvent::Progress {
                received_bytes,
                total_bytes,
                elapsed_ms,
            } => {
                if active.cancel_requested || self.snapshot.phase != UpdatePhase::Downloading {
                    return (false, None);
                }
                if received_bytes < active.internal_received_bytes {
                    return (false, None);
                }
                let public_is_current = self.snapshot.operation.as_ref().is_some_and(|operation| {
                    operation.received_bytes == received_bytes
                        && operation.total_bytes == total_bytes
                });
                active.internal_received_bytes = received_bytes;
                if !public_is_current
                    && elapsed_ms.saturating_sub(active.last_progress_commit_ms)
                        >= PUBLIC_PROGRESS_INTERVAL_MS
                {
                    active.last_progress_commit_ms = elapsed_ms;
                    if let Some(operation) = self.snapshot.operation.as_mut() {
                        operation.received_bytes = received_bytes;
                        operation.total_bytes = total_bytes;
                    }
                    should_commit = true;
                }
            }
            InstallerDownloadEvent::Retrying { .. } => {
                if active.cancel_requested || self.snapshot.phase != UpdatePhase::Downloading {
                    return (false, None);
                }
                active.internal_received_bytes = 0;
            }
            InstallerDownloadEvent::Verifying {
                received_bytes,
                total_bytes,
            } => {
                if active.cancel_requested || self.snapshot.phase != UpdatePhase::Downloading {
                    return (false, None);
                }
                active.internal_received_bytes = received_bytes;
                self.snapshot.phase = UpdatePhase::Verifying;
                if let Some(operation) = self.snapshot.operation.as_mut() {
                    operation.kind = UpdateOperationKind::Verify;
                    operation.received_bytes = received_bytes;
                    operation.total_bytes = total_bytes;
                    operation.cancellable = false;
                }
                should_commit = true;
            }
        }

        if should_commit {
            self.snapshot.revision += 1;
            (true, Some(self.snapshot.clone()))
        } else {
            (true, None)
        }
    }

    fn finish_download(
        &mut self,
        claimed: &ClaimedDownload,
        result: Result<VerifiedInstallerArtifact, InstallerDownloadError>,
    ) -> Option<UpdateSnapshot> {
        let active = self.active_download.as_ref()?;
        if active.operation_id != claimed.operation_id
            || active.candidate_id != claimed.candidate_id
            || self
                .snapshot
                .operation
                .as_ref()
                .map(|operation| operation.id.as_str())
                != Some(claimed.operation_id.as_str())
        {
            return None;
        }
        let cancel_requested = active.cancel_requested;

        self.snapshot.operation = None;
        match result {
            Ok(artifact)
                if self.snapshot.phase == UpdatePhase::Verifying
                    && artifact.candidate_id() == &claimed.candidate_id =>
            {
                self.snapshot.phase = UpdatePhase::ReadyToInstall;
                self.snapshot.fault = None;
                self.verified_artifact = Some(artifact);
            }
            Ok(_) => {
                self.snapshot.phase = UpdatePhase::Available;
                self.snapshot.fault = Some(UpdateFaultView {
                    stage: UpdateFaultStage::Cache,
                    code: "UPDATE_DOWNLOAD_STATE_REJECTED".into(),
                    retryable: false,
                    message: "更新下载结果与当前 operation authority 不一致".into(),
                });
            }
            Err(error) => {
                self.snapshot.phase = UpdatePhase::Available;
                let cancellation_won = error.is_cancelled()
                    || (cancel_requested
                        && !error.is_authenticity_failure()
                        && error.stage() == InstallerDownloadFailureStage::Download);
                if error.is_authenticity_failure() && !cancellation_won {
                    self.quarantined_candidate = Some(claimed.candidate_id.clone());
                }
                self.snapshot.fault = if cancellation_won {
                    None
                } else {
                    Some(UpdateFaultView {
                        stage: match error.stage() {
                            InstallerDownloadFailureStage::Download => UpdateFaultStage::Download,
                            InstallerDownloadFailureStage::Verify => UpdateFaultStage::Verify,
                            InstallerDownloadFailureStage::Cache => UpdateFaultStage::Cache,
                        },
                        code: error.code().into(),
                        retryable: error.retryable(),
                        message: error.message().into(),
                    })
                };
            }
        }
        self.active_download = None;
        self.snapshot.revision += 1;
        Some(self.snapshot.clone())
    }

    fn finish_interrupted_download(&mut self, claimed: &ClaimedDownload) -> Option<UpdateSnapshot> {
        let active = self.active_download.as_ref()?;
        if active.operation_id != claimed.operation_id
            || active.candidate_id != claimed.candidate_id
            || self
                .snapshot
                .operation
                .as_ref()
                .map(|operation| operation.id.as_str())
                != Some(claimed.operation_id.as_str())
        {
            return None;
        }
        let cancelled = active.cancel_requested || active.cancellation.is_cancelled();
        self.snapshot.phase = UpdatePhase::Available;
        self.snapshot.operation = None;
        self.snapshot.fault = if cancelled {
            None
        } else {
            Some(UpdateFaultView {
                stage: UpdateFaultStage::Download,
                code: "UPDATE_DOWNLOAD_INTERRUPTED".into(),
                retryable: true,
                message: "更新下载任务被中断".into(),
            })
        };
        self.active_download = None;
        self.snapshot.revision += 1;
        Some(self.snapshot.clone())
    }

    fn cancel_unclaimed_download_for_shutdown(&mut self) -> Option<UpdateSnapshot> {
        let active = self.active_download.as_ref()?;
        if active.claimed {
            return None;
        }
        active.cancellation.cancel();
        self.snapshot.phase = UpdatePhase::Available;
        self.snapshot.operation = None;
        self.snapshot.fault = None;
        self.active_download = None;
        self.snapshot.revision += 1;
        Some(self.snapshot.clone())
    }

    fn finish_cache_recovery(
        &mut self,
        pending: &PendingCacheRecovery,
        outcome: CacheRecoveryOutcome,
    ) -> Option<UpdateSnapshot> {
        if self
            .snapshot
            .operation
            .as_ref()
            .map(|operation| operation.id.as_str())
            != Some(pending.operation_id.as_str())
        {
            return None;
        }
        self.snapshot.operation = None;
        self.pending_cache_recovery = None;
        match outcome {
            CacheRecoveryOutcome::Recovered(recovered) => {
                let recovered = *recovered;
                if recovered.artifact.candidate_id() != &recovered.release.candidate_id {
                    self.snapshot.phase = UpdatePhase::Idle;
                    self.snapshot.fault = Some(UpdateFaultView {
                        stage: UpdateFaultStage::Cache,
                        code: "UPDATE_CACHE_IDENTITY_REJECTED".into(),
                        retryable: false,
                        message: "缓存 artifact 与 candidate identity 不一致".into(),
                    });
                    self.cache_cleanup_blocked = true;
                } else {
                    let metadata_digest = recovered.metadata_digest;
                    let recovery_fault = recovered.recovery_fault;
                    self.commit_candidate(recovered.release, UpdatePhase::ReadyToInstall);
                    self.verified_artifact = Some(recovered.artifact);
                    self.verified_metadata_digest = Some(metadata_digest);
                    self.cache_cleanup_blocked = false;
                    self.snapshot.fault = recovery_fault.map(|fault| UpdateFaultView {
                        stage: UpdateFaultStage::Cache,
                        code: fault.code.into(),
                        retryable: false,
                        message: fault.message.into(),
                    });
                }
            }
            CacheRecoveryOutcome::PendingQuarantine(_) => {
                self.snapshot.phase = UpdatePhase::Idle;
                self.snapshot.fault = Some(UpdateFaultView {
                    stage: UpdateFaultStage::Cache,
                    code: "UPDATE_QUARANTINE_FINALIZATION_REQUIRED".into(),
                    retryable: false,
                    message: "隔离记录尚未完成策略提交与缓存清理".into(),
                });
                self.cache_cleanup_blocked = true;
            }
            CacheRecoveryOutcome::Empty { fault, quarantine } => {
                self.snapshot.phase = UpdatePhase::Idle;
                self.snapshot.candidate = None;
                self.normalized_candidate = None;
                self.verified_artifact = None;
                self.verified_metadata_digest = None;
                self.cache_cleanup_blocked = false;
                self.snapshot.fault = fault.map(|fault| UpdateFaultView {
                    stage: UpdateFaultStage::Cache,
                    code: fault.code.into(),
                    retryable: false,
                    message: fault.message.into(),
                });
                if let Some(candidate) = quarantine {
                    self.quarantined_candidate = ReleaseCandidateId::parse(candidate.candidate_id);
                }
            }
            CacheRecoveryOutcome::Blocked(fault) => {
                self.snapshot.phase = UpdatePhase::Idle;
                self.snapshot.fault = Some(UpdateFaultView {
                    stage: UpdateFaultStage::Cache,
                    code: fault.code.into(),
                    retryable: false,
                    message: fault.message.into(),
                });
                self.cache_cleanup_blocked = true;
            }
        }
        self.snapshot.revision += 1;
        Some(self.snapshot.clone())
    }

    fn finish_interrupted_cache_recovery(
        &mut self,
        pending: &PendingCacheRecovery,
    ) -> Option<UpdateSnapshot> {
        if self
            .snapshot
            .operation
            .as_ref()
            .map(|operation| operation.id.as_str())
            != Some(pending.operation_id.as_str())
        {
            return None;
        }
        self.pending_cache_recovery = None;
        self.snapshot.phase = UpdatePhase::Idle;
        self.snapshot.operation = None;
        self.snapshot.fault = Some(UpdateFaultView {
            stage: UpdateFaultStage::Cache,
            code: "UPDATE_CACHE_RECOVERY_INTERRUPTED".into(),
            retryable: true,
            message: "更新缓存恢复任务被中断".into(),
        });
        self.cache_cleanup_blocked = true;
        self.snapshot.revision += 1;
        Some(self.snapshot.clone())
    }

    fn finish_check(
        &mut self,
        pending: PendingCheck,
        result: Result<Option<NormalizedRelease>, UpdateSourceError>,
    ) -> Option<UpdateSnapshot> {
        if self
            .snapshot
            .operation
            .as_ref()
            .map(|value| value.id.as_str())
            != Some(pending.operation_id.as_str())
        {
            return None;
        }
        self.snapshot.operation = None;
        match result {
            Ok(Some(release)) => {
                let policy_identity_conflict =
                    self.policy.quarantine.as_ref().is_some_and(|value| {
                        value.version == release.version
                            && value.candidate_id != release.candidate_id.as_str()
                    }) || self.policy.remind.as_ref().is_some_and(|value| {
                        value.version == release.version
                            && value.candidate_id != release.candidate_id.as_str()
                    });
                if policy_identity_conflict {
                    self.snapshot.phase = pending.previous_phase;
                    self.snapshot.fault = Some(candidate_fault(
                        "UPDATE_CANDIDATE_IDENTITY_CONFLICT",
                        "同版本更新 candidate identity 与跨重启可信策略不一致",
                    ));
                    self.snapshot.revision += 1;
                    return Some(self.snapshot.clone());
                }
                let decision = self.candidate_refresh_decision(&release);
                let automatic_exact_skip = pending.trigger == CheckTrigger::Automatic
                    && self.policy.skipped_version.as_deref() == Some(release.version.as_str());

                match decision {
                    Some(CandidateRefreshDecision::IdentityConflict) => {
                        self.snapshot.phase = pending.previous_phase;
                        self.snapshot.fault = Some(candidate_fault(
                            "UPDATE_CANDIDATE_IDENTITY_CONFLICT",
                            "同版本更新 candidate identity 与当前可信 candidate 不一致",
                        ));
                    }
                    Some(CandidateRefreshDecision::Rollback) => {
                        self.snapshot.phase = pending.previous_phase;
                        self.snapshot.fault = Some(candidate_fault(
                            "UPDATE_CANDIDATE_ROLLBACK_REJECTED",
                            "更新源返回了低于当前可信 candidate 的版本",
                        ));
                    }
                    Some(CandidateRefreshDecision::InvalidVersion) => {
                        self.snapshot.phase = pending.previous_phase;
                        self.snapshot.fault = Some(candidate_fault(
                            "UPDATE_CANDIDATE_VERSION_REJECTED",
                            "更新源返回了无效 candidate 版本",
                        ));
                    }
                    None if automatic_exact_skip => {
                        self.snapshot.phase = UpdatePhase::Current;
                        self.snapshot.fault = None;
                    }
                    Some(CandidateRefreshDecision::Higher) if automatic_exact_skip => {
                        // skip 只压制新版本的自动提示，不能撤销当前较低版本仍持有的
                        // verified authority；手动检查仍可显式接受该更高版本。
                        self.snapshot.phase = pending.previous_phase;
                        self.snapshot.fault = None;
                    }
                    Some(CandidateRefreshDecision::Same) => {
                        // 同一可信 candidate 只刷新展示 metadata，并保留 ready artifact。
                        self.commit_candidate(release, pending.previous_phase);
                    }
                    None | Some(CandidateRefreshDecision::Higher) => {
                        if matches!(decision, Some(CandidateRefreshDecision::Higher)) {
                            self.quarantined_candidate = None;
                        }
                        self.commit_candidate(release, UpdatePhase::Available);
                    }
                }
            }
            Ok(None) => {
                self.snapshot.phase = if self.normalized_candidate.is_some() {
                    pending.previous_phase
                } else {
                    UpdatePhase::Current
                };
                self.snapshot.fault = None;
            }
            Err(error) => {
                self.snapshot.phase = pending.previous_phase;
                self.snapshot.fault = Some(UpdateFaultView {
                    stage: UpdateFaultStage::Check,
                    code: error.code,
                    retryable: error.retryable,
                    message: error.message,
                });
            }
        }
        self.snapshot.revision += 1;
        Some(self.snapshot.clone())
    }

    fn candidate_refresh_decision(
        &self,
        release: &NormalizedRelease,
    ) -> Option<CandidateRefreshDecision> {
        self.normalized_candidate.as_ref().map(|current| {
            if current.candidate_id == release.candidate_id {
                if current.version == release.version {
                    CandidateRefreshDecision::Same
                } else {
                    CandidateRefreshDecision::IdentityConflict
                }
            } else {
                match (
                    Version::parse(&current.version),
                    Version::parse(&release.version),
                ) {
                    (Ok(current_version), Ok(incoming_version))
                        if incoming_version > current_version =>
                    {
                        CandidateRefreshDecision::Higher
                    }
                    (Ok(current_version), Ok(incoming_version))
                        if incoming_version == current_version =>
                    {
                        CandidateRefreshDecision::IdentityConflict
                    }
                    (Ok(_), Ok(_)) => CandidateRefreshDecision::Rollback,
                    _ => CandidateRefreshDecision::InvalidVersion,
                }
            }
        })
    }

    fn verified_artifact_replaced_by(
        &self,
        pending: &PendingCheck,
        result: &Result<Option<NormalizedRelease>, UpdateSourceError>,
    ) -> Option<VerifiedInstallerArtifact> {
        let release = result.as_ref().ok()?.as_ref()?;
        if pending.trigger == CheckTrigger::Automatic
            && self.policy.skipped_version.as_deref() == Some(release.version.as_str())
        {
            return None;
        }
        if self.candidate_refresh_decision(release) == Some(CandidateRefreshDecision::Higher) {
            self.verified_artifact.clone()
        } else {
            None
        }
    }

    fn clear_verified_artifact(&mut self, candidate_id: &ReleaseCandidateId) {
        if self
            .verified_artifact
            .as_ref()
            .is_some_and(|artifact| artifact.candidate_id() == candidate_id)
        {
            self.verified_artifact = None;
            self.verified_metadata_digest = None;
        }
    }

    fn finish_check_replacement_failure(
        &mut self,
        pending: PendingCheck,
        error: InstallerDownloadError,
    ) -> Option<UpdateSnapshot> {
        if self
            .snapshot
            .operation
            .as_ref()
            .map(|operation| operation.id.as_str())
            != Some(pending.operation_id.as_str())
        {
            return None;
        }
        self.clear_candidate_for_policy(UpdatePhase::Current);
        self.snapshot.operation = None;
        self.snapshot.fault = Some(UpdateFaultView {
            stage: UpdateFaultStage::Cache,
            code: error.code().into(),
            retryable: false,
            message: error.message().into(),
        });
        self.cache_cleanup_blocked = true;
        self.snapshot.revision += 1;
        Some(self.snapshot.clone())
    }

    fn finish_interrupted_check(&mut self, pending: &PendingCheck) -> Option<UpdateSnapshot> {
        if self
            .snapshot
            .operation
            .as_ref()
            .map(|operation| operation.id.as_str())
            != Some(pending.operation_id.as_str())
        {
            return None;
        }
        self.snapshot.phase = pending.previous_phase;
        self.snapshot.operation = None;
        self.snapshot.fault = Some(UpdateFaultView {
            stage: UpdateFaultStage::Check,
            code: "UPDATE_CHECK_INTERRUPTED".into(),
            retryable: true,
            message: "更新检查任务被中断".into(),
        });
        self.snapshot.revision += 1;
        Some(self.snapshot.clone())
    }

    fn commit_candidate(&mut self, release: NormalizedRelease, phase: UpdatePhase) {
        self.snapshot.phase = phase;
        self.snapshot.candidate = Some(UpdateCandidateView {
            id: release.candidate_id.as_str().to_owned(),
            version: release.version.clone(),
            notes: release.notes.clone(),
            published_at: release.published_at.clone(),
        });
        self.normalized_candidate = Some(release);
        self.snapshot.fault = None;
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CandidateRefreshDecision {
    Same,
    Higher,
    IdentityConflict,
    Rollback,
    InvalidVersion,
}

fn candidate_fault(code: &str, message: &str) -> UpdateFaultView {
    UpdateFaultView {
        stage: UpdateFaultStage::Check,
        code: code.to_owned(),
        retryable: false,
        message: message.to_owned(),
    }
}

fn policy_source_error(code: impl Into<String>) -> UpdateSourceError {
    UpdateSourceError {
        code: code.into(),
        retryable: false,
        message: "无法持久化本机更新策略".into(),
    }
}

fn cache_policy_fault(code: &'static str) -> CacheRecoveryFault {
    CacheRecoveryFault {
        code,
        message: "无法持久化本机更新策略",
    }
}

fn is_strictly_higher_version(incoming: &str, previous: &str) -> bool {
    match (Version::parse(incoming), Version::parse(previous)) {
        (Ok(incoming), Ok(previous)) => {
            incoming.pre.is_empty() && incoming.build.is_empty() && incoming > previous
        }
        _ => false,
    }
}

/// 只有严格更高且已由 Source 完整验证的 candidate 才能解除旧策略。
fn clear_superseded_policy(policy: &mut UpdatePolicySnapshot, incoming_version: &str) -> bool {
    let mut changed = false;
    if policy
        .remind
        .as_ref()
        .is_some_and(|value| is_strictly_higher_version(incoming_version, &value.version))
    {
        policy.remind = None;
        changed = true;
    }
    if policy
        .skipped_version
        .as_ref()
        .is_some_and(|value| is_strictly_higher_version(incoming_version, value))
    {
        policy.skipped_version = None;
        changed = true;
    }
    if policy
        .quarantine
        .as_ref()
        .is_some_and(|value| is_strictly_higher_version(incoming_version, &value.version))
    {
        policy.quarantine = None;
        changed = true;
    }
    changed
}

#[derive(Default)]
struct SnapshotPublicationQueue {
    pending: VecDeque<UpdateSnapshot>,
    draining: bool,
}

pub struct UpdateRuntime {
    policy_gate: Mutex<()>,
    commit_gate: Mutex<()>,
    publication_queue: Mutex<SnapshotPublicationQueue>,
    state: Mutex<UpdateState>,
    source: Arc<dyn UpdateSource>,
    sink: Arc<dyn UpdateSnapshotSink>,
    downloader: Option<Arc<dyn InstallerDownloader>>,
    installer: Option<Arc<dyn UpdateInstaller>>,
    recovery: Option<Arc<dyn UpdateStartupRecovery>>,
    policy_store: Arc<dyn UpdatePolicyStore>,
    time: Arc<dyn UpdateTime>,
    #[cfg(test)]
    download_commit_barrier: Mutex<Option<DownloadCommitBarrier>>,
}

#[cfg(test)]
#[derive(Clone)]
struct DownloadCommitBarrier {
    arrived: Arc<tokio::sync::Notify>,
    release: Arc<tokio::sync::Notify>,
}

impl UpdateRuntime {
    pub fn new(
        current_version: impl Into<String>,
        source: Arc<dyn UpdateSource>,
        sink: Arc<dyn UpdateSnapshotSink>,
    ) -> Self {
        Self::build(current_version, source, sink, None, UpdatePhase::Idle)
    }

    fn build(
        current_version: impl Into<String>,
        source: Arc<dyn UpdateSource>,
        sink: Arc<dyn UpdateSnapshotSink>,
        downloader: Option<Arc<dyn InstallerDownloader>>,
        phase: UpdatePhase,
    ) -> Self {
        Self {
            policy_gate: Mutex::new(()),
            commit_gate: Mutex::new(()),
            publication_queue: Mutex::new(SnapshotPublicationQueue::default()),
            state: Mutex::new(UpdateState::with_phase(current_version, phase)),
            source,
            sink,
            downloader,
            installer: None,
            recovery: None,
            policy_store: Arc::new(MemoryUpdatePolicyStore::default()),
            time: Arc::new(SystemUpdateTime),
            #[cfg(test)]
            download_commit_barrier: Mutex::new(None),
        }
    }

    pub(crate) fn with_downloader(
        current_version: impl Into<String>,
        source: Arc<dyn UpdateSource>,
        sink: Arc<dyn UpdateSnapshotSink>,
        downloader: Arc<dyn InstallerDownloader>,
    ) -> Self {
        Self::build(
            current_version,
            source,
            sink,
            Some(downloader),
            UpdatePhase::Idle,
        )
    }

    pub(crate) fn with_recovery(
        current_version: impl Into<String>,
        source: Arc<dyn UpdateSource>,
        sink: Arc<dyn UpdateSnapshotSink>,
        recovery: Arc<dyn UpdateStartupRecovery>,
    ) -> Self {
        Self::with_recovery_and_policy(
            current_version,
            source,
            sink,
            recovery,
            Arc::new(MemoryUpdatePolicyStore::default()),
        )
        .expect("memory update policy store should initialize")
    }

    pub(crate) fn with_recovery_and_policy(
        current_version: impl Into<String>,
        source: Arc<dyn UpdateSource>,
        sink: Arc<dyn UpdateSnapshotSink>,
        recovery: Arc<dyn UpdateStartupRecovery>,
        policy_store: Arc<dyn UpdatePolicyStore>,
    ) -> Result<Self, UpdatePolicyStoreError> {
        let policy = policy_store.load()?;
        let mut runtime = Self::build(current_version, source, sink, None, UpdatePhase::Idle);
        runtime.recovery = Some(recovery);
        runtime.policy_store = policy_store;
        runtime
            .state
            .lock()
            .expect("update runtime state poisoned")
            .hydrate_policy(policy);
        runtime
            .state
            .lock()
            .expect("update runtime state poisoned")
            .initialize_cache_recovery();
        Ok(runtime)
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn with_production_dependencies(
        current_version: impl Into<String>,
        source: Arc<dyn UpdateSource>,
        sink: Arc<dyn UpdateSnapshotSink>,
        downloader: Arc<dyn InstallerDownloader>,
        recovery: Arc<dyn UpdateStartupRecovery>,
        policy_store: Arc<dyn UpdatePolicyStore>,
        installer: Arc<dyn UpdateInstaller>,
    ) -> Result<Self, UpdatePolicyStoreError> {
        let mut runtime =
            Self::with_recovery_and_policy(current_version, source, sink, recovery, policy_store)?;
        runtime.downloader = Some(downloader);
        runtime.installer = Some(installer);
        Ok(runtime)
    }

    /// #54 生产切换使用的 native policy 组合入口；这里只组装依赖，不提前接入 bootstrap。
    pub(crate) fn with_recovery_and_native_policy(
        current_version: impl Into<String>,
        source: Arc<dyn UpdateSource>,
        sink: Arc<dyn UpdateSnapshotSink>,
        recovery: Arc<dyn UpdateStartupRecovery>,
        policy_directory: impl AsRef<std::path::Path>,
    ) -> Result<Self, UpdatePolicyStoreError> {
        Self::with_recovery_and_policy(
            current_version,
            source,
            sink,
            recovery,
            Arc::new(NativeUpdatePolicyStore::for_app_data(policy_directory)),
        )
    }

    #[cfg(test)]
    fn set_download_commit_barrier(
        &self,
        arrived: Arc<tokio::sync::Notify>,
        release: Arc<tokio::sync::Notify>,
    ) {
        *self
            .download_commit_barrier
            .lock()
            .expect("download commit barrier poisoned") =
            Some(DownloadCommitBarrier { arrived, release });
    }

    pub fn with_noop_sink(
        current_version: impl Into<String>,
        source: Arc<dyn UpdateSource>,
    ) -> Self {
        Self::new(current_version, source, Arc::new(NoopSnapshotSink))
    }

    pub fn disabled(
        current_version: impl Into<String>,
        source: Arc<dyn UpdateSource>,
        sink: Arc<dyn UpdateSnapshotSink>,
    ) -> Self {
        Self::build(current_version, source, sink, None, UpdatePhase::Disabled)
    }

    pub(crate) fn disabled_without_network(
        current_version: impl Into<String>,
        sink: Arc<dyn UpdateSnapshotSink>,
    ) -> Self {
        Self::build(
            current_version,
            Arc::new(DisabledUpdateSource),
            sink,
            None,
            UpdatePhase::Disabled,
        )
    }

    pub fn snapshot(&self) -> UpdateSnapshot {
        self.state
            .lock()
            .expect("update runtime state poisoned")
            .snapshot
            .clone()
    }

    pub(crate) fn rearm_web_reconciliation_recovery(&self) -> bool {
        if self.recovery.is_none() {
            return false;
        }
        let commit = self
            .commit_gate
            .lock()
            .expect("update runtime commit gate poisoned");
        let published = self
            .state
            .lock()
            .expect("update runtime state poisoned")
            .rearm_web_reconciliation_cache_recovery();
        let rearmed = published.is_some();
        let should_drain = published
            .map(|snapshot| self.queue_committed_snapshot(snapshot))
            .unwrap_or(false);
        drop(commit);
        if should_drain {
            self.drain_publications();
        }
        rearmed
    }

    pub(crate) fn release_page_url(&self, candidate_id: Option<&str>) -> Option<String> {
        let state = self.state.lock().expect("update runtime state poisoned");
        if let Some(candidate_id) = candidate_id {
            if let Some(candidate) = state.normalized_candidate.as_ref() {
                if candidate.candidate_id.as_str() == candidate_id {
                    return candidate.release_page_url();
                }
            }
            return None;
        }

        Some(format!(
            "https://github.com/{}/releases",
            github_source::OFFICIAL_REPOSITORY
        ))
    }

    fn queue_policy_failure(&self, expected_revision: u64, error: &UpdatePolicyStoreError) -> bool {
        let commit = self
            .commit_gate
            .lock()
            .expect("update runtime commit gate poisoned");
        let published = self
            .state
            .lock()
            .expect("update runtime state poisoned")
            .finish_policy_failure(expected_revision, error);
        let should_drain = published
            .map(|snapshot| self.queue_committed_snapshot(snapshot))
            .unwrap_or(false);
        drop(commit);
        should_drain
    }

    /// 函数自行持有 policy_gate，确保持久化与状态提交不会被另一个 intent 穿插。
    fn dispatch_remind_later(&self, expected_revision: u64, candidate_id: &str) -> UpdateReceipt {
        let policy_guard = self
            .policy_gate
            .lock()
            .expect("update runtime policy gate poisoned");
        let now = match self.time.now_millis() {
            Ok(now) => now,
            Err(code) => {
                let error = UpdatePolicyStoreError::runtime(code, "本机时钟无法生成更新策略时间");
                let should_drain = self.queue_policy_failure(expected_revision, &error);
                drop(policy_guard);
                if should_drain {
                    self.drain_publications();
                }
                return UpdateReceipt::PolicyBlocked;
            }
        };
        let (mut policy, version) = {
            let _commit = self
                .commit_gate
                .lock()
                .expect("update runtime commit gate poisoned");
            let state = self.state.lock().expect("update runtime state poisoned");
            if state.snapshot.phase == UpdatePhase::Disabled {
                return UpdateReceipt::RuntimeUnavailable;
            }
            if state.snapshot.revision != expected_revision {
                return UpdateReceipt::InvalidOrder;
            }
            if state.snapshot.phase == UpdatePhase::RecoveringCache || state.cache_cleanup_blocked {
                return UpdateReceipt::PolicyBlocked;
            }
            let Some(candidate) = state.normalized_candidate.as_ref() else {
                return UpdateReceipt::StaleCandidate;
            };
            if candidate.candidate_id.as_str() != candidate_id {
                return UpdateReceipt::StaleCandidate;
            }
            if !matches!(
                state.snapshot.phase,
                UpdatePhase::Available | UpdatePhase::ReadyToInstall
            ) {
                return UpdateReceipt::InvalidOrder;
            }
            (state.policy.clone(), candidate.version.clone())
        };
        policy.remind = Some(UpdatePolicyReminder {
            candidate_id: candidate_id.to_owned(),
            version,
            until: now.saturating_add(REMIND_LATER_MILLIS),
        });
        if let Err(error) = self.policy_store.save(&policy) {
            let should_drain = self.queue_policy_failure(expected_revision, &error);
            drop(policy_guard);
            if should_drain {
                self.drain_publications();
            }
            return UpdateReceipt::PolicyBlocked;
        }

        let commit = self
            .commit_gate
            .lock()
            .expect("update runtime commit gate poisoned");
        let published = {
            let mut state = self.state.lock().expect("update runtime state poisoned");
            if state.snapshot.revision != expected_revision
                || state
                    .normalized_candidate
                    .as_ref()
                    .map(|candidate| candidate.candidate_id.as_str())
                    != Some(candidate_id)
                || !matches!(
                    state.snapshot.phase,
                    UpdatePhase::Available | UpdatePhase::ReadyToInstall
                )
            {
                return UpdateReceipt::InvalidOrder;
            }
            state.hydrate_policy(policy);
            state.snapshot.fault = None;
            state.snapshot.revision += 1;
            state.snapshot.clone()
        };
        let should_drain = self.queue_committed_snapshot(published);
        drop(commit);
        drop(policy_guard);
        if should_drain {
            self.drain_publications();
        }
        UpdateReceipt::Accepted
    }

    /// 函数自行持有 policy_gate。先持久化 skip，再删除 cache；崩溃后恢复仍会服从 skip。
    fn dispatch_skip_version(&self, expected_revision: u64, candidate_id: &str) -> UpdateReceipt {
        let policy_guard = self
            .policy_gate
            .lock()
            .expect("update runtime policy gate poisoned");
        let (mut policy, version, artifact) = {
            let _commit = self
                .commit_gate
                .lock()
                .expect("update runtime commit gate poisoned");
            let state = self.state.lock().expect("update runtime state poisoned");
            if state.snapshot.phase == UpdatePhase::Disabled {
                return UpdateReceipt::RuntimeUnavailable;
            }
            if state.snapshot.revision != expected_revision {
                return UpdateReceipt::InvalidOrder;
            }
            if state.snapshot.phase == UpdatePhase::RecoveringCache || state.cache_cleanup_blocked {
                return UpdateReceipt::PolicyBlocked;
            }
            let Some(candidate) = state.normalized_candidate.as_ref() else {
                return UpdateReceipt::StaleCandidate;
            };
            if candidate.candidate_id.as_str() != candidate_id {
                return UpdateReceipt::StaleCandidate;
            }
            if !matches!(
                state.snapshot.phase,
                UpdatePhase::Available | UpdatePhase::ReadyToInstall
            ) {
                return UpdateReceipt::InvalidOrder;
            }
            (
                state.policy.clone(),
                candidate.version.clone(),
                state.verified_artifact.clone(),
            )
        };
        policy.skipped_version = Some(version);
        if policy
            .remind
            .as_ref()
            .is_some_and(|value| value.candidate_id == candidate_id)
        {
            policy.remind = None;
        }
        if policy
            .quarantine
            .as_ref()
            .is_some_and(|value| value.candidate_id == candidate_id)
        {
            policy.quarantine = None;
        }
        if let Err(error) = self.policy_store.save(&policy) {
            let should_drain = self.queue_policy_failure(expected_revision, &error);
            drop(policy_guard);
            if should_drain {
                self.drain_publications();
            }
            return UpdateReceipt::PolicyBlocked;
        }
        let cleanup_error = artifact
            .as_ref()
            .and_then(|artifact| artifact.discard().err());

        let commit = self
            .commit_gate
            .lock()
            .expect("update runtime commit gate poisoned");
        let published = {
            let mut state = self.state.lock().expect("update runtime state poisoned");
            if state.snapshot.revision != expected_revision
                || state
                    .normalized_candidate
                    .as_ref()
                    .map(|candidate| candidate.candidate_id.as_str())
                    != Some(candidate_id)
            {
                return UpdateReceipt::InvalidOrder;
            }
            state.hydrate_policy(policy);
            state.clear_candidate_for_policy(UpdatePhase::Current);
            state.cache_cleanup_blocked = cleanup_error.is_some();
            state.snapshot.fault = cleanup_error.map(|error| UpdateFaultView {
                stage: UpdateFaultStage::Cache,
                code: error.code().into(),
                retryable: false,
                message: error.message().into(),
            });
            state.snapshot.revision += 1;
            state.snapshot.clone()
        };
        let should_drain = self.queue_committed_snapshot(published);
        drop(commit);
        drop(policy_guard);
        if should_drain {
            self.drain_publications();
        }
        UpdateReceipt::Accepted
    }

    pub fn dispatch(&self, request: UpdateDispatchRequest) -> UpdateReceipt {
        match &request.intent {
            UpdateIntent::RemindLater { candidate_id } => {
                return self
                    .dispatch_remind_later(request.expected_revision, candidate_id.as_str());
            }
            UpdateIntent::SkipVersion { candidate_id } => {
                return self
                    .dispatch_skip_version(request.expected_revision, candidate_id.as_str());
            }
            _ => {}
        }
        let policy = self
            .policy_gate
            .lock()
            .expect("update runtime policy gate poisoned");
        let commit = self
            .commit_gate
            .lock()
            .expect("update runtime commit gate poisoned");
        let published = {
            let mut state = self.state.lock().expect("update runtime state poisoned");
            if state.snapshot.phase == UpdatePhase::Disabled {
                return UpdateReceipt::RuntimeUnavailable;
            }
            if request.expected_revision != state.snapshot.revision {
                return UpdateReceipt::InvalidOrder;
            }
            if state.snapshot.phase == UpdatePhase::RecoveringCache || state.cache_cleanup_blocked {
                return UpdateReceipt::PolicyBlocked;
            }
            match &request.intent {
                UpdateIntent::Download { candidate_id } => {
                    let Some(candidate) = state.normalized_candidate.as_ref() else {
                        return UpdateReceipt::StaleCandidate;
                    };
                    if candidate.candidate_id.as_str() != candidate_id {
                        return UpdateReceipt::StaleCandidate;
                    }
                    if state.snapshot.phase != UpdatePhase::Available {
                        return UpdateReceipt::InvalidOrder;
                    }
                    if state
                        .quarantined_candidate
                        .as_ref()
                        .is_some_and(|value| value.as_str() == candidate_id)
                    {
                        return UpdateReceipt::PolicyBlocked;
                    }
                    let Some(plan) = candidate.verified_installer_plan() else {
                        return UpdateReceipt::PolicyBlocked;
                    };
                    if self.downloader.is_none() {
                        return UpdateReceipt::RuntimeUnavailable;
                    }
                    state.begin_download(plan)
                }
                UpdateIntent::InstallAndRestart { candidate_id } => {
                    let Some(candidate) = state.normalized_candidate.as_ref() else {
                        return UpdateReceipt::StaleCandidate;
                    };
                    if candidate.candidate_id.as_str() != candidate_id {
                        return UpdateReceipt::StaleCandidate;
                    }
                    if state.snapshot.phase != UpdatePhase::ReadyToInstall {
                        return UpdateReceipt::InvalidOrder;
                    }
                    if self.installer.is_none() {
                        return UpdateReceipt::RuntimeUnavailable;
                    }
                    let Some(snapshot) = state.begin_install() else {
                        return UpdateReceipt::PolicyBlocked;
                    };
                    snapshot
                }
                UpdateIntent::RemindLater { .. } | UpdateIntent::SkipVersion { .. } => {
                    unreachable!("policy intents are dispatched before the generic state path")
                }
                UpdateIntent::OpenRelease { candidate_id } => {
                    let Some(candidate) = state.normalized_candidate.as_ref() else {
                        return UpdateReceipt::StaleCandidate;
                    };
                    if candidate.candidate_id.as_str() != candidate_id {
                        return UpdateReceipt::StaleCandidate;
                    }
                    return if candidate.release_page_url().is_some() {
                        UpdateReceipt::Accepted
                    } else {
                        UpdateReceipt::PolicyBlocked
                    };
                }
                UpdateIntent::CancelDownload { operation_id } => {
                    if state
                        .snapshot
                        .operation
                        .as_ref()
                        .map(|value| value.id.as_str())
                        != Some(operation_id.as_str())
                    {
                        return UpdateReceipt::StaleOperation;
                    }
                    if state.snapshot.phase != UpdatePhase::Downloading
                        || !state
                            .snapshot
                            .operation
                            .as_ref()
                            .is_some_and(|operation| operation.cancellable)
                    {
                        return UpdateReceipt::InvalidOrder;
                    }
                    let Some(active) = state.active_download.as_mut() else {
                        return UpdateReceipt::InvalidOrder;
                    };
                    if active.operation_id != *operation_id {
                        return UpdateReceipt::StaleOperation;
                    }
                    active.cancel_requested = true;
                    active.cancellation.cancel();
                    if let Some(operation) = state.snapshot.operation.as_mut() {
                        operation.cancellable = false;
                    }
                    state.snapshot.revision += 1;
                    state.snapshot.clone()
                }
                UpdateIntent::CheckNow => {
                    if !matches!(
                        state.snapshot.phase,
                        UpdatePhase::Idle
                            | UpdatePhase::Current
                            | UpdatePhase::Available
                            | UpdatePhase::ReadyToInstall
                    ) {
                        return UpdateReceipt::InvalidOrder;
                    }
                    state.begin_check(CheckTrigger::Manual)
                }
            }
        };
        let should_drain = self.queue_committed_snapshot(published);
        drop(commit);
        drop(policy);
        if should_drain {
            self.drain_publications();
        }
        UpdateReceipt::Accepted
    }

    fn begin_automatic_check(&self) -> AutomaticCheckOutcome {
        let now = match self.time.now_millis() {
            Ok(now) => now,
            Err(_) => return AutomaticCheckOutcome::TimingUnavailable,
        };
        let policy = self
            .policy_gate
            .lock()
            .expect("update runtime policy gate poisoned");
        let commit = self
            .commit_gate
            .lock()
            .expect("update runtime commit gate poisoned");
        let published = {
            let mut state = self.state.lock().expect("update runtime state poisoned");
            if state.snapshot.phase == UpdatePhase::Disabled {
                return AutomaticCheckOutcome::Disabled;
            }
            if state.snapshot.phase == UpdatePhase::RecoveringCache || state.cache_cleanup_blocked {
                return AutomaticCheckOutcome::PolicyBlocked;
            }
            if !matches!(
                state.snapshot.phase,
                UpdatePhase::Idle
                    | UpdatePhase::Current
                    | UpdatePhase::Available
                    | UpdatePhase::ReadyToInstall
            ) {
                return AutomaticCheckOutcome::Busy;
            }
            if state
                .policy
                .last_successful_check_at
                .is_some_and(|checked_at| {
                    checked_at <= now && now - checked_at < SUCCESS_INTERVAL_MILLIS
                })
            {
                return AutomaticCheckOutcome::Throttled;
            }
            state.begin_check(CheckTrigger::Automatic)
        };
        let should_drain = self.queue_committed_snapshot(published);
        drop(commit);
        drop(policy);
        if should_drain {
            self.drain_publications();
        }
        AutomaticCheckOutcome::Started
    }

    pub(crate) async fn run_automatic_check(&self) -> AutomaticCheckOutcome {
        let started = self.begin_automatic_check();
        if started != AutomaticCheckOutcome::Started {
            return started;
        }
        if self.run_pending_check().await {
            AutomaticCheckOutcome::Completed
        } else {
            AutomaticCheckOutcome::Busy
        }
    }

    pub async fn run_pending_check(&self) -> bool {
        let pending = {
            self.state
                .lock()
                .expect("update runtime state poisoned")
                .pending_check
                .take()
        };
        let Some(pending) = pending else {
            return false;
        };
        let mut lease = CheckRunLease::new(self, pending.clone());
        let request = CheckRequest {
            current_version: self.snapshot().current_version,
        };
        let mut result = self.source.check(request).await;
        let _policy = self
            .policy_gate
            .lock()
            .expect("update runtime policy gate poisoned");
        let (mut next_policy, mut replacement_artifact) = {
            let state = self.state.lock().expect("update runtime state poisoned");
            (
                state.policy.clone(),
                state.verified_artifact_replaced_by(&pending, &result),
            )
        };
        let mut policy_to_hydrate = None;
        if result.is_ok() {
            match self.time.now_millis() {
                Ok(checked_at) => {
                    next_policy.last_successful_check_at = Some(checked_at);
                    if let Ok(Some(release)) = &result {
                        let accepted = {
                            let state = self.state.lock().expect("update runtime state poisoned");
                            matches!(
                                state.candidate_refresh_decision(release),
                                None | Some(CandidateRefreshDecision::Same)
                                    | Some(CandidateRefreshDecision::Higher)
                            )
                        };
                        if accepted {
                            clear_superseded_policy(&mut next_policy, &release.version);
                        }
                    }
                    match self.policy_store.save(&next_policy) {
                        Ok(()) => policy_to_hydrate = Some(next_policy),
                        Err(error) => {
                            replacement_artifact = None;
                            result = Err(policy_source_error(error.code()));
                        }
                    }
                }
                Err(code) => {
                    replacement_artifact = None;
                    result = Err(policy_source_error(code));
                }
            }
        }
        let replacement_result = replacement_artifact
            .as_ref()
            .map(VerifiedInstallerArtifact::discard)
            .transpose();

        let commit = self
            .commit_gate
            .lock()
            .expect("update runtime commit gate poisoned");
        let published = {
            let mut state = self.state.lock().expect("update runtime state poisoned");
            if let Some(policy) = policy_to_hydrate {
                state.hydrate_policy(policy);
            }
            match replacement_result {
                Ok(None) => state.finish_check(pending.clone(), result),
                Ok(Some(())) => {
                    if let Some(artifact) = replacement_artifact.as_ref() {
                        state.clear_verified_artifact(artifact.candidate_id());
                    }
                    state.finish_check(pending.clone(), result)
                }
                Err(error) => state.finish_check_replacement_failure(pending.clone(), error),
            }
        };
        if let Some(snapshot) = published {
            let should_drain = self.queue_committed_snapshot(snapshot);
            drop(commit);
            lease.complete();
            drop(_policy);
            if should_drain {
                self.drain_publications();
            }
            true
        } else {
            drop(commit);
            lease.complete();
            drop(_policy);
            false
        }
    }

    pub(crate) async fn run_pending_cache_recovery(&self) -> bool {
        let pending = self
            .state
            .lock()
            .expect("update runtime state poisoned")
            .claim_cache_recovery();
        let Some(pending) = pending else {
            return false;
        };
        let Some(recovery) = self.recovery.as_ref() else {
            return false;
        };
        let mut lease = CacheRecoveryRunLease::new(self, pending.clone());
        let current_version = self.snapshot().current_version;
        let mut outcome = recovery.recover(&current_version).await;
        let _policy = self
            .policy_gate
            .lock()
            .expect("update runtime policy gate poisoned");
        let mut next_policy = self
            .state
            .lock()
            .expect("update runtime state poisoned")
            .policy
            .clone();
        let mut policy_changed = false;
        let mut pending_finalize = None;
        match &outcome {
            CacheRecoveryOutcome::Recovered(recovered) => {
                let candidate_id = recovered.release.candidate_id.as_str();
                let version = recovered.release.version.as_str();
                let rejected_by_policy = next_policy.skipped_version.as_deref() == Some(version)
                    || next_policy
                        .quarantine
                        .as_ref()
                        .is_some_and(|value| value.version == version)
                    || next_policy.remind.as_ref().is_some_and(|value| {
                        value.version == version && value.candidate_id != candidate_id
                    });
                if rejected_by_policy {
                    outcome = match recovered.artifact.discard() {
                        Ok(()) => CacheRecoveryOutcome::Empty {
                            fault: None,
                            quarantine: None,
                        },
                        Err(error) => CacheRecoveryOutcome::Blocked(CacheRecoveryFault {
                            code: error.code(),
                            message: "无法清理被本机策略拒绝的更新缓存",
                        }),
                    };
                } else {
                    policy_changed = clear_superseded_policy(&mut next_policy, version);
                }
            }
            CacheRecoveryOutcome::Empty {
                quarantine: Some(rejected),
                ..
            } => match self.time.now_millis() {
                Ok(rejected_at) => {
                    next_policy.quarantine = Some(UpdatePolicyQuarantine {
                        candidate_id: rejected.candidate_id.clone(),
                        version: rejected.version.clone(),
                        reason: rejected.reason_code.clone(),
                        rejected_at,
                    });
                    policy_changed = true;
                }
                Err(code) => {
                    outcome = CacheRecoveryOutcome::Blocked(cache_policy_fault(code));
                }
            },
            CacheRecoveryOutcome::PendingQuarantine(pending) => {
                let rejected = pending.rejected();
                next_policy.quarantine = Some(UpdatePolicyQuarantine {
                    candidate_id: rejected.candidate_id.clone(),
                    version: rejected.version.clone(),
                    reason: rejected.reason_code.clone(),
                    rejected_at: rejected.rejected_at,
                });
                policy_changed = true;
                pending_finalize = Some((**pending).clone());
            }
            CacheRecoveryOutcome::Empty { .. } | CacheRecoveryOutcome::Blocked(_) => {}
        }
        let policy_to_hydrate = if policy_changed {
            match self.policy_store.save(&next_policy) {
                Ok(()) => Some(next_policy),
                Err(error) => {
                    outcome = CacheRecoveryOutcome::Blocked(cache_policy_fault(error.code()));
                    None
                }
            }
        } else {
            None
        };
        if let Some(pending) = pending_finalize {
            if policy_to_hydrate.is_some() {
                outcome = match pending.finalize() {
                    Ok(()) => CacheRecoveryOutcome::Empty {
                        fault: Some(CacheRecoveryFault {
                            code: "UPDATE_CACHE_AUTHENTICITY_REJECTED",
                            message: "已验证更新缓存无法重新通过来源与签名验证",
                        }),
                        quarantine: None,
                    },
                    Err(error) => CacheRecoveryOutcome::Blocked(CacheRecoveryFault {
                        code: error.code,
                        message: "隔离策略已保存，但无法完成 rejection journal",
                    }),
                };
            }
        }
        let commit = self
            .commit_gate
            .lock()
            .expect("update runtime commit gate poisoned");
        let published = {
            let mut state = self.state.lock().expect("update runtime state poisoned");
            if let Some(policy) = policy_to_hydrate {
                state.hydrate_policy(policy);
            }
            state.finish_cache_recovery(&pending, outcome)
        };
        if let Some(snapshot) = published {
            let should_drain = self.queue_committed_snapshot(snapshot);
            drop(commit);
            lease.complete();
            drop(_policy);
            if should_drain {
                self.drain_publications();
            }
            true
        } else {
            drop(commit);
            lease.complete();
            drop(_policy);
            false
        }
    }

    pub async fn run_pending_download(&self) -> bool {
        let claimed = self
            .state
            .lock()
            .expect("update runtime state poisoned")
            .claim_download();
        let Some(claimed) = claimed else {
            return false;
        };
        let Some(downloader) = self.downloader.as_ref() else {
            return false;
        };
        let observer = RuntimeDownloadObserver {
            runtime: self,
            operation_id: claimed.operation_id.clone(),
            candidate_id: claimed.candidate_id.clone(),
        };
        let mut lease = DownloadRunLease::new(self, claimed.clone());
        let mut result = downloader
            .run(
                claimed.plan.clone(),
                claimed.cancellation.clone(),
                &observer,
            )
            .await;
        #[cfg(test)]
        let barrier = self
            .download_commit_barrier
            .lock()
            .expect("download commit barrier poisoned")
            .take();
        #[cfg(test)]
        if let Some(barrier) = barrier {
            barrier.arrived.notify_one();
            barrier.release.notified().await;
        }
        let _policy = self
            .policy_gate
            .lock()
            .expect("update runtime policy gate poisoned");
        if claimed.cancellation.is_cancelled() {
            if let Ok(artifact) = &result {
                result = match artifact.discard() {
                    Ok(()) => Err(InstallerDownloadError::cancelled()),
                    Err(error) => Err(error),
                };
            }
        }
        let mut policy_to_hydrate = None;
        let mut policy_failed = false;
        let should_quarantine = result.as_ref().err().is_some_and(|error| {
            error.is_authenticity_failure()
                && !error.is_cancelled()
                && !(claimed.cancellation.is_cancelled()
                    && error.stage() == InstallerDownloadFailureStage::Download)
        });
        let pending_rejection = result
            .as_ref()
            .err()
            .and_then(InstallerDownloadError::pending_rejection)
            .cloned();
        if should_quarantine {
            let next_policy = {
                let state = self.state.lock().expect("update runtime state poisoned");
                state.normalized_candidate.as_ref().and_then(|candidate| {
                    if candidate.candidate_id != claimed.candidate_id {
                        return None;
                    }
                    let quarantine = if let Some(pending) = pending_rejection.as_ref() {
                        let rejected = pending.rejected();
                        if rejected.candidate_id != claimed.candidate_id.as_str()
                            || rejected.version != candidate.version
                        {
                            return None;
                        }
                        UpdatePolicyQuarantine {
                            candidate_id: rejected.candidate_id.clone(),
                            version: rejected.version.clone(),
                            reason: rejected.reason_code.clone(),
                            rejected_at: rejected.rejected_at,
                        }
                    } else {
                        UpdatePolicyQuarantine {
                            candidate_id: claimed.candidate_id.as_str().into(),
                            version: candidate.version.clone(),
                            reason: result
                                .as_ref()
                                .expect_err("quarantine requires an error")
                                .code()
                                .into(),
                            rejected_at: self.time.now_millis().ok()?,
                        }
                    };
                    let mut policy = state.policy.clone();
                    policy.quarantine = Some(quarantine);
                    Some(policy)
                })
            };
            match next_policy {
                Some(policy) => match self.policy_store.save(&policy) {
                    Ok(()) => {
                        policy_to_hydrate = Some(policy);
                        if let Some(pending) = pending_rejection.as_ref() {
                            if let Err(error) = pending.finalize() {
                                policy_failed = true;
                                result = Err(InstallerDownloadError::policy_failure(error.code));
                            }
                        }
                    }
                    Err(error) => {
                        policy_failed = true;
                        result = Err(InstallerDownloadError::policy_failure(error.code()));
                    }
                },
                _ => {
                    policy_failed = true;
                    result = Err(InstallerDownloadError::policy_failure(
                        "UPDATE_POLICY_QUARANTINE_REJECTED",
                    ));
                }
            }
        }
        let commit = self
            .commit_gate
            .lock()
            .expect("update runtime commit gate poisoned");
        let published = {
            let mut state = self.state.lock().expect("update runtime state poisoned");
            if let Some(policy) = policy_to_hydrate {
                state.hydrate_policy(policy);
            }
            if policy_failed {
                state.cache_cleanup_blocked = true;
            }
            state.finish_download(&claimed, result)
        };
        if let Some(snapshot) = published {
            let should_drain = self.queue_committed_snapshot(snapshot);
            drop(commit);
            lease.complete();
            drop(_policy);
            if should_drain {
                self.drain_publications();
            }
            true
        } else {
            drop(commit);
            lease.complete();
            drop(_policy);
            false
        }
    }

    pub(crate) async fn run_pending_install(&self) -> bool {
        let claimed = self
            .state
            .lock()
            .expect("update runtime state poisoned")
            .claim_install();
        let Some(claimed) = claimed else {
            return false;
        };
        let Some(installer) = self.installer.as_ref() else {
            self.finish_interrupted_install(&claimed);
            return false;
        };
        let mut lease = InstallRunLease::new(self, claimed.clone());
        let started_at = match self.time.now_millis() {
            Ok(value) => value,
            Err(code) => {
                let result = Err(UpdateInstallFault::new(
                    UpdateFaultStage::Install,
                    code,
                    true,
                    "本机时钟无法生成安装事务时间",
                    claimed.recovery_required,
                ));
                let committed = self.finish_install_result(&claimed, result);
                lease.complete();
                return committed;
            }
        };
        let result = if claimed.recovery_required {
            installer.retry_recovery(started_at).await
        } else {
            installer
                .install_exact(
                    claimed.candidate_id.as_str().to_owned(),
                    claimed.artifact.clone(),
                    started_at,
                )
                .await
        };
        let committed = self.finish_install_result(&claimed, result);
        lease.complete();
        committed
    }

    /// 一个已接受的安装事务最多自动执行一次 exact rollback 恢复。
    /// 这保证 WebView 重载时并发 reconcile worker 即使未取得 claim，原 owner
    /// 在释放 claim 后仍会闭合恢复事务；再次失败则等待下一次显式 reconcile。
    pub(crate) async fn run_pending_install_transaction(&self) -> bool {
        let committed = self.run_pending_install().await;
        if committed && self.snapshot().phase == UpdatePhase::PreparingInstall {
            let _ = self.run_pending_install().await;
        }
        committed
    }

    fn finish_install_result(
        &self,
        claimed: &ClaimedInstall,
        result: Result<UpdateInstallOutcome, UpdateInstallFault>,
    ) -> bool {
        let commit = self
            .commit_gate
            .lock()
            .expect("update runtime commit gate poisoned");
        let published = self
            .state
            .lock()
            .expect("update runtime state poisoned")
            .finish_install(claimed, result);
        let committed = published.is_some();
        let should_drain = published
            .map(|snapshot| self.queue_committed_snapshot(snapshot))
            .unwrap_or(false);
        drop(commit);
        if should_drain {
            self.drain_publications();
        }
        committed
    }

    fn handle_download_event(
        &self,
        operation_id: &str,
        candidate_id: &ReleaseCandidateId,
        event: InstallerDownloadEvent,
    ) -> bool {
        let commit = self
            .commit_gate
            .lock()
            .expect("update runtime commit gate poisoned");
        let (accepted, published) = self
            .state
            .lock()
            .expect("update runtime state poisoned")
            .apply_download_event(operation_id, candidate_id, event);
        if let Some(snapshot) = published {
            let should_drain = self.queue_committed_snapshot(snapshot);
            drop(commit);
            if should_drain {
                self.drain_publications();
            }
        } else {
            drop(commit);
        }
        accepted
    }

    fn queue_committed_snapshot(&self, snapshot: UpdateSnapshot) -> bool {
        let mut queue = self
            .publication_queue
            .lock()
            .expect("update runtime publication queue poisoned");
        queue.pending.push_back(snapshot);
        if queue.draining {
            false
        } else {
            queue.draining = true;
            true
        }
    }

    fn drain_publications(&self) {
        loop {
            let next = {
                let mut queue = self
                    .publication_queue
                    .lock()
                    .expect("update runtime publication queue poisoned");
                match queue.pending.pop_front() {
                    Some(snapshot) => Some(snapshot),
                    None => {
                        queue.draining = false;
                        None
                    }
                }
            };
            let Some(snapshot) = next else {
                return;
            };
            self.sink.publish(snapshot);
        }
    }

    fn begin_active_download_shutdown(&self) -> Option<Option<CancellationToken>> {
        let commit = self
            .commit_gate
            .lock()
            .expect("update runtime commit gate poisoned");
        let (completion, published) = {
            let mut state = self.state.lock().expect("update runtime state poisoned");
            let active = state.active_download.as_mut()?;
            active.cancel_requested = true;
            active.cancellation.cancel();
            let completion = active.claimed.then(|| active.completion.clone());
            let published = if completion.is_none() {
                state.cancel_unclaimed_download_for_shutdown()
            } else {
                let changed = state.snapshot.operation.as_mut().is_some_and(|operation| {
                    let was_cancellable = operation.cancellable;
                    operation.cancellable = false;
                    was_cancellable
                });
                if changed {
                    state.snapshot.revision += 1;
                    Some(state.snapshot.clone())
                } else {
                    None
                }
            };
            (completion, published)
        };
        let should_drain = published
            .map(|snapshot| self.queue_committed_snapshot(snapshot))
            .unwrap_or(false);
        drop(commit);
        if should_drain {
            self.drain_publications();
        }
        Some(completion)
    }

    /// 最终 RunEvent::Exit 必须同步撤销网络 authority，不能依赖一个可能来不及调度的 task。
    pub(crate) fn request_active_download_shutdown(&self) -> bool {
        self.begin_active_download_shutdown().is_some()
    }

    pub(crate) async fn shutdown_active_download(&self) -> bool {
        let Some(completion) = self.begin_active_download_shutdown() else {
            return false;
        };
        if let Some(completion) = completion {
            completion.cancelled().await;
        }
        true
    }

    fn finish_interrupted_claim(&self, claimed: &ClaimedDownload) {
        let commit = self
            .commit_gate
            .lock()
            .expect("update runtime commit gate poisoned");
        let published = self
            .state
            .lock()
            .expect("update runtime state poisoned")
            .finish_interrupted_download(claimed);
        let should_drain = published
            .map(|snapshot| self.queue_committed_snapshot(snapshot))
            .unwrap_or(false);
        drop(commit);
        claimed.completion.cancel();
        if should_drain {
            self.drain_publications();
        }
    }

    fn finish_interrupted_install(&self, claimed: &ClaimedInstall) {
        let commit = self
            .commit_gate
            .lock()
            .expect("update runtime commit gate poisoned");
        let published = self
            .state
            .lock()
            .expect("update runtime state poisoned")
            .finish_interrupted_install(claimed);
        let should_drain = published
            .map(|snapshot| self.queue_committed_snapshot(snapshot))
            .unwrap_or(false);
        drop(commit);
        if should_drain {
            self.drain_publications();
        }
    }

    fn finish_interrupted_check(&self, pending: &PendingCheck) {
        let commit = self
            .commit_gate
            .lock()
            .expect("update runtime commit gate poisoned");
        let published = self
            .state
            .lock()
            .expect("update runtime state poisoned")
            .finish_interrupted_check(pending);
        let should_drain = published
            .map(|snapshot| self.queue_committed_snapshot(snapshot))
            .unwrap_or(false);
        drop(commit);
        if should_drain {
            self.drain_publications();
        }
    }

    fn finish_interrupted_cache_recovery(&self, pending: &PendingCacheRecovery) {
        let commit = self
            .commit_gate
            .lock()
            .expect("update runtime commit gate poisoned");
        let published = self
            .state
            .lock()
            .expect("update runtime state poisoned")
            .finish_interrupted_cache_recovery(pending);
        let should_drain = published
            .map(|snapshot| self.queue_committed_snapshot(snapshot))
            .unwrap_or(false);
        drop(commit);
        if should_drain {
            self.drain_publications();
        }
    }
}

struct CacheRecoveryRunLease<'a> {
    runtime: &'a UpdateRuntime,
    pending: PendingCacheRecovery,
    completed: bool,
}

impl<'a> CacheRecoveryRunLease<'a> {
    fn new(runtime: &'a UpdateRuntime, pending: PendingCacheRecovery) -> Self {
        Self {
            runtime,
            pending,
            completed: false,
        }
    }

    fn complete(&mut self) {
        self.completed = true;
    }
}

impl Drop for CacheRecoveryRunLease<'_> {
    fn drop(&mut self) {
        if !self.completed {
            self.runtime
                .finish_interrupted_cache_recovery(&self.pending);
        }
    }
}

struct CheckRunLease<'a> {
    runtime: &'a UpdateRuntime,
    pending: PendingCheck,
    completed: bool,
}

impl<'a> CheckRunLease<'a> {
    fn new(runtime: &'a UpdateRuntime, pending: PendingCheck) -> Self {
        Self {
            runtime,
            pending,
            completed: false,
        }
    }

    fn complete(&mut self) {
        self.completed = true;
    }
}

impl Drop for CheckRunLease<'_> {
    fn drop(&mut self) {
        if !self.completed {
            self.runtime.finish_interrupted_check(&self.pending);
        }
    }
}

struct DownloadRunLease<'a> {
    runtime: &'a UpdateRuntime,
    claimed: ClaimedDownload,
    completed: bool,
}

impl<'a> DownloadRunLease<'a> {
    fn new(runtime: &'a UpdateRuntime, claimed: ClaimedDownload) -> Self {
        Self {
            runtime,
            claimed,
            completed: false,
        }
    }

    fn complete(&mut self) {
        self.completed = true;
        self.claimed.completion.cancel();
    }
}

impl Drop for DownloadRunLease<'_> {
    fn drop(&mut self) {
        if !self.completed {
            self.runtime.finish_interrupted_claim(&self.claimed);
        }
    }
}

struct InstallRunLease<'a> {
    runtime: &'a UpdateRuntime,
    claimed: ClaimedInstall,
    completed: bool,
}

impl<'a> InstallRunLease<'a> {
    fn new(runtime: &'a UpdateRuntime, claimed: ClaimedInstall) -> Self {
        Self {
            runtime,
            claimed,
            completed: false,
        }
    }

    fn complete(&mut self) {
        self.completed = true;
    }
}

impl Drop for InstallRunLease<'_> {
    fn drop(&mut self) {
        if !self.completed {
            self.runtime.finish_interrupted_install(&self.claimed);
        }
    }
}

struct RuntimeDownloadObserver<'a> {
    runtime: &'a UpdateRuntime,
    operation_id: String,
    candidate_id: ReleaseCandidateId,
}

impl InstallerDownloadEvents for RuntimeDownloadObserver<'_> {
    fn emit(&self, event: InstallerDownloadEvent) -> bool {
        self.runtime
            .handle_download_event(&self.operation_id, &self.candidate_id, event)
    }
}

#[cfg(test)]
pub struct MemoryUpdateSource {
    outcomes: Mutex<VecDeque<Result<Option<NormalizedRelease>, UpdateSourceError>>>,
    check_count: std::sync::atomic::AtomicUsize,
}

#[cfg(test)]
impl MemoryUpdateSource {
    pub fn with_outcomes<I>(outcomes: I) -> Self
    where
        I: IntoIterator<Item = Result<Option<NormalizedRelease>, UpdateSourceError>>,
    {
        Self {
            outcomes: Mutex::new(outcomes.into_iter().collect()),
            check_count: std::sync::atomic::AtomicUsize::new(0),
        }
    }

    pub fn check_count(&self) -> usize {
        self.check_count.load(std::sync::atomic::Ordering::Acquire)
    }
}

#[cfg(test)]
impl UpdateSource for MemoryUpdateSource {
    fn check(
        &self,
        request: CheckRequest,
    ) -> Pin<
        Box<dyn Future<Output = Result<Option<NormalizedRelease>, UpdateSourceError>> + Send + '_>,
    > {
        self.check_count
            .fetch_add(1, std::sync::atomic::Ordering::AcqRel);
        let _current_version = request.current_version;
        let outcome = self
            .outcomes
            .lock()
            .expect("memory update source poisoned")
            .pop_front()
            .unwrap_or(Ok(None));
        Box::pin(async move { outcome })
    }
}

#[cfg(test)]
#[derive(Default)]
pub struct MemorySnapshotSink {
    snapshots: Mutex<Vec<UpdateSnapshot>>,
}

#[cfg(test)]
impl MemorySnapshotSink {
    pub fn revisions(&self) -> Vec<u64> {
        self.snapshots
            .lock()
            .expect("memory snapshot sink poisoned")
            .iter()
            .map(|snapshot| snapshot.revision)
            .collect()
    }
}

#[cfg(test)]
impl UpdateSnapshotSink for MemorySnapshotSink {
    fn publish(&self, snapshot: UpdateSnapshot) {
        self.snapshots
            .lock()
            .expect("memory snapshot sink poisoned")
            .push(snapshot);
    }
}

#[cfg(test)]
mod tests;
