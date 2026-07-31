use std::{
    path::Path,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};

use tauri::Emitter;
use tokio_util::sync::CancellationToken;

use crate::runtime::updater::{
    auto_check::StartupUpdateScheduler,
    cache::VerifiedCacheStore,
    download::StreamingInstallerDownloader,
    github_source::GitHubReleaseSource,
    install_attempt::InstallAttemptStore,
    nsis_install::{CurrentUserNsisSpawnPort, LocalRelaunchArguments},
    policy::{NativeUpdatePolicyStore, UpdatePolicyStore},
    quiescence::NativeWebQuiescenceStore,
    startup_reconciliation::{
        InstallAttemptStartupRecovery, NativeInstallAttemptRejectionPolicy,
        VerifiedCacheInstallAttemptPort, VerifiedCacheInstallAttemptQuarantinePort,
    },
    web_quiescence_handshake::WebQuiescenceHandshake,
    UpdateDispatchRequest, UpdateIntent, UpdatePhase, UpdateReceipt, UpdateRuntime, UpdateSnapshot,
    UpdateSnapshotSink,
};

use super::{
    update_distribution::OfficialUpdateDistribution,
    update_install_coordinator::{RuntimeUpdateInstallerAdapter, UpdateInstallCoordinator},
    update_install_exit::TauriInstallExitOwnership,
    update_install_native::production_native_quiescence,
    update_web_quiescence::{TauriUpdateWebQuiescencePort, UpdateWebQuiescenceAcknowledgement},
    window_labels,
};

pub(crate) const UPDATE_RUNTIME_SNAPSHOT_EVENT: &str = "update-runtime-snapshot";
const WEB_ACKNOWLEDGEMENT_TIMEOUT: Duration = Duration::from_secs(5);
const NATIVE_DRAIN_TIMEOUT: Duration = Duration::from_secs(5);

struct TauriUpdateSnapshotSink {
    app: tauri::AppHandle,
}

impl UpdateSnapshotSink for TauriUpdateSnapshotSink {
    fn publish(&self, snapshot: UpdateSnapshot) {
        // Event 是只读 projection；窗口尚未建立或正在退出时丢失 event 不改变 Rust authority。
        let _ = self
            .app
            .emit_to(window_labels::MAIN, UPDATE_RUNTIME_SNAPSHOT_EVENT, snapshot);
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum AcceptedWorker {
    Check,
    Download,
    Install,
}

fn accepted_worker(intent: &UpdateIntent) -> Option<AcceptedWorker> {
    match intent {
        UpdateIntent::CheckNow => Some(AcceptedWorker::Check),
        UpdateIntent::Download { .. } => Some(AcceptedWorker::Download),
        UpdateIntent::InstallAndRestart { .. } => Some(AcceptedWorker::Install),
        UpdateIntent::CancelDownload { .. }
        | UpdateIntent::RemindLater { .. }
        | UpdateIntent::SkipVersion { .. }
        | UpdateIntent::OpenRelease { .. } => None,
    }
}

fn trusted_release_open_command(url: &str) -> Option<(&'static str, Vec<&str>)> {
    let parsed = url::Url::parse(url).ok()?;
    if parsed.scheme() != "https"
        || parsed.host_str() != Some("github.com")
        || parsed.port().is_some()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return None;
    }
    let release_root = format!(
        "/{}/releases",
        crate::runtime::updater::github_source::OFFICIAL_REPOSITORY
    );
    let path_allowed = parsed.path() == release_root
        || parsed
            .path()
            .strip_prefix(&format!("{release_root}/tag/v"))
            .and_then(|version| semver::Version::parse(version).ok())
            .is_some_and(|version| version.pre.is_empty() && version.build.is_empty());
    if !path_allowed {
        return None;
    }
    if cfg!(target_os = "windows") {
        Some(("explorer.exe", vec![url]))
    } else if cfg!(target_os = "macos") {
        Some(("open", vec![url]))
    } else {
        Some(("xdg-open", vec![url]))
    }
}

fn open_trusted_release_page(url: &str) -> Result<(), ()> {
    let (program, arguments) = trusted_release_open_command(url).ok_or(())?;
    std::process::Command::new(program)
        .args(arguments)
        .spawn()
        .map(|_| ())
        .map_err(|_| ())
}

#[derive(Default)]
struct WebReconciliationGeneration {
    requested: AtomicU64,
    settled: AtomicU64,
    gate: tokio::sync::Mutex<()>,
}

impl WebReconciliationGeneration {
    fn request(&self) -> u64 {
        let previous = self
            .requested
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |value| {
                Some(value.saturating_add(1))
            })
            .expect("reconcile generation update cannot fail");
        previous.saturating_add(1)
    }

