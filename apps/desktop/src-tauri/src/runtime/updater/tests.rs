use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex, Weak,
    },
};

use super::download::{
    InstallerDownloadError, InstallerDownloadEvent, InstallerDownloadEvents, InstallerDownloader,
    VerifiedInstallerArtifact, VerifiedInstallerPlan,
};
use super::*;
use tokio_util::sync::CancellationToken;

const RAW_PROVENANCE: &[u8] = include_bytes!("fixtures/provenance-v2.json");
const CONTRACT_JSON: &str = include_str!("fixtures/provenance-v2-contract.json");

fn verified_fixture_release(notes: &[&str]) -> NormalizedRelease {
    let contract: serde_json::Value =
        serde_json::from_str(CONTRACT_JSON).expect("共享 provenance contract 应有效");
    let public_key = contract["encoded_public_key"]
        .as_str()
        .expect("contract 应包含测试公钥");
    let provenance_signature = contract["provenance_signature"]
        .as_str()
        .expect("contract 应包含 provenance 签名");
    let installer_signature = contract["installer_signature"]
        .as_str()
        .expect("contract 应包含安装包签名");
    let verifier =
        provenance::ProvenanceVerifier::from_tauri_pubkey(public_key).expect("fixture 公钥应有效");
    let evidence = verifier
        .verify(provenance::ProvenanceVerificationInput {
            raw_provenance: RAW_PROVENANCE,
            provenance_signature,
            installer_signature,
            expected_repository: "zzstar101/Mineradio-Tauri",
            expected_tag: "v1.2.3",
            expected_version: "1.2.3",
            expected_commit_sha: "0123456789abcdef0123456789abcdef01234567",
            expected_target: "windows-x86_64-nsis",
        })
        .expect("fixture provenance 应有效");
    NormalizedRelease::from_verified(evidence, notes.iter().copied(), None)
}

#[test]
fn accepted_check_commits_checking_then_available() {
    tauri::async_runtime::block_on(async {
        let source = Arc::new(MemoryUpdateSource::with_outcomes([Ok(Some(
            NormalizedRelease::new(
                "candidate-0.2.0",
                "0.2.0",
                ["修复播放链路"],
                Some("2026-07-31T00:00:00Z"),
            ),
        ))]));
        let published = Arc::new(MemorySnapshotSink::default());
        let runtime = UpdateRuntime::new("0.1.0", source.clone(), published.clone());

        let receipt = runtime.dispatch(UpdateDispatchRequest {
            expected_revision: 0,
            intent: UpdateIntent::CheckNow,
        });

        assert_eq!(receipt, UpdateReceipt::Accepted);
        assert_eq!(runtime.snapshot().phase, UpdatePhase::Checking);
        assert_eq!(runtime.snapshot().revision, 1);
        assert_eq!(source.check_count(), 0);

        assert!(runtime.run_pending_check().await);

        let snapshot = runtime.snapshot();
        assert_eq!(snapshot.phase, UpdatePhase::Available);
        assert_eq!(snapshot.revision, 2);
        assert_eq!(
            snapshot.candidate.as_ref().map(|value| value.id.as_str()),
            Some("candidate-0.2.0")
        );
        assert_eq!(source.check_count(), 1);
        assert_eq!(published.revisions(), vec![1, 2]);
    });
}

#[test]
fn candidate_intent_rejects_an_identity_not_owned_by_the_snapshot() {
    tauri::async_runtime::block_on(async {
        let source = Arc::new(MemoryUpdateSource::with_outcomes([Ok(Some(
            NormalizedRelease::new("candidate-0.2.0", "0.2.0", std::iter::empty::<&str>(), None),
        ))]));
        let runtime = UpdateRuntime::with_noop_sink("0.1.0", source);
        assert_eq!(
            runtime.dispatch(UpdateDispatchRequest {
                expected_revision: 0,
                intent: UpdateIntent::CheckNow,
            }),
            UpdateReceipt::Accepted
        );
        assert!(runtime.run_pending_check().await);

        assert_eq!(
            runtime.dispatch(UpdateDispatchRequest {
                expected_revision: 2,
                intent: UpdateIntent::Download {
                    candidate_id: "stale-candidate".into(),
                },
            }),
            UpdateReceipt::StaleCandidate
        );
        assert_eq!(runtime.snapshot().revision, 2);
    });
}

#[test]
fn intent_contract_uses_the_web_port_field_names() {
    let json = serde_json::to_value(UpdateIntent::Download {
        candidate_id: "candidate-0.2.0".into(),
    })
    .expect("serialize update intent");

    assert_eq!(
        json,
        serde_json::json!({
            "kind": "download",
            "candidateId": "candidate-0.2.0",
        })
    );
}

#[test]
fn disabled_runtime_rejects_every_intent_without_publishing() {
    let source = Arc::new(MemoryUpdateSource::with_outcomes([Ok(None)]));
    let published = Arc::new(MemorySnapshotSink::default());
    let runtime = UpdateRuntime::disabled("0.1.0", source.clone(), published.clone());

    assert_eq!(
        runtime.dispatch(UpdateDispatchRequest {
            expected_revision: 0,
            intent: UpdateIntent::CheckNow,
        }),
        UpdateReceipt::RuntimeUnavailable
    );
    assert_eq!(runtime.snapshot().phase, UpdatePhase::Disabled);
    assert_eq!(runtime.snapshot().revision, 0);
    assert_eq!(source.check_count(), 0);
    assert!(published.revisions().is_empty());
}

#[test]
fn check_is_single_flight_and_does_not_start_a_second_source_call() {
    tauri::async_runtime::block_on(async {
        let source = Arc::new(MemoryUpdateSource::with_outcomes([Ok(None)]));
        let runtime = UpdateRuntime::with_noop_sink("0.1.0", source.clone());

        assert_eq!(
            runtime.dispatch(UpdateDispatchRequest {
                expected_revision: 0,
                intent: UpdateIntent::CheckNow,
            }),
            UpdateReceipt::Accepted
        );
        assert_eq!(
            runtime.dispatch(UpdateDispatchRequest {
                expected_revision: 1,
                intent: UpdateIntent::CheckNow,
            }),
            UpdateReceipt::InvalidOrder
        );
        assert_eq!(source.check_count(), 0);

        assert!(runtime.run_pending_check().await);
        assert_eq!(source.check_count(), 1);
        assert_eq!(runtime.snapshot().phase, UpdatePhase::Current);
    });
}

