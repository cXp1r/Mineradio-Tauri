use std::sync::Arc;

use super::*;

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