    fn pending_generation(&self) -> Option<u64> {
        let requested = self.requested.load(Ordering::Acquire);
        (requested > self.settled.load(Ordering::Acquire)).then_some(requested)
    }

    fn settle_through(&self, generation: u64) {
        self.settled.fetch_max(generation, Ordering::AcqRel);
    }
}

fn reconciliation_remains_unresolved(snapshot: &UpdateSnapshot) -> bool {
    matches!(
        snapshot.phase,
        UpdatePhase::PreparingInstall | UpdatePhase::RecoveringCache
    ) || (snapshot.phase == UpdatePhase::Idle
        && snapshot.fault.as_ref().is_some_and(|fault| {
            fault.code == crate::runtime::updater::WEB_RECONCILIATION_REQUIRED_FAULT
        }))
}

pub(crate) struct ApplicationUpdateRuntime {
    runtime: Arc<UpdateRuntime>,
    web_port: Option<TauriUpdateWebQuiescencePort>,
    startup_started: AtomicBool,
    shutdown_started: AtomicBool,
    scheduler_cancellation: CancellationToken,
    web_reconciliation: Arc<WebReconciliationGeneration>,
}

impl ApplicationUpdateRuntime {
    pub(crate) fn disabled_after_bootstrap_failure(
        app: tauri::AppHandle,
        current_version: &str,
    ) -> Self {
        let sink: Arc<dyn UpdateSnapshotSink> = Arc::new(TauriUpdateSnapshotSink { app });
        Self::disabled(current_version, sink)
    }

    pub(crate) fn build(
        app: tauri::AppHandle,
        app_data_directory: &Path,
        current_version: &str,
        updater_public_key: Option<&str>,
        distribution: Option<OfficialUpdateDistribution>,
    ) -> Result<Self, String> {
        let sink: Arc<dyn UpdateSnapshotSink> =
            Arc::new(TauriUpdateSnapshotSink { app: app.clone() });
        let Some(_distribution) = distribution else {
            return Ok(Self::disabled(current_version, sink));
        };
        let public_key = updater_public_key
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "UPDATE_PRODUCTION_PUBLIC_KEY_MISSING".to_owned())?;
        let updater_directory = app_data_directory.join("updater");

        let source = Arc::new(
            GitHubReleaseSource::new(public_key)
                .map_err(|error| format!("UPDATE_PRODUCTION_SOURCE_REJECTED: {}", error.code))?,
        );
        let downloader = Arc::new(
            StreamingInstallerDownloader::new(&updater_directory)
                .map_err(|error| error.code().to_owned())?,
        );
        let policy_store = Arc::new(NativeUpdatePolicyStore::for_app_data(app_data_directory));
        let attempts = Arc::new(InstallAttemptStore::for_app_data(app_data_directory));
        let web_port = TauriUpdateWebQuiescencePort::new(app.clone());
        let web_handshake = Arc::new(WebQuiescenceHandshake::new(
            NativeWebQuiescenceStore::for_app_data(app_data_directory),
            web_port.clone(),
            WEB_ACKNOWLEDGEMENT_TIMEOUT,
        ));

        let rejection_policy = Arc::new(NativeInstallAttemptRejectionPolicy::new(Arc::clone(
            &policy_store,
        )));
        let startup_recovery = Arc::new(InstallAttemptStartupRecovery::new(
            Arc::clone(&attempts),
            Arc::new(VerifiedCacheInstallAttemptPort::new(
                VerifiedCacheStore::new(&updater_directory, public_key)
                    .map_err(|error| error.code.to_owned())?,
            )),
            web_handshake.clone(),
            Arc::new(VerifiedCacheInstallAttemptQuarantinePort::new(
                &updater_directory,
                rejection_policy,
            )),
        ));

