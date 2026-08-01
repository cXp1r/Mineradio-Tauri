use std::{
    future::Future,
    path::PathBuf,
    pin::Pin,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use semver::Version;

use super::{
    cache::{
        persist_pending_quarantine, resume_pending_quarantine, CacheRecoveryFault,
        CacheRecoveryFaultKind, CacheRecoveryOutcome, InstallAttemptArtifactIdentity,
        RecoveredVerifiedCache, UpdateStartupRecovery, VerifiedCacheStore,
    },
    install_attempt::{
        InstallAttemptMarkerV1, InstallAttemptReconciliationV1, InstallAttemptRecovery,
        InstallAttemptStore, ReconciliationDisposition,
    },
    policy::NativeUpdatePolicyStore,
    quiescence::{CheckpointEvidence, WebQuiescenceIdentity, WebQuiescenceReconciliation},
    web_quiescence_handshake::{
        WebPlaybackQuiescencePort, WebQuiescenceHandshake, WebQuiescenceHandshakeError,
    },
};

type RecoveryFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

const GENERIC_BLOCKED_MESSAGE: &str = "安装尝试启动协调失败，已保留全部恢复证据";
const NOT_APPLIED_CODE: &str = "UPDATE_INSTALL_NOT_APPLIED";
const NOT_APPLIED_MESSAGE: &str = "安装器未应用目标版本，已恢复播放状态与已验证更新";

/// install-attempt 协调器只依赖三个窄 Port；普通 cache 恢复仍复用原入口。
pub(crate) trait InstallAttemptCachePort: Send + Sync {
    fn inspect_exact<'a>(
        &'a self,
        expected: &'a InstallAttemptArtifactIdentity,
    ) -> RecoveryFuture<'a, Result<(), CacheRecoveryFault>>;

    fn discard_exact<'a>(
        &'a self,
        expected: &'a InstallAttemptArtifactIdentity,
    ) -> RecoveryFuture<'a, Result<ExactCacheDiscardOutcome, CacheRecoveryFault>>;

    fn recover_ordinary<'a>(
        &'a self,
        current_version: &'a str,
    ) -> RecoveryFuture<'a, CacheRecoveryOutcome>;
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ExactCacheDiscardOutcome {
    Discarded,
    AlreadyDiscarded,
}

/// `VerifiedCacheStore` 的 exact adapter。Applied 重放只有在 cache 已完全不存在时才
/// 接受 AlreadyDiscarded；任何仍存在但不匹配的 pair 都 fail closed。
pub(crate) struct VerifiedCacheInstallAttemptPort {
    store: VerifiedCacheStore,
}

impl VerifiedCacheInstallAttemptPort {
    pub(crate) fn new(store: VerifiedCacheStore) -> Self {
        Self { store }
    }
}

impl InstallAttemptCachePort for VerifiedCacheInstallAttemptPort {
    fn inspect_exact<'a>(
        &'a self,
        expected: &'a InstallAttemptArtifactIdentity,
    ) -> RecoveryFuture<'a, Result<(), CacheRecoveryFault>> {
        Box::pin(async move {
            self.store
                .inspect_install_attempt_artifact(expected)
                .await
                .map(|_| ())
        })
    }

    fn discard_exact<'a>(
        &'a self,
        expected: &'a InstallAttemptArtifactIdentity,
    ) -> RecoveryFuture<'a, Result<ExactCacheDiscardOutcome, CacheRecoveryFault>> {
        Box::pin(async move {
            let recovered = match self.store.inspect_install_attempt_artifact(expected).await {
                Ok(recovered) => recovered,
                Err(fault)
                    if matches!(
                        fault.kind(),
                        CacheRecoveryFaultKind::Missing | CacheRecoveryFaultKind::Corrupt
                    ) =>
                {
                    return match self.store.resume_install_attempt_cleanup()? {
                        true => Ok(ExactCacheDiscardOutcome::Discarded),
                        false if fault.kind() == CacheRecoveryFaultKind::Missing => {
                            Ok(ExactCacheDiscardOutcome::AlreadyDiscarded)
                        }
                        false => Err(fault),
                    };
                }
                Err(fault) => return Err(fault),
            };
            recovered
                .artifact
                .discard()
                .map_err(|error| CacheRecoveryFault {
                    code: error.code(),
                    message: "exact install-attempt cache 无法安全清理",
                })?;
            Ok(ExactCacheDiscardOutcome::Discarded)
        })
    }

    fn recover_ordinary<'a>(
        &'a self,
        current_version: &'a str,
    ) -> RecoveryFuture<'a, CacheRecoveryOutcome> {
        Box::pin(async move { self.store.recover(current_version).await })
    }
}

/// 持久化 authenticity rejection 的 policy 必须幂等；返回成功意味着新进程即使
/// 在下一条指令前崩溃，也不会遗忘 exact rejected candidate。
pub(crate) trait InstallAttemptRejectionPolicyPort: Send + Sync {
    fn persist_exact_rejection<'a>(
        &'a self,
        expected: &'a InstallAttemptArtifactIdentity,
        reason: &'a CacheRecoveryFault,
    ) -> RecoveryFuture<'a, Result<(), CacheRecoveryFault>>;
}

/// 这个 Port 的成功边界同时覆盖：policy 已 durable、cache quarantine journal 已
/// durable、被拒绝 cache 已 finalize。调用方只有收到 Ok 才能消费 reconciliation。
pub(crate) trait InstallAttemptQuarantinePort: Send + Sync {
    fn persist_policy_and_quarantine<'a>(
        &'a self,
        expected: &'a InstallAttemptArtifactIdentity,
        reason: &'a CacheRecoveryFault,
    ) -> RecoveryFuture<'a, Result<(), CacheRecoveryFault>>;

    /// 只允许 durable exact journal 续做半完成 quarantine，不得凭损坏 cache 新建 journal。
    fn resume_exact_quarantine<'a>(
        &'a self,
        expected: &'a InstallAttemptArtifactIdentity,
        reason: &'a CacheRecoveryFault,
    ) -> RecoveryFuture<'a, Result<(), CacheRecoveryFault>>;
}

pub(crate) struct VerifiedCacheInstallAttemptQuarantinePort {
    updater_directory: PathBuf,
    policy: Arc<dyn InstallAttemptRejectionPolicyPort>,
}

impl VerifiedCacheInstallAttemptQuarantinePort {
    pub(crate) fn new(
        updater_directory: impl Into<PathBuf>,
        policy: Arc<dyn InstallAttemptRejectionPolicyPort>,
    ) -> Self {
        Self {
            updater_directory: updater_directory.into(),
            policy,
        }
    }
}

impl InstallAttemptQuarantinePort for VerifiedCacheInstallAttemptQuarantinePort {
    fn persist_policy_and_quarantine<'a>(
        &'a self,
        expected: &'a InstallAttemptArtifactIdentity,
        reason: &'a CacheRecoveryFault,
    ) -> RecoveryFuture<'a, Result<(), CacheRecoveryFault>> {
        Box::pin(async move {
            self.policy
                .persist_exact_rejection(expected, reason)
                .await?;
            let pending = persist_pending_quarantine(
                &self.updater_directory,
                expected.candidate_id(),
                expected.version(),
                reason.code,
            )
            .map_err(|error| CacheRecoveryFault {
                code: error.code,
                message: "无法持久化 exact authenticity rejection journal",
            })?;
            if pending.rejected().candidate_id != expected.candidate_id()
                || pending.rejected().version != expected.version()
                || pending.rejected().reason_code != reason.code
            {
                return Err(identity_conflict_fault());
            }
            pending.finalize().map_err(|error| CacheRecoveryFault {
                code: error.code,
                message: "authenticity rejection policy 已保存，但 cache quarantine 未完成",
            })
        })
    }

    fn resume_exact_quarantine<'a>(
        &'a self,
        expected: &'a InstallAttemptArtifactIdentity,
        reason: &'a CacheRecoveryFault,
    ) -> RecoveryFuture<'a, Result<(), CacheRecoveryFault>> {
        Box::pin(async move {
            self.policy
                .persist_exact_rejection(expected, reason)
                .await?;
            resume_pending_quarantine(
                &self.updater_directory,
                expected.candidate_id(),
                expected.version(),
                reason.code,
            )
            .map_err(|error| CacheRecoveryFault {
                code: error.code,
                message: "无法续做 exact authenticity rejection journal",
            })
        })
    }
}