#[test]
fn operation_intent_rejects_an_identity_not_owned_by_the_snapshot() {
    let runtime = UpdateRuntime::with_noop_sink(
        "0.1.0",
        Arc::new(MemoryUpdateSource::with_outcomes([Ok(None)])),
    );

    assert_eq!(
        runtime.dispatch(UpdateDispatchRequest {
            expected_revision: 0,
            intent: UpdateIntent::CancelDownload {
                operation_id: "stale-operation".into(),
            },
        }),
        UpdateReceipt::StaleOperation
    );
    assert_eq!(runtime.snapshot().revision, 0);
}

#[test]
fn trusted_candidate_is_retained_for_fixed_release_page_projection() {
    tauri::async_runtime::block_on(async {
        let source = Arc::new(MemoryUpdateSource::with_outcomes([Ok(Some(
            verified_fixture_release(&[]),
        ))]));
        let runtime = UpdateRuntime::with_noop_sink("0.1.0", source);
        assert_eq!(
            runtime.dispatch(UpdateDispatchRequest {
                expected_revision: 0,
                intent: UpdateIntent::CheckNow,
            }),
            UpdateReceipt::Accepted
        );
        assert!(runtime.run_pending_check().await);

        assert_eq!(
            runtime.release_page_url(Some(
                "1f524da9660c738e349f342d1e3f0bc9da3b28b9c4842636475ccdde59b9ee0e",
            )),
            Some("https://github.com/zzstar101/Mineradio-Tauri/releases/tag/v1.2.3".into())
        );
        assert_eq!(runtime.release_page_url(Some("stale-candidate")), None);
        assert_eq!(
            runtime.release_page_url(None),
            Some("https://github.com/zzstar101/Mineradio-Tauri/releases".into())
        );
        assert_eq!(
            runtime.dispatch(UpdateDispatchRequest {
                expected_revision: 2,
                intent: UpdateIntent::OpenRelease {
                    candidate_id:
                        "1f524da9660c738e349f342d1e3f0bc9da3b28b9c4842636475ccdde59b9ee0e".into(),
                },
            }),
            UpdateReceipt::Accepted
        );
    });
}

#[test]
fn source_failure_projects_a_typed_fault_without_losing_runtime_authority() {
    tauri::async_runtime::block_on(async {
        let source = Arc::new(MemoryUpdateSource::with_outcomes([Err(
            UpdateSourceError {
                code: "UPDATE_MANIFEST_REJECTED".into(),
                retryable: false,
                message: "manifest target mismatch".into(),
            },
        )]));
        let runtime = UpdateRuntime::with_noop_sink("0.1.0", source);
        assert_eq!(
            runtime.dispatch(UpdateDispatchRequest {
                expected_revision: 0,
                intent: UpdateIntent::CheckNow,
            }),
            UpdateReceipt::Accepted
        );
        assert!(runtime.run_pending_check().await);

        let snapshot = runtime.snapshot();
        assert_eq!(snapshot.phase, UpdatePhase::Idle);
        assert_eq!(snapshot.revision, 2);
        assert_eq!(
            snapshot.fault,
            Some(UpdateFaultView {
                stage: UpdateFaultStage::Check,
                code: "UPDATE_MANIFEST_REJECTED".into(),
                retryable: false,
                message: "manifest target mismatch".into(),
            })
        );
    });
}

#[test]
fn recheck_none_or_same_candidate_preserves_available_authority() {
    tauri::async_runtime::block_on(async {
        let source = Arc::new(MemoryUpdateSource::with_outcomes([
            Ok(Some(NormalizedRelease::new(
                "candidate-0.2.0",
                "0.2.0",
                ["初次说明"],
                None,
            ))),
            Ok(None),
            Ok(Some(NormalizedRelease::new(
                "candidate-0.2.0",
                "0.2.0",
                ["刷新说明"],
                None,
            ))),
        ]));
        let runtime = UpdateRuntime::with_noop_sink("0.1.0", source);

        for expected_revision in [0, 2, 4] {
            assert_eq!(
                runtime.dispatch(UpdateDispatchRequest {
                    expected_revision,
                    intent: UpdateIntent::CheckNow,
                }),
                UpdateReceipt::Accepted
            );
            assert!(runtime.run_pending_check().await);
            assert_eq!(runtime.snapshot().phase, UpdatePhase::Available);
            assert_eq!(
                runtime
                    .snapshot()
                    .candidate
                    .as_ref()
                    .map(|value| value.id.as_str()),
                Some("candidate-0.2.0")
            );
        }
        assert_eq!(
            runtime.snapshot().candidate.unwrap().notes,
            vec!["刷新说明"]
        );
    });
}

