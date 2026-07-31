use std::{
    collections::VecDeque,
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex},
};

use semver::Version;
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

pub(crate) mod download;
pub(crate) mod github_source;
pub(crate) mod provenance;

use download::{
    InstallerDownloadError, InstallerDownloadEvent, InstallerDownloadEvents,
    InstallerDownloadFailureStage, InstallerDownloader, VerifiedInstallerArtifact,
    VerifiedInstallerPlan, PUBLIC_PROGRESS_INTERVAL_MS,
};
use provenance::{ReleaseCandidateId, VerifiedReleaseEvidence};

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
        evidence: VerifiedReleaseEvidence,
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
                evidence,
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
                evidence.clone(),
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

#[derive(Debug, Clone)]
struct PendingCheck {
    operation_id: String,
    previous_phase: UpdatePhase,
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

#[derive(Debug)]
struct UpdateState {
    snapshot: UpdateSnapshot,
    normalized_candidate: Option<NormalizedRelease>,
    next_operation: u64,
    pending_check: Option<PendingCheck>,
    active_download: Option<ActiveDownload>,
    quarantined_candidate: Option<ReleaseCandidateId>,
    verified_artifact: Option<VerifiedInstallerArtifact>,
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
            pending_check: None,
            active_download: None,
            quarantined_candidate: None,
            verified_artifact: None,
        }
    }

    fn begin_check(&mut self) -> UpdateSnapshot {
        let operation_id = format!("check-{}", self.next_operation);
        self.next_operation += 1;
        let previous_phase = self.snapshot.phase;
        self.pending_check = Some(PendingCheck {
            operation_id: operation_id.clone(),
            previous_phase,
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
                let decision = self.candidate_refresh_decision(&release);

                match decision {
                    None | Some(CandidateRefreshDecision::Higher) => {
                        if matches!(decision, Some(CandidateRefreshDecision::Higher)) {
                            self.quarantined_candidate = None;
                        }
                        self.commit_candidate(release, UpdatePhase::Available);
                    }
                    Some(CandidateRefreshDecision::Same) => {
                        self.commit_candidate(release, pending.previous_phase);
                    }
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
        result: &Result<Option<NormalizedRelease>, UpdateSourceError>,
    ) -> Option<VerifiedInstallerArtifact> {
        let release = result.as_ref().ok()?.as_ref()?;
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
        self.snapshot.phase = pending.previous_phase;
        self.snapshot.operation = None;
        self.snapshot.fault = Some(UpdateFaultView {
            stage: UpdateFaultStage::Cache,
            code: error.code().into(),
            retryable: false,
            message: error.message().into(),
        });
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

#[derive(Default)]
struct SnapshotPublicationQueue {
    pending: VecDeque<UpdateSnapshot>,
    draining: bool,
}

pub struct UpdateRuntime {
    commit_gate: Mutex<()>,
    publication_queue: Mutex<SnapshotPublicationQueue>,
    state: Mutex<UpdateState>,
    source: Arc<dyn UpdateSource>,
    sink: Arc<dyn UpdateSnapshotSink>,
    downloader: Option<Arc<dyn InstallerDownloader>>,
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
            commit_gate: Mutex::new(()),
            publication_queue: Mutex::new(SnapshotPublicationQueue::default()),
            state: Mutex::new(UpdateState::with_phase(current_version, phase)),
            source,
            sink,
            downloader,
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

    pub fn snapshot(&self) -> UpdateSnapshot {
        self.state
            .lock()
            .expect("update runtime state poisoned")
            .snapshot
            .clone()
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

    pub fn dispatch(&self, request: UpdateDispatchRequest) -> UpdateReceipt {
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
                UpdateIntent::RemindLater { candidate_id }
                | UpdateIntent::SkipVersion { candidate_id }
                | UpdateIntent::InstallAndRestart { candidate_id } => {
                    if state
                        .normalized_candidate
                        .as_ref()
                        .map(|value| value.candidate_id.as_str())
                        != Some(candidate_id.as_str())
                    {
                        return UpdateReceipt::StaleCandidate;
                    }
                    return UpdateReceipt::InvalidOrder;
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
                    state.begin_check()
                }
            }
        };
        let should_drain = self.queue_committed_snapshot(published);
        drop(commit);
        if should_drain {
            self.drain_publications();
        }
        UpdateReceipt::Accepted
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
        let result = self.source.check(request).await;
        let commit = self
            .commit_gate
            .lock()
            .expect("update runtime commit gate poisoned");
        let published = {
            let mut state = self.state.lock().expect("update runtime state poisoned");
            match state.verified_artifact_replaced_by(&result) {
                Some(artifact) => match artifact.discard() {
                    Ok(()) => {
                        state.clear_verified_artifact(artifact.candidate_id());
                        state.finish_check(pending, result)
                    }
                    Err(error) => state.finish_check_replacement_failure(pending, error),
                },
                None => state.finish_check(pending, result),
            }
        };
        if let Some(snapshot) = published {
            let should_drain = self.queue_committed_snapshot(snapshot);
            drop(commit);
            lease.complete();
            if should_drain {
                self.drain_publications();
            }
            true
        } else {
            drop(commit);
            lease.complete();
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
        let commit = self
            .commit_gate
            .lock()
            .expect("update runtime commit gate poisoned");
        if claimed.cancellation.is_cancelled() {
            if let Ok(artifact) = &result {
                result = match artifact.discard() {
                    Ok(()) => Err(InstallerDownloadError::cancelled()),
                    Err(error) => Err(error),
                };
            }
        }
        let published = self
            .state
            .lock()
            .expect("update runtime state poisoned")
            .finish_download(&claimed, result);
        if let Some(snapshot) = published {
            let should_drain = self.queue_committed_snapshot(snapshot);
            drop(commit);
            lease.complete();
            if should_drain {
                self.drain_publications();
            }
            true
        } else {
            drop(commit);
            lease.complete();
            false
        }
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

    pub(crate) async fn shutdown_active_download(&self) -> bool {
        let commit = self
            .commit_gate
            .lock()
            .expect("update runtime commit gate poisoned");
        let (completion, published) = {
            let mut state = self.state.lock().expect("update runtime state poisoned");
            let Some(active) = state.active_download.as_mut() else {
                return false;
            };
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
