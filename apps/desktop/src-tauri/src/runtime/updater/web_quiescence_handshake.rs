use std::{fmt, future::Future, pin::Pin, time::Duration};

use super::quiescence::{
    CheckpointEvidence, NativeWebQuiescenceStore, PlaybackExitCheckpointV1,
    PrepareWebQuiescenceRequest, RollbackAcknowledgement, RollbackAcknowledgementOutcome,
    RollbackWebQuiescencePlan, RollbackWebQuiescenceRequest, WebQuiescenceError,
    WebQuiescenceIdentity,
};

type WebQuiescencePortFuture<'a, T> =
    Pin<Box<dyn Future<Output = Result<T, WebQuiescencePortFailure>> + Send + 'a>>;

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct PreparedWebQuiescence {
    pub(crate) identity: WebQuiescenceIdentity,
    pub(crate) checkpoint: PlaybackExitCheckpointV1,
    pub(crate) evidence: CheckpointEvidence,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct PreparedWebAcknowledgement {
    pub(crate) identity: WebQuiescenceIdentity,
    pub(crate) evidence: CheckpointEvidence,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WebQuiescencePortFailure {
    TimedOut,
    Failed,
}

pub(crate) trait WebPlaybackQuiescencePort: Send + Sync {
    /// 只 stage owner lease 并生成 checkpoint；在 Rust 明确确认落盘前不得暂停。
    fn stage_checkpoint<'a>(
        &'a self,
        request: &'a PrepareWebQuiescenceRequest,
        timeout: Duration,
    ) -> WebQuiescencePortFuture<'a, PlaybackExitCheckpointV1>;

    /// Rust 已 crash-safe 持久化 checkpoint 后，Web 才能暂停 exact committed owner。
    fn confirm_checkpoint_persisted<'a>(
        &'a self,
        identity: &'a WebQuiescenceIdentity,
        evidence: &'a CheckpointEvidence,
        timeout: Duration,
    ) -> WebQuiescencePortFuture<'a, PreparedWebAcknowledgement>;

    fn rollback<'a>(
        &'a self,
        request: &'a RollbackWebQuiescenceRequest,
        timeout: Duration,
    ) -> WebQuiescencePortFuture<'a, RollbackAcknowledgement>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WebQuiescenceHandshakeError {
    code: &'static str,
}

impl WebQuiescenceHandshakeError {
    fn port(failure: WebQuiescencePortFailure) -> Self {
        Self {
            code: match failure {
                WebQuiescencePortFailure::TimedOut => "UPDATE_WEB_QUIESCENCE_ACK_TIMEOUT",
                WebQuiescencePortFailure::Failed => "UPDATE_WEB_QUIESCENCE_ACK_FAILED",
            },
        }
    }

    fn stale_acknowledgement() -> Self {
        Self {
            code: "UPDATE_WEB_QUIESCENCE_STALE_ACKNOWLEDGEMENT",
        }
    }

    pub(crate) fn code(&self) -> &'static str {
        self.code
    }
}

impl From<WebQuiescenceError> for WebQuiescenceHandshakeError {
    fn from(error: WebQuiescenceError) -> Self {
        Self { code: error.code() }
    }
}

impl fmt::Display for WebQuiescenceHandshakeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code)
    }
}

/// #54 只需提供 Tauri event/command Port；事务顺序与 timeout 失败语义固定在这里。
pub(crate) struct WebQuiescenceHandshake<P> {
    store: NativeWebQuiescenceStore,
    port: P,
    acknowledgement_timeout: Duration,
}

impl<P: WebPlaybackQuiescencePort> WebQuiescenceHandshake<P> {
    pub(crate) fn new(
        store: NativeWebQuiescenceStore,
        port: P,
        acknowledgement_timeout: Duration,
    ) -> Self {
        Self {
            store,
            port,
            acknowledgement_timeout,
        }
    }

