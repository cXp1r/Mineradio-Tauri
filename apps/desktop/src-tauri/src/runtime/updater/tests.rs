use std::sync::Arc;

use super::*;

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
