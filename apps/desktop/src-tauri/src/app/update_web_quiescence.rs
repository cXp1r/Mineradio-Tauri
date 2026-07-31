use std::{
    collections::HashMap,
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex},
    time::Duration,
};

use serde::{Deserialize, Serialize};
use tauri::Emitter;

use crate::runtime::updater::{
    quiescence::{
        CheckpointEvidence, PlaybackExitCheckpointV1, PrepareWebQuiescenceRequest,
        RollbackAcknowledgement, RollbackWebQuiescenceRequest, WebQuiescenceIdentity,
    },
    web_quiescence_handshake::{
        PreparedWebAcknowledgement, WebPlaybackQuiescencePort, WebQuiescencePortFailure,
    },
};

use super::window_labels;

pub(crate) const UPDATE_WEB_QUIESCENCE_PREPARE_EVENT: &str =
    "mineradio-update-web-quiescence-prepare";
pub(crate) const UPDATE_WEB_QUIESCENCE_CONFIRM_EVENT: &str =
    "mineradio-update-web-quiescence-confirm";
pub(crate) const UPDATE_WEB_QUIESCENCE_ROLLBACK_EVENT: &str =
    "mineradio-update-web-quiescence-rollback";
pub(crate) const UPDATE_WEB_QUIESCENCE_RELEASE_EVENT: &str =
    "mineradio-update-web-quiescence-release";