        let coordinator = Arc::new(UpdateInstallCoordinator::new(
            web_handshake,
            production_native_quiescence(app.clone()),
            Arc::new(
                VerifiedCacheStore::new(&updater_directory, public_key)
                    .map_err(|error| error.code.to_owned())?,
            ),
            attempts,
            Arc::new(TauriInstallExitOwnership::new(app)),
            Arc::new(CurrentUserNsisSpawnPort),
            LocalRelaunchArguments::capture_current_process()
                .map_err(|error| error.code().to_owned())?,
            NATIVE_DRAIN_TIMEOUT,
        ));
        let runtime = UpdateRuntime::with_production_dependencies(
            current_version,
            source,
            sink,
            downloader,
            startup_recovery,
            policy_store as Arc<dyn UpdatePolicyStore>,
            Arc::new(RuntimeUpdateInstallerAdapter::new(coordinator)),
        )
        .map_err(|error| error.code().to_owned())?;

        Ok(Self {
            runtime: Arc::new(runtime),
            web_port: Some(web_port),
            startup_started: AtomicBool::new(false),
            shutdown_started: AtomicBool::new(false),
            scheduler_cancellation: CancellationToken::new(),
            web_reconciliation: Arc::new(WebReconciliationGeneration::default()),
        })
    }

    fn disabled(current_version: &str, sink: Arc<dyn UpdateSnapshotSink>) -> Self {
        Self {
            runtime: Arc::new(UpdateRuntime::disabled_without_network(
                current_version,
                sink,
            )),
            web_port: None,
            startup_started: AtomicBool::new(false),
            shutdown_started: AtomicBool::new(false),
            scheduler_cancellation: CancellationToken::new(),
            web_reconciliation: Arc::new(WebReconciliationGeneration::default()),
        }
    }

    pub(crate) fn snapshot(&self) -> UpdateSnapshot {
        self.runtime.snapshot()
    }

    /// 次级 WebView 只能看到不可操作的投影，不能借此发现候选 ID 或运行时状态。
    pub(crate) fn restricted_snapshot(&self) -> UpdateSnapshot {
        let snapshot = self.runtime.snapshot();
        UpdateSnapshot {
            revision: 0,
            phase: UpdatePhase::Disabled,
            current_version: snapshot.current_version,
            candidate: None,
            operation: None,
            fault: None,
            checked_at: None,
            remind_after: None,
            skipped_version: None,
        }
    }

    pub(crate) fn dispatch(&self, request: UpdateDispatchRequest) -> UpdateReceipt {
        if self.shutdown_started.load(Ordering::Acquire) {
            return UpdateReceipt::RuntimeUnavailable;
        }
        let worker = accepted_worker(&request.intent);
        let open_candidate = match &request.intent {
            UpdateIntent::OpenRelease { candidate_id } => Some(candidate_id.clone()),
            _ => None,
        };
        let receipt = self.runtime.dispatch(request);
        if receipt != UpdateReceipt::Accepted {
            return receipt;
        }
        if let Some(worker) = worker {
            self.spawn_worker(worker);
        }
        if let Some(candidate_id) = open_candidate {
            if let Some(url) = self.runtime.release_page_url(Some(&candidate_id)) {
                if open_trusted_release_page(&url).is_err() {
                    return UpdateReceipt::RuntimeUnavailable;
                }
            } else {
                return UpdateReceipt::StaleCandidate;
            }
        }
        receipt
    }

    fn spawn_worker(&self, worker: AcceptedWorker) {
        let runtime = Arc::clone(&self.runtime);
        let cancellation = self.scheduler_cancellation.clone();
        let reconciliation = Arc::clone(&self.web_reconciliation);
        tauri::async_runtime::spawn(async move {
            match worker {
                AcceptedWorker::Check => {
                    runtime.run_pending_check().await;
                }
                AcceptedWorker::Download => {
                    runtime.run_pending_download().await;
                }
                AcceptedWorker::Install => {
                    runtime.run_pending_install_transaction().await;
                }
            }
            Self::settle_requested_web_reconciliation(runtime, cancellation, reconciliation).await;
        });
    }

    async fn settle_requested_web_reconciliation(
        runtime: Arc<UpdateRuntime>,
        cancellation: CancellationToken,
        reconciliation: Arc<WebReconciliationGeneration>,
    ) {
        let _gate = reconciliation.gate.lock().await;
        loop {
            let Some(generation) = reconciliation.pending_generation() else {
                return;
            };
            if cancellation.is_cancelled() {
                return;
            }

            match runtime.snapshot().phase {
                UpdatePhase::PreparingInstall => {
                    let completed = tokio::select! {
                        _ = cancellation.cancelled() => return,
                        completed = runtime.run_pending_install_transaction() => completed,
                    };
                    // 另一个 worker 仍持有 claim 时保留 generation，由原 owner 完成后消费。
                    if !completed {
                        return;
                    }
                }
                UpdatePhase::RecoveringCache => {
                    // Startup worker 仍持有 cache claim；它退出后会再次进入本方法。
                    return;
                }
                UpdatePhase::Idle if runtime.rearm_web_reconciliation_recovery() => {
                    let completed = tokio::select! {
                        _ = cancellation.cancelled() => return,
                        completed = runtime.run_pending_cache_recovery() => completed,
                    };
                    if !completed {
                        return;
                    }
                }
                _ => {}
            }

            if reconciliation_remains_unresolved(&runtime.snapshot()) {
                // 每个 generation 只执行一次有界恢复；再次失败等待下一次 Web reconcile。
                return;
            }
            reconciliation.settle_through(generation);
        }
    }

    fn spawn_requested_web_reconciliation(&self) {
        let runtime = Arc::clone(&self.runtime);
        let cancellation = self.scheduler_cancellation.clone();
        let reconciliation = Arc::clone(&self.web_reconciliation);
        tauri::async_runtime::spawn(async move {
            Self::settle_requested_web_reconciliation(runtime, cancellation, reconciliation).await;
        });
    }

    pub(crate) fn acknowledge_web(
        &self,
        acknowledgement: UpdateWebQuiescenceAcknowledgement,
    ) -> bool {
        self.web_port
            .as_ref()
            .is_some_and(|port| port.acknowledge(acknowledgement))
    }

    /// Web 在四个 listener 全部安装后调用。首次调用才启动 cache recovery + auto check；
    /// reload 只重放 exact install/cache reconciliation，不创建第二个 scheduler。
    pub(crate) fn reconcile_web(&self) {
        if self.shutdown_started.load(Ordering::Acquire) || self.web_port.is_none() {
            return;
        }
        self.web_reconciliation.request();
        if !self.startup_started.swap(true, Ordering::AcqRel) {
            let runtime = Arc::clone(&self.runtime);
            let cancellation = self.scheduler_cancellation.clone();
            let reconciliation = Arc::clone(&self.web_reconciliation);
            tauri::async_runtime::spawn(async move {
                StartupUpdateScheduler::new()
                    .run_once(&runtime, cancellation.clone())
                    .await;
                Self::settle_requested_web_reconciliation(runtime, cancellation, reconciliation)
                    .await;
            });
            return;
        }
        self.spawn_requested_web_reconciliation();
    }

    pub(crate) fn shutdown(&self) {
        if self.shutdown_started.swap(true, Ordering::AcqRel) {
            return;
        }
        self.scheduler_cancellation.cancel();
        self.runtime.request_active_download_shutdown();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::updater::{
        cache::{CacheRecoveryFault, CacheRecoveryOutcome, UpdateStartupRecovery},
        MemorySnapshotSink, MemoryUpdateSource,
    };

    struct ReloadRaceRecovery {
        entered: Arc<tokio::sync::Notify>,
        release: Arc<tokio::sync::Notify>,
        calls: std::sync::atomic::AtomicUsize,
    }

    impl UpdateStartupRecovery for ReloadRaceRecovery {
        fn recover<'a>(
            &'a self,
            _current_version: &'a str,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = CacheRecoveryOutcome> + Send + 'a>>
        {
            let call = self.calls.fetch_add(1, Ordering::AcqRel);
            Box::pin(async move {
                if call == 0 {
                    self.entered.notify_one();
                    self.release.notified().await;
                    CacheRecoveryOutcome::Blocked(CacheRecoveryFault {
                        code: crate::runtime::updater::WEB_RECONCILIATION_REQUIRED_FAULT,
                        message: "旧 WebView acknowledgement 已失效",
                    })
                } else {
                    CacheRecoveryOutcome::Empty {
                        fault: None,
                        quarantine: None,
                    }
                }
            })
        }
    }

    #[test]
    fn reconciliation_generation_never_loses_a_newer_reload_request() {
        let generations = WebReconciliationGeneration::default();
        let first = generations.request();
        let second = generations.request();
        assert!(second > first);

        generations.settle_through(first);
        assert_eq!(generations.pending_generation(), Some(second));

        generations.settle_through(second);
        assert_eq!(generations.pending_generation(), None);
    }

    #[test]
    fn cache_owner_consumes_reload_generation_after_claim_release() {
        tauri::async_runtime::block_on(async {
            let recovery = Arc::new(ReloadRaceRecovery {
                entered: Arc::new(tokio::sync::Notify::new()),
                release: Arc::new(tokio::sync::Notify::new()),
                calls: std::sync::atomic::AtomicUsize::new(0),
            });
            let runtime = Arc::new(UpdateRuntime::with_recovery(
                "1.0.0",
                Arc::new(MemoryUpdateSource::with_outcomes([Ok(None)])),
                Arc::new(MemorySnapshotSink::default()),
                recovery.clone(),
            ));
            let generations = Arc::new(WebReconciliationGeneration::default());
            let cancellation = CancellationToken::new();
            generations.request();

            let owner_runtime = runtime.clone();
            let owner_generations = generations.clone();
            let owner_cancellation = cancellation.clone();
            let owner = tauri::async_runtime::spawn(async move {
                owner_runtime.run_pending_cache_recovery().await;
                ApplicationUpdateRuntime::settle_requested_web_reconciliation(
                    owner_runtime,
                    owner_cancellation,
                    owner_generations,
                )
                .await;
            });
            recovery.entered.notified().await;

            let reload_generation = generations.request();
            ApplicationUpdateRuntime::settle_requested_web_reconciliation(
                runtime.clone(),
                cancellation.clone(),
                generations.clone(),
            )
            .await;
            assert_eq!(generations.pending_generation(), Some(reload_generation));

            recovery.release.notify_one();
            owner.await.expect("cache owner 不应 panic");

            assert_eq!(recovery.calls.load(Ordering::Acquire), 2);
            assert_eq!(runtime.snapshot().phase, UpdatePhase::Idle);
            assert!(runtime.snapshot().fault.is_none());
            assert_eq!(generations.pending_generation(), None);
        });
    }

    #[test]
    fn every_accepted_mutating_intent_has_exactly_one_worker_classification() {
        let candidate = "a".repeat(64);
        let operation = "download-1".to_owned();
        assert_eq!(
            accepted_worker(&UpdateIntent::CheckNow),
            Some(AcceptedWorker::Check)
        );
        assert_eq!(
            accepted_worker(&UpdateIntent::Download {
                candidate_id: candidate.clone(),
            }),
            Some(AcceptedWorker::Download)
        );
        assert_eq!(
            accepted_worker(&UpdateIntent::InstallAndRestart {
                candidate_id: candidate.clone(),
            }),
            Some(AcceptedWorker::Install)
        );
        for intent in [
            UpdateIntent::CancelDownload {
                operation_id: operation,
            },
            UpdateIntent::RemindLater {
                candidate_id: candidate.clone(),
            },
            UpdateIntent::SkipVersion {
                candidate_id: candidate.clone(),
            },
            UpdateIntent::OpenRelease {
                candidate_id: candidate,
            },
        ] {
            assert_eq!(accepted_worker(&intent), None);
        }
    }

    #[test]
    fn release_page_opener_accepts_only_the_fixed_repository_without_mutable_url_parts() {
        for accepted in [
            "https://github.com/zzstar101/Mineradio-Tauri/releases",
            "https://github.com/zzstar101/Mineradio-Tauri/releases/tag/v1.0.0",
        ] {
            assert!(trusted_release_open_command(accepted).is_some());
        }
        for rejected in [
            "http://github.com/zzstar101/Mineradio-Tauri/releases",
            "https://example.com/zzstar101/Mineradio-Tauri/releases",
            "https://github.com/zzstar101/Mineradio-Tauri/releases/latest",
            "https://github.com/zzstar101/Mineradio-Tauri/releases/tag/v1.0.0-beta.1",
            "https://github.com/zzstar101/Mineradio-Tauri/releases/tag/v1.0.0?token=secret",
            "https://github.com/zzstar101/Mineradio-Tauri/releases#fragment",
        ] {
            assert!(trusted_release_open_command(rejected).is_none());
        }
    }
}