#[test]
fn higher_candidate_replaces_but_rollback_or_same_version_conflict_fail_closed() {
    tauri::async_runtime::block_on(async {
        let source = Arc::new(MemoryUpdateSource::with_outcomes([
            Ok(Some(NormalizedRelease::new(
                "candidate-0.2.0",
                "0.2.0",
                std::iter::empty::<&str>(),
                None,
            ))),
            Ok(Some(NormalizedRelease::new(
                "candidate-0.3.0",
                "0.3.0",
                std::iter::empty::<&str>(),
                None,
            ))),
            Ok(Some(NormalizedRelease::new(
                "conflicting-0.3.0",
                "0.3.0",
                std::iter::empty::<&str>(),
                None,
            ))),
            Ok(Some(NormalizedRelease::new(
                "candidate-0.2.5",
                "0.2.5",
                std::iter::empty::<&str>(),
                None,
            ))),
        ]));
        let runtime = UpdateRuntime::with_noop_sink("0.1.0", source);

        for expected_revision in [0, 2] {
            assert_eq!(
                runtime.dispatch(UpdateDispatchRequest {
                    expected_revision,
                    intent: UpdateIntent::CheckNow,
                }),
                UpdateReceipt::Accepted
            );
            assert!(runtime.run_pending_check().await);
        }
        assert_eq!(
            runtime
                .snapshot()
                .candidate
                .as_ref()
                .map(|value| value.id.as_str()),
            Some("candidate-0.3.0")
        );

        for (expected_revision, fault_code) in [
            (4, "UPDATE_CANDIDATE_IDENTITY_CONFLICT"),
            (6, "UPDATE_CANDIDATE_ROLLBACK_REJECTED"),
        ] {
            assert_eq!(
                runtime.dispatch(UpdateDispatchRequest {
                    expected_revision,
                    intent: UpdateIntent::CheckNow,
                }),
                UpdateReceipt::Accepted
            );
            assert!(runtime.run_pending_check().await);
            let snapshot = runtime.snapshot();
            assert_eq!(snapshot.phase, UpdatePhase::Available);
            assert_eq!(
                snapshot.candidate.as_ref().map(|value| value.id.as_str()),
                Some("candidate-0.3.0")
            );
            assert_eq!(
                snapshot.fault.as_ref().map(|fault| fault.code.as_str()),
                Some(fault_code)
            );
        }
    });
}

#[test]
fn candidate_identity_cannot_be_reused_for_a_different_version() {
    tauri::async_runtime::block_on(async {
        let source = Arc::new(MemoryUpdateSource::with_outcomes([
            Ok(Some(NormalizedRelease::new(
                "candidate-reused",
                "0.2.0",
                std::iter::empty::<&str>(),
                None,
            ))),
            Ok(Some(NormalizedRelease::new(
                "candidate-reused",
                "0.3.0",
                std::iter::empty::<&str>(),
                None,
            ))),
        ]));
        let runtime = UpdateRuntime::with_noop_sink("0.1.0", source);

        for expected_revision in [0, 2] {
            assert_eq!(
                runtime.dispatch(UpdateDispatchRequest {
                    expected_revision,
                    intent: UpdateIntent::CheckNow,
                }),
                UpdateReceipt::Accepted
            );
            assert!(runtime.run_pending_check().await);
        }

        let snapshot = runtime.snapshot();
        assert_eq!(snapshot.phase, UpdatePhase::Available);
        assert_eq!(
            snapshot
                .candidate
                .as_ref()
                .map(|candidate| (candidate.id.as_str(), candidate.version.as_str())),
            Some(("candidate-reused", "0.2.0"))
        );
        assert_eq!(
            snapshot.fault.as_ref().map(|fault| fault.code.as_str()),
            Some("UPDATE_CANDIDATE_IDENTITY_CONFLICT")
        );
    });
}

#[test]
fn recheck_matrix_preserves_available_and_ready_to_install_authority() {
    #[derive(Debug, Clone, Copy)]
    enum RefreshCase {
        None,
        Same,
        Higher,
        SameVersionConflict,
        Lower,
        Error,
    }

    tauri::async_runtime::block_on(async {
        for phase in [UpdatePhase::Available, UpdatePhase::ReadyToInstall] {
            for case in [
                RefreshCase::None,
                RefreshCase::Same,
                RefreshCase::Higher,
                RefreshCase::SameVersionConflict,
                RefreshCase::Lower,
                RefreshCase::Error,
            ] {
                let outcome = match case {
                    RefreshCase::None => Ok(None),
                    RefreshCase::Same => Ok(Some(NormalizedRelease::new(
                        "candidate-0.3.0",
                        "0.3.0",
                        ["刷新说明"],
                        None,
                    ))),
                    RefreshCase::Higher => Ok(Some(NormalizedRelease::new(
                        "candidate-0.4.0",
                        "0.4.0",
                        ["更高版本"],
                        None,
                    ))),
                    RefreshCase::SameVersionConflict => Ok(Some(NormalizedRelease::new(
                        "conflicting-0.3.0",
                        "0.3.0",
                        std::iter::empty::<&str>(),
                        None,
                    ))),
                    RefreshCase::Lower => Ok(Some(NormalizedRelease::new(
                        "candidate-0.2.0",
                        "0.2.0",
                        std::iter::empty::<&str>(),
                        None,
                    ))),
                    RefreshCase::Error => Err(UpdateSourceError {
                        code: "UPDATE_SOURCE_OFFLINE".into(),
                        retryable: true,
                        message: "更新源暂时不可用".into(),
                    }),
                };
                let runtime = UpdateRuntime::with_noop_sink(
                    "0.1.0",
                    Arc::new(MemoryUpdateSource::with_outcomes([outcome])),
                );
                runtime
                    .state
                    .lock()
                    .expect("update runtime state poisoned")
                    .commit_candidate(
                        NormalizedRelease::new("candidate-0.3.0", "0.3.0", ["原始说明"], None),
                        phase,
                    );

                assert_eq!(
                    runtime.dispatch(UpdateDispatchRequest {
                        expected_revision: 0,
                        intent: UpdateIntent::CheckNow,
                    }),
                    UpdateReceipt::Accepted,
                    "phase={phase:?}, case={case:?}"
                );
                assert!(runtime.run_pending_check().await);

                let snapshot = runtime.snapshot();
                let (expected_phase, expected_id, expected_fault) = match case {
                    RefreshCase::None | RefreshCase::Same => (phase, "candidate-0.3.0", None),
                    RefreshCase::Higher => (UpdatePhase::Available, "candidate-0.4.0", None),
                    RefreshCase::SameVersionConflict => (
                        phase,
                        "candidate-0.3.0",
                        Some("UPDATE_CANDIDATE_IDENTITY_CONFLICT"),
                    ),
                    RefreshCase::Lower => (
                        phase,
                        "candidate-0.3.0",
                        Some("UPDATE_CANDIDATE_ROLLBACK_REJECTED"),
                    ),
                    RefreshCase::Error => (phase, "candidate-0.3.0", Some("UPDATE_SOURCE_OFFLINE")),
                };
                assert_eq!(snapshot.phase, expected_phase, "case={case:?}");
                assert_eq!(
                    snapshot
                        .candidate
                        .as_ref()
                        .map(|candidate| candidate.id.as_str()),
                    Some(expected_id),
                    "phase={phase:?}, case={case:?}"
                );
                assert_eq!(
                    snapshot.fault.as_ref().map(|fault| fault.code.as_str()),
                    expected_fault,
                    "phase={phase:?}, case={case:?}"
                );
                if matches!(case, RefreshCase::Same) {
                    assert_eq!(
                        snapshot.candidate.expect("same candidate 应保留").notes,
                        vec!["刷新说明"]
                    );
                }
            }
        }
    });
}