type PortFuture<'a, T> =
    Pin<Box<dyn Future<Output = Result<T, WebQuiescencePortFailure>> + Send + 'a>>;

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum UpdateWebQuiescenceAcknowledgementKind {
    Prepare,
    Confirm,
    Rollback,
    Release,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct UpdateWebQuiescenceAcknowledgement {
    kind: UpdateWebQuiescenceAcknowledgementKind,
    operation_id: String,
    operation_generation: u64,
    candidate_id: String,
    result: String,
    #[serde(default)]
    receipt: Option<String>,
    #[serde(default)]
    checkpoint_digest: Option<String>,
    #[serde(default)]
    checkpoint: Option<PlaybackExitCheckpointV1>,
    #[serde(default)]
    reason: Option<String>,
}

impl UpdateWebQuiescenceAcknowledgement {
    fn key(&self) -> Option<PendingAcknowledgementKey> {
        let identity = WebQuiescenceIdentity {
            operation_id: self.operation_id.clone(),
            operation_generation: self.operation_generation,
            candidate_id: self.candidate_id.clone(),
        };
        valid_identity(&identity).then_some(PendingAcknowledgementKey {
            kind: self.kind,
            operation_id: identity.operation_id,
            operation_generation: identity.operation_generation,
            candidate_id: identity.candidate_id,
        })
    }
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct PendingAcknowledgementKey {
    kind: UpdateWebQuiescenceAcknowledgementKind,
    operation_id: String,
    operation_generation: u64,
    candidate_id: String,
}

impl PendingAcknowledgementKey {
    fn exact(
        kind: UpdateWebQuiescenceAcknowledgementKind,
        identity: &WebQuiescenceIdentity,
    ) -> Result<Self, WebQuiescencePortFailure> {
        if !valid_identity(identity) {
            return Err(WebQuiescencePortFailure::Failed);
        }
        Ok(Self {
            kind,
            operation_id: identity.operation_id.clone(),
            operation_generation: identity.operation_generation,
            candidate_id: identity.candidate_id.clone(),
        })
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct IdentityPayload<'a> {
    operation_id: &'a str,
    operation_generation: u64,
    candidate_id: &'a str,
}

impl<'a> From<&'a WebQuiescenceIdentity> for IdentityPayload<'a> {
    fn from(identity: &'a WebQuiescenceIdentity) -> Self {
        Self {
            operation_id: &identity.operation_id,
            operation_generation: identity.operation_generation,
            candidate_id: &identity.candidate_id,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct EvidencePayload<'a> {
    operation_id: &'a str,
    operation_generation: u64,
    candidate_id: &'a str,
    receipt: &'a str,
    checkpoint_digest: &'a str,
}

impl<'a> EvidencePayload<'a> {
    fn exact(identity: &'a WebQuiescenceIdentity, evidence: &'a CheckpointEvidence) -> Self {
        Self {
            operation_id: &identity.operation_id,
            operation_generation: identity.operation_generation,
            candidate_id: &identity.candidate_id,
            receipt: &evidence.receipt,
            checkpoint_digest: &evidence.digest,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PersistedCheckpointPayload<'a> {
    receipt: &'a str,
    digest: &'a str,
    payload: &'a PlaybackExitCheckpointV1,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RollbackPayload<'a> {
    operation_id: &'a str,
    operation_generation: u64,
    candidate_id: &'a str,
    checkpoint: Option<PersistedCheckpointPayload<'a>>,
}

pub(crate) trait UpdateWebQuiescenceEventSink: Send + Sync {
    fn emit(&self, event: &'static str, payload: serde_json::Value) -> Result<(), ()>;
}

struct TauriUpdateWebQuiescenceEventSink {
    app: tauri::AppHandle,
}

impl UpdateWebQuiescenceEventSink for TauriUpdateWebQuiescenceEventSink {
    fn emit(&self, event: &'static str, payload: serde_json::Value) -> Result<(), ()> {
        self.app
            .emit_to(window_labels::MAIN, event, payload)
            .map_err(|_| ())
    }
}

struct UpdateWebQuiescenceBridgeInner {
    sink: Arc<dyn UpdateWebQuiescenceEventSink>,
    pending: Arc<
        Mutex<
            HashMap<
                PendingAcknowledgementKey,
                tokio::sync::oneshot::Sender<UpdateWebQuiescenceAcknowledgement>,
            >,
        >,
    >,
}

#[derive(Clone)]
pub(crate) struct TauriUpdateWebQuiescencePort {
    inner: Arc<UpdateWebQuiescenceBridgeInner>,
}

impl TauriUpdateWebQuiescencePort {
    pub(crate) fn new(app: tauri::AppHandle) -> Self {
        Self::with_sink(Arc::new(TauriUpdateWebQuiescenceEventSink { app }))
    }

    fn with_sink(sink: Arc<dyn UpdateWebQuiescenceEventSink>) -> Self {
        Self {
            inner: Arc::new(UpdateWebQuiescenceBridgeInner {
                sink,
                pending: Arc::new(Mutex::new(HashMap::new())),
            }),
        }
    }

    pub(crate) fn acknowledge(&self, acknowledgement: UpdateWebQuiescenceAcknowledgement) -> bool {
        let Some(key) = acknowledgement.key() else {
            return false;
        };
        let sender = self
            .inner
            .pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&key);
        sender.is_some_and(|sender| sender.send(acknowledgement).is_ok())
    }

    async fn request_acknowledgement<T: Serialize>(
        &self,
        event: &'static str,
        key: PendingAcknowledgementKey,
        payload: &T,
        timeout: Duration,
    ) -> Result<UpdateWebQuiescenceAcknowledgement, WebQuiescencePortFailure> {
        let payload =
            serde_json::to_value(payload).map_err(|_| WebQuiescencePortFailure::Failed)?;
        let (sender, receiver) = tokio::sync::oneshot::channel();
        {
            let mut pending = self
                .inner
                .pending
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if pending.insert(key.clone(), sender).is_some() {
                pending.remove(&key);
                return Err(WebQuiescencePortFailure::Failed);
            }
        }
        let mut registration = PendingAcknowledgementRegistration {
            pending: Arc::clone(&self.inner.pending),
            key,
        };
        if self.inner.sink.emit(event, payload).is_err() {
            return Err(WebQuiescencePortFailure::Failed);
        }
        let acknowledgement = match tokio::time::timeout(timeout, receiver).await {
            Ok(Ok(acknowledgement)) => acknowledgement,
            Ok(Err(_)) => return Err(WebQuiescencePortFailure::Failed),
            Err(_) => return Err(WebQuiescencePortFailure::TimedOut),
        };
        registration.disarm();
        Ok(acknowledgement)
    }
}

struct PendingAcknowledgementRegistration {
    pending: Arc<
        Mutex<
            HashMap<
                PendingAcknowledgementKey,
                tokio::sync::oneshot::Sender<UpdateWebQuiescenceAcknowledgement>,
            >,
        >,
    >,
    key: PendingAcknowledgementKey,
}

impl PendingAcknowledgementRegistration {
    fn disarm(&mut self) {
        // ACK command 已先从 map 移除 exact sender；保留空 Drop 即可。
        self.pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&self.key);
    }
}

impl Drop for PendingAcknowledgementRegistration {
    fn drop(&mut self) {
        self.pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&self.key);
    }
}

impl WebPlaybackQuiescencePort for TauriUpdateWebQuiescencePort {
    fn stage_checkpoint<'a>(
        &'a self,
        request: &'a PrepareWebQuiescenceRequest,
        timeout: Duration,
    ) -> PortFuture<'a, PlaybackExitCheckpointV1> {
        Box::pin(async move {
            let key = PendingAcknowledgementKey::exact(
                UpdateWebQuiescenceAcknowledgementKind::Prepare,
                &request.identity,
            )?;
            let acknowledgement = self
                .request_acknowledgement(
                    UPDATE_WEB_QUIESCENCE_PREPARE_EVENT,
                    key,
                    &IdentityPayload::from(&request.identity),
                    timeout,
                )
                .await?;
            if !matches!(
                acknowledgement.result.as_str(),
                "prepared" | "already-prepared"
            ) {
                return Err(WebQuiescencePortFailure::Failed);
            }
            let checkpoint = acknowledgement
                .checkpoint
                .ok_or(WebQuiescencePortFailure::Failed)?;
            if checkpoint.operation_id != request.identity.operation_id
                || !is_lower_hex(&checkpoint.receipt, 32)
            {
                return Err(WebQuiescencePortFailure::Failed);
            }
            Ok(checkpoint)
        })
    }

    fn confirm_checkpoint_persisted<'a>(
        &'a self,
        identity: &'a WebQuiescenceIdentity,
        evidence: &'a CheckpointEvidence,
        timeout: Duration,
    ) -> PortFuture<'a, PreparedWebAcknowledgement> {
        Box::pin(async move {
            request_exact_evidence_ack(
                self,
                UPDATE_WEB_QUIESCENCE_CONFIRM_EVENT,
                UpdateWebQuiescenceAcknowledgementKind::Confirm,
                identity,
                evidence,
                &["confirmed", "already-confirmed"],
                timeout,
            )
            .await
        })
    }

    fn seal_for_exit<'a>(
        &'a self,
        identity: &'a WebQuiescenceIdentity,
        evidence: &'a CheckpointEvidence,
        timeout: Duration,
    ) -> PortFuture<'a, PreparedWebAcknowledgement> {
        Box::pin(async move {
            request_exact_evidence_ack(
                self,
                UPDATE_WEB_QUIESCENCE_RELEASE_EVENT,
                UpdateWebQuiescenceAcknowledgementKind::Release,
                identity,
                evidence,
                &["released", "already-released"],
                timeout,
            )
            .await
        })
    }

    fn rollback<'a>(
        &'a self,
        request: &'a RollbackWebQuiescenceRequest,
        timeout: Duration,
    ) -> PortFuture<'a, RollbackAcknowledgement> {
        Box::pin(async move {
            let key = PendingAcknowledgementKey::exact(
                UpdateWebQuiescenceAcknowledgementKind::Rollback,
                &request.identity,
            )?;
            let payload = RollbackPayload {
                operation_id: &request.identity.operation_id,
                operation_generation: request.identity.operation_generation,
                candidate_id: &request.identity.candidate_id,
                checkpoint: request.checkpoint.as_ref().map(|checkpoint| {
                    PersistedCheckpointPayload {
                        receipt: &checkpoint.evidence.receipt,
                        digest: &checkpoint.evidence.digest,
                        payload: &checkpoint.payload,
                    }
                }),
            };
            let acknowledgement = self
                .request_acknowledgement(
                    UPDATE_WEB_QUIESCENCE_ROLLBACK_EVENT,
                    key,
                    &payload,
                    timeout,
                )
                .await?;
            match (acknowledgement.result.as_str(), request.checkpoint.as_ref()) {
                ("restored", Some(checkpoint))
                    if acknowledgement.receipt.as_deref()
                        == Some(checkpoint.evidence.receipt.as_str())
                        && acknowledgement.checkpoint_digest.as_deref()
                            == Some(checkpoint.evidence.digest.as_str()) =>
                {
                    Ok(RollbackAcknowledgement::Restored(
                        checkpoint.evidence.clone(),
                    ))
                }
                ("no-op-not-prepared", None)
                    if acknowledgement.receipt.is_none()
                        && acknowledgement.checkpoint_digest.is_none() =>
                {
                    Ok(RollbackAcknowledgement::NoOpNotPrepared)
                }
                _ => Err(WebQuiescencePortFailure::Failed),
            }
        })
    }
}