pub(crate) trait InstallAttemptWebPort: Send + Sync {
    fn verify_pending<'a>(
        &'a self,
        attempt: &'a InstallAttemptMarkerV1,
        updated_at: u64,
    ) -> RecoveryFuture<'a, Result<(), CacheRecoveryFault>>;

    fn consume_applied<'a>(
        &'a self,
        attempt: &'a InstallAttemptMarkerV1,
        completed_at: u64,
    ) -> RecoveryFuture<'a, Result<(), CacheRecoveryFault>>;

    fn restore<'a>(
        &'a self,
        attempt: &'a InstallAttemptMarkerV1,
        updated_at: u64,
    ) -> RecoveryFuture<'a, Result<(), CacheRecoveryFault>>;

    fn reconcile_orphan<'a>(
        &'a self,
        updated_at: u64,
    ) -> RecoveryFuture<'a, Result<(), CacheRecoveryFault>>;
}

impl<P: WebPlaybackQuiescencePort> InstallAttemptWebPort for WebQuiescenceHandshake<P> {
    fn verify_pending<'a>(
        &'a self,
        attempt: &'a InstallAttemptMarkerV1,
        updated_at: u64,
    ) -> RecoveryFuture<'a, Result<(), CacheRecoveryFault>> {
        Box::pin(async move {
            let reconciliation = self
                .store()
                .reconcile_startup(true, updated_at)
                .map_err(web_store_fault)?;
            match reconciliation {
                WebQuiescenceReconciliation::InstallAttemptPending {
                    identity,
                    checkpoint,
                } if web_identity_matches(attempt, &identity)
                    && checkpoint.evidence == checkpoint_evidence(attempt) =>
                {
                    Ok(())
                }
                _ => Err(web_identity_fault()),
            }
        })
    }

    fn consume_applied<'a>(
        &'a self,
        attempt: &'a InstallAttemptMarkerV1,
        completed_at: u64,
    ) -> RecoveryFuture<'a, Result<(), CacheRecoveryFault>> {
        Box::pin(async move {
            self.store()
                .consume_applied_install(
                    &web_identity(attempt),
                    &checkpoint_evidence(attempt),
                    completed_at,
                )
                .map(|_| ())
                .map_err(web_store_fault)
        })
    }

    fn restore<'a>(
        &'a self,
        attempt: &'a InstallAttemptMarkerV1,
        updated_at: u64,
    ) -> RecoveryFuture<'a, Result<(), CacheRecoveryFault>> {
        Box::pin(async move {
            self.restore_install_attempt(
                &web_identity(attempt),
                &checkpoint_evidence(attempt),
                updated_at,
            )
            .await
            .map(|_| ())
            .map_err(web_handshake_fault)
        })
    }

    fn reconcile_orphan<'a>(
        &'a self,
        updated_at: u64,
    ) -> RecoveryFuture<'a, Result<(), CacheRecoveryFault>> {
        Box::pin(async move {
            match self
                .store()
                .reconcile_startup(false, updated_at)
                .map_err(web_store_fault)?
            {
                WebQuiescenceReconciliation::Idle
                | WebQuiescenceReconciliation::CompletedRecovered(_) => Ok(()),
                WebQuiescenceReconciliation::RequestPrepare(request) => {
                    self.rollback_orphan_prepare(&request.identity, updated_at)
                        .await
                }
                WebQuiescenceReconciliation::RepeatPreparedAcknowledgement { identity, .. } => {
                    self.rollback_orphan_prepare(&identity, updated_at).await
                }
                WebQuiescenceReconciliation::NativeRollbackRequired(identity) => {
                    self.confirm_and_rollback_orphan(&identity, updated_at)
                        .await
                }
                WebQuiescenceReconciliation::RequestRollback(request) => self
                    .rollback_after_native_confirmation(&request.identity, updated_at)
                    .await
                    .map(|_| ())
                    .map_err(web_handshake_fault),
                WebQuiescenceReconciliation::InstallAttemptPending { .. } => {
                    Err(web_identity_fault())
                }
            }
        })
    }
}

impl<P: WebPlaybackQuiescencePort> WebQuiescenceHandshake<P> {
    async fn rollback_orphan_prepare(
        &self,
        identity: &WebQuiescenceIdentity,
        updated_at: u64,
    ) -> Result<(), CacheRecoveryFault> {
        self.mark_pre_spawn_failure(identity, updated_at)
            .map_err(web_handshake_fault)?;
        self.confirm_and_rollback_orphan(identity, updated_at).await
    }

    async fn confirm_and_rollback_orphan(
        &self,
        identity: &WebQuiescenceIdentity,
        updated_at: u64,
    ) -> Result<(), CacheRecoveryFault> {
        self.store()
            .confirm_native_rollback(identity, updated_at)
            .map_err(web_store_fault)?;
        self.rollback_after_native_confirmation(identity, updated_at)
            .await
            .map(|_| ())
            .map_err(web_handshake_fault)
    }
}

pub(crate) trait InstallAttemptClock: Send + Sync {
    fn now_millis(&self) -> Result<u64, CacheRecoveryFault>;
}

#[derive(Default)]
pub(crate) struct SystemInstallAttemptClock;

impl InstallAttemptClock for SystemInstallAttemptClock {
    fn now_millis(&self) -> Result<u64, CacheRecoveryFault> {
        let value = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| clock_fault())?
            .as_millis();
        u64::try_from(value)
            .ok()
            .filter(|value| *value <= 9_007_199_254_740_991)
            .ok_or_else(clock_fault)
    }
}

/// 生产 install-attempt authenticity rejection adapter。它与 Update Runtime 共享同一个
/// native policy store，使 exact quarantine 的检查与写入处于同一 I/O 临界区。
pub(crate) struct NativeInstallAttemptRejectionPolicy {
    store: Arc<NativeUpdatePolicyStore>,
    clock: Arc<dyn InstallAttemptClock>,
}

impl NativeInstallAttemptRejectionPolicy {
    pub(crate) fn new(store: Arc<NativeUpdatePolicyStore>) -> Self {
        Self::with_clock(store, Arc::new(SystemInstallAttemptClock))
    }

    fn with_clock(
        store: Arc<NativeUpdatePolicyStore>,
        clock: Arc<dyn InstallAttemptClock>,
    ) -> Self {
        Self { store, clock }
    }
}

impl InstallAttemptRejectionPolicyPort for NativeInstallAttemptRejectionPolicy {
    fn persist_exact_rejection<'a>(
        &'a self,
        expected: &'a InstallAttemptArtifactIdentity,
        reason: &'a CacheRecoveryFault,
    ) -> RecoveryFuture<'a, Result<(), CacheRecoveryFault>> {
        Box::pin(async move {
            let rejected_at = self.clock.now_millis()?;
            self.store
                .persist_exact_quarantine(
                    expected.candidate_id(),
                    expected.version(),
                    reason.code,
                    rejected_at,
                )
                .map_err(|error| CacheRecoveryFault {
                    code: error.code(),
                    message: "无法持久化 exact install-attempt quarantine 策略",
                })
        })
    }
}

/// 启动恢复的深模块。它先协调 install-attempt/Web/cache 三方证据，再把控制权
/// 交回普通 cache 恢复，避免普通版本清理提前销毁升级结果证据。
pub(crate) struct InstallAttemptStartupRecovery {
    attempts: Arc<InstallAttemptStore>,
    cache: Arc<dyn InstallAttemptCachePort>,
    web: Arc<dyn InstallAttemptWebPort>,
    quarantine: Arc<dyn InstallAttemptQuarantinePort>,
    clock: Arc<dyn InstallAttemptClock>,
}