enum ScriptedDownloadOutcome {
    Success,
    SuccessAt {
        path: PathBuf,
        before_return: Option<Arc<tokio::sync::Notify>>,
    },
    AuthenticityFailure,
    WaitForCancellation,
    CancelledAfterRelease {
        cancel_observed: Arc<tokio::sync::Notify>,
        release: Arc<tokio::sync::Notify>,
    },
    NetworkFailureAfterCancellation,
    NeverCompletes,
    SuccessAfterCancellation {
        cancel_observed: Arc<tokio::sync::Notify>,
        release: Arc<tokio::sync::Notify>,
    },
    AuthenticityAfterRelease(Arc<tokio::sync::Notify>),
}

struct RuntimeTestDirectory(PathBuf);

impl RuntimeTestDirectory {
    fn new() -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(1);
        let path = std::env::temp_dir().join(format!(
            "mineradio-updater-runtime-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&path).expect("runtime 测试目录应能创建");
        Self(path)
    }

    fn join(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
}

impl Drop for RuntimeTestDirectory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

struct PendingUpdateSource {
    entered: Arc<tokio::sync::Notify>,
}

impl UpdateSource for PendingUpdateSource {
    fn check(
        &self,
        _request: CheckRequest,
    ) -> Pin<
        Box<dyn Future<Output = Result<Option<NormalizedRelease>, UpdateSourceError>> + Send + '_>,
    > {
        Box::pin(async move {
            self.entered.notify_one();
            std::future::pending().await
        })
    }
}

struct ReentrantSnapshotSink {
    runtime: Mutex<Option<Weak<UpdateRuntime>>>,
    revisions: Mutex<Vec<u64>>,
    reentered: AtomicBool,
    receipt: Mutex<Option<UpdateReceipt>>,
}

impl ReentrantSnapshotSink {
    fn new() -> Self {
        Self {
            runtime: Mutex::new(None),
            revisions: Mutex::new(Vec::new()),
            reentered: AtomicBool::new(false),
            receipt: Mutex::new(None),
        }
    }

    fn attach(&self, runtime: &Arc<UpdateRuntime>) {
        *self.runtime.lock().expect("reentrant runtime poisoned") = Some(Arc::downgrade(runtime));
    }

    fn revisions(&self) -> Vec<u64> {
        self.revisions
            .lock()
            .expect("reentrant revisions poisoned")
            .clone()
    }
}

impl UpdateSnapshotSink for ReentrantSnapshotSink {
    fn publish(&self, snapshot: UpdateSnapshot) {
        self.revisions
            .lock()
            .expect("reentrant revisions poisoned")
            .push(snapshot.revision);
        if snapshot.phase != UpdatePhase::Available || self.reentered.swap(true, Ordering::AcqRel) {
            return;
        }
        let Some(candidate_id) = snapshot.candidate.map(|candidate| candidate.id) else {
            return;
        };
        let runtime = self
            .runtime
            .lock()
            .expect("reentrant runtime poisoned")
            .as_ref()
            .and_then(Weak::upgrade);
        let Some(runtime) = runtime else {
            return;
        };
        let receipt = runtime.dispatch(UpdateDispatchRequest {
            expected_revision: snapshot.revision,
            intent: UpdateIntent::Download { candidate_id },
        });
        *self.receipt.lock().expect("reentrant receipt poisoned") = Some(receipt);
    }
}

struct ScriptedDownloader {
    events: Vec<InstallerDownloadEvent>,
    outcome: ScriptedDownloadOutcome,
    events_emitted: Option<Arc<tokio::sync::Notify>>,
}

impl InstallerDownloader for ScriptedDownloader {
    fn run<'a>(
        &'a self,
        plan: VerifiedInstallerPlan,
        cancellation: CancellationToken,
        events: &'a dyn InstallerDownloadEvents,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<VerifiedInstallerArtifact, InstallerDownloadError>>
                + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            for event in self.events.iter().cloned() {
                if !events.emit(event) {
                    return Err(InstallerDownloadError::stale());
                }
            }
            if let Some(events_emitted) = &self.events_emitted {
                events_emitted.notify_one();
            }
            match &self.outcome {
                ScriptedDownloadOutcome::Success => {
                    Ok(VerifiedInstallerArtifact::fake(plan.candidate_id().clone()))
                }
                ScriptedDownloadOutcome::SuccessAt {
                    path,
                    before_return,
                } => {
                    if let Some(before_return) = before_return {
                        before_return.notify_one();
                    }
                    Ok(VerifiedInstallerArtifact::fake_at(
                        plan.candidate_id().clone(),
                        path.clone(),
                    ))
                }
                ScriptedDownloadOutcome::AuthenticityFailure => {
                    Err(InstallerDownloadError::fake_authenticity_failure())
                }
                ScriptedDownloadOutcome::WaitForCancellation => {
                    cancellation.cancelled().await;
                    Err(InstallerDownloadError::cancelled())
                }
                ScriptedDownloadOutcome::CancelledAfterRelease {
                    cancel_observed,
                    release,
                } => {
                    cancellation.cancelled().await;
                    cancel_observed.notify_one();
                    release.notified().await;
                    Err(InstallerDownloadError::cancelled())
                }
                ScriptedDownloadOutcome::NetworkFailureAfterCancellation => {
                    cancellation.cancelled().await;
                    Err(InstallerDownloadError::fake_network_failure())
                }
                ScriptedDownloadOutcome::NeverCompletes => std::future::pending().await,
                ScriptedDownloadOutcome::SuccessAfterCancellation {
                    cancel_observed,
                    release,
                } => {
                    cancellation.cancelled().await;
                    cancel_observed.notify_one();
                    release.notified().await;
                    Ok(VerifiedInstallerArtifact::fake(plan.candidate_id().clone()))
                }
                ScriptedDownloadOutcome::AuthenticityAfterRelease(release) => {
                    release.notified().await;
                    Err(InstallerDownloadError::fake_authenticity_failure())
                }
            }
        })
    }
}

