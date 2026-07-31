use std::{
    ffi::OsStr,
    future::Future,
    io::{self, Read as _, Write as _},
    path::{Path, PathBuf},
    pin::Pin,
    time::{SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::AsyncReadExt;

use super::{
    download::VerifiedInstallerArtifact,
    github_source::OFFICIAL_REPOSITORY,
    managed_fs::StableDirectory,
    provenance::{ProvenanceVerifier, VerifiedReleaseEvidence},
    NormalizedRelease,
};

const CACHE_SCHEMA_VERSION: u64 = 1;
const CACHE_SOURCE_ID: &str = "github-release-v1";
const CACHE_TARGET: &str = "windows-x86_64-nsis";
const MAX_CANDIDATE_METADATA_BYTES: u64 = 256 * 1024;
const MAX_QUARANTINE_JOURNAL_BYTES: u64 = 4 * 1024;
const MAX_INSTALLER_BYTES: u64 = 512 * 1024 * 1024;
const INSTALLER_READ_CHUNK_BYTES: usize = 64 * 1024;
const QUARANTINE_JOURNAL_SCHEMA_VERSION: u64 = 1;
const QUARANTINE_JOURNAL_FILE_NAME: &str = "quarantine-pending-v1.json";
const QUARANTINE_JOURNAL_TEMP_FILE_NAME: &str = "quarantine-pending-v1.json.tmp";
const QUARANTINE_JOURNAL_RECOVERY_FILE_NAME: &str = "quarantine-pending-v1.json.recover";
pub(crate) const AUTH_REJECTED_PART_FILE_NAME: &str = "installer.auth-rejected";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CachedCandidateV1 {
    source_id: String,
    candidate_id: String,
    candidate_identity_base64: String,
    repository: String,
    tag: String,
    version: String,
    commit_sha: String,
    target: String,
    asset_name: String,
    expected_size: u64,
    actual_size: u64,
    installer_sha256: String,
    installer_signature: String,
    installer_signature_sha256: String,
    provenance_payload_base64: String,
    provenance_signature: String,
    provenance_sha256: String,
    provenance_signature_sha256: String,
    downloaded_at: u64,
    verified_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CandidateCacheDocumentV1 {
    schema_version: u64,
    metadata_digest: String,
    candidate: CachedCandidateV1,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct QuarantinePendingDocumentV1 {
    schema_version: u64,
    candidate_id: String,
    version: String,
    reason: String,
    rejected_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CacheRecoveryFault {
    pub(crate) code: &'static str,
    pub(crate) message: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CacheRecoveryFaultKind {
    Blocked,
    IdentityConflict,
    AuthenticityRejected,
}

impl CacheRecoveryFault {
    pub(crate) fn kind(&self) -> CacheRecoveryFaultKind {
        match self.code {
            "UPDATE_CACHE_IDENTITY_CONFLICT" => CacheRecoveryFaultKind::IdentityConflict,
            "UPDATE_CACHE_AUTHENTICITY_REJECTED" => CacheRecoveryFaultKind::AuthenticityRejected,
            _ => CacheRecoveryFaultKind::Blocked,
        }
    }
}

/// 从 durable install-attempt marker 提取的六轴安装包身份。
///
/// 仓库、tag、target 与 NSIS 包名不由调用方自由传入，而是由版本和固定发布策略派生，
/// 避免启动协调器把不受信任的 metadata 再包装成“期望值”。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct InstallAttemptArtifactIdentity {
    candidate_id: String,
    version: String,
    provenance_sha256: String,
    metadata_digest: String,
    installer_sha256: String,
    installer_size: u64,
}

impl InstallAttemptArtifactIdentity {
    pub(crate) fn new(
        candidate_id: impl Into<String>,
        version: impl Into<String>,
        provenance_sha256: impl Into<String>,
        metadata_digest: impl Into<String>,
        installer_sha256: impl Into<String>,
        installer_size: u64,
    ) -> Result<Self, CacheRecoveryFault> {
        let identity = Self {
            candidate_id: candidate_id.into(),
            version: version.into(),
            provenance_sha256: provenance_sha256.into(),
            metadata_digest: metadata_digest.into(),
            installer_sha256: installer_sha256.into(),
            installer_size,
        };
        if !is_lower_hex(&identity.candidate_id, 64)
            || parse_stable_version(&identity.version).is_err()
            || !is_lower_hex(&identity.provenance_sha256, 64)
            || !is_lower_hex(&identity.metadata_digest, 64)
            || !is_lower_hex(&identity.installer_sha256, 64)
            || identity.installer_size == 0
            || identity.installer_size > MAX_INSTALLER_BYTES
        {
            return Err(identity_conflict_fault());
        }
        Ok(identity)
    }

    pub(crate) fn candidate_id(&self) -> &str {
        &self.candidate_id
    }

    pub(crate) fn version(&self) -> &str {
        &self.version
    }

    pub(crate) fn provenance_sha256(&self) -> &str {
        &self.provenance_sha256
    }

    pub(crate) fn metadata_digest(&self) -> &str {
        &self.metadata_digest
    }

    pub(crate) fn installer_sha256(&self) -> &str {
        &self.installer_sha256
    }

    pub(crate) fn installer_size(&self) -> u64 {
        self.installer_size
    }
}

#[derive(Debug, Clone)]
pub(crate) struct RecoveredVerifiedCache {
    pub(crate) release: NormalizedRelease,
    pub(crate) artifact: VerifiedInstallerArtifact,
    pub(crate) metadata_digest: String,
}

#[derive(Debug, Clone)]
pub(crate) enum CacheRecoveryOutcome {
    Empty {
        fault: Option<CacheRecoveryFault>,
        quarantine: Option<RejectedCachedCandidate>,
    },
    Recovered(Box<RecoveredVerifiedCache>),
    PendingQuarantine(Box<PendingQuarantineRejection>),
    Blocked(CacheRecoveryFault),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RejectedCachedCandidate {
    pub(crate) candidate_id: String,
    pub(crate) version: String,
    pub(crate) reason_code: String,
    pub(crate) rejected_at: u64,
}

/// 已 durable 的两阶段隔离记录。只有调用方先持久化 native policy 后才能 finalize。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PendingQuarantineRejection {
    updater_directory: PathBuf,
    rejected: RejectedCachedCandidate,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct VerifiedCacheError {
    pub(crate) code: &'static str,
    pub(crate) message: &'static str,
}

pub(crate) struct VerifiedCacheStore {
    updater_directory: PathBuf,
    encoded_public_key: String,
}

impl PendingQuarantineRejection {
    pub(crate) fn rejected(&self) -> &RejectedCachedCandidate {
        &self.rejected
    }

    pub(crate) fn finalize(&self) -> Result<(), VerifiedCacheError> {
        let store = VerifiedCacheStore {
            updater_directory: self.updater_directory.clone(),
            encoded_public_key: String::new(),
        };
        let updater = StableDirectory::open_existing(&self.updater_directory)
            .map_err(|_| quarantine_journal_error())?
            .ok_or_else(quarantine_journal_error)?;
        let persisted = store
            .load_pending_quarantine()
            .map_err(|_| quarantine_journal_error())?
            .ok_or_else(quarantine_journal_error)?;
        if persisted.rejected != self.rejected {
            return Err(quarantine_journal_error());
        }
        store.cleanup_cache().map_err(|_| {
            cache_error(
                "UPDATE_CACHE_CLEANUP_BLOCKED",
                "隔离策略已保存，但无法清理被拒绝的更新缓存",
            )
        })?;
        updater
            .remove_regular(OsStr::new(QUARANTINE_JOURNAL_FILE_NAME))
            .and_then(|removed| {
                removed.then_some(()).ok_or_else(|| {
                    io::Error::new(io::ErrorKind::NotFound, "rejection journal disappeared")
                })
            })
            .map_err(|_| {
                cache_error(
                    "UPDATE_QUARANTINE_JOURNAL_FINALIZE_FAILED",
                    "隔离策略已保存，但无法完成 rejection journal",
                )
            })
    }
}

pub(crate) fn persist_pending_quarantine(
    updater_directory: impl Into<PathBuf>,
    candidate_id: &str,
    version: &str,
    reason: &str,
) -> Result<PendingQuarantineRejection, VerifiedCacheError> {
    let store = VerifiedCacheStore {
        updater_directory: updater_directory.into(),
        encoded_public_key: String::new(),
    };
    store.persist_pending_quarantine(candidate_id, version, reason)
}

pub(crate) trait UpdateStartupRecovery: Send + Sync {
    fn recover<'a>(
        &'a self,
        current_version: &'a str,
    ) -> Pin<Box<dyn Future<Output = CacheRecoveryOutcome> + Send + 'a>>;
}

impl UpdateStartupRecovery for VerifiedCacheStore {
    fn recover<'a>(
        &'a self,
        current_version: &'a str,
    ) -> Pin<Box<dyn Future<Output = CacheRecoveryOutcome> + Send + 'a>> {
        Box::pin(async move { VerifiedCacheStore::recover(self, current_version).await })
    }
}

pub(crate) async fn commit_downloaded_candidate(
    updater_directory: impl Into<PathBuf>,
    evidence: &VerifiedReleaseEvidence,
    actual_size: u64,
    installer_sha256: &str,
    downloaded_at: u64,
    verified_at: u64,
) -> Result<String, VerifiedCacheError> {
    VerifiedCacheStore {
        updater_directory: updater_directory.into(),
        encoded_public_key: String::new(),
    }
    .commit_verified(
        evidence,
        actual_size,
        installer_sha256,
        downloaded_at,
        verified_at,
    )
    .await
}

pub(crate) fn discard_verified_cache(updater_directory: &Path) -> Result<(), VerifiedCacheError> {
    StableDirectory::open_existing(updater_directory)
        .map_err(|_| cache_error("UPDATE_CACHE_PATH_REJECTED", "更新缓存路径不属于受管目录"))?
        .ok_or_else(|| cache_error("UPDATE_CACHE_PATH_REJECTED", "更新缓存路径不属于受管目录"))?;
    let store = VerifiedCacheStore {
        updater_directory: updater_directory.to_path_buf(),
        encoded_public_key: String::new(),
    };
    if store.cleanup_cache_transaction().is_ok() {
        return Ok(());
    }
    Err(cache_error(
        "UPDATE_CACHE_CLEANUP_BLOCKED",
        "无法清理完整 verified cache pair",
    ))
}

impl VerifiedCacheStore {
    pub(crate) fn new(
        updater_directory: impl Into<PathBuf>,
        encoded_public_key: impl Into<String>,
    ) -> Result<Self, VerifiedCacheError> {
        let encoded_public_key = encoded_public_key.into();
        ProvenanceVerifier::from_tauri_pubkey(&encoded_public_key).map_err(|_| {
            VerifiedCacheError {
                code: "UPDATE_CACHE_PUBLIC_KEY_REJECTED",
                message: "更新缓存公钥无效",
            }
        })?;
        Ok(Self {
            updater_directory: updater_directory.into(),
            encoded_public_key,
        })
    }

    pub(crate) async fn commit_verified(
        &self,
        evidence: &VerifiedReleaseEvidence,
        actual_size: u64,
        installer_sha256: &str,
        downloaded_at: u64,
        verified_at: u64,
    ) -> Result<String, VerifiedCacheError> {
        if downloaded_at > verified_at {
            return Err(cache_error(
                "UPDATE_CACHE_TIMESTAMP_REJECTED",
                "更新缓存时间顺序无效",
            ));
        }
        evidence
            .verify_installer_measurement(actual_size, installer_sha256)
            .map_err(|_| {
                cache_error(
                    "UPDATE_CACHE_MEASUREMENT_REJECTED",
                    "更新缓存安装包测量与签名来源不一致",
                )
            })?;
        let candidate = CachedCandidateV1 {
            source_id: CACHE_SOURCE_ID.into(),
            candidate_id: evidence.candidate_id().as_str().into(),
            candidate_identity_base64: STANDARD.encode(evidence.candidate_identity()),
            repository: evidence.repository().into(),
            tag: evidence.tag().into(),
            version: evidence.version().into(),
            commit_sha: evidence.commit_sha().into(),
            target: evidence.target().into(),
            asset_name: evidence.installer_name().into(),
            expected_size: evidence.installer_size(),
            actual_size,
            installer_sha256: installer_sha256.into(),
            installer_signature: evidence.installer_signature().into(),
            installer_signature_sha256: evidence.installer_signature_sha256().into(),
            provenance_payload_base64: STANDARD.encode(evidence.raw_provenance()),
            provenance_signature: evidence.provenance_signature().into(),
            provenance_sha256: evidence.provenance_sha256().into(),
            provenance_signature_sha256: evidence.provenance_signature_sha256().into(),
            downloaded_at,
            verified_at,
        };
        let metadata_digest = candidate_digest(&candidate)?;
        let document = CandidateCacheDocumentV1 {
            schema_version: CACHE_SCHEMA_VERSION,
            metadata_digest: metadata_digest.clone(),
            candidate,
        };
        let bytes = serde_json::to_vec(&document).map_err(|_| {
            cache_error(
                "UPDATE_CACHE_METADATA_SERIALIZE_FAILED",
                "无法序列化更新缓存 metadata",
            )
        })?;
        if bytes.len() as u64 > MAX_CANDIDATE_METADATA_BYTES {
            return Err(cache_error(
                "UPDATE_CACHE_METADATA_TOO_LARGE",
                "更新缓存 metadata 超过安全上限",
            ));
        }

        let cache = StableDirectory::open_or_create(self.cache_directory())
            .map_err(|_| cache_io_error())?;
        let _installer_authority = cache
            .open_regular_read(OsStr::new("installer.exe"))
            .map_err(|_| cache_io_error())?
            .ok_or_else(cache_io_error)?;
        reject_existing_leaf(&cache, "candidate.json")?;
        reject_existing_leaf(&cache, "candidate.json.tmp")?;

        let mut file = cache
            .create_new_renameable(OsStr::new("candidate.json.tmp"))
            .map_err(|_| cache_io_error())?;
        let write_result = file.write_all(&bytes).and_then(|()| file.sync_all());
        if write_result.is_err() {
            drop(file);
            let _ = cache.remove_regular(OsStr::new("candidate.json.tmp"));
            return Err(cache_io_error());
        }
        let publish_result = cache.publish_without_replace(
            &file,
            OsStr::new("candidate.json.tmp"),
            OsStr::new("candidate.json"),
        );
        if publish_result.is_err() {
            drop(file);
            let _ = cache.remove_regular(OsStr::new("candidate.json.tmp"));
            return Err(cache_error(
                "UPDATE_CACHE_METADATA_PUBLISH_FAILED",
                "无法原子发布更新缓存 metadata",
            ));
        }
        drop(file);
        Ok(metadata_digest)
    }

    /// 对 install-attempt 指向的 exact cache pair 做只读完整复核。
    ///
    /// 该入口有意绕过普通启动恢复的版本清理、Web marker 与 install-attempt marker
    /// 阻断，但不会清理、隔离或发布 ready candidate。任何失败都会保留现场证据。
    pub(crate) async fn inspect_install_attempt_artifact(
        &self,
        expected: &InstallAttemptArtifactIdentity,
    ) -> Result<RecoveredVerifiedCache, CacheRecoveryFault> {
        let cache = match StableDirectory::open_existing(self.cache_directory()) {
            Ok(Some(directory)) => std::sync::Arc::new(directory),
            Ok(None) => return Err(install_attempt_cache_missing_fault()),
            Err(_) => return Err(corrupt_fault()),
        };
        if !self.has_exact_cache_pair(&cache)? {
            return Err(install_attempt_cache_missing_fault());
        }

        let raw_document = read_bounded_candidate_metadata(&cache)?;
        let document: CandidateCacheDocumentV1 =
            serde_json::from_slice(&raw_document).map_err(|_| corrupt_fault())?;
        if document.schema_version != CACHE_SCHEMA_VERSION
            || serde_json::to_vec(&document).map_err(|_| corrupt_fault())? != raw_document
        {
            return Err(corrupt_fault());
        }
        let actual_metadata_digest =
            candidate_digest(&document.candidate).map_err(|_| corrupt_fault())?;
        if actual_metadata_digest != document.metadata_digest
            || !candidate_matches_install_attempt(&document, expected)
        {
            return Err(identity_conflict_fault());
        }

        self.revalidate_verified_document(cache, document).await
    }

    pub(crate) async fn recover(&self, current_version: &str) -> CacheRecoveryOutcome {
        let updater = match StableDirectory::open_existing(&self.updater_directory) {
            Ok(Some(directory)) => directory,
            Ok(None) => {
                return CacheRecoveryOutcome::Empty {
                    fault: None,
                    quarantine: None,
                };
            }
            Err(_) => return CacheRecoveryOutcome::Blocked(cleanup_blocked_fault()),
        };
        match updater.open_regular_read(OsStr::new("install-attempt-v1.json")) {
            Ok(Some(_)) => {
                return CacheRecoveryOutcome::Blocked(reconciliation_required_fault());
            }
            Ok(None) => {}
            Err(_) => return CacheRecoveryOutcome::Blocked(reconciliation_required_fault()),
        }
        match updater.open_regular_read(OsStr::new("install-attempt-reconciliation-v1.json")) {
            Ok(Some(_)) => {
                return CacheRecoveryOutcome::Blocked(reconciliation_required_fault());
            }
            Ok(None) => {}
            Err(_) => return CacheRecoveryOutcome::Blocked(reconciliation_required_fault()),
        }
        match updater.open_regular_read(OsStr::new("web-quiescence-v1.json")) {
            Ok(Some(_)) => {
                return CacheRecoveryOutcome::Blocked(web_reconciliation_required_fault());
            }
            Ok(None) => {}
            Err(_) => return CacheRecoveryOutcome::Blocked(web_reconciliation_required_fault()),
        }
        match self.load_pending_quarantine() {
            Ok(Some(pending)) => {
                return CacheRecoveryOutcome::PendingQuarantine(Box::new(pending));
            }
            Ok(None) => {}
            Err(fault) => return CacheRecoveryOutcome::Blocked(fault),
        }
        match self.has_auth_rejected_part_marker() {
            Ok(true) => return CacheRecoveryOutcome::Blocked(quarantine_journal_fault()),
            Ok(false) => {}
            Err(()) => return CacheRecoveryOutcome::Blocked(quarantine_journal_fault()),
        }
        match updater.open_regular_read(OsStr::new("cache-delete-v1.json")) {
            Ok(Some(tombstone)) => {
                drop(tombstone);
                if self.cleanup_cache().is_err() {
                    return CacheRecoveryOutcome::Blocked(cleanup_blocked_fault());
                }
                if !matches!(
                    updater.remove_regular(OsStr::new("cache-delete-v1.json")),
                    Ok(true)
                ) {
                    return CacheRecoveryOutcome::Blocked(cleanup_blocked_fault());
                }
            }
            Ok(None) => {}
            Err(_) => return CacheRecoveryOutcome::Blocked(cleanup_blocked_fault()),
        }
        if self.cleanup_startup_remnants().is_err() {
            let _ = self.persist_cleanup_tombstone();
            return CacheRecoveryOutcome::Blocked(cleanup_blocked_fault());
        }
        match self.recover_verified(current_version).await {
            Ok(Some(recovered)) => CacheRecoveryOutcome::Recovered(Box::new(recovered)),
            Ok(None) => match self.cache_has_entries() {
                Ok(false) => CacheRecoveryOutcome::Empty {
                    fault: None,
                    quarantine: None,
                },
                Ok(true) if self.cleanup_cache_transaction().is_ok() => {
                    CacheRecoveryOutcome::Empty {
                        fault: None,
                        quarantine: None,
                    }
                }
                Ok(true) | Err(()) => {
                    let _ = self.persist_cleanup_tombstone();
                    CacheRecoveryOutcome::Blocked(cleanup_blocked_fault())
                }
            },
            Err(fault) => {
                if fault.code == "UPDATE_CACHE_AUTHENTICITY_REJECTED" {
                    let Some(rejected) = self.read_rejected_candidate(fault.code) else {
                        return CacheRecoveryOutcome::Blocked(quarantine_identity_fault());
                    };
                    return match self.persist_pending_quarantine(
                        &rejected.candidate_id,
                        &rejected.version,
                        &rejected.reason_code,
                    ) {
                        Ok(pending) => CacheRecoveryOutcome::PendingQuarantine(Box::new(pending)),
                        Err(_) => CacheRecoveryOutcome::Blocked(quarantine_journal_fault()),
                    };
                }
                match self.cleanup_cache_transaction() {
                    Ok(()) => CacheRecoveryOutcome::Empty {
                        fault: Some(fault),
                        quarantine: None,
                    },
                    Err(()) => {
                        let _ = self.persist_cleanup_tombstone();
                        CacheRecoveryOutcome::Blocked(cleanup_blocked_fault())
                    }
                }
            }
        }
    }

    fn cache_directory(&self) -> PathBuf {
        self.updater_directory.join("cache-v1")
    }

    fn installer_path(&self) -> PathBuf {
        self.cache_directory().join("installer.exe")
    }

    fn persist_pending_quarantine(
        &self,
        candidate_id: &str,
        version: &str,
        reason: &str,
    ) -> Result<PendingQuarantineRejection, VerifiedCacheError> {
        let document = QuarantinePendingDocumentV1 {
            schema_version: QUARANTINE_JOURNAL_SCHEMA_VERSION,
            candidate_id: candidate_id.into(),
            version: version.into(),
            reason: reason.into(),
            rejected_at: unix_timestamp_millis()?,
        };
        validate_quarantine_document(&document)?;
        let updater = StableDirectory::open_or_create(&self.updater_directory)
            .map_err(|_| quarantine_journal_error())?;

        if let Some(existing) = self
            .load_pending_quarantine()
            .map_err(|_| quarantine_journal_error())?
        {
            if existing.rejected.candidate_id == document.candidate_id
                && existing.rejected.version == document.version
                && existing.rejected.reason_code == document.reason
            {
                return Ok(existing);
            }
            return Err(cache_error(
                "UPDATE_QUARANTINE_JOURNAL_CONFLICT",
                "已存在不同 identity 的 rejection journal",
            ));
        }
        match updater.open_regular_read(OsStr::new(QUARANTINE_JOURNAL_TEMP_FILE_NAME)) {
            Ok(None) => {}
            Ok(Some(_)) | Err(_) => return Err(quarantine_journal_error()),
        }
        let bytes = serde_json::to_vec(&document).map_err(|_| quarantine_journal_error())?;
        if bytes.is_empty() || bytes.len() as u64 > MAX_QUARANTINE_JOURNAL_BYTES {
            return Err(quarantine_journal_error());
        }
        let mut file = updater
            .create_new_renameable(OsStr::new(QUARANTINE_JOURNAL_TEMP_FILE_NAME))
            .map_err(|_| quarantine_journal_error())?;
        let write_result = file.write_all(&bytes).and_then(|()| file.sync_all());
        if write_result.is_err() {
            drop(file);
            let _ = updater.remove_regular(OsStr::new(QUARANTINE_JOURNAL_TEMP_FILE_NAME));
            return Err(quarantine_journal_error());
        }
        if updater
            .publish_without_replace(
                &file,
                OsStr::new(QUARANTINE_JOURNAL_TEMP_FILE_NAME),
                OsStr::new(QUARANTINE_JOURNAL_FILE_NAME),
            )
            .is_err()
        {
            drop(file);
            let _ = updater.remove_regular(OsStr::new(QUARANTINE_JOURNAL_TEMP_FILE_NAME));
            return Err(quarantine_journal_error());
        }
        drop(file);
        sync_directory_best_effort(&self.updater_directory);
        Ok(PendingQuarantineRejection {
            updater_directory: self.updater_directory.clone(),
            rejected: RejectedCachedCandidate {
                candidate_id: document.candidate_id,
                version: document.version,
                reason_code: document.reason,
                rejected_at: document.rejected_at,
            },
        })
    }

    fn load_pending_quarantine(
        &self,
    ) -> Result<Option<PendingQuarantineRejection>, CacheRecoveryFault> {
        let updater = match StableDirectory::open_existing(&self.updater_directory) {
            Ok(Some(directory)) => directory,
            Ok(None) => return Ok(None),
            Err(_) => return Err(quarantine_journal_fault()),
        };
        let final_raw = match read_bounded_managed_file(
            &updater,
            QUARANTINE_JOURNAL_FILE_NAME,
            MAX_QUARANTINE_JOURNAL_BYTES,
        ) {
            Ok(raw) => raw,
            Err(()) => return Err(quarantine_journal_fault()),
        };
        let temp_raw = match read_bounded_managed_file(
            &updater,
            QUARANTINE_JOURNAL_TEMP_FILE_NAME,
            MAX_QUARANTINE_JOURNAL_BYTES,
        ) {
            Ok(raw) => raw,
            Err(()) => return Err(quarantine_journal_fault()),
        };
        let recovery_raw = match read_bounded_managed_file(
            &updater,
            QUARANTINE_JOURNAL_RECOVERY_FILE_NAME,
            MAX_QUARANTINE_JOURNAL_BYTES,
        ) {
            Ok(raw) => raw,
            Err(()) => return Err(quarantine_journal_fault()),
        };

        let raw = match (final_raw, temp_raw, recovery_raw) {
            (None, None, None) => return Ok(None),
            (Some(final_raw), None, None) => final_raw,
            (Some(final_raw), Some(temp_raw), None) => {
                let final_document = parse_quarantine_document(&final_raw)?;
                let temp_document = parse_quarantine_document(&temp_raw)?;
                if final_document != temp_document
                    || !matches!(
                        updater.remove_regular(OsStr::new(QUARANTINE_JOURNAL_TEMP_FILE_NAME)),
                        Ok(true)
                    )
                {
                    return Err(quarantine_journal_fault());
                }
                final_raw
            }
            (None, Some(temp_raw), None | Some(_)) => {
                parse_quarantine_document(&temp_raw)?;
                self.promote_quarantine_temp(&updater, &temp_raw)?;
                temp_raw
            }
            _ => return Err(quarantine_journal_fault()),
        };
        let document = parse_quarantine_document(&raw)?;
        Ok(Some(PendingQuarantineRejection {
            updater_directory: self.updater_directory.clone(),
            rejected: RejectedCachedCandidate {
                candidate_id: document.candidate_id,
                version: document.version,
                reason_code: document.reason,
                rejected_at: document.rejected_at,
            },
        }))
    }

    fn promote_quarantine_temp(
        &self,
        updater: &StableDirectory,
        raw: &[u8],
    ) -> Result<(), CacheRecoveryFault> {
        match read_bounded_managed_file(
            updater,
            QUARANTINE_JOURNAL_RECOVERY_FILE_NAME,
            MAX_QUARANTINE_JOURNAL_BYTES,
        ) {
            Ok(Some(existing)) if existing == raw => {
                if !matches!(
                    updater.remove_regular(OsStr::new(QUARANTINE_JOURNAL_RECOVERY_FILE_NAME)),
                    Ok(true)
                ) {
                    return Err(quarantine_journal_fault());
                }
            }
            Ok(None) => {}
            Ok(Some(_)) | Err(()) => return Err(quarantine_journal_fault()),
        }

        let mut staged = updater
            .create_new_renameable(OsStr::new(QUARANTINE_JOURNAL_RECOVERY_FILE_NAME))
            .map_err(|_| quarantine_journal_fault())?;
        if staged
            .write_all(raw)
            .and_then(|()| staged.sync_all())
            .is_err()
        {
            drop(staged);
            let _ = updater.remove_regular(OsStr::new(QUARANTINE_JOURNAL_RECOVERY_FILE_NAME));
            return Err(quarantine_journal_fault());
        }
        if updater
            .publish_without_replace(
                &staged,
                OsStr::new(QUARANTINE_JOURNAL_RECOVERY_FILE_NAME),
                OsStr::new(QUARANTINE_JOURNAL_FILE_NAME),
            )
            .is_err()
        {
            drop(staged);
            let _ = updater.remove_regular(OsStr::new(QUARANTINE_JOURNAL_RECOVERY_FILE_NAME));
            return Err(quarantine_journal_fault());
        }
        drop(staged);
        if !matches!(
            updater.remove_regular(OsStr::new(QUARANTINE_JOURNAL_TEMP_FILE_NAME)),
            Ok(true)
        ) {
            return Err(quarantine_journal_fault());
        }
        Ok(())
    }

    fn has_auth_rejected_part_marker(&self) -> Result<bool, ()> {
        let Some(cache) = StableDirectory::open_existing(self.cache_directory()).map_err(|_| ())?
        else {
            return Ok(false);
        };
        cache
            .open_regular_read(OsStr::new(AUTH_REJECTED_PART_FILE_NAME))
            .map(|value| value.is_some())
            .map_err(|_| ())
    }

    async fn recover_verified(
        &self,
        current_version: &str,
    ) -> Result<Option<RecoveredVerifiedCache>, CacheRecoveryFault> {
        let cache = match StableDirectory::open_existing(self.cache_directory()) {
            Ok(Some(directory)) => std::sync::Arc::new(directory),
            Ok(None) => return Ok(None),
            Err(_) => return Err(corrupt_fault()),
        };
        let exact_pair = self.has_exact_cache_pair(&cache)?;
        if !exact_pair {
            return Ok(None);
        }

        let raw_document = read_bounded_candidate_metadata(&cache)?;
        let document: CandidateCacheDocumentV1 =
            serde_json::from_slice(&raw_document).map_err(|_| corrupt_fault())?;
        if document.schema_version != CACHE_SCHEMA_VERSION
            || serde_json::to_vec(&document).map_err(|_| corrupt_fault())? != raw_document
            || candidate_digest(&document.candidate).map_err(|_| corrupt_fault())?
                != document.metadata_digest
        {
            return Err(corrupt_fault());
        }
        validate_fixed_candidate_fields(&document.candidate)?;

        let current = parse_stable_version(current_version)?;
        let cached = parse_stable_version(&document.candidate.version)?;
        if cached <= current {
            return Ok(None);
        }

        self.revalidate_verified_document(cache, document)
            .await
            .map(Some)
    }

    async fn revalidate_verified_document(
        &self,
        cache: std::sync::Arc<StableDirectory>,
        document: CandidateCacheDocumentV1,
    ) -> Result<RecoveredVerifiedCache, CacheRecoveryFault> {
        let raw_provenance = STANDARD
            .decode(&document.candidate.provenance_payload_base64)
            .map_err(|_| authenticity_fault())?;
        let verifier = ProvenanceVerifier::from_tauri_pubkey(&self.encoded_public_key)
            .map_err(|_| authenticity_fault())?;
        let evidence = verifier
            .verify(super::provenance::ProvenanceVerificationInput {
                raw_provenance: &raw_provenance,
                provenance_signature: &document.candidate.provenance_signature,
                installer_signature: &document.candidate.installer_signature,
                expected_repository: OFFICIAL_REPOSITORY,
                expected_tag: &document.candidate.tag,
                expected_version: &document.candidate.version,
                expected_commit_sha: &document.candidate.commit_sha,
                expected_target: CACHE_TARGET,
            })
            .map_err(|_| authenticity_fault())?;
        validate_evidence_matches_metadata(&evidence, &document.candidate)?;

        let (actual_size, actual_sha256, installer_file) = self
            .verify_installer(&cache, &evidence, &document.candidate)
            .await?;
        let artifact = VerifiedInstallerArtifact::from_recovered(
            &evidence,
            document.metadata_digest.clone(),
            self.installer_path(),
            actual_size,
            actual_sha256,
            cache,
            installer_file,
        );
        let release =
            NormalizedRelease::from_verified(evidence, std::iter::empty::<String>(), None);
        Ok(RecoveredVerifiedCache {
            release,
            artifact,
            metadata_digest: document.metadata_digest,
        })
    }

    fn has_exact_cache_pair(&self, cache: &StableDirectory) -> Result<bool, CacheRecoveryFault> {
        let entries = cache.entry_names().map_err(|_| corrupt_fault())?;
        let mut has_candidate = false;
        let mut has_installer = false;
        for name in entries {
            let name = name.to_str().ok_or_else(corrupt_fault)?;
            match name {
                "candidate.json" if !has_candidate => has_candidate = true,
                "installer.exe" if !has_installer => has_installer = true,
                _ => return Err(corrupt_fault()),
            }
            cache
                .open_regular_read(OsStr::new(name))
                .map_err(|_| corrupt_fault())?
                .ok_or_else(corrupt_fault)?;
        }

        match (has_candidate, has_installer) {
            (false, false) => Ok(false),
            (true, true) => Ok(true),
            _ => Err(corrupt_fault()),
        }
    }

    async fn verify_installer(
        &self,
        cache: &StableDirectory,
        evidence: &VerifiedReleaseEvidence,
        candidate: &CachedCandidateV1,
    ) -> Result<(u64, String, std::fs::File), CacheRecoveryFault> {
        let material = evidence
            .installer_verification_material()
            .map_err(|_| authenticity_fault())?;
        let mut minisign = material
            .public_key
            .verify_stream(&material.signature)
            .map_err(|_| authenticity_fault())?;
        let installer = cache
            .open_regular_read(OsStr::new("installer.exe"))
            .map_err(|_| corrupt_fault())?;
        let mut file = tokio::fs::File::from_std(installer.ok_or_else(corrupt_fault)?);
        let mut buffer = vec![0u8; INSTALLER_READ_CHUNK_BYTES];
        let mut size = 0u64;
        let mut sha256 = Sha256::new();
        loop {
            let read = file.read(&mut buffer).await.map_err(|_| corrupt_fault())?;
            if read == 0 {
                break;
            }
            size = size
                .checked_add(read as u64)
                .ok_or_else(authenticity_fault)?;
            if size > MAX_INSTALLER_BYTES || size > material.expected_size {
                return Err(authenticity_fault());
            }
            sha256.update(&buffer[..read]);
            minisign.update(&buffer[..read]);
        }
        let sha256 = format!("{:x}", sha256.finalize());
        if size != candidate.actual_size
            || size != candidate.expected_size
            || sha256 != candidate.installer_sha256
            || evidence
                .verify_installer_measurement(size, &sha256)
                .is_err()
            || minisign.finalize().is_err()
        {
            return Err(authenticity_fault());
        }
        Ok((size, sha256, file.into_std().await))
    }

    fn read_rejected_candidate(&self, reason_code: &str) -> Option<RejectedCachedCandidate> {
        let cache = StableDirectory::open_existing(self.cache_directory())
            .ok()
            .flatten()?;
        let raw = read_bounded_candidate_metadata(&cache).ok()?;
        let document: CandidateCacheDocumentV1 = serde_json::from_slice(&raw).ok()?;
        if document.schema_version != CACHE_SCHEMA_VERSION
            || serde_json::to_vec(&document).ok()? != raw
            || candidate_digest(&document.candidate).ok()? != document.metadata_digest
            || document.candidate.candidate_id.len() != 64
            || !document
                .candidate
                .candidate_id
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
            || parse_stable_version(&document.candidate.version).is_err()
        {
            return None;
        }
        Some(RejectedCachedCandidate {
            candidate_id: document.candidate.candidate_id,
            version: document.candidate.version,
            reason_code: reason_code.into(),
            rejected_at: 0,
        })
    }

    fn cleanup_startup_remnants(&self) -> Result<(), ()> {
        let cache = match StableDirectory::open_existing(self.cache_directory()) {
            Ok(Some(directory)) => directory,
            Ok(None) => return Ok(()),
            Err(_) => return Err(()),
        };
        let mut remnants = Vec::new();
        for name in cache.entry_names().map_err(|_| ())? {
            let name = name.to_str().ok_or(())?;
            if !matches!(name, "candidate.json.tmp" | "installer.part")
                && !name.starts_with(".installer.part.delete-")
            {
                continue;
            }
            remnants.push(name.to_owned());
        }
        if remnants.is_empty() {
            return Ok(());
        }
        self.persist_cleanup_tombstone()?;
        for name in remnants {
            let _ = cache.remove_regular(OsStr::new(&name)).map_err(|_| ())?;
        }
        for name in cache.entry_names().map_err(|_| ())? {
            let name = name.to_str().ok_or(())?;
            if matches!(name, "candidate.json.tmp" | "installer.part")
                || name.starts_with(".installer.part.delete-")
            {
                return Err(());
            }
        }
        self.clear_cleanup_tombstone()
    }

    fn cache_has_entries(&self) -> Result<bool, ()> {
        match StableDirectory::open_existing(self.cache_directory()) {
            Ok(Some(cache)) => Ok(!cache.entry_names().map_err(|_| ())?.is_empty()),
            Ok(None) => Ok(false),
            Err(_) => Err(()),
        }
    }

    fn cleanup_cache(&self) -> Result<(), ()> {
        let cache = match StableDirectory::open_existing(self.cache_directory()) {
            Ok(Some(directory)) => directory,
            Ok(None) => return Ok(()),
            Err(_) => return Err(()),
        };
        let entries = cache.entry_names().map_err(|_| ())?;
        for name in &entries {
            let name = name.to_str().ok_or(())?;
            if !matches!(
                name,
                "candidate.json"
                    | "candidate.json.tmp"
                    | "installer.exe"
                    | "installer.part"
                    | AUTH_REJECTED_PART_FILE_NAME
            ) && !name.starts_with(".installer.part.delete-")
            {
                return Err(());
            }
        }
        for name in entries {
            if !cache.remove_regular(&name).map_err(|_| ())? {
                return Err(());
            }
        }
        Ok(())
    }

    fn cleanup_cache_transaction(&self) -> Result<(), ()> {
        self.persist_cleanup_tombstone()?;
        self.cleanup_cache()?;
        self.clear_cleanup_tombstone()
    }

    fn persist_cleanup_tombstone(&self) -> Result<(), ()> {
        let updater = StableDirectory::open_or_create(&self.updater_directory).map_err(|_| ())?;
        match updater.open_regular_read(OsStr::new("cache-delete-v1.json")) {
            Ok(Some(_)) => return Ok(()),
            Ok(None) => {}
            Err(_) => return Err(()),
        }
        let mut nonce = [0u8; 16];
        getrandom::fill(&mut nonce).map_err(|_| ())?;
        let nonce = nonce
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let body = format!("{{\"schemaVersion\":1,\"cache\":\"cache-v1\",\"nonce\":\"{nonce}\"}}");
        let mut file = updater
            .create_new_renameable(OsStr::new("cache-delete-v1.json"))
            .map_err(|_| ())?;
        file.write_all(body.as_bytes()).map_err(|_| ())?;
        file.sync_all().map_err(|_| ())
    }

    fn clear_cleanup_tombstone(&self) -> Result<(), ()> {
        let updater = StableDirectory::open_existing(&self.updater_directory)
            .map_err(|_| ())?
            .ok_or(())?;
        updater
            .remove_regular(OsStr::new("cache-delete-v1.json"))
            .map_err(|_| ())?
            .then_some(())
            .ok_or(())
    }
}

fn candidate_digest(candidate: &CachedCandidateV1) -> Result<String, VerifiedCacheError> {
    let canonical = serde_json::to_vec(candidate).map_err(|_| {
        cache_error(
            "UPDATE_CACHE_METADATA_SERIALIZE_FAILED",
            "无法序列化更新缓存 metadata",
        )
    })?;
    Ok(format!("{:x}", Sha256::digest(canonical)))
}

fn candidate_matches_install_attempt(
    document: &CandidateCacheDocumentV1,
    expected: &InstallAttemptArtifactIdentity,
) -> bool {
    let candidate = &document.candidate;
    candidate.source_id == CACHE_SOURCE_ID
        && candidate.candidate_id == expected.candidate_id
        && candidate.version == expected.version
        && candidate.provenance_sha256 == expected.provenance_sha256
        && document.metadata_digest == expected.metadata_digest
        && candidate.installer_sha256 == expected.installer_sha256
        && candidate.expected_size == expected.installer_size
        && candidate.actual_size == expected.installer_size
        && candidate.repository == OFFICIAL_REPOSITORY
        && candidate.tag == format!("v{}", expected.version)
        && candidate.target == CACHE_TARGET
        && candidate.asset_name == format!("MineRadio-Tauri_{}_x64-setup.exe", expected.version)
        && candidate.downloaded_at <= candidate.verified_at
}

fn is_lower_hex(value: &str, expected_len: usize) -> bool {
    value.len() == expected_len
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn validate_fixed_candidate_fields(
    candidate: &CachedCandidateV1,
) -> Result<(), CacheRecoveryFault> {
    if candidate.source_id != CACHE_SOURCE_ID
        || candidate.repository != OFFICIAL_REPOSITORY
        || candidate.target != CACHE_TARGET
        || candidate.expected_size == 0
        || candidate.expected_size > MAX_INSTALLER_BYTES
        || candidate.actual_size != candidate.expected_size
        || candidate.downloaded_at > candidate.verified_at
    {
        return Err(authenticity_fault());
    }
    Ok(())
}

fn validate_evidence_matches_metadata(
    evidence: &VerifiedReleaseEvidence,
    candidate: &CachedCandidateV1,
) -> Result<(), CacheRecoveryFault> {
    let candidate_identity = STANDARD
        .decode(&candidate.candidate_identity_base64)
        .map_err(|_| authenticity_fault())?;
    if evidence.candidate_id().as_str() != candidate.candidate_id
        || evidence.candidate_identity() != candidate_identity
        || evidence.repository() != candidate.repository
        || evidence.tag() != candidate.tag
        || evidence.version() != candidate.version
        || evidence.commit_sha() != candidate.commit_sha
        || evidence.target() != candidate.target
        || evidence.installer_name() != candidate.asset_name
        || evidence.installer_size() != candidate.expected_size
        || evidence.installer_sha256() != candidate.installer_sha256
        || evidence.installer_signature() != candidate.installer_signature
        || evidence.installer_signature_sha256() != candidate.installer_signature_sha256
        || evidence.provenance_signature() != candidate.provenance_signature
        || evidence.provenance_sha256() != candidate.provenance_sha256
        || evidence.provenance_signature_sha256() != candidate.provenance_signature_sha256
    {
        return Err(authenticity_fault());
    }
    Ok(())
}

fn parse_stable_version(raw: &str) -> Result<Version, CacheRecoveryFault> {
    let version = Version::parse(raw).map_err(|_| authenticity_fault())?;
    if !version.pre.is_empty() || !version.build.is_empty() || version.to_string() != raw {
        return Err(authenticity_fault());
    }
    Ok(version)
}

fn validate_quarantine_document(
    document: &QuarantinePendingDocumentV1,
) -> Result<(), VerifiedCacheError> {
    let candidate_id_is_valid = document.candidate_id.len() == 64
        && document
            .candidate_id
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase());
    let stable_version_is_valid = document.version.len() <= 64
        && Version::parse(&document.version).is_ok_and(|version| {
            version.pre.is_empty()
                && version.build.is_empty()
                && version.to_string() == document.version
        });
    let reason_is_valid = (1..=128).contains(&document.reason.len())
        && document.reason.starts_with("UPDATE_")
        && document
            .reason
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_');
    if document.schema_version != QUARANTINE_JOURNAL_SCHEMA_VERSION
        || !candidate_id_is_valid
        || !stable_version_is_valid
        || !reason_is_valid
        || document.rejected_at == 0
    {
        return Err(quarantine_journal_error());
    }
    Ok(())
}

fn parse_quarantine_document(
    raw: &[u8],
) -> Result<QuarantinePendingDocumentV1, CacheRecoveryFault> {
    let document: QuarantinePendingDocumentV1 =
        serde_json::from_slice(raw).map_err(|_| quarantine_journal_fault())?;
    if serde_json::to_vec(&document).map_err(|_| quarantine_journal_fault())? != raw
        || validate_quarantine_document(&document).is_err()
    {
        return Err(quarantine_journal_fault());
    }
    Ok(document)
}

fn unix_timestamp_millis() -> Result<u64, VerifiedCacheError> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| quarantine_journal_error())?
        .as_millis();
    u64::try_from(millis)
        .ok()
        .filter(|value| *value > 0)
        .ok_or_else(quarantine_journal_error)
}

fn read_bounded_managed_file(
    directory: &StableDirectory,
    name: &str,
    maximum: u64,
) -> Result<Option<Vec<u8>>, ()> {
    let mut file = directory
        .open_regular_read(OsStr::new(name))
        .map_err(|_| ())?;
    let Some(mut file) = file.take() else {
        return Ok(None);
    };
    let expected_len = file.metadata().map_err(|_| ())?.len();
    if expected_len == 0 || expected_len > maximum {
        return Err(());
    }
    let mut raw = Vec::with_capacity(expected_len as usize);
    (&mut file)
        .take(maximum + 1)
        .read_to_end(&mut raw)
        .map_err(|_| ())?;
    if raw.len() as u64 != expected_len
        || raw.len() as u64 > maximum
        || raw.starts_with(&[0xEF, 0xBB, 0xBF])
    {
        return Err(());
    }
    Ok(Some(raw))
}

#[cfg(unix)]
fn sync_directory_best_effort(path: &Path) {
    let _ = std::fs::File::open(path).and_then(|directory| directory.sync_all());
}

#[cfg(not(unix))]
fn sync_directory_best_effort(_path: &Path) {}

fn reject_existing_leaf(directory: &StableDirectory, name: &str) -> Result<(), VerifiedCacheError> {
    match directory.open_regular_read(OsStr::new(name)) {
        Ok(None) => Ok(()),
        Ok(Some(_)) => Err(cache_error(
            "UPDATE_CACHE_METADATA_CONFLICT",
            "更新缓存 metadata 已存在",
        )),
        Err(_) => Err(cache_io_error()),
    }
}

fn read_bounded_candidate_metadata(cache: &StableDirectory) -> Result<Vec<u8>, CacheRecoveryFault> {
    let mut file = cache
        .open_regular_read(OsStr::new("candidate.json"))
        .map_err(|_| corrupt_fault())?
        .ok_or_else(corrupt_fault)?;
    let metadata_before = file.metadata().map_err(|_| corrupt_fault())?;
    let expected_len = metadata_before.len();
    if expected_len == 0 || expected_len > MAX_CANDIDATE_METADATA_BYTES {
        return Err(corrupt_fault());
    }

    let mut raw = Vec::with_capacity(expected_len as usize);
    {
        let mut bounded = (&mut file).take(MAX_CANDIDATE_METADATA_BYTES + 1);
        bounded.read_to_end(&mut raw).map_err(|_| corrupt_fault())?;
    }
    let metadata_after = file.metadata().map_err(|_| corrupt_fault())?;
    if raw.len() as u64 != expected_len
        || metadata_after.len() != expected_len
        || raw.len() as u64 > MAX_CANDIDATE_METADATA_BYTES
        || raw.starts_with(&[0xEF, 0xBB, 0xBF])
    {
        return Err(corrupt_fault());
    }
    Ok(raw)
}

fn cache_error(code: &'static str, message: &'static str) -> VerifiedCacheError {
    VerifiedCacheError { code, message }
}

fn cache_io_error() -> VerifiedCacheError {
    cache_error("UPDATE_CACHE_IO_FAILED", "无法安全读写更新缓存 metadata")
}

fn quarantine_journal_error() -> VerifiedCacheError {
    cache_error(
        "UPDATE_QUARANTINE_JOURNAL_REJECTED",
        "无法安全持久化 exact rejection journal",
    )
}

fn corrupt_fault() -> CacheRecoveryFault {
    CacheRecoveryFault {
        code: "UPDATE_CACHE_CORRUPT",
        message: "已验证更新缓存不完整或损坏",
    }
}

fn authenticity_fault() -> CacheRecoveryFault {
    CacheRecoveryFault {
        code: "UPDATE_CACHE_AUTHENTICITY_REJECTED",
        message: "已验证更新缓存无法重新通过来源与签名验证",
    }
}

fn identity_conflict_fault() -> CacheRecoveryFault {
    CacheRecoveryFault {
        code: "UPDATE_CACHE_IDENTITY_CONFLICT",
        message: "安装尝试与已验证更新缓存 identity 不一致",
    }
}

fn install_attempt_cache_missing_fault() -> CacheRecoveryFault {
    CacheRecoveryFault {
        code: "UPDATE_CACHE_INSTALL_ATTEMPT_ARTIFACT_MISSING",
        message: "安装尝试对应的完整 verified cache pair 不存在",
    }
}

fn cleanup_blocked_fault() -> CacheRecoveryFault {
    CacheRecoveryFault {
        code: "UPDATE_CACHE_CLEANUP_BLOCKED",
        message: "更新缓存清理失败，已阻止发布 candidate",
    }
}

fn quarantine_journal_fault() -> CacheRecoveryFault {
    CacheRecoveryFault {
        code: "UPDATE_QUARANTINE_JOURNAL_REJECTED",
        message: "exact rejection journal 缺失、损坏或无法安全读取",
    }
}

fn quarantine_identity_fault() -> CacheRecoveryFault {
    CacheRecoveryFault {
        code: "UPDATE_QUARANTINE_IDENTITY_UNAVAILABLE",
        message: "无法从被拒绝缓存取得 exact candidate identity",
    }
}

fn reconciliation_required_fault() -> CacheRecoveryFault {
    CacheRecoveryFault {
        code: "UPDATE_INSTALL_RECONCILIATION_REQUIRED",
        message: "安装尝试证据尚未协调，已保留更新缓存",
    }
}

fn web_reconciliation_required_fault() -> CacheRecoveryFault {
    CacheRecoveryFault {
        code: "UPDATE_WEB_QUIESCENCE_RECONCILIATION_REQUIRED",
        message: "Web 播放静默证据尚未协调，已保留更新缓存",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::updater::provenance::ProvenanceVerificationInput;

    const RAW_PROVENANCE: &[u8] = include_bytes!("fixtures/provenance-v2.json");
    const CONTRACT_JSON: &str = include_str!("fixtures/provenance-v2-contract.json");

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let mut nonce = [0u8; 16];
            getrandom::fill(&mut nonce).expect("测试目录应取得系统随机标识");
            let suffix = nonce
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>();
            let path = std::env::temp_dir().join(format!("mineradio-updater-cache-{suffix}"));
            std::fs::create_dir(&path).expect("测试目录应能创建");
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn fixture() -> (String, VerifiedReleaseEvidence) {
        let contract: serde_json::Value =
            serde_json::from_str(CONTRACT_JSON).expect("共享 contract 应有效");
        let encoded_public_key = contract["encoded_public_key"]
            .as_str()
            .expect("contract 应包含公钥")
            .to_owned();
        let verifier =
            ProvenanceVerifier::from_tauri_pubkey(&encoded_public_key).expect("fixture 公钥应有效");
        let evidence = verifier
            .verify(ProvenanceVerificationInput {
                raw_provenance: RAW_PROVENANCE,
                provenance_signature: contract["provenance_signature"].as_str().unwrap(),
                installer_signature: contract["installer_signature"].as_str().unwrap(),
                expected_repository: "zzstar101/Mineradio-Tauri",
                expected_tag: "v1.2.3",
                expected_version: "1.2.3",
                expected_commit_sha: "0123456789abcdef0123456789abcdef01234567",
                expected_target: "windows-x86_64-nsis",
            })
            .expect("fixture provenance 应有效");
        (encoded_public_key, evidence)
    }

    fn install_attempt_identity(metadata_digest: String) -> InstallAttemptArtifactIdentity {
        InstallAttemptArtifactIdentity::new(
            "1f524da9660c738e349f342d1e3f0bc9da3b28b9c4842636475ccdde59b9ee0e",
            "1.2.3",
            "8f0e1c18d801bde833d2aec15adca1bc6b49f19ad81b4c4300655fb0350f29a6",
            metadata_digest,
            "9c0d294c05fc1d88d698034609bb81c0c69196327594e4c69d2915c80fd9850c",
            9,
        )
        .expect("fixture install-attempt identity 应有效")
    }

    #[test]
    fn install_attempt_inspection_bypasses_version_and_pending_marker_gates() {
        tauri::async_runtime::block_on(async {
            for current_version in ["1.2.3", "9.0.0"] {
                let root = TestDirectory::new();
                let (public_key, evidence) = fixture();
                let store = VerifiedCacheStore::new(&root.0, public_key).unwrap();
                let cache = root.0.join("cache-v1");
                std::fs::create_dir(&cache).unwrap();
                std::fs::write(cache.join("installer.exe"), b"installer").unwrap();
                let metadata_digest = store
                    .commit_verified(
                        &evidence,
                        9,
                        "9c0d294c05fc1d88d698034609bb81c0c69196327594e4c69d2915c80fd9850c",
                        10,
                        11,
                    )
                    .await
                    .unwrap();
                std::fs::write(root.0.join("install-attempt-v1.json"), b"pending").unwrap();
                std::fs::write(
                    root.0.join("install-attempt-reconciliation-v1.json"),
                    b"reconciled",
                )
                .unwrap();
                std::fs::write(root.0.join("web-quiescence-v1.json"), b"prepared").unwrap();

                let recovered = store
                    .inspect_install_attempt_artifact(&install_attempt_identity(metadata_digest))
                    .await
                    .expect("同版/低版缓存和 reconciliation marker 不得阻断 exact inspect");

                assert_eq!(recovered.release.version, "1.2.3");
                assert_eq!(recovered.artifact.size(), 9);
                assert!(cache.join("candidate.json").is_file());
                assert!(cache.join("installer.exe").is_file());
                drop(recovered);

                std::fs::remove_file(root.0.join("install-attempt-v1.json")).unwrap();
                std::fs::remove_file(root.0.join("install-attempt-reconciliation-v1.json"))
                    .unwrap();
                std::fs::remove_file(root.0.join("web-quiescence-v1.json")).unwrap();
                let ordinary = store.recover(current_version).await;
                assert!(matches!(
                    ordinary,
                    CacheRecoveryOutcome::Empty {
                        fault: None,
                        quarantine: None
                    }
                ));
            }
        });
    }

    #[test]
    fn install_attempt_identity_mismatch_fails_closed_without_mutating_evidence() {
        tauri::async_runtime::block_on(async {
            for axis in [
                "candidate",
                "version",
                "provenance",
                "metadata",
                "installer-sha256",
                "installer-size",
            ] {
                let root = TestDirectory::new();
                let (public_key, evidence) = fixture();
                let store = VerifiedCacheStore::new(&root.0, public_key).unwrap();
                let cache = root.0.join("cache-v1");
                std::fs::create_dir(&cache).unwrap();
                std::fs::write(cache.join("installer.exe"), b"installer").unwrap();
                let metadata_digest = store
                    .commit_verified(
                        &evidence,
                        9,
                        "9c0d294c05fc1d88d698034609bb81c0c69196327594e4c69d2915c80fd9850c",
                        10,
                        11,
                    )
                    .await
                    .unwrap();
                let metadata_before = std::fs::read(cache.join("candidate.json")).unwrap();
                let installer_before = std::fs::read(cache.join("installer.exe")).unwrap();
                let mut expected = install_attempt_identity(metadata_digest);
                match axis {
                    "candidate" => {
                        expected.candidate_id =
                            "2f524da9660c738e349f342d1e3f0bc9da3b28b9c4842636475ccdde59b9ee0e"
                                .into()
                    }
                    "version" => expected.version = "1.2.4".into(),
                    "provenance" => {
                        expected.provenance_sha256 =
                            "7f0e1c18d801bde833d2aec15adca1bc6b49f19ad81b4c4300655fb0350f29a6"
                                .into()
                    }
                    "metadata" => {
                        expected.metadata_digest =
                            "7e0d294c05fc1d88d698034609bb81c0c69196327594e4c69d2915c80fd9850c"
                                .into()
                    }
                    "installer-sha256" => {
                        expected.installer_sha256 =
                            "8c0d294c05fc1d88d698034609bb81c0c69196327594e4c69d2915c80fd9850c"
                                .into()
                    }
                    "installer-size" => expected.installer_size = 10,
                    _ => unreachable!("identity axis 应穷尽"),
                }

                let fault = store
                    .inspect_install_attempt_artifact(&expected)
                    .await
                    .expect_err("任一 install-attempt identity 轴不一致都必须 fail closed");

                assert_eq!(fault.kind(), CacheRecoveryFaultKind::IdentityConflict);
                assert_eq!(fault.code, "UPDATE_CACHE_IDENTITY_CONFLICT");
                assert_eq!(
                    std::fs::read(cache.join("candidate.json")).unwrap(),
                    metadata_before
                );
                assert_eq!(
                    std::fs::read(cache.join("installer.exe")).unwrap(),
                    installer_before
                );
            }
        });
    }

    #[test]
    fn install_attempt_metadata_digest_or_fixed_origin_mismatch_is_identity_conflict() {
        tauri::async_runtime::block_on(async {
            for mutation in ["stored-digest", "repository"] {
                let root = TestDirectory::new();
                let (public_key, evidence) = fixture();
                let store = VerifiedCacheStore::new(&root.0, public_key).unwrap();
                let cache = root.0.join("cache-v1");
                std::fs::create_dir(&cache).unwrap();
                std::fs::write(cache.join("installer.exe"), b"installer").unwrap();
                let metadata_digest = store
                    .commit_verified(
                        &evidence,
                        9,
                        "9c0d294c05fc1d88d698034609bb81c0c69196327594e4c69d2915c80fd9850c",
                        10,
                        11,
                    )
                    .await
                    .unwrap();
                let path = cache.join("candidate.json");
                let mut document: CandidateCacheDocumentV1 =
                    serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
                let mut expected = install_attempt_identity(metadata_digest);
                match mutation {
                    "stored-digest" => {
                        document.metadata_digest =
                            "7e0d294c05fc1d88d698034609bb81c0c69196327594e4c69d2915c80fd9850c"
                                .into();
                    }
                    "repository" => {
                        document.candidate.repository = "attacker/example".into();
                        document.metadata_digest = candidate_digest(&document.candidate).unwrap();
                        expected.metadata_digest = document.metadata_digest.clone();
                    }
                    _ => unreachable!("metadata mutation 应穷尽"),
                }
                let mutated = serde_json::to_vec(&document).unwrap();
                std::fs::write(&path, &mutated).unwrap();

                let fault = store
                    .inspect_install_attempt_artifact(&expected)
                    .await
                    .expect_err("metadata digest 或固定来源字段不一致必须是 identity conflict");

                assert_eq!(fault.kind(), CacheRecoveryFaultKind::IdentityConflict);
                assert_eq!(fault.code, "UPDATE_CACHE_IDENTITY_CONFLICT");
                assert_eq!(std::fs::read(&path).unwrap(), mutated);
                assert_eq!(
                    std::fs::read(cache.join("installer.exe")).unwrap(),
                    b"installer"
                );
            }
        });
    }

    #[test]
    fn install_attempt_missing_or_malformed_cache_is_blocked_without_cleanup() {
        tauri::async_runtime::block_on(async {
            let (public_key, _) = fixture();
            let missing_root = TestDirectory::new();
            let missing_store = VerifiedCacheStore::new(&missing_root.0, public_key).unwrap();
            let fault = missing_store
                .inspect_install_attempt_artifact(&install_attempt_identity(
                    "8e0d294c05fc1d88d698034609bb81c0c69196327594e4c69d2915c80fd9850c".into(),
                ))
                .await
                .expect_err("缺失 exact cache pair 必须 fail closed");
            assert_eq!(fault.kind(), CacheRecoveryFaultKind::Blocked);
            assert_eq!(fault.code, "UPDATE_CACHE_INSTALL_ATTEMPT_ARTIFACT_MISSING");

            let malformed_root = TestDirectory::new();
            let (public_key, _) = fixture();
            let malformed_store = VerifiedCacheStore::new(&malformed_root.0, public_key).unwrap();
            let cache = malformed_root.0.join("cache-v1");
            std::fs::create_dir(&cache).unwrap();
            std::fs::write(cache.join("candidate.json"), b"{not-json}").unwrap();
            std::fs::write(cache.join("installer.exe"), b"installer").unwrap();

            let fault = malformed_store
                .inspect_install_attempt_artifact(&install_attempt_identity(
                    "8e0d294c05fc1d88d698034609bb81c0c69196327594e4c69d2915c80fd9850c".into(),
                ))
                .await
                .expect_err("损坏 metadata 必须 fail closed");

            assert_eq!(fault.kind(), CacheRecoveryFaultKind::Blocked);
            assert_eq!(fault.code, "UPDATE_CACHE_CORRUPT");
            assert_eq!(
                std::fs::read(cache.join("candidate.json")).unwrap(),
                b"{not-json}"
            );
            assert_eq!(
                std::fs::read(cache.join("installer.exe")).unwrap(),
                b"installer"
            );
        });
    }

    #[test]
    fn install_attempt_authenticity_failure_preserves_exact_cache_evidence() {
        tauri::async_runtime::block_on(async {
            let root = TestDirectory::new();
            let (public_key, evidence) = fixture();
            let store = VerifiedCacheStore::new(&root.0, public_key).unwrap();
            let cache = root.0.join("cache-v1");
            std::fs::create_dir(&cache).unwrap();
            std::fs::write(cache.join("installer.exe"), b"installer").unwrap();
            let metadata_digest = store
                .commit_verified(
                    &evidence,
                    9,
                    "9c0d294c05fc1d88d698034609bb81c0c69196327594e4c69d2915c80fd9850c",
                    10,
                    11,
                )
                .await
                .unwrap();
            let metadata_before = std::fs::read(cache.join("candidate.json")).unwrap();
            std::fs::write(cache.join("installer.exe"), b"tampered!").unwrap();

            let fault = store
                .inspect_install_attempt_artifact(&install_attempt_identity(metadata_digest))
                .await
                .expect_err("exact identity 后安装包 hash/Minisign 失败必须拒绝真实性");

            assert_eq!(fault.kind(), CacheRecoveryFaultKind::AuthenticityRejected);
            assert_eq!(fault.code, "UPDATE_CACHE_AUTHENTICITY_REJECTED");
            assert_eq!(
                std::fs::read(cache.join("candidate.json")).unwrap(),
                metadata_before
            );
            assert_eq!(
                std::fs::read(cache.join("installer.exe")).unwrap(),
                b"tampered!"
            );
            assert!(!root.0.join(QUARANTINE_JOURNAL_FILE_NAME).exists());
            assert!(!root.0.join("cache-delete-v1.json").exists());
        });
    }

    #[test]
    fn complete_verified_cache_recovers_offline_after_full_revalidation() {
        tauri::async_runtime::block_on(async {
            let root = TestDirectory::new();
            let (public_key, evidence) = fixture();
            let store = VerifiedCacheStore::new(&root.0, public_key).unwrap();
            let cache = root.0.join("cache-v1");
            std::fs::create_dir(&cache).unwrap();
            std::fs::write(cache.join("installer.exe"), b"installer").unwrap();
            let installer_sha256 =
                "9c0d294c05fc1d88d698034609bb81c0c69196327594e4c69d2915c80fd9850c";

            let metadata_digest = store
                .commit_verified(&evidence, 9, installer_sha256, 10, 11)
                .await
                .expect("完整 verified pair 应能提交");
            let recovered = store.recover("0.1.0").await;

            let CacheRecoveryOutcome::Recovered(recovered) = recovered else {
                panic!("完整 verified pair 应离线恢复: {recovered:?}");
            };
            assert_eq!(
                recovered.release.candidate_id.as_str(),
                "1f524da9660c738e349f342d1e3f0bc9da3b28b9c4842636475ccdde59b9ee0e"
            );
            assert_eq!(recovered.release.version, "1.2.3");
            assert_eq!(recovered.metadata_digest, metadata_digest);
        });
    }

    #[cfg(windows)]
    #[test]
    fn recovered_artifact_keeps_the_revalidated_leaf_locked_across_clones() {
        tauri::async_runtime::block_on(async {
            let root = TestDirectory::new();
            let (public_key, evidence) = fixture();
            let store = VerifiedCacheStore::new(&root.0, public_key).unwrap();
            let cache = root.0.join("cache-v1");
            std::fs::create_dir(&cache).unwrap();
            std::fs::write(cache.join("installer.exe"), b"installer").unwrap();
            store
                .commit_verified(
                    &evidence,
                    9,
                    "9c0d294c05fc1d88d698034609bb81c0c69196327594e4c69d2915c80fd9850c",
                    10,
                    11,
                )
                .await
                .unwrap();

            let outcome = store.recover("0.1.0").await;
            let CacheRecoveryOutcome::Recovered(recovered) = outcome else {
                panic!("完整缓存必须恢复");
            };
            let clone = recovered.artifact.clone();
            let path = recovered.artifact.path().to_path_buf();
            assert!(std::fs::OpenOptions::new().write(true).open(&path).is_err());
            drop(recovered);
            assert!(std::fs::OpenOptions::new().write(true).open(&path).is_err());

            clone.discard().unwrap();
            assert!(!path.exists());
        });
    }

    #[test]
    fn unknown_cache_entry_blocks_recovery_and_persists_cleanup_tombstone() {
        tauri::async_runtime::block_on(async {
            let root = TestDirectory::new();
            let (public_key, evidence) = fixture();
            let store = VerifiedCacheStore::new(&root.0, public_key).unwrap();
            let cache = root.0.join("cache-v1");
            std::fs::create_dir(&cache).unwrap();
            std::fs::write(cache.join("installer.exe"), b"installer").unwrap();
            store
                .commit_verified(
                    &evidence,
                    9,
                    "9c0d294c05fc1d88d698034609bb81c0c69196327594e4c69d2915c80fd9850c",
                    10,
                    11,
                )
                .await
                .unwrap();
            std::fs::write(cache.join("unexpected.bin"), b"untrusted").unwrap();

            let outcome = store.recover("0.1.0").await;
            let CacheRecoveryOutcome::Blocked(fault) = outcome else {
                panic!("cache-v1 出现未知条目时必须阻断 candidate 发布: {outcome:?}");
            };
            assert_eq!(fault.code, "UPDATE_CACHE_CLEANUP_BLOCKED");
            assert!(root.0.join("cache-delete-v1.json").exists());
        });
    }

    #[test]
    fn incomplete_cache_pair_is_rejected_and_cleaned() {
        tauri::async_runtime::block_on(async {
            for lone_entry in ["candidate.json", "installer.exe"] {
                let root = TestDirectory::new();
                let (public_key, _) = fixture();
                let store = VerifiedCacheStore::new(&root.0, public_key).unwrap();
                let cache = root.0.join("cache-v1");
                std::fs::create_dir(&cache).unwrap();
                std::fs::write(cache.join(lone_entry), b"incomplete").unwrap();

                let outcome = store.recover("0.1.0").await;
                let CacheRecoveryOutcome::Empty {
                    fault: Some(fault),
                    quarantine: None,
                } = outcome
                else {
                    panic!("仅存在 {lone_entry} 时必须拒绝不完整 cache pair: {outcome:?}");
                };
                assert_eq!(fault.code, "UPDATE_CACHE_CORRUPT");
                assert!(std::fs::read_dir(cache).unwrap().next().is_none());
            }
        });
    }

    #[test]
    fn oversized_or_bom_prefixed_metadata_is_rejected_and_cleaned() {
        tauri::async_runtime::block_on(async {
            let cases = [
                vec![b'x'; MAX_CANDIDATE_METADATA_BYTES as usize + 1],
                b"\xEF\xBB\xBF{}".to_vec(),
            ];
            for raw_metadata in cases {
                let root = TestDirectory::new();
                let (public_key, _) = fixture();
                let store = VerifiedCacheStore::new(&root.0, public_key).unwrap();
                let cache = root.0.join("cache-v1");
                std::fs::create_dir(&cache).unwrap();
                std::fs::write(cache.join("candidate.json"), raw_metadata).unwrap();
                std::fs::write(cache.join("installer.exe"), b"installer").unwrap();

                let outcome = store.recover("0.1.0").await;
                let CacheRecoveryOutcome::Empty {
                    fault: Some(fault),
                    quarantine: None,
                } = outcome
                else {
                    panic!("超限或带 BOM 的 metadata 必须被拒绝并清理: {outcome:?}");
                };
                assert_eq!(fault.code, "UPDATE_CACHE_CORRUPT");
                assert!(std::fs::read_dir(cache).unwrap().next().is_none());
            }
        });
    }

    #[test]
    fn provenance_and_minisign_tampering_is_rejected_after_a_valid_metadata_digest() {
        tauri::async_runtime::block_on(async {
            for mutation in [
                "provenance-payload",
                "provenance-signature",
                "installer-signature",
            ] {
                let root = TestDirectory::new();
                let (public_key, evidence) = fixture();
                let store = VerifiedCacheStore::new(&root.0, public_key).unwrap();
                let cache = root.0.join("cache-v1");
                std::fs::create_dir(&cache).unwrap();
                std::fs::write(cache.join("installer.exe"), b"installer").unwrap();
                store
                    .commit_verified(
                        &evidence,
                        9,
                        "9c0d294c05fc1d88d698034609bb81c0c69196327594e4c69d2915c80fd9850c",
                        10,
                        11,
                    )
                    .await
                    .unwrap();

                let path = cache.join("candidate.json");
                let mut document: CandidateCacheDocumentV1 =
                    serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
                match mutation {
                    "provenance-payload" => {
                        document.candidate.provenance_payload_base64 = STANDARD.encode(b"{}");
                    }
                    "provenance-signature" => {
                        document.candidate.provenance_signature.push('A');
                        document.candidate.provenance_signature_sha256 = format!(
                            "{:x}",
                            Sha256::digest(document.candidate.provenance_signature.as_bytes())
                        );
                    }
                    "installer-signature" => {
                        document.candidate.installer_signature.push('A');
                        document.candidate.installer_signature_sha256 = format!(
                            "{:x}",
                            Sha256::digest(document.candidate.installer_signature.as_bytes())
                        );
                    }
                    _ => unreachable!("测试 mutation 必须穷尽"),
                }
                document.metadata_digest = candidate_digest(&document.candidate).unwrap();
                std::fs::write(&path, serde_json::to_vec(&document).unwrap()).unwrap();

                let outcome = store.recover("0.1.0").await;
                let CacheRecoveryOutcome::PendingQuarantine(pending) = outcome else {
                    panic!("{mutation} 篡改必须进入 exact quarantine: {outcome:?}");
                };
                assert_eq!(
                    pending.rejected().reason_code,
                    "UPDATE_CACHE_AUTHENTICITY_REJECTED"
                );
                assert!(root.0.join(QUARANTINE_JOURNAL_FILE_NAME).is_file());
                assert!(cache.join("candidate.json").is_file());
                assert!(cache.join("installer.exe").is_file());
            }
        });
    }

    #[test]
    fn tampered_installer_persists_rejection_before_cleanup_and_replays_until_finalized() {
        tauri::async_runtime::block_on(async {
            let root = TestDirectory::new();
            let (public_key, evidence) = fixture();
            let store = VerifiedCacheStore::new(&root.0, public_key).unwrap();
            let cache = root.0.join("cache-v1");
            std::fs::create_dir(&cache).unwrap();
            std::fs::write(cache.join("installer.exe"), b"installer").unwrap();
            store
                .commit_verified(
                    &evidence,
                    9,
                    "9c0d294c05fc1d88d698034609bb81c0c69196327594e4c69d2915c80fd9850c",
                    10,
                    11,
                )
                .await
                .unwrap();
            std::fs::write(cache.join("installer.exe"), b"tampered!").unwrap();

            let outcome = store.recover("0.1.0").await;
            let CacheRecoveryOutcome::PendingQuarantine(pending) = outcome else {
                panic!("被篡改缓存必须先持久化 exact rejection: {outcome:?}");
            };
            let quarantine = pending.rejected();
            assert_eq!(
                quarantine.candidate_id,
                "1f524da9660c738e349f342d1e3f0bc9da3b28b9c4842636475ccdde59b9ee0e"
            );
            assert_eq!(quarantine.version, "1.2.3");
            assert_eq!(quarantine.reason_code, "UPDATE_CACHE_AUTHENTICITY_REJECTED");
            assert!(quarantine.rejected_at > 0);
            assert!(root.0.join("quarantine-pending-v1.json").is_file());
            assert!(cache.join("candidate.json").is_file());
            assert!(cache.join("installer.exe").is_file());

            let replayed = store.recover("0.1.0").await;
            let CacheRecoveryOutcome::PendingQuarantine(replayed) = replayed else {
                panic!("未 finalize 的 rejection 必须在重启时重放: {replayed:?}");
            };
            assert_eq!(replayed.rejected(), quarantine);
            replayed
                .finalize()
                .expect("策略持久化后应能完成 cache 清理与 journal 删除");

            assert!(!root.0.join("quarantine-pending-v1.json").exists());
            assert!(!cache.join("candidate.json").exists());
            assert!(!cache.join("installer.exe").exists());
        });
    }

    #[test]
    fn malformed_or_incomplete_rejection_journal_fails_closed_without_cache_cleanup() {
        tauri::async_runtime::block_on(async {
            let valid_id = "1f524da9660c738e349f342d1e3f0bc9da3b28b9c4842636475ccdde59b9ee0e";
            let cases = vec![
                format!(
                    "\u{feff}{{\"schemaVersion\":1,\"candidateId\":\"{valid_id}\",\"version\":\"1.2.3\",\"reason\":\"UPDATE_CACHE_AUTHENTICITY_REJECTED\",\"rejectedAt\":1}}"
                )
                .into_bytes(),
                format!(
                    "{{\"schemaVersion\":2,\"candidateId\":\"{valid_id}\",\"version\":\"1.2.3\",\"reason\":\"UPDATE_CACHE_AUTHENTICITY_REJECTED\",\"rejectedAt\":1}}"
                )
                .into_bytes(),
                format!(
                    "{{\"schemaVersion\":1,\"candidateId\":\"{valid_id}\",\"version\":\"1.2.3\",\"reason\":\"UPDATE_CACHE_AUTHENTICITY_REJECTED\",\"rejectedAt\":1,\"extra\":true}}"
                )
                .into_bytes(),
                format!(
                    "{{\"schemaVersion\":1,\"candidateId\":\"{valid_id}\",\"version\":\"1.2.3-alpha\",\"reason\":\"unsafe reason\",\"rejectedAt\":1}}"
                )
                .into_bytes(),
                vec![b'x'; MAX_QUARANTINE_JOURNAL_BYTES as usize + 1],
            ];
            for raw in cases {
                let root = TestDirectory::new();
                let (public_key, _) = fixture();
                let store = VerifiedCacheStore::new(&root.0, public_key).unwrap();
                let cache = root.0.join("cache-v1");
                std::fs::create_dir(&cache).unwrap();
                std::fs::write(cache.join("installer.part"), b"preserve me").unwrap();
                std::fs::write(root.0.join(QUARANTINE_JOURNAL_FILE_NAME), raw).unwrap();

                let outcome = store.recover("0.1.0").await;
                let CacheRecoveryOutcome::Blocked(fault) = outcome else {
                    panic!("非法 journal 必须 fail closed: {outcome:?}");
                };
                assert_eq!(fault.code, "UPDATE_QUARANTINE_JOURNAL_REJECTED");
                assert_eq!(
                    std::fs::read(cache.join("installer.part")).unwrap(),
                    b"preserve me"
                );
            }

            let root = TestDirectory::new();
            let (public_key, _) = fixture();
            let store = VerifiedCacheStore::new(&root.0, public_key).unwrap();
            let cache = root.0.join("cache-v1");
            std::fs::create_dir(&cache).unwrap();
            std::fs::write(cache.join("installer.part"), b"preserve me").unwrap();
            std::fs::create_dir(root.0.join(QUARANTINE_JOURNAL_TEMP_FILE_NAME)).unwrap();

            let outcome = store.recover("0.1.0").await;
            assert!(matches!(outcome, CacheRecoveryOutcome::Blocked(_)));
            assert!(cache.join("installer.part").is_file());

            let root = TestDirectory::new();
            let (public_key, _) = fixture();
            let store = VerifiedCacheStore::new(&root.0, public_key).unwrap();
            let cache = root.0.join("cache-v1");
            std::fs::create_dir(&cache).unwrap();
            std::fs::write(cache.join("installer.part"), b"preserve me").unwrap();
            std::fs::write(
                root.0.join(QUARANTINE_JOURNAL_TEMP_FILE_NAME),
                b"{\"schemaVersion\":1}",
            )
            .unwrap();

            let outcome = store.recover("0.1.0").await;
            let CacheRecoveryOutcome::Blocked(fault) = outcome else {
                panic!("字段不完整的普通 temp 文件必须 fail closed: {outcome:?}");
            };
            assert_eq!(fault.code, "UPDATE_QUARANTINE_JOURNAL_REJECTED");
            assert!(root.0.join(QUARANTINE_JOURNAL_TEMP_FILE_NAME).is_file());
            assert_eq!(
                std::fs::read(cache.join("installer.part")).unwrap(),
                b"preserve me"
            );
        });
    }

    #[test]
    fn valid_quarantine_temp_is_strictly_promoted_and_replayed_before_any_cleanup() {
        tauri::async_runtime::block_on(async {
            let root = TestDirectory::new();
            let (public_key, _) = fixture();
            let store = VerifiedCacheStore::new(&root.0, public_key).unwrap();
            let cache = root.0.join("cache-v1");
            std::fs::create_dir(&cache).unwrap();
            std::fs::write(cache.join(AUTH_REJECTED_PART_FILE_NAME), b"rejected").unwrap();
            let document = QuarantinePendingDocumentV1 {
                schema_version: QUARANTINE_JOURNAL_SCHEMA_VERSION,
                candidate_id: "1f524da9660c738e349f342d1e3f0bc9da3b28b9c4842636475ccdde59b9ee0e"
                    .into(),
                version: "1.2.3".into(),
                reason: "UPDATE_INSTALLER_SIGNATURE_REJECTED".into(),
                rejected_at: 1,
            };
            std::fs::write(
                root.0.join(QUARANTINE_JOURNAL_TEMP_FILE_NAME),
                serde_json::to_vec(&document).unwrap(),
            )
            .unwrap();

            let first = store.recover("0.1.0").await;
            let CacheRecoveryOutcome::PendingQuarantine(first) = first else {
                panic!("合法 temp 必须被 promote 并重放: {first:?}");
            };
            assert_eq!(first.rejected().candidate_id, document.candidate_id);
            assert!(root.0.join(QUARANTINE_JOURNAL_FILE_NAME).is_file());
            assert!(!root.0.join(QUARANTINE_JOURNAL_TEMP_FILE_NAME).exists());
            assert!(cache.join(AUTH_REJECTED_PART_FILE_NAME).is_file());

            let replayed = store.recover("0.1.0").await;
            let CacheRecoveryOutcome::PendingQuarantine(replayed) = replayed else {
                panic!("promote 后的 final journal 必须继续重放: {replayed:?}");
            };
            replayed.finalize().unwrap();
            assert!(!root.0.join(QUARANTINE_JOURNAL_FILE_NAME).exists());
            assert!(!cache.join(AUTH_REJECTED_PART_FILE_NAME).exists());
        });
    }

    #[test]
    fn install_attempt_marker_preserves_old_cache_and_blocks_ordinary_cleanup() {
        tauri::async_runtime::block_on(async {
            let root = TestDirectory::new();
            let (public_key, evidence) = fixture();
            let store = VerifiedCacheStore::new(&root.0, public_key).unwrap();
            let cache = root.0.join("cache-v1");
            std::fs::create_dir(&cache).unwrap();
            std::fs::write(cache.join("installer.exe"), b"installer").unwrap();
            store
                .commit_verified(
                    &evidence,
                    9,
                    "9c0d294c05fc1d88d698034609bb81c0c69196327594e4c69d2915c80fd9850c",
                    10,
                    11,
                )
                .await
                .unwrap();
            std::fs::write(root.0.join("install-attempt-v1.json"), b"pending").unwrap();

            let outcome = store.recover("1.2.3").await;
            let CacheRecoveryOutcome::Blocked(fault) = outcome else {
                panic!("install-attempt 证据存在时必须先阻断普通 cache cleanup: {outcome:?}");
            };
            assert_eq!(fault.code, "UPDATE_INSTALL_RECONCILIATION_REQUIRED");
            assert!(cache.join("candidate.json").exists());
            assert!(cache.join("installer.exe").exists());
        });
    }

    #[test]
    fn install_reconciliation_tombstone_preserves_cache_and_blocks_ordinary_cleanup() {
        tauri::async_runtime::block_on(async {
            let root = TestDirectory::new();
            let (public_key, evidence) = fixture();
            let store = VerifiedCacheStore::new(&root.0, public_key).unwrap();
            let cache = root.0.join("cache-v1");
            std::fs::create_dir(&cache).unwrap();
            std::fs::write(cache.join("installer.exe"), b"installer").unwrap();
            store
                .commit_verified(
                    &evidence,
                    9,
                    "9c0d294c05fc1d88d698034609bb81c0c69196327594e4c69d2915c80fd9850c",
                    10,
                    11,
                )
                .await
                .unwrap();
            std::fs::write(
                root.0.join("install-attempt-reconciliation-v1.json"),
                b"pending",
            )
            .unwrap();

            let outcome = store.recover("1.2.3").await;
            let CacheRecoveryOutcome::Blocked(fault) = outcome else {
                panic!("reconciliation tombstone 存在时必须阻断普通 cache cleanup: {outcome:?}");
            };
            assert_eq!(fault.code, "UPDATE_INSTALL_RECONCILIATION_REQUIRED");
            assert!(cache.join("candidate.json").exists());
            assert!(cache.join("installer.exe").exists());
        });
    }

    #[test]
    fn web_quiescence_marker_preserves_cache_until_exact_reconciliation_exists() {
        tauri::async_runtime::block_on(async {
            let root = TestDirectory::new();
            let (public_key, evidence) = fixture();
            let store = VerifiedCacheStore::new(&root.0, public_key).unwrap();
            let cache = root.0.join("cache-v1");
            std::fs::create_dir(&cache).unwrap();
            std::fs::write(cache.join("installer.exe"), b"installer").unwrap();
            store
                .commit_verified(
                    &evidence,
                    9,
                    "9c0d294c05fc1d88d698034609bb81c0c69196327594e4c69d2915c80fd9850c",
                    10,
                    11,
                )
                .await
                .unwrap();
            std::fs::write(root.0.join("web-quiescence-v1.json"), b"prepared").unwrap();

            let outcome = store.recover("1.2.3").await;
            let CacheRecoveryOutcome::Blocked(fault) = outcome else {
                panic!("Web checkpoint 存在时必须先阻断普通 cache cleanup: {outcome:?}");
            };
            assert_eq!(fault.code, "UPDATE_WEB_QUIESCENCE_RECONCILIATION_REQUIRED");
            assert!(cache.join("candidate.json").exists());
            assert!(cache.join("installer.exe").exists());
        });
    }

    #[test]
    fn startup_removes_partial_file_and_cache_not_newer_than_current_version() {
        tauri::async_runtime::block_on(async {
            let root = TestDirectory::new();
            let (public_key, evidence) = fixture();
            let store = VerifiedCacheStore::new(&root.0, public_key).unwrap();
            let cache = root.0.join("cache-v1");
            std::fs::create_dir(&cache).unwrap();
            std::fs::write(cache.join("installer.exe"), b"installer").unwrap();
            store
                .commit_verified(
                    &evidence,
                    9,
                    "9c0d294c05fc1d88d698034609bb81c0c69196327594e4c69d2915c80fd9850c",
                    10,
                    11,
                )
                .await
                .unwrap();
            std::fs::write(cache.join("installer.part"), b"partial").unwrap();

            let outcome = store.recover("1.2.3").await;
            assert!(matches!(
                outcome,
                CacheRecoveryOutcome::Empty {
                    fault: None,
                    quarantine: None
                }
            ));
            assert!(std::fs::read_dir(cache).unwrap().next().is_none());
        });
    }

    #[test]
    fn cleanup_failure_persists_tombstone_and_next_start_retries_before_recovery() {
        tauri::async_runtime::block_on(async {
            let root = TestDirectory::new();
            let (public_key, _) = fixture();
            let store = VerifiedCacheStore::new(&root.0, public_key).unwrap();
            let cache = root.0.join("cache-v1");
            std::fs::create_dir(&cache).unwrap();
            std::fs::create_dir(cache.join("candidate.json")).unwrap();

            let first = store.recover("0.1.0").await;
            let CacheRecoveryOutcome::Blocked(fault) = first else {
                panic!("无法安全删除损坏 cache 时必须阻断: {first:?}");
            };
            assert_eq!(fault.code, "UPDATE_CACHE_CLEANUP_BLOCKED");
            let tombstone = root.0.join("cache-delete-v1.json");
            assert!(tombstone.exists());

            std::fs::remove_dir(cache.join("candidate.json")).unwrap();
            let second = store.recover("0.1.0").await;
            assert!(matches!(
                second,
                CacheRecoveryOutcome::Empty {
                    fault: None,
                    quarantine: None
                }
            ));
            assert!(!tombstone.exists());
        });
    }
}
