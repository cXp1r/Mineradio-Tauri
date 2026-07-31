use std::{
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex},
};

#[cfg(test)]
use std::collections::VecDeque;

use semver::Version;
use serde::{Deserialize, Serialize};

pub(crate) mod github_source;
pub(crate) mod provenance;

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

#[derive(Debug)]
struct UpdateState {
    snapshot: UpdateSnapshot,
    normalized_candidate: Option<NormalizedRelease>,
    next_operation: u64,
    pending_check: Option<PendingCheck>,
}

impl UpdateState {
    fn new(current_version: impl Into<String>) -> Self {
        Self::with_phase(current_version, UpdatePhase::Idle)
    }

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
                let decision = self.normalized_candidate.as_ref().map(|current| {
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
                });

                match decision {
                    None | Some(CandidateRefreshDecision::Higher) => {
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

pub struct UpdateRuntime {
    state: Mutex<UpdateState>,
    source: Arc<dyn UpdateSource>,
    sink: Arc<dyn UpdateSnapshotSink>,
}

impl UpdateRuntime {
    pub fn new(
        current_version: impl Into<String>,
        source: Arc<dyn UpdateSource>,
        sink: Arc<dyn UpdateSnapshotSink>,
    ) -> Self {
        Self {
            state: Mutex::new(UpdateState::new(current_version)),
            source,
            sink,
        }
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
        Self {
            state: Mutex::new(UpdateState::with_phase(
                current_version,
                UpdatePhase::Disabled,
            )),
            source,
            sink,
        }
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
        let published = {
            let mut state = self.state.lock().expect("update runtime state poisoned");
            if state.snapshot.phase == UpdatePhase::Disabled {
                return UpdateReceipt::RuntimeUnavailable;
            }
            if request.expected_revision != state.snapshot.revision {
                return UpdateReceipt::InvalidOrder;
            }
            match &request.intent {
                UpdateIntent::Download { candidate_id }
                | UpdateIntent::RemindLater { candidate_id }
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
                    return UpdateReceipt::InvalidOrder;
                }
                UpdateIntent::CheckNow => {}
            }
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
        };
        self.sink.publish(published);
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
        let request = CheckRequest {
            current_version: self.snapshot().current_version,
        };
        let result = self.source.check(request).await;
        let published = self
            .state
            .lock()
            .expect("update runtime state poisoned")
            .finish_check(pending, result);
        if let Some(snapshot) = published {
            self.sink.publish(snapshot);
            true
        } else {
            false
        }
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