async fn runtime_with_verified_candidate(
    downloader: Arc<dyn InstallerDownloader>,
    sink: Arc<MemorySnapshotSink>,
) -> UpdateRuntime {
    let source = Arc::new(MemoryUpdateSource::with_outcomes([Ok(Some(
        verified_fixture_release(&[]),
    ))]));
    let runtime = UpdateRuntime::with_downloader("0.1.0", source, sink, downloader);
    assert_eq!(
        runtime.dispatch(UpdateDispatchRequest {
            expected_revision: 0,
            intent: UpdateIntent::CheckNow,
        }),
        UpdateReceipt::Accepted
    );
    assert!(runtime.run_pending_check().await);
    runtime
}

#[test]
fn interrupted_check_runner_restores_a_stable_phase_and_releases_operation_authority() {
    tauri::async_runtime::block_on(async {
        let entered = Arc::new(tokio::sync::Notify::new());
        let source = Arc::new(PendingUpdateSource {
            entered: entered.clone(),
        });
        let sink = Arc::new(MemorySnapshotSink::default());
        let runtime = Arc::new(UpdateRuntime::new("0.1.0", source, sink.clone()));
        assert_eq!(
            runtime.dispatch(UpdateDispatchRequest {
                expected_revision: 0,
                intent: UpdateIntent::CheckNow,
            }),
            UpdateReceipt::Accepted
        );
        let task_runtime = runtime.clone();
        let task =
            tauri::async_runtime::spawn(async move { task_runtime.run_pending_check().await });
        entered.notified().await;

        task.abort();
        let _ = task.await;

        let snapshot = runtime.snapshot();
        assert_eq!(snapshot.phase, UpdatePhase::Idle);
        assert!(snapshot.operation.is_none());
        assert_eq!(
            snapshot.fault.as_ref().map(|fault| fault.code.as_str()),
            Some("UPDATE_CHECK_INTERRUPTED")
        );
        assert_eq!(sink.revisions(), vec![1, 2]);
    });
}

#[test]
fn snapshot_sink_can_reenter_dispatch_without_deadlock_or_revision_reordering() {
    tauri::async_runtime::block_on(async {
        let source = Arc::new(MemoryUpdateSource::with_outcomes([Ok(Some(
            verified_fixture_release(&[]),
        ))]));
        let sink = Arc::new(ReentrantSnapshotSink::new());
        let downloader = Arc::new(ScriptedDownloader {
            events: Vec::new(),
            outcome: ScriptedDownloadOutcome::Success,
            events_emitted: None,
        });
        let runtime = Arc::new(UpdateRuntime::with_downloader(
            "0.1.0",
            source,
            sink.clone(),
            downloader,
        ));
        sink.attach(&runtime);
        assert_eq!(
            runtime.dispatch(UpdateDispatchRequest {
                expected_revision: 0,
                intent: UpdateIntent::CheckNow,
            }),
            UpdateReceipt::Accepted
        );

        assert!(runtime.run_pending_check().await);
        assert_eq!(runtime.snapshot().phase, UpdatePhase::Downloading);
        assert_eq!(sink.revisions(), vec![1, 2, 3]);
        assert_eq!(
            *sink.receipt.lock().expect("reentrant receipt poisoned"),
            Some(UpdateReceipt::Accepted)
        );
    });
}

#[test]
fn trusted_download_commits_throttled_progress_and_ready_edges_in_revision_order() {
    tauri::async_runtime::block_on(async {
        let sink = Arc::new(MemorySnapshotSink::default());
        let downloader = Arc::new(ScriptedDownloader {
            events: vec![
                InstallerDownloadEvent::Opened {
                    total_bytes: Some(9),
                    elapsed_ms: 0,
                },
                InstallerDownloadEvent::Progress {
                    received_bytes: 1,
                    total_bytes: Some(9),
                    elapsed_ms: 10,
                },
                InstallerDownloadEvent::Progress {
                    received_bytes: 4,
                    total_bytes: Some(9),
                    elapsed_ms: 99,
                },
                InstallerDownloadEvent::Progress {
                    received_bytes: 5,
                    total_bytes: Some(9),
                    elapsed_ms: 100,
                },
                InstallerDownloadEvent::Progress {
                    received_bytes: 8,
                    total_bytes: Some(9),
                    elapsed_ms: 199,
                },
                InstallerDownloadEvent::Progress {
                    received_bytes: 9,
                    total_bytes: Some(9),
                    elapsed_ms: 200,
                },
                InstallerDownloadEvent::Verifying {
                    received_bytes: 9,
                    total_bytes: Some(9),
                },
            ],
            outcome: ScriptedDownloadOutcome::Success,
            events_emitted: None,
        });
        let runtime = runtime_with_verified_candidate(downloader, sink.clone()).await;
        let candidate_id = runtime.snapshot().candidate.unwrap().id;

        assert_eq!(
            runtime.dispatch(UpdateDispatchRequest {
                expected_revision: 2,
                intent: UpdateIntent::Download { candidate_id },
            }),
            UpdateReceipt::Accepted
        );
        assert_eq!(runtime.snapshot().phase, UpdatePhase::Downloading);
        assert!(runtime.run_pending_download().await);

        let snapshot = runtime.snapshot();
        assert_eq!(snapshot.phase, UpdatePhase::ReadyToInstall);
        assert!(snapshot.operation.is_none());
        assert!(snapshot.fault.is_none());
        assert_eq!(sink.revisions(), (1..=7).collect::<Vec<_>>());
    });
}