async fn request_exact_evidence_ack(
    port: &TauriUpdateWebQuiescencePort,
    event: &'static str,
    kind: UpdateWebQuiescenceAcknowledgementKind,
    identity: &WebQuiescenceIdentity,
    evidence: &CheckpointEvidence,
    accepted_results: &[&str],
    timeout: Duration,
) -> Result<PreparedWebAcknowledgement, WebQuiescencePortFailure> {
    if !is_lower_hex(&evidence.receipt, 32) || !is_lower_hex(&evidence.digest, 64) {
        return Err(WebQuiescencePortFailure::Failed);
    }
    let key = PendingAcknowledgementKey::exact(kind, identity)?;
    let acknowledgement = port
        .request_acknowledgement(
            event,
            key,
            &EvidencePayload::exact(identity, evidence),
            timeout,
        )
        .await?;
    if !accepted_results.contains(&acknowledgement.result.as_str())
        || acknowledgement.receipt.as_deref() != Some(evidence.receipt.as_str())
        || acknowledgement.checkpoint_digest.as_deref() != Some(evidence.digest.as_str())
        || acknowledgement.checkpoint.is_some()
    {
        return Err(WebQuiescencePortFailure::Failed);
    }
    Ok(PreparedWebAcknowledgement {
        identity: identity.clone(),
        evidence: evidence.clone(),
    })
}