impl InstallAttemptStartupRecovery {
    pub(crate) fn new(
        attempts: Arc<InstallAttemptStore>,
        cache: Arc<dyn InstallAttemptCachePort>,
        web: Arc<dyn InstallAttemptWebPort>,
        quarantine: Arc<dyn InstallAttemptQuarantinePort>,
    ) -> Self {
        Self::with_clock(
            attempts,
            cache,
            web,
            quarantine,
            Arc::new(SystemInstallAttemptClock),
        )
    }

    pub(crate) fn with_clock(
        attempts: Arc<InstallAttemptStore>,
        cache: Arc<dyn InstallAttemptCachePort>,
        web: Arc<dyn InstallAttemptWebPort>,
        quarantine: Arc<dyn InstallAttemptQuarantinePort>,
        clock: Arc<dyn InstallAttemptClock>,
    ) -> Self {
        Self {
            attempts,
            cache,
            web,
            quarantine,
            clock,
        }
    }

    pub(crate) async fn recover(&self, current_version: &str) -> CacheRecoveryOutcome {
        let attempt_recovery = match self.attempts.recover() {
            Ok(recovery) => recovery,
            Err(error) => return blocked(error.code()),
        };
        let now = match self.clock.now_millis() {
            Ok(now) => now,
            Err(fault) => return CacheRecoveryOutcome::Blocked(fault),
        };

        match attempt_recovery {
            InstallAttemptRecovery::None => {
                if let Err(fault) = self.web.reconcile_orphan(now).await {
                    return CacheRecoveryOutcome::Blocked(fault);
                }
                self.cache.recover_ordinary(current_version).await
            }
            InstallAttemptRecovery::Pending(attempt) => {
                self.reconcile_pending(current_version, attempt, now).await
            }
            InstallAttemptRecovery::Reconciled(reconciliation) => {
                self.replay_reconciliation(current_version, reconciliation, now)
                    .await
            }
            InstallAttemptRecovery::ConsumedCleanupPending(reconciliation) => {
                if let Err(fault) = validate_reconciled_version(current_version, &reconciliation) {
                    return CacheRecoveryOutcome::Blocked(fault);
                }
                if let Err(error) = self.attempts.consume_reconciliation(&reconciliation) {
                    return blocked(error.code());
                }
                self.finish_ordinary(current_version, &reconciliation).await
            }
            InstallAttemptRecovery::ConsumedReceipt(reconciliation) => {
                // consumed receipt 不再代表 active install attempt；与 None 路径一样，
                // 先协调当前 Web orphan。该动作不由历史 receipt 驱动，也不会重放
                // 已消费 attempt 的 exact Web/cache effect。
                if let Err(fault) = self.web.reconcile_orphan(now).await {
                    return CacheRecoveryOutcome::Blocked(fault);
                }
                self.finish_consumed_receipt(current_version, &reconciliation)
                    .await
            }
        }
    }

    async fn reconcile_pending(
        &self,
        current_version: &str,
        attempt: InstallAttemptMarkerV1,
        now: u64,
    ) -> CacheRecoveryOutcome {
        // 顺序是安全契约：attempt 已先读取，Web 五轴必须先于版本与 cache 判定。
        if let Err(fault) = self.web.verify_pending(&attempt, now).await {
            return CacheRecoveryOutcome::Blocked(fault);
        }
        let relation = match version_relation(current_version, attempt.target_version()) {
            Ok(relation) => relation,
            Err(fault) => return CacheRecoveryOutcome::Blocked(fault),
        };
        let expected = match artifact_identity(&attempt) {
            Ok(expected) => expected,
            Err(fault) => return CacheRecoveryOutcome::Blocked(fault),
        };
        let disposition = match self.cache.inspect_exact(&expected).await {
            Ok(()) => match relation {
                VersionRelation::Applied => ReconciliationDisposition::Applied,
                VersionRelation::NotApplied => ReconciliationDisposition::NotApplied,
            },
            Err(fault)
                if relation == VersionRelation::NotApplied
                    && fault.kind() == CacheRecoveryFaultKind::AuthenticityRejected =>
            {
                ReconciliationDisposition::AuthenticityRejected
            }
            Err(fault) => return CacheRecoveryOutcome::Blocked(fault),
        };

        if let Err(error) = self
            .attempts
            .complete_reconciliation(&attempt, disposition, now)
        {
            return blocked(error.code());
        }
        let reconciliation = match self.attempts.recover() {
            Ok(InstallAttemptRecovery::Reconciled(reconciliation)) => reconciliation,
            Ok(InstallAttemptRecovery::ConsumedCleanupPending(reconciliation)) => {
                return self
                    .finish_consumed_cleanup(current_version, reconciliation)
                    .await;
            }
            Ok(_) => return blocked("UPDATE_INSTALL_ATTEMPT_RECONCILIATION_MISSING"),
            Err(error) => return blocked(error.code()),
        };
        self.execute_reconciliation(current_version, reconciliation, now)
            .await
    }

    async fn replay_reconciliation(
        &self,
        current_version: &str,
        reconciliation: InstallAttemptReconciliationV1,
        now: u64,
    ) -> CacheRecoveryOutcome {
        if let Err(fault) = validate_reconciled_version(current_version, &reconciliation) {
            return CacheRecoveryOutcome::Blocked(fault);
        }
        self.execute_reconciliation(current_version, reconciliation, now)
            .await
    }

    async fn execute_reconciliation(
        &self,
        current_version: &str,
        reconciliation: InstallAttemptReconciliationV1,
        now: u64,
    ) -> CacheRecoveryOutcome {
        let attempt = reconciliation.attempt();
        let expected = match artifact_identity(attempt) {
            Ok(expected) => expected,
            Err(fault) => return CacheRecoveryOutcome::Blocked(fault),
        };

        // disposition 在版本约束、effect replay 与 ordinary-cache 终态处分别穷举；
        // 这是刻意的 fail-closed 状态机边界，新增变体必须同时补齐三处编译期审查。
        let action = match reconciliation.disposition() {
            ReconciliationDisposition::Applied => {
                if let Err(fault) = self.web.consume_applied(attempt, now).await {
                    Err(fault)
                } else {
                    self.cache.discard_exact(&expected).await.map(|_| ())
                }
            }
            ReconciliationDisposition::NotApplied => {
                if let Err(fault) = self.web.restore(attempt, now).await {
                    Err(fault)
                } else {
                    // Tombstone 已冻结 NotApplied；重放只执行其 RevalidateReadyToInstall
                    // resolution，不依据新观测改写 disposition。
                    self.cache.inspect_exact(&expected).await
                }
            }
            ReconciliationDisposition::AuthenticityRejected => {
                if let Err(fault) = self.web.restore(attempt, now).await {
                    Err(fault)
                } else {
                    let reason = authenticity_fault();
                    match self.cache.inspect_exact(&expected).await {
                        Err(fault)
                            if fault.kind() == CacheRecoveryFaultKind::AuthenticityRejected =>
                        {
                            self.quarantine
                                .persist_policy_and_quarantine(&expected, &reason)
                                .await
                        }
                        Err(fault) if fault.kind() == CacheRecoveryFaultKind::Missing => {
                            // finalize 已完成但 consumed receipt 尚未提交时，空 cache 可以
                            // 安全重建 exact journal 并再次完成幂等清理。
                            self.quarantine
                                .persist_policy_and_quarantine(&expected, &reason)
                                .await
                        }
                        Err(fault) if fault.kind() == CacheRecoveryFaultKind::Corrupt => {
                            self.quarantine
                                .resume_exact_quarantine(&expected, &reason)
                                .await
                        }
                        Err(fault) => Err(fault),
                        Ok(()) => Err(identity_conflict_fault()),
                    }
                }
            }
        };
        if let Err(fault) = action {
            return CacheRecoveryOutcome::Blocked(fault);
        }
        if let Err(error) = self.attempts.consume_reconciliation(&reconciliation) {
            return blocked(error.code());
        }
        self.finish_ordinary(current_version, &reconciliation).await
    }