#[test]
fn retry_open_and_progress_events_share_one_global_ten_hertz_gate() {
    tauri::async_runtime::block_on(async {
        let sink = Arc::new(MemorySnapshotSink::default());
        let downloader = Arc::new(ScriptedDownloader {
            events: vec![
                InstallerDownloadEvent::Opened {
                    total_bytes: Some(9),
                    elapsed_ms: 0,
                },
                InstallerDownloadEvent::Progress {
                    received_bytes: 3,
                    total_bytes: Some(9),
                    elapsed_ms: 100,
                },
                InstallerDownloadEvent::Retrying {
                    attempt: 2,
                    elapsed_ms: 100,
                },
                InstallerDownloadEvent::Opened {
                    total_bytes: Some(9),
                    elapsed_ms: 100,
                },
                InstallerDownloadEvent::Progress {
                    received_bytes: 8,
                    total_bytes: Some(9),
                    elapsed_ms: 199,
                },
                InstallerDownloadEvent::Progress {
                    received_bytes: 9,
                    total_bytes: Some(9),
                    elapsed_ms: 200,
                },
                InstallerDownloadEvent::Verifying {
                    received_bytes: 9,
                    total_bytes: Some(9),
                },
            ],
            outcome: ScriptedDownloadOutcome::Success,
            events_emitted: None,
        });
        let runtime = runtime_with_verified_candidate(downloader, sink.clone()).await;
        let candidate_id = runtime.snapshot().candidate.unwrap().id;
        assert_eq!(
            runtime.dispatch(UpdateDispatchRequest {
                expected_revision: 2,
                intent: UpdateIntent::Download { candidate_id },
            }),
            UpdateReceipt::Accepted
        );

        assert!(runtime.run_pending_download().await);
        assert_eq!(runtime.snapshot().phase, UpdatePhase::ReadyToInstall);
        assert_eq!(sink.revisions(), (1..=7).collect::<Vec<_>>());
    });
}

#[test]
fn exact_cancel_disables_cancellation_immediately_then_returns_to_available_after_cleanup() {
    tauri::async_runtime::block_on(async {
        let sink = Arc::new(MemorySnapshotSink::default());
        let events_emitted = Arc::new(tokio::sync::Notify::new());
        let cancel_observed = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        let downloader = Arc::new(ScriptedDownloader {
            events: vec![InstallerDownloadEvent::Opened {
                total_bytes: Some(9),
                elapsed_ms: 0,
            }],
            outcome: ScriptedDownloadOutcome::CancelledAfterRelease {
                cancel_observed: cancel_observed.clone(),
                release: release.clone(),
            },
            events_emitted: Some(events_emitted.clone()),
        });
        let runtime = Arc::new(runtime_with_verified_candidate(downloader, sink.clone()).await);
        let candidate_id = runtime.snapshot().candidate.unwrap().id;
        assert_eq!(
            runtime.dispatch(UpdateDispatchRequest {
                expected_revision: 2,
                intent: UpdateIntent::Download { candidate_id },
            }),
            UpdateReceipt::Accepted
        );
        let task_runtime = runtime.clone();
        let task =
            tauri::async_runtime::spawn(async move { task_runtime.run_pending_download().await });
        events_emitted.notified().await;
        let before_cancel = runtime.snapshot();
        let operation_id = before_cancel.operation.unwrap().id;

        assert_eq!(
            runtime.dispatch(UpdateDispatchRequest {
                expected_revision: before_cancel.revision,
                intent: UpdateIntent::CancelDownload {
                    operation_id: operation_id.clone(),
                },
            }),
            UpdateReceipt::Accepted
        );
        cancel_observed.notified().await;
        assert!(!runtime.snapshot().operation.unwrap().cancellable);
        release.notify_one();
        assert!(task.await.unwrap());
        assert_eq!(runtime.snapshot().phase, UpdatePhase::Available);
        assert!(
            runtime.snapshot().fault.is_none(),
            "取消不应产生 fault: {:?}",
            runtime.snapshot().fault
        );
        assert_eq!(
            runtime.dispatch(UpdateDispatchRequest {
                expected_revision: runtime.snapshot().revision,
                intent: UpdateIntent::CancelDownload { operation_id },
            }),
            UpdateReceipt::StaleOperation
        );
        let revisions = sink.revisions();
        assert!(revisions.windows(2).all(|pair| pair[1] == pair[0] + 1));
    });
}

#[test]
fn accepted_cancel_is_not_overwritten_by_a_racing_transport_failure() {
    tauri::async_runtime::block_on(async {
        let sink = Arc::new(MemorySnapshotSink::default());
        let entered = Arc::new(tokio::sync::Notify::new());
        let downloader = Arc::new(ScriptedDownloader {
            events: Vec::new(),
            outcome: ScriptedDownloadOutcome::NetworkFailureAfterCancellation,
            events_emitted: Some(entered.clone()),
        });
        let runtime = Arc::new(runtime_with_verified_candidate(downloader, sink).await);
        let candidate_id = runtime.snapshot().candidate.unwrap().id;
        assert_eq!(
            runtime.dispatch(UpdateDispatchRequest {
                expected_revision: 2,
                intent: UpdateIntent::Download { candidate_id },
            }),
            UpdateReceipt::Accepted
        );
        let task_runtime = runtime.clone();
        let task =
            tauri::async_runtime::spawn(async move { task_runtime.run_pending_download().await });
        entered.notified().await;
        let downloading = runtime.snapshot();
        assert_eq!(
            runtime.dispatch(UpdateDispatchRequest {
                expected_revision: downloading.revision,
                intent: UpdateIntent::CancelDownload {
                    operation_id: downloading.operation.unwrap().id,
                },
            }),
            UpdateReceipt::Accepted
        );

        assert!(task.await.unwrap());
        assert_eq!(runtime.snapshot().phase, UpdatePhase::Available);
        assert!(runtime.snapshot().fault.is_none());
    });
}