fn valid_identity(identity: &WebQuiescenceIdentity) -> bool {
    is_lower_hex(&identity.operation_id, 32)
        && identity.operation_generation > 0
        && identity.operation_generation <= 9_007_199_254_740_991
        && is_lower_hex(&identity.candidate_id, 64)
}

fn is_lower_hex(value: &str, expected_length: usize) -> bool {
    value.len() == expected_length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    #[derive(Default)]
    struct RecordingSink {
        emitted: Mutex<Vec<(&'static str, serde_json::Value)>>,
        emitted_notify: tokio::sync::Notify,
        fail: AtomicBool,
    }

    impl UpdateWebQuiescenceEventSink for RecordingSink {
        fn emit(&self, event: &'static str, payload: serde_json::Value) -> Result<(), ()> {
            if self.fail.load(Ordering::Acquire) {
                return Err(());
            }
            self.emitted
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .push((event, payload));
            self.emitted_notify.notify_one();
            Ok(())
        }
    }

    fn identity() -> WebQuiescenceIdentity {
        WebQuiescenceIdentity {
            operation_id: "1".repeat(32),
            operation_generation: 7,
            candidate_id: "2".repeat(64),
        }
    }

    fn checkpoint() -> PlaybackExitCheckpointV1 {
        let mut checkpoint: PlaybackExitCheckpointV1 = serde_json::from_str(include_str!(
            "../runtime/updater/fixtures/playback-exit-checkpoint-v1.json"
        ))
        .expect("checkpoint fixture 应有效");
        checkpoint.operation_id = identity().operation_id;
        checkpoint.receipt = "3".repeat(32);
        checkpoint
    }

    fn acknowledgement(
        kind: UpdateWebQuiescenceAcknowledgementKind,
        result: &str,
    ) -> UpdateWebQuiescenceAcknowledgement {
        let identity = identity();
        UpdateWebQuiescenceAcknowledgement {
            kind,
            operation_id: identity.operation_id,
            operation_generation: identity.operation_generation,
            candidate_id: identity.candidate_id,
            result: result.to_owned(),
            receipt: None,
            checkpoint_digest: None,
            checkpoint: None,
            reason: None,
        }
    }

    #[test]
    fn prepare_acknowledgement_is_exact_and_old_generation_cannot_steal_waiter() {
        tauri::async_runtime::block_on(async {
            let sink = Arc::new(RecordingSink::default());
            let port = TauriUpdateWebQuiescencePort::with_sink(sink.clone());
            let request = PrepareWebQuiescenceRequest {
                identity: identity(),
            };
            let running = {
                let port = port.clone();
                let request = request.clone();
                tauri::async_runtime::spawn(async move {
                    port.stage_checkpoint(&request, Duration::from_secs(1))
                        .await
                })
            };
            sink.emitted_notify.notified().await;

            let mut stale =
                acknowledgement(UpdateWebQuiescenceAcknowledgementKind::Prepare, "prepared");
            stale.operation_generation -= 1;
            stale.checkpoint = Some(checkpoint());
            assert!(!port.acknowledge(stale));

            let mut exact =
                acknowledgement(UpdateWebQuiescenceAcknowledgementKind::Prepare, "prepared");
            exact.checkpoint = Some(checkpoint());
            assert!(port.acknowledge(exact));
            assert_eq!(running.await.unwrap().unwrap(), checkpoint());
            let emitted = sink.emitted.lock().unwrap();
            assert_eq!(emitted.len(), 1);
            assert_eq!(emitted[0].0, UPDATE_WEB_QUIESCENCE_PREPARE_EVENT);
        });
    }

    #[test]
    fn rollback_requires_the_exact_persisted_checkpoint_evidence() {
        tauri::async_runtime::block_on(async {
            let sink = Arc::new(RecordingSink::default());
            let port = TauriUpdateWebQuiescencePort::with_sink(sink.clone());
            let request = RollbackWebQuiescenceRequest {
                identity: identity(),
                checkpoint: Some(
                    crate::runtime::updater::quiescence::PersistedPlaybackCheckpoint {
                        evidence: CheckpointEvidence {
                            receipt: "3".repeat(32),
                            digest: "4".repeat(64),
                        },
                        payload: checkpoint(),
                    },
                ),
            };
            let running = {
                let port = port.clone();
                let request = request.clone();
                tauri::async_runtime::spawn(async move {
                    port.rollback(&request, Duration::from_secs(1)).await
                })
            };
            sink.emitted_notify.notified().await;
            let mut wrong =
                acknowledgement(UpdateWebQuiescenceAcknowledgementKind::Rollback, "restored");
            wrong.receipt = Some("5".repeat(32));
            wrong.checkpoint_digest = Some("4".repeat(64));
            assert!(port.acknowledge(wrong));
            assert_eq!(
                running.await.unwrap(),
                Err(WebQuiescencePortFailure::Failed)
            );
        });
    }

    #[test]
    fn timeout_cleans_pending_acknowledgement_slot() {
        tauri::async_runtime::block_on(async {
            let sink = Arc::new(RecordingSink::default());
            let port = TauriUpdateWebQuiescencePort::with_sink(sink);
            let request = PrepareWebQuiescenceRequest {
                identity: identity(),
            };
            assert_eq!(
                port.stage_checkpoint(&request, Duration::from_millis(1))
                    .await,
                Err(WebQuiescencePortFailure::TimedOut)
            );
            let mut late =
                acknowledgement(UpdateWebQuiescenceAcknowledgementKind::Prepare, "prepared");
            late.checkpoint = Some(checkpoint());
            assert!(!port.acknowledge(late));
        });
    }
}