    pub(crate) async fn prepare(
        &self,
        candidate_id: &str,
        updated_at: u64,
    ) -> Result<PreparedWebQuiescence, WebQuiescenceHandshakeError> {
        let request = self.store.begin_prepare(candidate_id, updated_at)?;
        let checkpoint = match bounded_port_call(
            self.acknowledgement_timeout,
            self.port
                .stage_checkpoint(&request, self.acknowledgement_timeout),
        )
        .await
        {
            Ok(checkpoint) => checkpoint,
            Err(failure) => return Err(self.fail_prepare(&request.identity, updated_at, failure)),
        };
        let evidence = match self
            .store
            .persist_checkpoint(&request.identity, &checkpoint)
        {
            Ok(evidence) => evidence,
            Err(error) => {
                self.store.fail_prepare(&request.identity, updated_at)?;
                return Err(error.into());
            }
        };
        let acknowledgement = match bounded_port_call(
            self.acknowledgement_timeout,
            self.port.confirm_checkpoint_persisted(
                &request.identity,
                &evidence,
                self.acknowledgement_timeout,
            ),
        )
        .await
        {
            Ok(acknowledgement) => acknowledgement,
            Err(failure) => return Err(self.fail_prepare(&request.identity, updated_at, failure)),
        };
        if acknowledgement.identity != request.identity || acknowledgement.evidence != evidence {
            self.store.fail_prepare(&request.identity, updated_at)?;
            return Err(WebQuiescenceHandshakeError::stale_acknowledgement());
        }
        if let Err(error) = self.store.acknowledge_prepared(
            &acknowledgement.identity,
            &acknowledgement.evidence,
            updated_at,
        ) {
            self.store.fail_prepare(&request.identity, updated_at)?;
            return Err(error.into());
        }
        Ok(PreparedWebQuiescence {
            identity: request.identity,
            checkpoint,
            evidence,
        })
    }

    fn fail_prepare(
        &self,
        identity: &WebQuiescenceIdentity,
        updated_at: u64,
        failure: WebQuiescencePortFailure,
    ) -> WebQuiescenceHandshakeError {
        match self.store.fail_prepare(identity, updated_at) {
            Ok(_) => WebQuiescenceHandshakeError::port(failure),
            Err(error) => error.into(),
        }
    }

    pub(crate) fn mark_pre_spawn_failure(
        &self,
        identity: &WebQuiescenceIdentity,
        updated_at: u64,
    ) -> Result<(), WebQuiescenceHandshakeError> {
        self.store.fail_prepare(identity, updated_at)?;
        Ok(())
    }

    /// caller 只有在 #51 native lease 已完成 exact rollback 后才能调用此方法；Store 会
    /// 再次验证 durable native confirmation，Web rollback 绝不先行。
    pub(crate) async fn rollback_after_native_confirmation(
        &self,
        identity: &WebQuiescenceIdentity,
        updated_at: u64,
    ) -> Result<RollbackAcknowledgementOutcome, WebQuiescenceHandshakeError> {
        let plan = self
            .store
            .request_rollback_after_native_confirmation(identity)?;
        let request = match plan {
            RollbackWebQuiescencePlan::Request(request) => request,
            RollbackWebQuiescencePlan::AlreadyCompleted => {
                return Ok(RollbackAcknowledgementOutcome::AlreadyCompleted);
            }
        };
        let acknowledgement = bounded_port_call(
            self.acknowledgement_timeout,
            self.port.rollback(&request, self.acknowledgement_timeout),
        )
        .await
        .map_err(WebQuiescenceHandshakeError::port)?;
        Ok(self
            .store
            .acknowledge_rollback(identity, &acknowledgement, updated_at)?)
    }

    pub(crate) fn store(&self) -> &NativeWebQuiescenceStore {
        &self.store
    }
}

async fn bounded_port_call<T>(
    timeout: Duration,
    future: WebQuiescencePortFuture<'_, T>,
) -> Result<T, WebQuiescencePortFailure> {
    match tokio::time::timeout(timeout, future).await {
        Ok(result) => result,
        Err(_) => Err(WebQuiescencePortFailure::TimedOut),
    }
}

#[cfg(test)]
mod tests {
    use std::{collections::VecDeque, fs, path::PathBuf, sync::Mutex};