#[test]
fn cancellation_wins_an_opened_event_race_without_projecting_a_stale_fault() {
    tauri::async_runtime::block_on(async {
        let sink = Arc::new(MemorySnapshotSink::default());
        let downloader = Arc::new(ScriptedDownloader {
            events: vec![InstallerDownloadEvent::Opened {
                total_bytes: Some(9),
                elapsed_ms: 0,
            }],
            outcome: ScriptedDownloadOutcome::WaitForCancellation,
            events_emitted: None,
        });
        let runtime = runtime_with_verified_candidate(downloader, sink.clone()).await;
        let candidate_id = runtime.snapshot().candidate.unwrap().id;
        assert_eq!(
            runtime.dispatch(UpdateDispatchRequest {
                expected_revision: 2,
                intent: UpdateIntent::Download { candidate_id },
            }),
            UpdateReceipt::Accepted
        );
        let downloading = runtime.snapshot();
        let operation_id = downloading.operation.unwrap().id;
        assert_eq!(
            runtime.dispatch(UpdateDispatchRequest {
                expected_revision: downloading.revision,
                intent: UpdateIntent::CancelDownload { operation_id },
            }),
            UpdateReceipt::Accepted
        );

        assert!(runtime.run_pending_download().await);
        assert_eq!(runtime.snapshot().phase, UpdatePhase::Available);
        assert!(runtime.snapshot().fault.is_none());
        assert_eq!(sink.revisions(), (1..=5).collect::<Vec<_>>());
    });
}

#[test]
fn dropped_download_runner_releases_the_claim_and_projects_an_interruption_fault() {
    tauri::async_runtime::block_on(async {
        let sink = Arc::new(MemorySnapshotSink::default());
        let entered = Arc::new(tokio::sync::Notify::new());
        let downloader = Arc::new(ScriptedDownloader {
            events: Vec::new(),
            outcome: ScriptedDownloadOutcome::NeverCompletes,
            events_emitted: Some(entered.clone()),
        });
        let runtime = Arc::new(runtime_with_verified_candidate(downloader, sink).await);
        let candidate_id = runtime.snapshot().candidate.unwrap().id;
        assert_eq!(
            runtime.dispatch(UpdateDispatchRequest {
                expected_revision: 2,
                intent: UpdateIntent::Download { candidate_id },
            }),
            UpdateReceipt::Accepted
        );
        let task_runtime = runtime.clone();
        let task =
            tauri::async_runtime::spawn(async move { task_runtime.run_pending_download().await });
        entered.notified().await;

        task.abort();
        let _ = task.await;

        let snapshot = runtime.snapshot();
        assert_eq!(snapshot.phase, UpdatePhase::Available);
        assert!(snapshot.operation.is_none());
        assert_eq!(
            snapshot.fault.as_ref().map(|fault| fault.code.as_str()),
            Some("UPDATE_DOWNLOAD_INTERRUPTED")
        );
    });
}

#[test]
fn shutdown_waits_for_cleanup_and_rejects_success_after_cancellation() {
    tauri::async_runtime::block_on(async {
        let sink = Arc::new(MemorySnapshotSink::default());
        let verifying = Arc::new(tokio::sync::Notify::new());
        let cancel_observed = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        let downloader = Arc::new(ScriptedDownloader {
            events: vec![InstallerDownloadEvent::Verifying {
                received_bytes: 9,
                total_bytes: Some(9),
            }],
            outcome: ScriptedDownloadOutcome::SuccessAfterCancellation {
                cancel_observed: cancel_observed.clone(),
                release: release.clone(),
            },
            events_emitted: Some(verifying.clone()),
        });
        let runtime = Arc::new(runtime_with_verified_candidate(downloader, sink).await);
        let candidate_id = runtime.snapshot().candidate.unwrap().id;
        assert_eq!(
            runtime.dispatch(UpdateDispatchRequest {
                expected_revision: 2,
                intent: UpdateIntent::Download { candidate_id },
            }),
            UpdateReceipt::Accepted
        );
        let task_runtime = runtime.clone();
        let task =
            tauri::async_runtime::spawn(async move { task_runtime.run_pending_download().await });
        verifying.notified().await;
        let shutdown_runtime = runtime.clone();
        let shutdown = tauri::async_runtime::spawn(async move {
            shutdown_runtime.shutdown_active_download().await
        });
        cancel_observed.notified().await;
        release.notify_one();

        assert!(shutdown.await.unwrap());
        assert!(task.await.unwrap());
        assert_eq!(runtime.snapshot().phase, UpdatePhase::Available);
        assert!(runtime.snapshot().fault.is_none());
        assert!(runtime
            .state
            .lock()
            .expect("update runtime state poisoned")
            .verified_artifact
            .is_none());
    });
}

#[test]
fn shutdown_wins_after_the_downloader_returns_but_before_success_is_committed() {
    tauri::async_runtime::block_on(async {
        let directory = RuntimeTestDirectory::new();
        let artifact_path = directory.join("verified-installer.exe");
        std::fs::write(&artifact_path, b"installer").unwrap();
        let sink = Arc::new(MemorySnapshotSink::default());
        let downloader = Arc::new(ScriptedDownloader {
            events: vec![InstallerDownloadEvent::Verifying {
                received_bytes: 9,
                total_bytes: Some(9),
            }],
            outcome: ScriptedDownloadOutcome::SuccessAt {
                path: artifact_path.clone(),
                before_return: None,
            },
            events_emitted: None,
        });
        let runtime = Arc::new(runtime_with_verified_candidate(downloader, sink).await);
        let arrived = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        runtime.set_download_commit_barrier(arrived.clone(), release.clone());
        let candidate_id = runtime.snapshot().candidate.unwrap().id;
        assert_eq!(
            runtime.dispatch(UpdateDispatchRequest {
                expected_revision: 2,
                intent: UpdateIntent::Download { candidate_id },
            }),
            UpdateReceipt::Accepted
        );
        let task_runtime = runtime.clone();
        let task =
            tauri::async_runtime::spawn(async move { task_runtime.run_pending_download().await });
        arrived.notified().await;

        let shutdown_runtime = runtime.clone();
        let shutdown = tauri::async_runtime::spawn(async move {
            shutdown_runtime.shutdown_active_download().await
        });
        for _ in 0..100 {
            if runtime
                .snapshot()
                .operation
                .as_ref()
                .is_some_and(|operation| !operation.cancellable)
            {
                break;
            }
            tokio::task::yield_now().await;
        }
        assert!(!runtime.snapshot().operation.unwrap().cancellable);
        release.notify_one();

        assert!(task.await.unwrap());
        assert!(shutdown.await.unwrap());
        assert_eq!(runtime.snapshot().phase, UpdatePhase::Available);
        assert!(runtime.snapshot().fault.is_none());
        assert!(!artifact_path.exists());
    });
}