    async fn finish_consumed_cleanup(
        &self,
        current_version: &str,
        reconciliation: InstallAttemptReconciliationV1,
    ) -> CacheRecoveryOutcome {
        if let Err(error) = self.attempts.consume_reconciliation(&reconciliation) {
            return blocked(error.code());
        }
        self.finish_ordinary(current_version, &reconciliation).await
    }

    async fn finish_ordinary(
        &self,
        current_version: &str,
        reconciliation: &InstallAttemptReconciliationV1,
    ) -> CacheRecoveryOutcome {
        let ordinary = self.cache.recover_ordinary(current_version).await;
        match reconciliation.disposition() {
            ReconciliationDisposition::Applied => match ordinary {
                CacheRecoveryOutcome::Empty { .. } | CacheRecoveryOutcome::Blocked(_) => ordinary,
                CacheRecoveryOutcome::Recovered(_) | CacheRecoveryOutcome::PendingQuarantine(_) => {
                    blocked("UPDATE_INSTALL_APPLIED_CACHE_NOT_EMPTY")
                }
            },
            ReconciliationDisposition::NotApplied => match ordinary {
                CacheRecoveryOutcome::Recovered(mut recovered)
                    if recovered_matches_attempt(&recovered, reconciliation.attempt()) =>
                {
                    recovered.recovery_fault = Some(not_applied_fault());
                    CacheRecoveryOutcome::Recovered(recovered)
                }
                CacheRecoveryOutcome::Blocked(_) => ordinary,
                CacheRecoveryOutcome::Empty { .. }
                | CacheRecoveryOutcome::Recovered(_)
                | CacheRecoveryOutcome::PendingQuarantine(_) => {
                    blocked("UPDATE_INSTALL_NOT_APPLIED_CACHE_REJECTED")
                }
            },
            ReconciliationDisposition::AuthenticityRejected => match ordinary {
                CacheRecoveryOutcome::Empty { quarantine, .. } => CacheRecoveryOutcome::Empty {
                    fault: Some(authenticity_fault()),
                    quarantine,
                },
                CacheRecoveryOutcome::Blocked(_) => ordinary,
                CacheRecoveryOutcome::Recovered(_) | CacheRecoveryOutcome::PendingQuarantine(_) => {
                    blocked("UPDATE_INSTALL_AUTH_REJECTION_INCOMPLETE")
                }
            },
        }
    }

    /// consumed receipt 是历史诊断证据，绝不能再次驱动 Web/cache mutation。只有缓存
    /// 仍与一次 NotApplied attempt 完全一致时才重放稳定 fault；候选已变化则让普通
    /// cache recovery 的当前事实获胜。
    async fn finish_consumed_receipt(
        &self,
        current_version: &str,
        reconciliation: &InstallAttemptReconciliationV1,
    ) -> CacheRecoveryOutcome {
        let ordinary = self.cache.recover_ordinary(current_version).await;
        if reconciliation.disposition() != ReconciliationDisposition::NotApplied {
            return ordinary;
        }
        match ordinary {
            CacheRecoveryOutcome::Recovered(mut recovered)
                if recovered_matches_attempt(&recovered, reconciliation.attempt()) =>
            {
                recovered.recovery_fault = Some(not_applied_fault());
                CacheRecoveryOutcome::Recovered(recovered)
            }
            outcome => outcome,
        }
    }
}

impl UpdateStartupRecovery for InstallAttemptStartupRecovery {
    fn recover<'a>(&'a self, current_version: &'a str) -> RecoveryFuture<'a, CacheRecoveryOutcome> {
        Box::pin(async move { InstallAttemptStartupRecovery::recover(self, current_version).await })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum VersionRelation {
    Applied,
    NotApplied,
}

fn version_relation(
    current_version: &str,
    target_version: &str,
) -> Result<VersionRelation, CacheRecoveryFault> {
    let current = parse_stable_canonical_version(current_version)?;
    let target = parse_stable_canonical_version(target_version)?;
    Ok(if current >= target {
        VersionRelation::Applied
    } else {
        VersionRelation::NotApplied
    })
}

fn validate_reconciled_version(
    current_version: &str,
    reconciliation: &InstallAttemptReconciliationV1,
) -> Result<(), CacheRecoveryFault> {
    let relation = version_relation(current_version, reconciliation.attempt().target_version())?;
    let valid = matches!(
        (reconciliation.disposition(), relation),
        (ReconciliationDisposition::Applied, VersionRelation::Applied)
            | (
                ReconciliationDisposition::NotApplied
                    | ReconciliationDisposition::AuthenticityRejected,
                VersionRelation::NotApplied
            )
    );
    valid.then_some(()).ok_or_else(version_relation_fault)
}

fn parse_stable_canonical_version(raw: &str) -> Result<Version, CacheRecoveryFault> {
    let version = Version::parse(raw).map_err(|_| version_fault())?;
    if !version.pre.is_empty() || !version.build.is_empty() || version.to_string() != raw {
        return Err(version_fault());
    }
    Ok(version)
}

fn artifact_identity(
    attempt: &InstallAttemptMarkerV1,
) -> Result<InstallAttemptArtifactIdentity, CacheRecoveryFault> {
    InstallAttemptArtifactIdentity::new(
        attempt.candidate_id(),
        attempt.target_version(),
        attempt.provenance_sha256(),
        attempt.candidate_metadata_digest(),
        attempt.installer_sha256(),
        attempt.installer_size(),
    )
}

fn web_identity(attempt: &InstallAttemptMarkerV1) -> WebQuiescenceIdentity {
    WebQuiescenceIdentity {
        operation_id: attempt.operation_id().to_owned(),
        operation_generation: attempt.operation_generation(),
        candidate_id: attempt.candidate_id().to_owned(),
    }
}

fn checkpoint_evidence(attempt: &InstallAttemptMarkerV1) -> CheckpointEvidence {
    CheckpointEvidence {
        receipt: attempt.checkpoint_receipt().to_owned(),
        digest: attempt.checkpoint_digest().to_owned(),
    }
}

fn web_identity_matches(
    attempt: &InstallAttemptMarkerV1,
    identity: &WebQuiescenceIdentity,
) -> bool {
    identity == &web_identity(attempt)
}

fn recovered_matches_attempt(
    recovered: &RecoveredVerifiedCache,
    attempt: &InstallAttemptMarkerV1,
) -> bool {
    let identity = recovered.artifact.identity();
    identity.candidate_id().as_str() == attempt.candidate_id()
        && identity.version() == attempt.target_version()
        && identity.provenance_sha256() == attempt.provenance_sha256()
        && identity.metadata_digest() == attempt.candidate_metadata_digest()
        && identity.installer_sha256() == attempt.installer_sha256()
        && identity.installer_size() == attempt.installer_size()
        && recovered.metadata_digest == attempt.candidate_metadata_digest()
}

fn blocked(code: &'static str) -> CacheRecoveryOutcome {
    CacheRecoveryOutcome::Blocked(CacheRecoveryFault {
        code,
        message: GENERIC_BLOCKED_MESSAGE,
    })
}

fn web_store_fault(error: super::quiescence::WebQuiescenceError) -> CacheRecoveryFault {
    CacheRecoveryFault {
        code: error.code(),
        message: GENERIC_BLOCKED_MESSAGE,
    }
}

fn web_handshake_fault(error: WebQuiescenceHandshakeError) -> CacheRecoveryFault {
    CacheRecoveryFault {
        code: if error.requires_listener_reconciliation() {
            super::WEB_RECONCILIATION_REQUIRED_FAULT
        } else {
            error.code()
        },
        message: GENERIC_BLOCKED_MESSAGE,
    }
}

fn version_fault() -> CacheRecoveryFault {
    CacheRecoveryFault {
        code: "UPDATE_INSTALL_CURRENT_VERSION_REJECTED",
        message: "当前应用版本不是 canonical stable SemVer",
    }
}

fn version_relation_fault() -> CacheRecoveryFault {
    CacheRecoveryFault {
        code: "UPDATE_INSTALL_RECONCILIATION_VERSION_CONFLICT",
        message: "持久化安装结论与当前应用版本关系冲突",
    }
}

fn identity_conflict_fault() -> CacheRecoveryFault {
    CacheRecoveryFault {
        code: "UPDATE_CACHE_IDENTITY_CONFLICT",
        message: "安装尝试与已验证更新缓存 identity 不一致",
    }
}

fn web_identity_fault() -> CacheRecoveryFault {
    CacheRecoveryFault {
        code: "UPDATE_INSTALL_ATTEMPT_WEB_STATE_REJECTED",
        message: "install-attempt 与 Web checkpoint 五轴 identity 不一致",
    }
}

fn authenticity_fault() -> CacheRecoveryFault {
    CacheRecoveryFault {
        code: "UPDATE_CACHE_AUTHENTICITY_REJECTED",
        message: "exact install-attempt cache 无法重新通过来源与签名验证",
    }
}

fn not_applied_fault() -> CacheRecoveryFault {
    CacheRecoveryFault {
        code: NOT_APPLIED_CODE,
        message: NOT_APPLIED_MESSAGE,
    }
}

fn clock_fault() -> CacheRecoveryFault {
    CacheRecoveryFault {
        code: "UPDATE_INSTALL_RECOVERY_CLOCK_REJECTED",
        message: "无法取得安全的安装恢复时间",
    }
}

#[cfg(test)]
mod tests {
    use std::{
        collections::{BTreeMap, VecDeque},
        fs, io,
        sync::{
            atomic::{AtomicBool, Ordering},
            Mutex,
        },
    };

    use super::*;
    use crate::runtime::updater::{
        download::VerifiedInstallerArtifact,
        install_attempt::{InstallAttemptFileSystem, InstallAttemptInput, ParentDurability},
        policy::{NativeUpdatePolicyStore, UpdatePolicyStore},
        provenance::ReleaseCandidateId,
        NormalizedRelease,
    };

    const CANDIDATE: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const PROVENANCE: &str = "9e0d294c05fc1d88d698034609bb81c0c69196327594e4c69d2915c80fd9850c";
    const METADATA: &str = "8e0d294c05fc1d88d698034609bb81c0c69196327594e4c69d2915c80fd9850c";
    const INSTALLER: &str = "9c0d294c05fc1d88d698034609bb81c0c69196327594e4c69d2915c80fd9850c";

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new(label: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "mineradio-startup-reconciliation-{label}-{}",
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
    struct EventLog(Mutex<Vec<String>>);

    impl EventLog {
        fn push(&self, event: &str) {
            self.0.lock().unwrap().push(event.into());
        }

        fn snapshot(&self) -> Vec<String> {
            self.0.lock().unwrap().clone()
        }
    }

    struct FakeCache {
        events: Arc<EventLog>,
        inspect: Mutex<VecDeque<Result<(), CacheRecoveryFault>>>,
        discard: Mutex<VecDeque<Result<ExactCacheDiscardOutcome, CacheRecoveryFault>>>,
        ordinary: Mutex<VecDeque<CacheRecoveryOutcome>>,
    }

    impl FakeCache {
        fn new(events: Arc<EventLog>) -> Self {
            Self {
                events,
                inspect: Mutex::new(VecDeque::new()),
                discard: Mutex::new(VecDeque::new()),
                ordinary: Mutex::new(VecDeque::new()),
            }
        }

        fn push_inspect(&self, result: Result<(), CacheRecoveryFault>) {
            self.inspect.lock().unwrap().push_back(result);
        }

        fn push_discard(&self, result: Result<ExactCacheDiscardOutcome, CacheRecoveryFault>) {
            self.discard.lock().unwrap().push_back(result);
        }

        fn push_ordinary(&self, result: CacheRecoveryOutcome) {
            self.ordinary.lock().unwrap().push_back(result);
        }
    }

    impl InstallAttemptCachePort for FakeCache {
        fn inspect_exact<'a>(
            &'a self,
            _expected: &'a InstallAttemptArtifactIdentity,
        ) -> RecoveryFuture<'a, Result<(), CacheRecoveryFault>> {
            Box::pin(async move {
                self.events.push("cache.inspect");
                self.inspect.lock().unwrap().pop_front().unwrap_or(Ok(()))
            })
        }

        fn discard_exact<'a>(
            &'a self,
            _expected: &'a InstallAttemptArtifactIdentity,
        ) -> RecoveryFuture<'a, Result<ExactCacheDiscardOutcome, CacheRecoveryFault>> {
            Box::pin(async move {
                self.events.push("cache.discard");
                self.discard
                    .lock()
                    .unwrap()
                    .pop_front()
                    .unwrap_or(Ok(ExactCacheDiscardOutcome::Discarded))
            })
        }