    use super::*;
    use crate::runtime::updater::quiescence::{
        PlaybackCheckpointMode, PlaybackCheckpointSourceKind, WebQuiescencePhase,
        WEB_QUIESCENCE_FILE_NAME,
    };

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new(label: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "mineradio-web-handshake-{label}-{}",
                getrandom::u64().unwrap()
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[derive(Default)]
    struct FakePort {
        stage: Mutex<VecDeque<Result<PlaybackExitCheckpointV1, WebQuiescencePortFailure>>>,
        confirm: Mutex<VecDeque<Result<PreparedWebAcknowledgement, WebQuiescencePortFailure>>>,
        rollback: Mutex<VecDeque<Result<RollbackAcknowledgement, WebQuiescencePortFailure>>>,
    }

    impl WebPlaybackQuiescencePort for FakePort {
        fn stage_checkpoint<'a>(
            &'a self,
            request: &'a PrepareWebQuiescenceRequest,
            _timeout: Duration,
        ) -> WebQuiescencePortFuture<'a, PlaybackExitCheckpointV1> {
            Box::pin(async move {
                self.stage
                    .lock()
                    .unwrap()
                    .pop_front()
                    .unwrap_or_else(|| Ok(checkpoint(&request.identity.operation_id)))
            })
        }

        fn confirm_checkpoint_persisted<'a>(
            &'a self,
            identity: &'a WebQuiescenceIdentity,
            evidence: &'a CheckpointEvidence,
            _timeout: Duration,
        ) -> WebQuiescencePortFuture<'a, PreparedWebAcknowledgement> {
            Box::pin(async move {
                self.confirm.lock().unwrap().pop_front().unwrap_or_else(|| {
                    Ok(PreparedWebAcknowledgement {
                        identity: identity.clone(),
                        evidence: evidence.clone(),
                    })
                })
            })
        }

        fn rollback<'a>(
            &'a self,
            request: &'a RollbackWebQuiescenceRequest,
            _timeout: Duration,
        ) -> WebQuiescencePortFuture<'a, RollbackAcknowledgement> {
            Box::pin(async move {
                self.rollback
                    .lock()
                    .unwrap()
                    .pop_front()
                    .unwrap_or_else(|| {
                        Ok(match request.checkpoint.as_ref() {
                            Some(checkpoint) => {
                                RollbackAcknowledgement::Restored(checkpoint.evidence.clone())
                            }
                            None => RollbackAcknowledgement::NoOpNotPrepared,
                        })
                    })
            })
        }
    }

    struct PendingStagePort;

    impl WebPlaybackQuiescencePort for PendingStagePort {
        fn stage_checkpoint<'a>(
            &'a self,
            _request: &'a PrepareWebQuiescenceRequest,
            _timeout: Duration,
        ) -> WebQuiescencePortFuture<'a, PlaybackExitCheckpointV1> {
            Box::pin(std::future::pending())
        }

        fn confirm_checkpoint_persisted<'a>(
            &'a self,
            _identity: &'a WebQuiescenceIdentity,
            _evidence: &'a CheckpointEvidence,
            _timeout: Duration,
        ) -> WebQuiescencePortFuture<'a, PreparedWebAcknowledgement> {
            Box::pin(async { unreachable!("pending stage 不会进入 confirm") })
        }

        fn rollback<'a>(
            &'a self,
            _request: &'a RollbackWebQuiescenceRequest,
            _timeout: Duration,
        ) -> WebQuiescencePortFuture<'a, RollbackAcknowledgement> {
            Box::pin(async { unreachable!("pending stage 不会进入 rollback") })
        }
    }

    fn checkpoint(operation_id: &str) -> PlaybackExitCheckpointV1 {
        PlaybackExitCheckpointV1 {
            schema: "playback-exit-checkpoint-v1".into(),
            operation_id: operation_id.into(),
            receipt: "b".repeat(32),
            queue: Vec::new(),
            current_track_index: None,
            current_track_ref: String::new(),
            captured_playback_intent_id: 0,
            position_ms: 0.0,
            duration_ms: None,
            was_playing: false,
            volume: 0.84,
            muted: false,
            mode: PlaybackCheckpointMode::Loop,
            source_kind: PlaybackCheckpointSourceKind::None,
            restart_restorable: true,
        }
    }

    fn candidate_id() -> String {
        "a".repeat(64)
    }

    fn record(root: &TestDirectory) -> serde_json::Value {
        serde_json::from_slice(
            &fs::read(root.0.join(WEB_QUIESCENCE_FILE_NAME)).expect("record 应存在"),
        )
        .unwrap()
    }

    fn block_on<T>(future: impl std::future::Future<Output = T>) -> T {
        tauri::async_runtime::block_on(future)
    }

    #[test]
    fn timeout_is_durable_rollback_required_before_native_cleanup_can_begin() {
        let root = TestDirectory::new("timeout");
        let port = FakePort::default();
        port.stage
            .lock()
            .unwrap()
            .push_back(Err(WebQuiescencePortFailure::TimedOut));
        let handshake = WebQuiescenceHandshake::new(
            NativeWebQuiescenceStore::with_updater_directory(&root.0),
            port,
            Duration::from_secs(2),
        );

        assert_eq!(
            block_on(handshake.prepare(&candidate_id(), 100))
                .unwrap_err()
                .code(),
            "UPDATE_WEB_QUIESCENCE_ACK_TIMEOUT"
        );
        assert_eq!(record(&root)["phase"], "rollback-required");
        assert_eq!(record(&root)["nativeRollbackCompleted"], false);
    }

    #[test]
    fn coordinator_enforces_timeout_even_when_the_port_never_resolves() {
        let root = TestDirectory::new("coordinator-timeout");
        let handshake = WebQuiescenceHandshake::new(
            NativeWebQuiescenceStore::with_updater_directory(&root.0),
            PendingStagePort,
            Duration::from_millis(5),
        );

        assert_eq!(
            block_on(handshake.prepare(&candidate_id(), 100))
                .unwrap_err()
                .code(),
            "UPDATE_WEB_QUIESCENCE_ACK_TIMEOUT"
        );
        assert_eq!(record(&root)["phase"], "rollback-required");
        assert_eq!(record(&root)["nativeRollbackCompleted"], false);
    }

    #[test]
    fn stale_confirmation_is_durable_rollback_required() {
        let root = TestDirectory::new("stale-confirm");
        let port = FakePort::default();
        port.confirm
            .lock()
            .unwrap()
            .push_back(Ok(PreparedWebAcknowledgement {
                identity: WebQuiescenceIdentity {
                    operation_id: "c".repeat(32),
                    operation_generation: 99,
                    candidate_id: candidate_id(),
                },
                evidence: CheckpointEvidence {
                    receipt: "d".repeat(32),
                    digest: "e".repeat(64),
                },
            }));
        let handshake = WebQuiescenceHandshake::new(
            NativeWebQuiescenceStore::with_updater_directory(&root.0),
            port,
            Duration::from_secs(2),
        );

        assert_eq!(
            block_on(handshake.prepare(&candidate_id(), 100))
                .unwrap_err()
                .code(),
            "UPDATE_WEB_QUIESCENCE_STALE_ACKNOWLEDGEMENT"
        );
        assert_eq!(record(&root)["phase"], "rollback-required");
    }

    #[test]
    fn simulated_pre_spawn_failure_restores_only_after_native_confirmation() {
        let root = TestDirectory::new("pre-spawn-rollback");
        let handshake = WebQuiescenceHandshake::new(
            NativeWebQuiescenceStore::with_updater_directory(&root.0),
            FakePort::default(),
            Duration::from_secs(2),
        );
        let prepared = block_on(handshake.prepare(&candidate_id(), 100)).unwrap();
        handshake
            .mark_pre_spawn_failure(&prepared.identity, 200)
            .unwrap();

        assert_eq!(
            block_on(handshake.rollback_after_native_confirmation(&prepared.identity, 300))
                .unwrap_err()
                .code(),
            "UPDATE_WEB_QUIESCENCE_NATIVE_ROLLBACK_REQUIRED"
        );
        handshake
            .store()
            .confirm_native_rollback(&prepared.identity, 400)
            .unwrap();
        assert_eq!(
            block_on(handshake.rollback_after_native_confirmation(&prepared.identity, 500))
                .unwrap(),
            RollbackAcknowledgementOutcome::Completed
        );
        assert_eq!(
            block_on(handshake.rollback_after_native_confirmation(&prepared.identity, 501))
                .unwrap(),
            RollbackAcknowledgementOutcome::AlreadyCompleted
        );
    }

    #[test]
    fn rollback_timeout_can_be_reconciled_after_process_restart() {
        let root = TestDirectory::new("rollback-lost-reply");
        let first_port = FakePort::default();
        first_port
            .rollback
            .lock()
            .unwrap()
            .push_back(Err(WebQuiescencePortFailure::TimedOut));
        let first = WebQuiescenceHandshake::new(
            NativeWebQuiescenceStore::with_updater_directory(&root.0),
            first_port,
            Duration::from_secs(2),
        );
        let prepared = block_on(first.prepare(&candidate_id(), 100)).unwrap();
        first
            .mark_pre_spawn_failure(&prepared.identity, 200)
            .unwrap();
        first
            .store()
            .confirm_native_rollback(&prepared.identity, 300)
            .unwrap();
        assert_eq!(
            block_on(first.rollback_after_native_confirmation(&prepared.identity, 400))
                .unwrap_err()
                .code(),
            "UPDATE_WEB_QUIESCENCE_ACK_TIMEOUT"
        );
        let state = record(&root);
        assert_eq!(state["phase"], "rollback-required");
        assert_eq!(state["nativeRollbackCompleted"], true);
        assert_eq!(state["rollbackAcknowledged"], false);
        drop(first);

        let restarted = WebQuiescenceHandshake::new(
            NativeWebQuiescenceStore::with_updater_directory(&root.0),
            FakePort::default(),
            Duration::from_secs(2),
        );
        assert_eq!(
            block_on(restarted.rollback_after_native_confirmation(&prepared.identity, 500))
                .unwrap(),
            RollbackAcknowledgementOutcome::Completed
        );
        assert_eq!(
            block_on(restarted.rollback_after_native_confirmation(&prepared.identity, 501))
                .unwrap(),
            RollbackAcknowledgementOutcome::AlreadyCompleted
        );
    }

    #[test]
    fn durable_generation_advances_and_stale_reload_identity_is_rejected() {
        let root = TestDirectory::new("generation");
        let handshake = WebQuiescenceHandshake::new(
            NativeWebQuiescenceStore::with_updater_directory(&root.0),
            FakePort::default(),
            Duration::from_secs(2),
        );
        let first = block_on(handshake.prepare(&candidate_id(), 100)).unwrap();
        handshake
            .mark_pre_spawn_failure(&first.identity, 200)
            .unwrap();
        handshake
            .store()
            .confirm_native_rollback(&first.identity, 300)
            .unwrap();
        block_on(handshake.rollback_after_native_confirmation(&first.identity, 400)).unwrap();

        let second = block_on(handshake.prepare(&candidate_id(), 500)).unwrap();
        assert_eq!(
            second.identity.operation_generation,
            first.identity.operation_generation + 1
        );
        let mut stale = second.identity.clone();
        stale.operation_generation = first.identity.operation_generation;
        assert_eq!(
            handshake
                .store()
                .acknowledge_prepared(&stale, &second.evidence, 600)
                .unwrap_err()
                .code(),
            "UPDATE_WEB_QUIESCENCE_STALE_IDENTITY"
        );
        assert_eq!(record(&root)["phase"], "rollback-required");
    }

    #[test]
    fn failed_port_result_is_classified_without_starting_native_cleanup() {
        let root = TestDirectory::new("failed-port");
        let port = FakePort::default();
        port.confirm
            .lock()
            .unwrap()
            .push_back(Err(WebQuiescencePortFailure::Failed));
        let handshake = WebQuiescenceHandshake::new(
            NativeWebQuiescenceStore::with_updater_directory(&root.0),
            port,
            Duration::from_secs(2),
        );

        assert_eq!(
            block_on(handshake.prepare(&candidate_id(), 100))
                .unwrap_err()
                .code(),
            "UPDATE_WEB_QUIESCENCE_ACK_FAILED"
        );
        let state = record(&root);
        assert_eq!(state["phase"], "rollback-required");
        assert_eq!(state["nativeRollbackCompleted"], false);
        assert_eq!(state["rollbackAcknowledged"], false);
        assert_eq!(state["operationGeneration"], 1);
        assert_ne!(
            state["phase"],
            serde_json::json!(WebQuiescencePhase::Prepared)
        );
    }

    #[test]
    fn successful_prepare_returns_exact_durable_checkpoint_identity() {
        let root = TestDirectory::new("success");
        let handshake = WebQuiescenceHandshake::new(
            NativeWebQuiescenceStore::with_updater_directory(&root.0),
            FakePort::default(),
            Duration::from_secs(2),
        );

        let prepared = block_on(handshake.prepare(&candidate_id(), 100)).unwrap();
        assert_eq!(prepared.identity.operation_generation, 1);
        assert_eq!(
            prepared.checkpoint.operation_id,
            prepared.identity.operation_id
        );
        assert_eq!(prepared.checkpoint.receipt, prepared.evidence.receipt);
        assert_eq!(record(&root)["phase"], "prepared");
    }
}