#[test]
fn cancellation_cannot_downgrade_a_confirmed_authenticity_failure() {
    tauri::async_runtime::block_on(async {
        let sink = Arc::new(MemorySnapshotSink::default());
        let ready = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        let downloader = Arc::new(ScriptedDownloader {
            events: Vec::new(),
            outcome: ScriptedDownloadOutcome::AuthenticityAfterRelease(release.clone()),
            events_emitted: Some(ready.clone()),
        });
        let runtime = Arc::new(runtime_with_verified_candidate(downloader, sink).await);
        let candidate_id = runtime.snapshot().candidate.unwrap().id;
        assert_eq!(
            runtime.dispatch(UpdateDispatchRequest {
                expected_revision: 2,
                intent: UpdateIntent::Download {
                    candidate_id: candidate_id.clone(),
                },
            }),
            UpdateReceipt::Accepted
        );
        let task_runtime = runtime.clone();
        let task =
            tauri::async_runtime::spawn(async move { task_runtime.run_pending_download().await });
        ready.notified().await;
        let downloading = runtime.snapshot();
        assert_eq!(
            runtime.dispatch(UpdateDispatchRequest {
                expected_revision: downloading.revision,
                intent: UpdateIntent::CancelDownload {
                    operation_id: downloading.operation.unwrap().id,
                },
            }),
            UpdateReceipt::Accepted
        );
        release.notify_one();
        assert!(task.await.unwrap());

        let failed = runtime.snapshot();
        assert_eq!(failed.phase, UpdatePhase::Available);
        assert_eq!(
            failed.fault.as_ref().map(|fault| fault.stage),
            Some(UpdateFaultStage::Verify)
        );
        assert_eq!(
            runtime.dispatch(UpdateDispatchRequest {
                expected_revision: failed.revision,
                intent: UpdateIntent::Download { candidate_id },
            }),
            UpdateReceipt::PolicyBlocked
        );
    });
}

#[test]
fn authenticity_failure_quarantines_only_the_exact_candidate() {
    tauri::async_runtime::block_on(async {
        let sink = Arc::new(MemorySnapshotSink::default());
        let downloader = Arc::new(ScriptedDownloader {
            events: vec![InstallerDownloadEvent::Verifying {
                received_bytes: 9,
                total_bytes: Some(9),
            }],
            outcome: ScriptedDownloadOutcome::AuthenticityFailure,
            events_emitted: None,
        });
        let runtime = runtime_with_verified_candidate(downloader, sink).await;
        let candidate_id = runtime.snapshot().candidate.unwrap().id;
        assert_eq!(
            runtime.dispatch(UpdateDispatchRequest {
                expected_revision: 2,
                intent: UpdateIntent::Download {
                    candidate_id: candidate_id.clone(),
                },
            }),
            UpdateReceipt::Accepted
        );
        assert!(runtime.run_pending_download().await);
        let failed = runtime.snapshot();
        assert_eq!(failed.phase, UpdatePhase::Available);
        assert_eq!(
            failed.fault.as_ref().map(|fault| fault.stage),
            Some(UpdateFaultStage::Verify)
        );
        assert_eq!(
            runtime.dispatch(UpdateDispatchRequest {
                expected_revision: failed.revision,
                intent: UpdateIntent::Download { candidate_id },
            }),
            UpdateReceipt::PolicyBlocked
        );
    });
}

#[test]
fn higher_candidate_removes_the_previous_verified_file_before_replacing_authority() {
    tauri::async_runtime::block_on(async {
        let directory = RuntimeTestDirectory::new();
        let artifact_path = directory.join("verified-installer.exe");
        std::fs::write(&artifact_path, b"installer").unwrap();
        let source = Arc::new(MemoryUpdateSource::with_outcomes([
            Ok(Some(verified_fixture_release(&[]))),
            Ok(Some(NormalizedRelease::new(
                "candidate-1.2.4",
                "1.2.4",
                ["更高版本"],
                Some("2026-07-31T01:00:00Z"),
            ))),
        ]));
        let sink = Arc::new(MemorySnapshotSink::default());
        let downloader = Arc::new(ScriptedDownloader {
            events: vec![InstallerDownloadEvent::Verifying {
                received_bytes: 9,
                total_bytes: Some(9),
            }],
            outcome: ScriptedDownloadOutcome::SuccessAt {
                path: artifact_path.clone(),
                before_return: None,
            },
            events_emitted: None,
        });
        let runtime = UpdateRuntime::with_downloader("0.1.0", source, sink, downloader);
        assert_eq!(
            runtime.dispatch(UpdateDispatchRequest {
                expected_revision: 0,
                intent: UpdateIntent::CheckNow,
            }),
            UpdateReceipt::Accepted
        );
        assert!(runtime.run_pending_check().await);
        let candidate_id = runtime.snapshot().candidate.unwrap().id;
        assert_eq!(
            runtime.dispatch(UpdateDispatchRequest {
                expected_revision: runtime.snapshot().revision,
                intent: UpdateIntent::Download { candidate_id },
            }),
            UpdateReceipt::Accepted
        );
        assert!(runtime.run_pending_download().await);
        assert_eq!(runtime.snapshot().phase, UpdatePhase::ReadyToInstall);
        assert!(artifact_path.exists());

        assert_eq!(
            runtime.dispatch(UpdateDispatchRequest {
                expected_revision: runtime.snapshot().revision,
                intent: UpdateIntent::CheckNow,
            }),
            UpdateReceipt::Accepted
        );
        assert!(runtime.run_pending_check().await);

        let snapshot = runtime.snapshot();
        assert_eq!(snapshot.phase, UpdatePhase::Available);
        assert_eq!(snapshot.candidate.unwrap().id, "candidate-1.2.4");
        assert!(!artifact_path.exists());
        assert!(runtime
            .state
            .lock()
            .expect("update runtime state poisoned")
            .verified_artifact
            .is_none());
    });
}