        fn recover_ordinary<'a>(
            &'a self,
            _current_version: &'a str,
        ) -> RecoveryFuture<'a, CacheRecoveryOutcome> {
            Box::pin(async move {
                self.events.push("cache.ordinary");
                self.ordinary
                    .lock()
                    .unwrap()
                    .pop_front()
                    .unwrap_or(CacheRecoveryOutcome::Empty {
                        fault: None,
                        quarantine: None,
                    })
            })
        }
    }

    struct FakeWeb {
        events: Arc<EventLog>,
        verify_result: Mutex<Result<(), CacheRecoveryFault>>,
        consume_result: Mutex<Result<(), CacheRecoveryFault>>,
        restore_result: Mutex<Result<(), CacheRecoveryFault>>,
        orphan_result: Mutex<Result<(), CacheRecoveryFault>>,
    }

    impl FakeWeb {
        fn new(events: Arc<EventLog>) -> Self {
            Self {
                events,
                verify_result: Mutex::new(Ok(())),
                consume_result: Mutex::new(Ok(())),
                restore_result: Mutex::new(Ok(())),
                orphan_result: Mutex::new(Ok(())),
            }
        }
    }

    impl InstallAttemptWebPort for FakeWeb {
        fn verify_pending<'a>(
            &'a self,
            _attempt: &'a InstallAttemptMarkerV1,
            _updated_at: u64,
        ) -> RecoveryFuture<'a, Result<(), CacheRecoveryFault>> {
            Box::pin(async move {
                self.events.push("web.verify");
                self.verify_result.lock().unwrap().clone()
            })
        }

        fn consume_applied<'a>(
            &'a self,
            _attempt: &'a InstallAttemptMarkerV1,
            _completed_at: u64,
        ) -> RecoveryFuture<'a, Result<(), CacheRecoveryFault>> {
            Box::pin(async move {
                self.events.push("web.consume");
                self.consume_result.lock().unwrap().clone()
            })
        }

        fn restore<'a>(
            &'a self,
            _attempt: &'a InstallAttemptMarkerV1,
            _updated_at: u64,
        ) -> RecoveryFuture<'a, Result<(), CacheRecoveryFault>> {
            Box::pin(async move {
                self.events.push("web.restore");
                self.restore_result.lock().unwrap().clone()
            })
        }

        fn reconcile_orphan<'a>(
            &'a self,
            _updated_at: u64,
        ) -> RecoveryFuture<'a, Result<(), CacheRecoveryFault>> {
            Box::pin(async move {
                self.events.push("web.orphan");
                self.orphan_result.lock().unwrap().clone()
            })
        }
    }

    struct FakeQuarantine {
        events: Arc<EventLog>,
        result: Mutex<Result<(), CacheRecoveryFault>>,
    }

    impl FakeQuarantine {
        fn new(events: Arc<EventLog>) -> Self {
            Self {
                events,
                result: Mutex::new(Ok(())),
            }
        }
    }

    impl InstallAttemptQuarantinePort for FakeQuarantine {
        fn persist_policy_and_quarantine<'a>(
            &'a self,
            _expected: &'a InstallAttemptArtifactIdentity,
            _reason: &'a CacheRecoveryFault,
        ) -> RecoveryFuture<'a, Result<(), CacheRecoveryFault>> {
            Box::pin(async move {
                self.events.push("cache.quarantine");
                self.result.lock().unwrap().clone()
            })
        }

        fn resume_exact_quarantine<'a>(
            &'a self,
            _expected: &'a InstallAttemptArtifactIdentity,
            _reason: &'a CacheRecoveryFault,
        ) -> RecoveryFuture<'a, Result<(), CacheRecoveryFault>> {
            Box::pin(async move {
                self.events.push("cache.resume-quarantine");
                self.result.lock().unwrap().clone()
            })
        }
    }

    struct FixedClock {
        // 测试 clock 同时持有 native store 的目录生命周期。
        _root: Option<TestDirectory>,
    }

    impl InstallAttemptClock for FixedClock {
        fn now_millis(&self) -> Result<u64, CacheRecoveryFault> {
            Ok(500)
        }
    }

    struct Harness {
        _root: TestDirectory,
        attempts: Arc<InstallAttemptStore>,
        cache: Arc<FakeCache>,
        web: Arc<FakeWeb>,
        quarantine: Arc<FakeQuarantine>,
        events: Arc<EventLog>,
    }

    impl Harness {
        fn new(label: &str) -> Self {
            let root = TestDirectory::new(label);
            let events = Arc::new(EventLog::default());
            Self {
                attempts: Arc::new(InstallAttemptStore::with_updater_directory(&root.0)),
                cache: Arc::new(FakeCache::new(events.clone())),
                web: Arc::new(FakeWeb::new(events.clone())),
                quarantine: Arc::new(FakeQuarantine::new(events.clone())),
                events,
                _root: root,
            }
        }

        fn publish(&self) -> InstallAttemptMarkerV1 {
            self.attempts.publish(attempt_input()).unwrap()
        }

        fn recovery(self) -> InstallAttemptStartupRecovery {
            let Self {
                _root,
                attempts,
                cache,
                web,
                quarantine,
                ..
            } = self;
            InstallAttemptStartupRecovery::with_clock(
                attempts,
                cache,
                web,
                quarantine,
                Arc::new(FixedClock { _root: Some(_root) }),
            )
        }
    }

    fn attempt_input() -> InstallAttemptInput {
        InstallAttemptInput {
            operation_id: "11111111111111111111111111111111".into(),
            operation_generation: 7,
            candidate_id: CANDIDATE.into(),
            target_version: "1.2.3".into(),
            provenance_sha256: PROVENANCE.into(),
            candidate_metadata_digest: METADATA.into(),
            installer_sha256: INSTALLER.into(),
            installer_size: 9,
            checkpoint_receipt: "22222222222222222222222222222222".into(),
            checkpoint_digest: "3333333333333333333333333333333333333333333333333333333333333333"
                .into(),
            created_at: 100,
        }
    }

    fn recovered_candidate() -> CacheRecoveryOutcome {
        let candidate_id = ReleaseCandidateId::fake(CANDIDATE);
        CacheRecoveryOutcome::Recovered(Box::new(RecoveredVerifiedCache {
            release: NormalizedRelease::new(CANDIDATE, "1.2.3", std::iter::empty::<&str>(), None),
            artifact: VerifiedInstallerArtifact::fake(candidate_id),
            metadata_digest: METADATA.into(),
            recovery_fault: None,
        }))
    }

    fn auth_fault() -> CacheRecoveryFault {
        authenticity_fault()
    }

    fn rejection_identity(candidate_id: &str) -> InstallAttemptArtifactIdentity {
        InstallAttemptArtifactIdentity::new(
            candidate_id,
            "1.2.3",
            PROVENANCE,
            METADATA,
            INSTALLER,
            9,
        )
        .unwrap()
    }

    struct RejectionClock(u64);

    impl InstallAttemptClock for RejectionClock {
        fn now_millis(&self) -> Result<u64, CacheRecoveryFault> {
            Ok(self.0)
        }
    }

    #[tokio::test]
    async fn native_rejection_policy_persists_exact_quarantine_idempotently() {
        let root = TestDirectory::new("native-rejection-idempotent");
        let store = Arc::new(NativeUpdatePolicyStore::for_app_data(&root.0));
        let expected = rejection_identity(CANDIDATE);
        let reason = CacheRecoveryFault {
            code: "UPDATE_CACHE_AUTHENTICITY_REJECTED",
            message: "测试 authenticity rejection",
        };

        NativeInstallAttemptRejectionPolicy::with_clock(
            store.clone(),
            Arc::new(RejectionClock(500)),
        )
        .persist_exact_rejection(&expected, &reason)
        .await
        .unwrap();
        NativeInstallAttemptRejectionPolicy::with_clock(
            store.clone(),
            Arc::new(RejectionClock(900)),
        )
        .persist_exact_rejection(&expected, &reason)
        .await
        .unwrap();

        let quarantine = store.load().unwrap().quarantine.unwrap();
        assert_eq!(quarantine.candidate_id, CANDIDATE);
        assert_eq!(quarantine.version, "1.2.3");
        assert_eq!(quarantine.reason, "UPDATE_CACHE_AUTHENTICITY_REJECTED");
        assert_eq!(quarantine.rejected_at, 500);
    }

    #[tokio::test]
    async fn native_rejection_policy_rejects_same_version_republished_candidate() {
        let root = TestDirectory::new("native-rejection-republished");
        let store = Arc::new(NativeUpdatePolicyStore::for_app_data(&root.0));
        let reason = CacheRecoveryFault {
            code: "UPDATE_CACHE_AUTHENTICITY_REJECTED",
            message: "测试 authenticity rejection",
        };
        let policy = NativeInstallAttemptRejectionPolicy::with_clock(
            store.clone(),
            Arc::new(RejectionClock(500)),
        );
        policy
            .persist_exact_rejection(&rejection_identity(CANDIDATE), &reason)
            .await
            .unwrap();

        let replacement = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        let error = policy
            .persist_exact_rejection(&rejection_identity(replacement), &reason)
            .await
            .unwrap_err();

        assert_eq!(error.code, "UPDATE_POLICY_QUARANTINE_IDENTITY_CONFLICT");
        let quarantine = store.load().unwrap().quarantine.unwrap();
        assert_eq!(quarantine.candidate_id, CANDIDATE);
        assert_eq!(quarantine.version, "1.2.3");
        assert_eq!(quarantine.rejected_at, 500);
    }

    fn outcome_code(outcome: &CacheRecoveryOutcome) -> Option<&'static str> {
        match outcome {
            CacheRecoveryOutcome::Blocked(fault) => Some(fault.code),
            CacheRecoveryOutcome::Empty { fault, .. } => fault.as_ref().map(|fault| fault.code),
            CacheRecoveryOutcome::Recovered(recovered) => {
                recovered.recovery_fault.as_ref().map(|fault| fault.code)
            }
            CacheRecoveryOutcome::PendingQuarantine(_) => None,
        }
    }

    #[tokio::test]
    async fn pending_applied_uses_web_version_cache_decision_then_exact_actions() {
        let harness = Harness::new("applied-order");
        harness.publish();
        let events = harness.events.clone();
        let recovery = harness.recovery();

        let outcome = recovery.recover("1.2.3").await;

        assert!(matches!(outcome, CacheRecoveryOutcome::Empty { .. }));
        assert_eq!(
            events.snapshot(),
            [
                "web.verify",
                "cache.inspect",
                "web.consume",
                "cache.discard",
                "cache.ordinary"
            ]
        );
    }

    #[tokio::test]
    async fn same_and_higher_versions_are_applied_while_lower_restores_candidate() {
        for current in ["1.2.3", "1.3.0"] {
            let harness = Harness::new("applied-version");
            harness.publish();
            let events = harness.events.clone();
            let outcome = harness.recovery().recover(current).await;
            assert!(matches!(outcome, CacheRecoveryOutcome::Empty { .. }));
            assert!(events.snapshot().contains(&"web.consume".into()));
        }

        let harness = Harness::new("not-applied-version");
        harness.publish();
        harness.cache.push_ordinary(recovered_candidate());
        let outcome = harness.recovery().recover("1.2.2").await;
        assert_eq!(outcome_code(&outcome), Some(NOT_APPLIED_CODE));
    }

    #[tokio::test]
    async fn invalid_prerelease_and_build_current_versions_preserve_pending_evidence() {
        for (index, current) in ["garbage", "1.2.3-rc.1", "1.2.3+build"]
            .into_iter()
            .enumerate()
        {
            let harness = Harness::new(&format!("invalid-current-{index}"));
            harness.publish();
            let events = harness.events.clone();
            let recovery = harness.recovery();
            assert_eq!(
                outcome_code(&recovery.recover(current).await),
                Some("UPDATE_INSTALL_CURRENT_VERSION_REJECTED")
            );
            assert_eq!(events.snapshot(), ["web.verify"]);
            assert!(matches!(
                recovery.attempts.recover().unwrap(),
                InstallAttemptRecovery::Pending(_)
            ));
        }
    }

    #[tokio::test]
    async fn web_mismatch_stops_before_version_and_cache_without_writing_decision() {
        let harness = Harness::new("web-mismatch");
        harness.publish();
        *harness.web.verify_result.lock().unwrap() = Err(web_identity_fault());
        let events = harness.events.clone();
        let recovery = harness.recovery();
        assert_eq!(
            outcome_code(&recovery.recover("1.2.3").await),
            Some("UPDATE_INSTALL_ATTEMPT_WEB_STATE_REJECTED")
        );
        assert_eq!(events.snapshot(), ["web.verify"]);
        assert!(matches!(
            recovery.attempts.recover().unwrap(),
            InstallAttemptRecovery::Pending(_)
        ));
    }

    #[tokio::test]
    async fn not_applied_crash_after_durable_decision_replays_web_and_cache_resolution() {
        let harness = Harness::new("decision-replay");
        let marker = harness.publish();
        harness
            .attempts
            .complete_reconciliation(&marker, ReconciliationDisposition::NotApplied, 200)
            .unwrap();
        harness.cache.push_ordinary(recovered_candidate());
        let events = harness.events.clone();

        let outcome = harness.recovery().recover("1.2.2").await;

        assert_eq!(outcome_code(&outcome), Some(NOT_APPLIED_CODE));
        assert_eq!(
            events.snapshot(),
            ["web.restore", "cache.inspect", "cache.ordinary"]
        );
    }

    #[tokio::test]
    async fn applied_retry_accepts_already_consumed_web_and_missing_cache() {
        let harness = Harness::new("applied-retry");
        let marker = harness.publish();
        harness
            .attempts
            .complete_reconciliation(&marker, ReconciliationDisposition::Applied, 200)
            .unwrap();
        harness
            .cache
            .push_discard(Ok(ExactCacheDiscardOutcome::AlreadyDiscarded));

        let outcome = harness.recovery().recover("1.2.3").await;

        assert!(matches!(outcome, CacheRecoveryOutcome::Empty { .. }));
    }

    #[tokio::test]
    async fn crash_after_web_completion_replays_tombstone_and_exact_cache_action() {
        let harness = Harness::new("web-completion-retry");
        harness.publish();
        harness.cache.push_discard(Err(CacheRecoveryFault {
            code: "UPDATE_CACHE_CLEANUP_BLOCKED",
            message: "测试 cache action 中断",
        }));
        let cache = harness.cache.clone();
        let events = harness.events.clone();
        let recovery = harness.recovery();

        assert_eq!(
            outcome_code(&recovery.recover("1.2.3").await),
            Some("UPDATE_CACHE_CLEANUP_BLOCKED")
        );
        assert!(matches!(
            recovery.attempts.recover().unwrap(),
            InstallAttemptRecovery::Reconciled(_)
        ));

        cache.push_discard(Ok(ExactCacheDiscardOutcome::Discarded));
        assert!(matches!(
            recovery.recover("1.2.3").await,
            CacheRecoveryOutcome::Empty { .. }
        ));
        assert_eq!(
            events.snapshot(),
            [
                "web.verify",
                "cache.inspect",
                "web.consume",
                "cache.discard",
                "web.consume",
                "cache.discard",
                "cache.ordinary"
            ]
        );
    }

    #[tokio::test]
    async fn authenticity_rejection_requires_successful_policy_and_quarantine_before_consume() {
        let harness = Harness::new("quarantine-failure");
        harness.publish();
        harness.cache.push_inspect(Err(auth_fault()));
        harness.cache.push_inspect(Err(auth_fault()));
        *harness.quarantine.result.lock().unwrap() = Err(CacheRecoveryFault {
            code: "UPDATE_QUARANTINE_POLICY_FAILED",
            message: "测试失败",
        });
        let recovery = harness.recovery();

        assert_eq!(
            outcome_code(&recovery.recover("1.2.2").await),
            Some("UPDATE_QUARANTINE_POLICY_FAILED")
        );
        assert!(matches!(
            recovery.attempts.recover().unwrap(),
            InstallAttemptRecovery::Reconciled(ref value)
                if value.disposition() == ReconciliationDisposition::AuthenticityRejected
        ));
    }

    #[tokio::test]
    async fn authenticity_rejection_replay_never_quarantines_a_replacement_cache() {
        let harness = Harness::new("quarantine-identity-conflict");
        let marker = harness.publish();
        harness
            .attempts
            .complete_reconciliation(
                &marker,
                ReconciliationDisposition::AuthenticityRejected,
                200,
            )
            .unwrap();
        harness.cache.push_inspect(Err(CacheRecoveryFault {
            code: "UPDATE_CACHE_IDENTITY_CONFLICT",
            message: "测试 replacement cache",
        }));
        let events = harness.events.clone();
        let recovery = harness.recovery();

        assert_eq!(
            outcome_code(&recovery.recover("1.2.2").await),
            Some("UPDATE_CACHE_IDENTITY_CONFLICT")
        );
        assert_eq!(events.snapshot(), ["web.restore", "cache.inspect"]);
        assert!(matches!(
            recovery.attempts.recover().unwrap(),
            InstallAttemptRecovery::Reconciled(ref value)
                if value.disposition() == ReconciliationDisposition::AuthenticityRejected
        ));
    }

    #[tokio::test]
    async fn authenticity_rejection_replay_only_resumes_a_durable_journal_for_corrupt_cache() {
        let harness = Harness::new("quarantine-corrupt-replay");
        let marker = harness.publish();
        harness
            .attempts
            .complete_reconciliation(
                &marker,
                ReconciliationDisposition::AuthenticityRejected,
                200,
            )
            .unwrap();
        harness.cache.push_inspect(Err(CacheRecoveryFault {
            code: "UPDATE_CACHE_CORRUPT",
            message: "测试 partially quarantined cache",
        }));
        let events = harness.events.clone();
        let recovery = harness.recovery();

        let outcome = recovery.recover("1.2.2").await;

        assert_eq!(
            outcome_code(&outcome),
            Some("UPDATE_CACHE_AUTHENTICITY_REJECTED")
        );
        assert_eq!(
            events.snapshot(),
            [
                "web.restore",
                "cache.inspect",
                "cache.resume-quarantine",
                "cache.ordinary"
            ]
        );
    }

    #[tokio::test]
    async fn reconciled_version_relation_conflict_never_replays_effects() {
        for (disposition, current) in [
            (ReconciliationDisposition::Applied, "1.2.2"),
            (ReconciliationDisposition::NotApplied, "1.2.3"),
            (ReconciliationDisposition::AuthenticityRejected, "1.3.0"),
        ] {
            let harness = Harness::new("relation-conflict");
            let marker = harness.publish();
            harness
                .attempts
                .complete_reconciliation(&marker, disposition, 200)
                .unwrap();
            let events = harness.events.clone();
            let outcome = harness.recovery().recover(current).await;
            assert_eq!(
                outcome_code(&outcome),
                Some("UPDATE_INSTALL_RECONCILIATION_VERSION_CONFLICT")
            );
            assert!(events.snapshot().is_empty());
        }
    }

    #[tokio::test]
    async fn no_attempt_reconciles_orphan_web_before_ordinary_cache_recovery() {
        let harness = Harness::new("orphan-order");
        let events = harness.events.clone();
        let outcome = harness.recovery().recover("1.0.0").await;
        assert!(matches!(outcome, CacheRecoveryOutcome::Empty { .. }));
        assert_eq!(events.snapshot(), ["web.orphan", "cache.ordinary"]);
    }

    #[derive(Default)]
    struct FaultingMemoryFileSystem {
        files: Mutex<BTreeMap<String, Vec<u8>>>,
        fail_remove: AtomicBool,
        fail_consumption_write: AtomicBool,
    }

    impl InstallAttemptFileSystem for FaultingMemoryFileSystem {
        fn read_bounded(&self, file_name: &str, max_bytes: u64) -> io::Result<Option<Vec<u8>>> {
            let files = self.files.lock().unwrap();
            let value = files.get(file_name).cloned();
            if value
                .as_ref()
                .is_some_and(|value| value.len() as u64 > max_bytes)
            {
                return Err(io::Error::new(io::ErrorKind::InvalidData, "too large"));
            }
            Ok(value)
        }

        fn write_temporary(&self, file_name: &str, bytes: &[u8]) -> io::Result<()> {
            if self.fail_consumption_write.load(Ordering::SeqCst)
                && file_name.contains("reconciliation-consumed")
            {
                return Err(io::Error::other("injected consumption write failure"));
            }
            let mut files = self.files.lock().unwrap();
            if files.contains_key(file_name) {
                return Err(io::Error::new(io::ErrorKind::AlreadyExists, "exists"));
            }
            files.insert(file_name.into(), bytes.to_vec());
            Ok(())
        }

        fn sync_temporary(&self, _file_name: &str) -> io::Result<()> {
            Ok(())
        }

        fn publish_replace(&self, temporary_name: &str, final_name: &str) -> io::Result<()> {
            let mut files = self.files.lock().unwrap();
            let value = files
                .remove(temporary_name)
                .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "missing"))?;
            files.insert(final_name.into(), value);
            Ok(())
        }

        fn remove(&self, file_name: &str) -> io::Result<bool> {
            if self.fail_remove.load(Ordering::SeqCst) {
                return Err(io::Error::other("injected remove failure"));
            }
            Ok(self.files.lock().unwrap().remove(file_name).is_some())
        }

        fn sync_parent(&self) -> io::Result<ParentDurability> {
            Ok(ParentDurability::DirectorySynced)
        }
    }

    #[tokio::test]
    async fn consumed_cleanup_pending_only_retries_receipt_cleanup_not_web_or_cache_actions() {
        let file_system = Arc::new(FaultingMemoryFileSystem::default());
        let attempts = InstallAttemptStore::with_file_system(file_system.clone());
        let marker = attempts.publish(attempt_input()).unwrap();
        attempts
            .complete_reconciliation(&marker, ReconciliationDisposition::Applied, 200)
            .unwrap();
        let reconciliation = match attempts.recover().unwrap() {
            InstallAttemptRecovery::Reconciled(value) => value,
            other => panic!("unexpected recovery: {other:?}"),
        };
        file_system.fail_remove.store(true, Ordering::SeqCst);
        assert!(attempts.consume_reconciliation(&reconciliation).is_err());
        file_system.fail_remove.store(false, Ordering::SeqCst);
        assert!(matches!(
            attempts.recover().unwrap(),
            InstallAttemptRecovery::ConsumedCleanupPending(_)
        ));

        let events = Arc::new(EventLog::default());
        let recovery = InstallAttemptStartupRecovery::with_clock(
            Arc::new(attempts),
            Arc::new(FakeCache::new(events.clone())),
            Arc::new(FakeWeb::new(events.clone())),
            Arc::new(FakeQuarantine::new(events.clone())),
            Arc::new(FixedClock { _root: None }),
        );
        let outcome = recovery.recover("1.2.3").await;

        assert!(matches!(outcome, CacheRecoveryOutcome::Empty { .. }));
        assert_eq!(events.snapshot(), ["cache.ordinary"]);
    }

    #[tokio::test]
    async fn consumed_not_applied_receipt_replays_only_the_stable_fault() {
        let harness = Harness::new("consumed-not-applied-receipt");
        let marker = harness.publish();
        harness
            .attempts
            .complete_reconciliation(&marker, ReconciliationDisposition::NotApplied, 200)
            .unwrap();
        let reconciliation = match harness.attempts.recover().unwrap() {
            InstallAttemptRecovery::Reconciled(value) => value,
            other => panic!("unexpected recovery: {other:?}"),
        };
        harness
            .attempts
            .consume_reconciliation(&reconciliation)
            .unwrap();
        harness.cache.push_ordinary(recovered_candidate());
        let events = harness.events.clone();
        let recovery = harness.recovery();

        let outcome = recovery.recover("1.2.2").await;

        assert_eq!(outcome_code(&outcome), Some(NOT_APPLIED_CODE));
        assert_eq!(events.snapshot(), ["web.orphan", "cache.ordinary"]);
    }

    #[tokio::test]
    async fn old_consumed_receipt_cannot_mask_a_new_orphan_web_transaction() {
        let harness = Harness::new("consumed-receipt-new-web-orphan");
        let marker = harness.publish();
        harness
            .attempts
            .complete_reconciliation(&marker, ReconciliationDisposition::NotApplied, 200)
            .unwrap();
        let reconciliation = match harness.attempts.recover().unwrap() {
            InstallAttemptRecovery::Reconciled(value) => value,
            other => panic!("unexpected recovery: {other:?}"),
        };
        harness
            .attempts
            .consume_reconciliation(&reconciliation)
            .unwrap();
        *harness.web.orphan_result.lock().unwrap() = Err(CacheRecoveryFault {
            code: "UPDATE_WEB_QUIESCENCE_ROLLBACK_REQUIRED",
            message: "测试新 Web orphan 尚未完成回滚",
        });
        let events = harness.events.clone();
        let recovery = harness.recovery();

        let outcome = recovery.recover("1.2.2").await;

        assert_eq!(
            outcome_code(&outcome),
            Some("UPDATE_WEB_QUIESCENCE_ROLLBACK_REQUIRED")
        );
        assert_eq!(events.snapshot(), ["web.orphan"]);
    }

    #[tokio::test]
    async fn crash_after_cache_action_but_before_receipt_replays_exact_actions_then_consumes() {
        let file_system = Arc::new(FaultingMemoryFileSystem::default());
        let attempts = InstallAttemptStore::with_file_system(file_system.clone());
        let marker = attempts.publish(attempt_input()).unwrap();
        attempts
            .complete_reconciliation(&marker, ReconciliationDisposition::Applied, 200)
            .unwrap();
        file_system
            .fail_consumption_write
            .store(true, Ordering::SeqCst);

        let events = Arc::new(EventLog::default());
        let cache = Arc::new(FakeCache::new(events.clone()));
        let recovery = InstallAttemptStartupRecovery::with_clock(
            Arc::new(attempts),
            cache.clone(),
            Arc::new(FakeWeb::new(events.clone())),
            Arc::new(FakeQuarantine::new(events.clone())),
            Arc::new(FixedClock { _root: None }),
        );

        assert_eq!(
            outcome_code(&recovery.recover("1.2.3").await),
            Some("UPDATE_INSTALL_ATTEMPT_WRITE_FAILED")
        );
        assert!(matches!(
            recovery.attempts.recover().unwrap(),
            InstallAttemptRecovery::Reconciled(_)
        ));

        file_system
            .fail_consumption_write
            .store(false, Ordering::SeqCst);
        cache.push_discard(Ok(ExactCacheDiscardOutcome::AlreadyDiscarded));
        assert!(matches!(
            recovery.recover("1.2.3").await,
            CacheRecoveryOutcome::Empty { .. }
        ));
        assert_eq!(
            events.snapshot(),
            [
                "web.consume",
                "cache.discard",
                "web.consume",
                "cache.discard",
                "cache.ordinary"
            ]
        );
    }
}
