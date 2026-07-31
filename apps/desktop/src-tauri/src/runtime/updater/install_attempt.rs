use std::{
    error::Error,
    fmt,
    fs::{self, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

#[cfg(not(windows))]
use std::fs::File;

use semver::Version;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::{Digest, Sha256};

const INSTALL_ATTEMPT_FILE_NAME: &str = "install-attempt-v1.json";
const RECONCILIATION_TOMBSTONE_FILE_NAME: &str = "install-attempt-reconciliation-v1.json";
const RECONCILIATION_CONSUMPTION_FILE_NAME: &str =
    "install-attempt-reconciliation-consumed-v1.json";
const INSTALL_ATTEMPT_SCHEMA: &str = "mineradio-install-attempt-v1";
const RECONCILIATION_TOMBSTONE_SCHEMA: &str = "mineradio-install-attempt-reconciliation-v1";
const RECONCILIATION_CONSUMPTION_SCHEMA: &str =
    "mineradio-install-attempt-reconciliation-consumed-v1";
const MAX_DOCUMENT_BYTES: u64 = 8 * 1024;
const MAX_INSTALLER_BYTES: u64 = 512 * 1024 * 1024;
const MAX_JS_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct InstallAttemptInput {
    pub(crate) operation_id: String,
    pub(crate) operation_generation: u64,
    pub(crate) candidate_id: String,
    pub(crate) target_version: String,
    pub(crate) provenance_sha256: String,
    pub(crate) candidate_metadata_digest: String,
    pub(crate) installer_sha256: String,
    pub(crate) installer_size: u64,
    pub(crate) checkpoint_receipt: String,
    pub(crate) checkpoint_digest: String,
    pub(crate) created_at: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct InstallAttemptMarkerV1 {
    schema: String,
    operation_id: String,
    operation_generation: u64,
    candidate_id: String,
    target_version: String,
    provenance_sha256: String,
    candidate_metadata_digest: String,
    installer_sha256: String,
    installer_size: u64,
    checkpoint_receipt: String,
    checkpoint_digest: String,
    created_at: u64,
}

impl InstallAttemptMarkerV1 {
    pub(crate) fn derive(input: InstallAttemptInput) -> Result<Self, InstallAttemptError> {
        let marker = Self {
            schema: INSTALL_ATTEMPT_SCHEMA.to_owned(),
            operation_id: input.operation_id,
            operation_generation: input.operation_generation,
            candidate_id: input.candidate_id,
            target_version: input.target_version,
            provenance_sha256: input.provenance_sha256,
            candidate_metadata_digest: input.candidate_metadata_digest,
            installer_sha256: input.installer_sha256,
            installer_size: input.installer_size,
            checkpoint_receipt: input.checkpoint_receipt,
            checkpoint_digest: input.checkpoint_digest,
            created_at: input.created_at,
        };
        validate_marker(&marker)?;
        Ok(marker)
    }

    pub(crate) fn operation_id(&self) -> &str {
        &self.operation_id
    }

    pub(crate) fn operation_generation(&self) -> u64 {
        self.operation_generation
    }

    pub(crate) fn candidate_id(&self) -> &str {
        &self.candidate_id
    }

    pub(crate) fn target_version(&self) -> &str {
        &self.target_version
    }

    pub(crate) fn provenance_sha256(&self) -> &str {
        &self.provenance_sha256
    }

    pub(crate) fn candidate_metadata_digest(&self) -> &str {
        &self.candidate_metadata_digest
    }

    pub(crate) fn installer_sha256(&self) -> &str {
        &self.installer_sha256
    }

    pub(crate) fn installer_size(&self) -> u64 {
        self.installer_size
    }

    pub(crate) fn checkpoint_receipt(&self) -> &str {
        &self.checkpoint_receipt
    }

    pub(crate) fn checkpoint_digest(&self) -> &str {
        &self.checkpoint_digest
    }

    pub(crate) fn created_at(&self) -> u64 {
        self.created_at
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ReconciliationDisposition {
    Applied,
    NotApplied,
    AuthenticityRejected,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum WebCheckpointResolution {
    ConsumeCheckpoint,
    RestoreCheckpoint,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum VerifiedCacheResolution {
    TombstoneInstalledCandidate,
    RevalidateReadyToInstall,
    QuarantineAuthenticityRejected,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct InstallAttemptReconciliationV1 {
    schema: String,
    attempt: InstallAttemptMarkerV1,
    attempt_digest: String,
    disposition: ReconciliationDisposition,
    web_resolution: WebCheckpointResolution,
    cache_resolution: VerifiedCacheResolution,
    reconciled_at: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct InstallAttemptConsumptionV1 {
    schema: String,
    reconciliation: InstallAttemptReconciliationV1,
    reconciliation_digest: String,
}

impl InstallAttemptReconciliationV1 {
    pub(crate) fn attempt(&self) -> &InstallAttemptMarkerV1 {
        &self.attempt
    }

    pub(crate) fn disposition(&self) -> ReconciliationDisposition {
        self.disposition
    }

    pub(crate) fn attempt_digest(&self) -> &str {
        &self.attempt_digest
    }

    pub(crate) fn web_resolution(&self) -> WebCheckpointResolution {
        self.web_resolution
    }

    pub(crate) fn cache_resolution(&self) -> VerifiedCacheResolution {
        self.cache_resolution
    }

    pub(crate) fn reconciled_at(&self) -> u64 {
        self.reconciled_at
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum InstallAttemptRecovery {
    None,
    Pending(InstallAttemptMarkerV1),
    Reconciled(InstallAttemptReconciliationV1),
    ConsumedCleanupPending(InstallAttemptReconciliationV1),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ReconciliationCommitOutcome {
    Committed,
    AlreadyCommitted,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ReconciliationConsumeOutcome {
    Consumed,
    AlreadyConsumed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ParentDurability {
    DirectorySynced,
    WindowsWriteThroughPublish,
}

pub(crate) trait InstallAttemptFileSystem: Send + Sync {
    fn read_bounded(&self, file_name: &str, max_bytes: u64) -> io::Result<Option<Vec<u8>>>;
    fn write_temporary(&self, file_name: &str, bytes: &[u8]) -> io::Result<()>;
    fn sync_temporary(&self, file_name: &str) -> io::Result<()>;
    fn publish_replace(&self, temporary_name: &str, final_name: &str) -> io::Result<()>;
    fn remove(&self, file_name: &str) -> io::Result<bool>;
    fn sync_parent(&self) -> io::Result<ParentDurability>;
}

#[derive(Debug)]
pub(crate) struct NativeInstallAttemptFileSystem {
    directory: PathBuf,
}

impl NativeInstallAttemptFileSystem {
    pub(crate) fn new(directory: impl Into<PathBuf>) -> Self {
        Self {
            directory: directory.into(),
        }
    }

    fn path(&self, file_name: &str) -> PathBuf {
        self.directory.join(file_name)
    }

    fn prepare_directory(&self) -> io::Result<()> {
        fs::create_dir_all(&self.directory)
    }
}

impl InstallAttemptFileSystem for NativeInstallAttemptFileSystem {
    fn read_bounded(&self, file_name: &str, max_bytes: u64) -> io::Result<Option<Vec<u8>>> {
        validate_file_name(file_name)?;
        let path = self.path(file_name);
        let mut file = match OpenOptions::new().read(true).open(path) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error),
        };
        let metadata = file.metadata()?;
        if !metadata.is_file() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "install-attempt 文档不是普通文件",
            ));
        }
        if metadata.len() > max_bytes {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "install-attempt 文档超过大小上限",
            ));
        }
        let mut bytes = Vec::with_capacity(metadata.len() as usize);
        Read::by_ref(&mut file)
            .take(max_bytes + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() as u64 > max_bytes {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "install-attempt 文档超过大小上限",
            ));
        }
        Ok(Some(bytes))
    }

    fn write_temporary(&self, file_name: &str, bytes: &[u8]) -> io::Result<()> {
        validate_file_name(file_name)?;
        self.prepare_directory()?;
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(self.path(file_name))?;
        file.write_all(bytes)
    }

    fn sync_temporary(&self, file_name: &str) -> io::Result<()> {
        validate_file_name(file_name)?;
        OpenOptions::new()
            .read(true)
            .write(true)
            .open(self.path(file_name))?
            .sync_all()
    }

    fn publish_replace(&self, temporary_name: &str, final_name: &str) -> io::Result<()> {
        validate_file_name(temporary_name)?;
        validate_file_name(final_name)?;
        publish_native(&self.path(temporary_name), &self.path(final_name))
    }

    fn remove(&self, file_name: &str) -> io::Result<bool> {
        validate_file_name(file_name)?;
        match fs::remove_file(self.path(file_name)) {
            Ok(()) => Ok(true),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(error),
        }
    }

    fn sync_parent(&self) -> io::Result<ParentDurability> {
        sync_parent_native(&self.directory)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct InstallAttemptError {
    code: &'static str,
    message: String,
}

impl InstallAttemptError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub(crate) fn code(&self) -> &'static str {
        self.code
    }
}

impl fmt::Display for InstallAttemptError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl Error for InstallAttemptError {}

pub(crate) struct InstallAttemptStore {
    file_system: Arc<dyn InstallAttemptFileSystem>,
    io_lock: Mutex<()>,
}

impl fmt::Debug for InstallAttemptStore {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("InstallAttemptStore")
            .finish_non_exhaustive()
    }
}

impl InstallAttemptStore {
    pub(crate) fn for_app_data(app_data_directory: impl AsRef<Path>) -> Self {
        Self::with_updater_directory(app_data_directory.as_ref().join("updater"))
    }

    pub(crate) fn with_updater_directory(directory: impl Into<PathBuf>) -> Self {
        Self::with_file_system(Arc::new(NativeInstallAttemptFileSystem::new(directory)))
    }

    pub(crate) fn with_file_system(file_system: Arc<dyn InstallAttemptFileSystem>) -> Self {
        Self {
            file_system,
            io_lock: Mutex::new(()),
        }
    }

    pub(crate) fn publish(
        &self,
        input: InstallAttemptInput,
    ) -> Result<InstallAttemptMarkerV1, InstallAttemptError> {
        let marker = InstallAttemptMarkerV1::derive(input)?;
        let _guard = self.io_lock.lock().expect("install-attempt store poisoned");
        if let Some(existing) = load_marker_from(self.file_system.as_ref())? {
            if existing == marker {
                return Ok(existing);
            }
            return Err(identity_conflict(
                "已有 install-attempt 与本次安装 identity 不一致",
            ));
        }
        if load_tombstone_from(self.file_system.as_ref())?.is_some() {
            return Err(identity_conflict(
                "上一 install-attempt 的 reconciliation tombstone 尚未消费",
            ));
        }
        // 历史 consumed receipt 仅提供上一事务的 bounded idempotence，不阻断新事务；
        // 但其格式或 identity 损坏时必须先 fail closed。
        if let Some(consumption) = load_consumption_from(self.file_system.as_ref())? {
            if consumption.reconciliation.attempt == marker {
                return Err(identity_conflict(
                    "已消费的 install-attempt identity 不允许重新发布",
                ));
            }
        }
        save_document(
            self.file_system.as_ref(),
            INSTALL_ATTEMPT_FILE_NAME,
            &marker,
        )?;
        Ok(marker)
    }

    pub(crate) fn load_marker(
        &self,
    ) -> Result<Option<InstallAttemptMarkerV1>, InstallAttemptError> {
        let _guard = self.io_lock.lock().expect("install-attempt store poisoned");
        load_marker_from(self.file_system.as_ref())
    }

    pub(crate) fn recover(&self) -> Result<InstallAttemptRecovery, InstallAttemptError> {
        let _guard = self.io_lock.lock().expect("install-attempt store poisoned");
        let marker = load_marker_from(self.file_system.as_ref())?;
        let tombstone = load_tombstone_from(self.file_system.as_ref())?;
        let consumption = load_consumption_from(self.file_system.as_ref())?;
        match (marker, tombstone) {
            (None, None) => Ok(InstallAttemptRecovery::None),
            (Some(marker), None) => match consumption {
                Some(consumption) if consumption.reconciliation.attempt == marker => Ok(
                    InstallAttemptRecovery::ConsumedCleanupPending(consumption.reconciliation),
                ),
                _ => Ok(InstallAttemptRecovery::Pending(marker)),
            },
            (None, Some(tombstone)) => match consumption {
                Some(consumption) if consumption.reconciliation == tombstone => {
                    Ok(InstallAttemptRecovery::ConsumedCleanupPending(tombstone))
                }
                _ => Ok(InstallAttemptRecovery::Reconciled(tombstone)),
            },
            (Some(marker), Some(tombstone)) if tombstone.attempt == marker => match consumption {
                Some(consumption) if consumption.reconciliation == tombstone => {
                    Ok(InstallAttemptRecovery::ConsumedCleanupPending(tombstone))
                }
                _ => Ok(InstallAttemptRecovery::Reconciled(tombstone)),
            },
            (Some(_), Some(_)) => Err(identity_conflict(
                "install-attempt marker 与 reconciliation tombstone identity 不一致",
            )),
        }
    }

    pub(crate) fn complete_reconciliation(
        &self,
        attempt: &InstallAttemptMarkerV1,
        disposition: ReconciliationDisposition,
        reconciled_at: u64,
    ) -> Result<ReconciliationCommitOutcome, InstallAttemptError> {
        validate_marker(attempt)?;
        validate_js_safe_timestamp(reconciled_at, "reconciledAt")?;
        let expected = derive_tombstone(attempt, disposition, reconciled_at)?;
        let _guard = self.io_lock.lock().expect("install-attempt store poisoned");
        let marker = load_marker_from(self.file_system.as_ref())?;
        let tombstone = load_tombstone_from(self.file_system.as_ref())?;

        let outcome = match tombstone {
            Some(existing) if existing == expected => ReconciliationCommitOutcome::AlreadyCommitted,
            Some(_) => {
                return Err(identity_conflict(
                    "已有 reconciliation tombstone 与本次决定不一致",
                ))
            }
            None => {
                let Some(existing_marker) = marker.as_ref() else {
                    return Err(InstallAttemptError::new(
                        "UPDATE_INSTALL_ATTEMPT_MISSING",
                        "找不到待协调的 install-attempt marker",
                    ));
                };
                if existing_marker != attempt {
                    return Err(identity_conflict(
                        "持久化 install-attempt 与本次协调 identity 不一致",
                    ));
                }
                save_document(
                    self.file_system.as_ref(),
                    RECONCILIATION_TOMBSTONE_FILE_NAME,
                    &expected,
                )?;
                ReconciliationCommitOutcome::Committed
            }
        };

        if let Some(existing_marker) = marker {
            if existing_marker != *attempt {
                return Err(identity_conflict(
                    "reconciliation tombstone 与遗留 marker identity 不一致",
                ));
            }
            remove_document(self.file_system.as_ref(), INSTALL_ATTEMPT_FILE_NAME)?;
        }
        Ok(outcome)
    }

    /// Web checkpoint 与 cache resolution 都成功后，消费 exact reconciliation。
    ///
    /// consumed receipt 会先于 marker/tombstone 删除落盘，因此删除任一 crash point
    /// 都能通过同一份 reconciliation 重试；调用方不得绕过该方法直接删除文件。
    pub(crate) fn consume_reconciliation(
        &self,
        reconciliation: &InstallAttemptReconciliationV1,
    ) -> Result<ReconciliationConsumeOutcome, InstallAttemptError> {
        validate_tombstone(reconciliation)?;
        let expected_consumption = derive_consumption(reconciliation)?;
        let _guard = self.io_lock.lock().expect("install-attempt store poisoned");
        let marker = load_marker_from(self.file_system.as_ref())?;
        let tombstone = load_tombstone_from(self.file_system.as_ref())?;
        let consumption = load_consumption_from(self.file_system.as_ref())?;

        if let Some(existing_marker) = marker.as_ref() {
            if existing_marker != reconciliation.attempt() {
                return Err(identity_conflict(
                    "待消费 reconciliation 与当前 install-attempt marker 不一致",
                ));
            }
        }

        let outcome = match tombstone.as_ref() {
            Some(existing) if existing == reconciliation => {
                if consumption.as_ref() != Some(&expected_consumption) {
                    save_document(
                        self.file_system.as_ref(),
                        RECONCILIATION_CONSUMPTION_FILE_NAME,
                        &expected_consumption,
                    )?;
                    ReconciliationConsumeOutcome::Consumed
                } else {
                    ReconciliationConsumeOutcome::AlreadyConsumed
                }
            }
            Some(_) => {
                return Err(identity_conflict(
                    "待消费 reconciliation 与持久化 tombstone 不一致",
                ))
            }
            None if consumption.as_ref() == Some(&expected_consumption) => {
                ReconciliationConsumeOutcome::AlreadyConsumed
            }
            None if consumption.is_some() => {
                return Err(identity_conflict(
                    "待消费 reconciliation 与 consumed receipt 不一致",
                ))
            }
            None => {
                return Err(InstallAttemptError::new(
                    "UPDATE_INSTALL_ATTEMPT_RECONCILIATION_MISSING",
                    "找不到待消费的 reconciliation tombstone",
                ))
            }
        };

        if marker.is_some() {
            remove_document(self.file_system.as_ref(), INSTALL_ATTEMPT_FILE_NAME)?;
        }
        if tombstone.is_some() {
            remove_document(
                self.file_system.as_ref(),
                RECONCILIATION_TOMBSTONE_FILE_NAME,
            )?;
        }
        Ok(outcome)
    }
}

fn derive_tombstone(
    attempt: &InstallAttemptMarkerV1,
    disposition: ReconciliationDisposition,
    reconciled_at: u64,
) -> Result<InstallAttemptReconciliationV1, InstallAttemptError> {
    let (web_resolution, cache_resolution) = resolution_for(disposition);
    Ok(InstallAttemptReconciliationV1 {
        schema: RECONCILIATION_TOMBSTONE_SCHEMA.to_owned(),
        attempt: attempt.clone(),
        attempt_digest: sha256_hex(&canonical_document(attempt)?),
        disposition,
        web_resolution,
        cache_resolution,
        reconciled_at,
    })
}

fn resolution_for(
    disposition: ReconciliationDisposition,
) -> (WebCheckpointResolution, VerifiedCacheResolution) {
    match disposition {
        ReconciliationDisposition::Applied => (
            WebCheckpointResolution::ConsumeCheckpoint,
            VerifiedCacheResolution::TombstoneInstalledCandidate,
        ),
        ReconciliationDisposition::NotApplied => (
            WebCheckpointResolution::RestoreCheckpoint,
            VerifiedCacheResolution::RevalidateReadyToInstall,
        ),
        ReconciliationDisposition::AuthenticityRejected => (
            WebCheckpointResolution::RestoreCheckpoint,
            VerifiedCacheResolution::QuarantineAuthenticityRejected,
        ),
    }
}

fn derive_consumption(
    reconciliation: &InstallAttemptReconciliationV1,
) -> Result<InstallAttemptConsumptionV1, InstallAttemptError> {
    Ok(InstallAttemptConsumptionV1 {
        schema: RECONCILIATION_CONSUMPTION_SCHEMA.to_owned(),
        reconciliation: reconciliation.clone(),
        reconciliation_digest: sha256_hex(&canonical_document(reconciliation)?),
    })
}

fn validate_marker(marker: &InstallAttemptMarkerV1) -> Result<(), InstallAttemptError> {
    if marker.schema != INSTALL_ATTEMPT_SCHEMA {
        return Err(invalid_document("install-attempt schema 不是受支持的 v1"));
    }
    validate_lower_hex(&marker.operation_id, 32, "operationId")?;
    validate_js_safe_generation(marker.operation_generation)?;
    validate_lower_hex(&marker.candidate_id, 64, "candidateId")?;
    validate_stable_semver(&marker.target_version)?;
    validate_lower_hex(&marker.provenance_sha256, 64, "provenanceSha256")?;
    validate_lower_hex(
        &marker.candidate_metadata_digest,
        64,
        "candidateMetadataDigest",
    )?;
    validate_lower_hex(&marker.installer_sha256, 64, "installerSha256")?;
    if marker.installer_size == 0 || marker.installer_size > MAX_INSTALLER_BYTES {
        return Err(InstallAttemptError::new(
            "UPDATE_INSTALL_ATTEMPT_INVALID_SIZE",
            "installerSize 必须落在受支持的安装包大小范围内",
        ));
    }
    validate_lower_hex(&marker.checkpoint_receipt, 32, "checkpointReceipt")?;
    validate_lower_hex(&marker.checkpoint_digest, 64, "checkpointDigest")?;
    validate_js_safe_timestamp(marker.created_at, "createdAt")
}

fn validate_tombstone(
    tombstone: &InstallAttemptReconciliationV1,
) -> Result<(), InstallAttemptError> {
    if tombstone.schema != RECONCILIATION_TOMBSTONE_SCHEMA {
        return Err(invalid_document(
            "reconciliation tombstone schema 不是受支持的 v1",
        ));
    }
    validate_marker(&tombstone.attempt)?;
    validate_lower_hex(&tombstone.attempt_digest, 64, "attemptDigest")?;
    let actual_digest = sha256_hex(&canonical_document(&tombstone.attempt)?);
    if tombstone.attempt_digest != actual_digest {
        return Err(identity_conflict(
            "reconciliation tombstone 的 attempt digest 不匹配",
        ));
    }
    let (expected_web, expected_cache) = resolution_for(tombstone.disposition);
    if tombstone.web_resolution != expected_web || tombstone.cache_resolution != expected_cache {
        return Err(identity_conflict(
            "reconciliation disposition 与 Web/cache resolution 不一致",
        ));
    }
    validate_js_safe_timestamp(tombstone.reconciled_at, "reconciledAt")
}

fn validate_consumption(
    consumption: &InstallAttemptConsumptionV1,
) -> Result<(), InstallAttemptError> {
    if consumption.schema != RECONCILIATION_CONSUMPTION_SCHEMA {
        return Err(invalid_document(
            "reconciliation consumed receipt schema 不是受支持的 v1",
        ));
    }
    validate_tombstone(&consumption.reconciliation)?;
    validate_lower_hex(
        &consumption.reconciliation_digest,
        64,
        "reconciliationDigest",
    )?;
    let actual_digest = sha256_hex(&canonical_document(&consumption.reconciliation)?);
    if consumption.reconciliation_digest != actual_digest {
        return Err(identity_conflict(
            "reconciliation consumed receipt digest 不匹配",
        ));
    }
    Ok(())
}

fn validate_lower_hex(
    value: &str,
    expected_len: usize,
    field: &str,
) -> Result<(), InstallAttemptError> {
    if value.len() != expected_len
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(InstallAttemptError::new(
            "UPDATE_INSTALL_ATTEMPT_INVALID_IDENTITY",
            format!("{field} 必须是长度固定的小写十六进制值"),
        ));
    }
    Ok(())
}

fn validate_js_safe_generation(value: u64) -> Result<(), InstallAttemptError> {
    if value == 0 || value > MAX_JS_SAFE_INTEGER {
        return Err(InstallAttemptError::new(
            "UPDATE_INSTALL_ATTEMPT_INVALID_GENERATION",
            "operationGeneration 必须是正的 JavaScript 安全整数",
        ));
    }
    Ok(())
}

fn validate_js_safe_timestamp(value: u64, field: &str) -> Result<(), InstallAttemptError> {
    if value == 0 || value > MAX_JS_SAFE_INTEGER {
        return Err(InstallAttemptError::new(
            "UPDATE_INSTALL_ATTEMPT_INVALID_TIMESTAMP",
            format!("{field} 必须是正的 JavaScript 安全整数毫秒时间戳"),
        ));
    }
    Ok(())
}

fn validate_stable_semver(value: &str) -> Result<(), InstallAttemptError> {
    if value.is_empty() || value.len() > 64 {
        return Err(InstallAttemptError::new(
            "UPDATE_INSTALL_ATTEMPT_INVALID_VERSION",
            "targetVersion 必须是长度受限的 canonical 稳定 SemVer",
        ));
    }
    let version = Version::parse(value).map_err(|_| {
        InstallAttemptError::new(
            "UPDATE_INSTALL_ATTEMPT_INVALID_VERSION",
            "targetVersion 必须是 canonical 稳定 SemVer",
        )
    })?;
    if !version.pre.is_empty() || !version.build.is_empty() || version.to_string() != value {
        return Err(InstallAttemptError::new(
            "UPDATE_INSTALL_ATTEMPT_INVALID_VERSION",
            "targetVersion 必须是 canonical 稳定 SemVer",
        ));
    }
    Ok(())
}

fn load_marker_from(
    file_system: &dyn InstallAttemptFileSystem,
) -> Result<Option<InstallAttemptMarkerV1>, InstallAttemptError> {
    let marker = load_document(file_system, INSTALL_ATTEMPT_FILE_NAME)?;
    if let Some(marker) = marker.as_ref() {
        validate_marker(marker)?;
    }
    Ok(marker)
}

fn load_tombstone_from(
    file_system: &dyn InstallAttemptFileSystem,
) -> Result<Option<InstallAttemptReconciliationV1>, InstallAttemptError> {
    let tombstone = load_document(file_system, RECONCILIATION_TOMBSTONE_FILE_NAME)?;
    if let Some(tombstone) = tombstone.as_ref() {
        validate_tombstone(tombstone)?;
    }
    Ok(tombstone)
}

fn load_consumption_from(
    file_system: &dyn InstallAttemptFileSystem,
) -> Result<Option<InstallAttemptConsumptionV1>, InstallAttemptError> {
    let consumption = load_document(file_system, RECONCILIATION_CONSUMPTION_FILE_NAME)?;
    if let Some(consumption) = consumption.as_ref() {
        validate_consumption(consumption)?;
    }
    Ok(consumption)
}

fn load_document<T: DeserializeOwned + Serialize>(
    file_system: &dyn InstallAttemptFileSystem,
    file_name: &str,
) -> Result<Option<T>, InstallAttemptError> {
    let Some(bytes) = file_system
        .read_bounded(file_name, MAX_DOCUMENT_BYTES)
        .map_err(|error| {
            io_error(
                "UPDATE_INSTALL_ATTEMPT_READ_FAILED",
                "读取持久化文档",
                error,
            )
        })?
    else {
        return Ok(None);
    };
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return Err(InstallAttemptError::new(
            "UPDATE_INSTALL_ATTEMPT_BOM_REJECTED",
            "install-attempt 持久化文档不允许 UTF-8 BOM",
        ));
    }
    let document: T = serde_json::from_slice(&bytes).map_err(|_| {
        InstallAttemptError::new(
            "UPDATE_INSTALL_ATTEMPT_INVALID_JSON",
            "install-attempt 持久化文档不是严格 v1 JSON",
        )
    })?;
    if canonical_document(&document)? != bytes {
        return Err(InstallAttemptError::new(
            "UPDATE_INSTALL_ATTEMPT_NONCANONICAL",
            "install-attempt 持久化文档不是 canonical v1 编码",
        ));
    }
    Ok(Some(document))
}

fn save_document<T: Serialize>(
    file_system: &dyn InstallAttemptFileSystem,
    final_name: &str,
    document: &T,
) -> Result<(), InstallAttemptError> {
    let canonical = canonical_document(document)?;
    let temporary_name = temporary_name(final_name)?;
    if let Err(error) = file_system.write_temporary(&temporary_name, &canonical) {
        let _ = file_system.remove(&temporary_name);
        return Err(io_error(
            "UPDATE_INSTALL_ATTEMPT_WRITE_FAILED",
            "写入 install-attempt 临时文件",
            error,
        ));
    }
    if let Err(error) = file_system.sync_temporary(&temporary_name) {
        let _ = file_system.remove(&temporary_name);
        return Err(io_error(
            "UPDATE_INSTALL_ATTEMPT_SYNC_FAILED",
            "同步 install-attempt 临时文件",
            error,
        ));
    }
    if let Err(error) = file_system.publish_replace(&temporary_name, final_name) {
        let _ = file_system.remove(&temporary_name);
        return Err(io_error(
            "UPDATE_INSTALL_ATTEMPT_PUBLISH_FAILED",
            "原子发布 install-attempt 文档",
            error,
        ));
    }
    if let Err(error) = file_system.sync_parent() {
        // 当前进程不能把未完成目录持久性确认的 final 当作权威证据。
        let _ = file_system.remove(final_name);
        let _ = file_system.sync_parent();
        return Err(io_error(
            "UPDATE_INSTALL_ATTEMPT_DIRECTORY_SYNC_FAILED",
            "确认 install-attempt 目录持久性",
            error,
        ));
    }
    Ok(())
}

fn remove_document(
    file_system: &dyn InstallAttemptFileSystem,
    file_name: &str,
) -> Result<(), InstallAttemptError> {
    let removed = file_system.remove(file_name).map_err(|error| {
        io_error(
            "UPDATE_INSTALL_ATTEMPT_DELETE_FAILED",
            "删除已 tombstone 的 install-attempt marker",
            error,
        )
    })?;
    if removed {
        file_system.sync_parent().map_err(|error| {
            io_error(
                "UPDATE_INSTALL_ATTEMPT_DIRECTORY_SYNC_FAILED",
                "确认 install-attempt marker 删除持久性",
                error,
            )
        })?;
    }
    Ok(())
}

fn canonical_document<T: Serialize>(document: &T) -> Result<Vec<u8>, InstallAttemptError> {
    let mut bytes = serde_json::to_vec(document).map_err(|_| {
        InstallAttemptError::new(
            "UPDATE_INSTALL_ATTEMPT_ENCODE_FAILED",
            "编码 install-attempt 持久化文档失败",
        )
    })?;
    bytes.push(b'\n');
    if bytes.len() as u64 > MAX_DOCUMENT_BYTES {
        return Err(InstallAttemptError::new(
            "UPDATE_INSTALL_ATTEMPT_TOO_LARGE",
            "install-attempt 持久化文档超过 8 KiB 上限",
        ));
    }
    Ok(bytes)
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn temporary_name(final_name: &str) -> Result<String, InstallAttemptError> {
    let mut random = [0_u8; 16];
    getrandom::fill(&mut random).map_err(|_| {
        InstallAttemptError::new(
            "UPDATE_INSTALL_ATTEMPT_RANDOM_FAILED",
            "无法生成 install-attempt 临时文件 identity",
        )
    })?;
    Ok(format!(".{final_name}.{}.tmp", encode_lower_hex(&random)))
}

fn encode_lower_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        encoded.push(HEX[(byte >> 4) as usize] as char);
        encoded.push(HEX[(byte & 0x0f) as usize] as char);
    }
    encoded
}

fn invalid_document(message: impl Into<String>) -> InstallAttemptError {
    InstallAttemptError::new("UPDATE_INSTALL_ATTEMPT_INVALID_DOCUMENT", message)
}

fn identity_conflict(message: impl Into<String>) -> InstallAttemptError {
    InstallAttemptError::new("UPDATE_INSTALL_ATTEMPT_IDENTITY_CONFLICT", message)
}

fn io_error(code: &'static str, action: &str, error: io::Error) -> InstallAttemptError {
    InstallAttemptError::new(code, format!("{action}失败：{}", error.kind()))
}

fn validate_file_name(file_name: &str) -> io::Result<()> {
    if file_name.is_empty()
        || file_name == "."
        || file_name == ".."
        || file_name.contains('/')
        || file_name.contains('\\')
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "持久化文件名不是受控的单一路径分量",
        ));
    }
    Ok(())
}

#[cfg(not(windows))]
fn publish_native(temporary_path: &Path, final_path: &Path) -> io::Result<()> {
    fs::rename(temporary_path, final_path)
}

#[cfg(windows)]
fn publish_native(temporary_path: &Path, final_path: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let temporary = temporary_path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let final_path = final_path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    // SAFETY: 两个 UTF-16 buffer 都以 NUL 结尾，调用期间保持有效。
    let moved = unsafe {
        MoveFileExW(
            temporary.as_ptr(),
            final_path.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if moved == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn sync_parent_native(directory: &Path) -> io::Result<ParentDurability> {
    File::open(directory)?.sync_all()?;
    Ok(ParentDurability::DirectorySynced)
}

#[cfg(windows)]
fn sync_parent_native(_directory: &Path) -> io::Result<ParentDurability> {
    // Windows 不提供与 POSIX directory fsync 等价的稳定接口。发布本身使用
    // MOVEFILE_WRITE_THROUGH；这里显式报告该保证，绝不伪称做过 parent fsync。
    Ok(ParentDurability::WindowsWriteThroughPublish)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;

    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    enum FaultPoint {
        Write,
        FileSync,
        Rename,
        Remove,
        DirectorySync,
    }

    #[derive(Debug)]
    struct ArmedFault {
        point: FaultPoint,
        remaining_matches: usize,
    }

    #[derive(Debug, Default)]
    struct MemoryState {
        files: BTreeMap<String, Vec<u8>>,
        operations: Vec<String>,
        fault: Option<ArmedFault>,
    }

    #[derive(Debug, Default)]
    struct MemoryFileSystem {
        state: Mutex<MemoryState>,
    }

    impl MemoryFileSystem {
        fn arm(&self, point: FaultPoint, occurrence: usize) {
            assert!(occurrence > 0);
            self.state.lock().unwrap().fault = Some(ArmedFault {
                point,
                remaining_matches: occurrence,
            });
        }

        fn clear_fault(&self) {
            self.state.lock().unwrap().fault = None;
        }

        fn operations(&self) -> Vec<String> {
            self.state.lock().unwrap().operations.clone()
        }

        fn contains(&self, file_name: &str) -> bool {
            self.state.lock().unwrap().files.contains_key(file_name)
        }

        fn raw(&self, file_name: &str) -> Option<Vec<u8>> {
            self.state.lock().unwrap().files.get(file_name).cloned()
        }

        fn write_raw(&self, file_name: &str, bytes: Vec<u8>) {
            self.state
                .lock()
                .unwrap()
                .files
                .insert(file_name.to_owned(), bytes);
        }

        fn should_fail(state: &mut MemoryState, point: FaultPoint) -> bool {
            let Some(fault) = state.fault.as_mut() else {
                return false;
            };
            if fault.point != point {
                return false;
            }
            fault.remaining_matches -= 1;
            if fault.remaining_matches == 0 {
                state.fault = None;
                return true;
            }
            false
        }

        fn injected_error(point: FaultPoint) -> io::Error {
            io::Error::other(format!("fault injected at {point:?}"))
        }
    }

    impl InstallAttemptFileSystem for MemoryFileSystem {
        fn read_bounded(&self, file_name: &str, max_bytes: u64) -> io::Result<Option<Vec<u8>>> {
            let state = self.state.lock().unwrap();
            let Some(bytes) = state.files.get(file_name) else {
                return Ok(None);
            };
            if bytes.len() as u64 > max_bytes {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "memory document too large",
                ));
            }
            Ok(Some(bytes.clone()))
        }

        fn write_temporary(&self, file_name: &str, bytes: &[u8]) -> io::Result<()> {
            let mut state = self.state.lock().unwrap();
            state.operations.push("write-temporary".into());
            if state.files.contains_key(file_name) {
                return Err(io::Error::new(
                    io::ErrorKind::AlreadyExists,
                    "temporary exists",
                ));
            }
            state.files.insert(file_name.to_owned(), bytes.to_vec());
            if Self::should_fail(&mut state, FaultPoint::Write) {
                return Err(Self::injected_error(FaultPoint::Write));
            }
            Ok(())
        }

        fn sync_temporary(&self, file_name: &str) -> io::Result<()> {
            let mut state = self.state.lock().unwrap();
            state.operations.push("sync-temporary".into());
            if !state.files.contains_key(file_name) {
                return Err(io::Error::new(io::ErrorKind::NotFound, "temporary missing"));
            }
            if Self::should_fail(&mut state, FaultPoint::FileSync) {
                return Err(Self::injected_error(FaultPoint::FileSync));
            }
            Ok(())
        }

        fn publish_replace(&self, temporary_name: &str, final_name: &str) -> io::Result<()> {
            let mut state = self.state.lock().unwrap();
            state.operations.push("atomic-publish".into());
            if Self::should_fail(&mut state, FaultPoint::Rename) {
                return Err(Self::injected_error(FaultPoint::Rename));
            }
            let bytes = state
                .files
                .remove(temporary_name)
                .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "temporary missing"))?;
            state.files.insert(final_name.to_owned(), bytes);
            Ok(())
        }

        fn remove(&self, file_name: &str) -> io::Result<bool> {
            let mut state = self.state.lock().unwrap();
            state.operations.push(format!("remove:{file_name}"));
            if Self::should_fail(&mut state, FaultPoint::Remove) {
                return Err(Self::injected_error(FaultPoint::Remove));
            }
            Ok(state.files.remove(file_name).is_some())
        }

        fn sync_parent(&self) -> io::Result<ParentDurability> {
            let mut state = self.state.lock().unwrap();
            state.operations.push("sync-parent".into());
            if Self::should_fail(&mut state, FaultPoint::DirectorySync) {
                return Err(Self::injected_error(FaultPoint::DirectorySync));
            }
            Ok(ParentDurability::DirectorySynced)
        }
    }

    fn valid_input() -> InstallAttemptInput {
        InstallAttemptInput {
            operation_id: "01".repeat(16),
            operation_generation: 7,
            candidate_id: "02".repeat(32),
            target_version: "1.0.0".into(),
            provenance_sha256: "03".repeat(32),
            candidate_metadata_digest: "04".repeat(32),
            installer_sha256: "05".repeat(32),
            installer_size: 42,
            checkpoint_receipt: "06".repeat(16),
            checkpoint_digest: "07".repeat(32),
            created_at: 1_775_000_000_000,
        }
    }

    fn store() -> (Arc<MemoryFileSystem>, InstallAttemptStore) {
        let file_system = Arc::new(MemoryFileSystem::default());
        let store = InstallAttemptStore::with_file_system(file_system.clone());
        (file_system, store)
    }

    fn canonical_value(mut value: serde_json::Value) -> Vec<u8> {
        // serde_json::Map 默认保持 deterministic key order；只用于制造严格但无效的 fixture。
        if let Some(object) = value.as_object_mut() {
            object.sort_keys();
        }
        let mut bytes = serde_json::to_vec(&value).unwrap();
        bytes.push(b'\n');
        bytes
    }

    #[test]
    fn marker_is_derived_only_from_valid_exact_inputs() {
        let marker = InstallAttemptMarkerV1::derive(valid_input()).unwrap();
        assert_eq!(marker.operation_generation(), 7);
        assert_eq!(marker.target_version(), "1.0.0");

        let mut invalid = valid_input();
        invalid.candidate_id = "AA".repeat(32);
        assert_eq!(
            InstallAttemptMarkerV1::derive(invalid).unwrap_err().code(),
            "UPDATE_INSTALL_ATTEMPT_INVALID_IDENTITY"
        );

        for mutate in [
            |input: &mut InstallAttemptInput| input.operation_generation = 0,
            |input: &mut InstallAttemptInput| input.operation_generation = MAX_JS_SAFE_INTEGER + 1,
            |input: &mut InstallAttemptInput| input.installer_size = 0,
            |input: &mut InstallAttemptInput| input.installer_size = MAX_INSTALLER_BYTES + 1,
            |input: &mut InstallAttemptInput| input.created_at = 0,
        ] {
            let mut invalid = valid_input();
            mutate(&mut invalid);
            assert!(InstallAttemptMarkerV1::derive(invalid).is_err());
        }

        for version in ["v1.0.0", "1.0", "1.0.0-rc.1", "1.0.0+build", "01.0.0"] {
            let mut invalid = valid_input();
            invalid.target_version = version.into();
            assert_eq!(
                InstallAttemptMarkerV1::derive(invalid).unwrap_err().code(),
                "UPDATE_INSTALL_ATTEMPT_INVALID_VERSION"
            );
        }
    }

    #[test]
    fn marker_round_trips_as_bounded_canonical_v1() {
        let (file_system, store) = store();
        let marker = store.publish(valid_input()).unwrap();
        let raw = file_system.raw(INSTALL_ATTEMPT_FILE_NAME).unwrap();

        assert!(raw.len() <= MAX_DOCUMENT_BYTES as usize);
        assert_eq!(raw.last(), Some(&b'\n'));
        assert_eq!(raw, canonical_document(&marker).unwrap());
        assert_eq!(store.load_marker().unwrap(), Some(marker.clone()));
        assert_eq!(store.publish(valid_input()).unwrap(), marker);
    }

    #[test]
    fn strict_load_rejects_bom_unknown_noncanonical_hex_and_semver() {
        let cases = [
            (
                "bom",
                Box::new(|raw: Vec<u8>| {
                    let mut bytes = vec![0xEF, 0xBB, 0xBF];
                    bytes.extend(raw);
                    bytes
                }) as Box<dyn Fn(Vec<u8>) -> Vec<u8>>,
            ),
            (
                "unknown",
                Box::new(|raw: Vec<u8>| {
                    let mut value: serde_json::Value = serde_json::from_slice(&raw).unwrap();
                    value
                        .as_object_mut()
                        .unwrap()
                        .insert("unexpected".into(), serde_json::Value::Bool(true));
                    canonical_value(value)
                }),
            ),
            (
                "noncanonical",
                Box::new(|raw: Vec<u8>| {
                    let mut bytes = b" ".to_vec();
                    bytes.extend(raw);
                    bytes
                }),
            ),
            (
                "hex",
                Box::new(|raw: Vec<u8>| {
                    let mut value: serde_json::Value = serde_json::from_slice(&raw).unwrap();
                    value["candidateId"] = serde_json::Value::String("AA".repeat(32));
                    canonical_value(value)
                }),
            ),
            (
                "semver",
                Box::new(|raw: Vec<u8>| {
                    let mut value: serde_json::Value = serde_json::from_slice(&raw).unwrap();
                    value["targetVersion"] = serde_json::Value::String("v1.0.0".into());
                    canonical_value(value)
                }),
            ),
        ];

        for (label, mutate) in cases {
            let (file_system, store) = store();
            store.publish(valid_input()).unwrap();
            let raw = file_system.raw(INSTALL_ATTEMPT_FILE_NAME).unwrap();
            file_system.write_raw(INSTALL_ATTEMPT_FILE_NAME, mutate(raw));
            assert!(
                store.load_marker().is_err(),
                "{label} marker 必须 fail closed"
            );
        }

        let (file_system, store) = store();
        file_system.write_raw(
            INSTALL_ATTEMPT_FILE_NAME,
            vec![b'x'; MAX_DOCUMENT_BYTES as usize + 1],
        );
        assert_eq!(
            store.load_marker().unwrap_err().code(),
            "UPDATE_INSTALL_ATTEMPT_READ_FAILED"
        );
    }

    #[test]
    fn atomic_publication_orders_write_sync_publish_and_parent_durability() {
        let (file_system, store) = store();
        store.publish(valid_input()).unwrap();
        assert_eq!(
            file_system.operations(),
            [
                "write-temporary",
                "sync-temporary",
                "atomic-publish",
                "sync-parent"
            ]
        );
    }

    #[test]
    fn every_marker_publication_fault_leaves_no_final_authority() {
        for point in [
            FaultPoint::Write,
            FaultPoint::FileSync,
            FaultPoint::Rename,
            FaultPoint::DirectorySync,
        ] {
            let (file_system, store) = store();
            file_system.arm(point, 1);
            assert!(store.publish(valid_input()).is_err(), "{point:?} 应失败");
            assert!(
                !file_system.contains(INSTALL_ATTEMPT_FILE_NAME),
                "{point:?} 后不得发布 final marker"
            );
            assert!(matches!(
                store.recover().unwrap(),
                InstallAttemptRecovery::None
            ));
        }
    }

    #[test]
    fn every_tombstone_publication_fault_preserves_pending_marker() {
        for point in [
            FaultPoint::Write,
            FaultPoint::FileSync,
            FaultPoint::Rename,
            FaultPoint::DirectorySync,
        ] {
            let (file_system, store) = store();
            let marker = store.publish(valid_input()).unwrap();
            file_system.arm(point, 1);
            assert!(
                store
                    .complete_reconciliation(
                        &marker,
                        ReconciliationDisposition::Applied,
                        marker.created_at() + 1,
                    )
                    .is_err(),
                "{point:?} 应失败"
            );
            assert!(file_system.contains(INSTALL_ATTEMPT_FILE_NAME));
            assert!(!file_system.contains(RECONCILIATION_TOMBSTONE_FILE_NAME));
            assert!(matches!(
                store.recover().unwrap(),
                InstallAttemptRecovery::Pending(existing) if existing == marker
            ));
        }
    }

    #[test]
    fn tombstone_survives_crash_before_marker_cleanup_and_retries_idempotently() {
        let (file_system, store) = store();
        let marker = store.publish(valid_input()).unwrap();
        file_system.arm(FaultPoint::Remove, 1);
        assert_eq!(
            store
                .complete_reconciliation(
                    &marker,
                    ReconciliationDisposition::NotApplied,
                    marker.created_at() + 1,
                )
                .unwrap_err()
                .code(),
            "UPDATE_INSTALL_ATTEMPT_DELETE_FAILED"
        );
        assert!(file_system.contains(INSTALL_ATTEMPT_FILE_NAME));
        assert!(file_system.contains(RECONCILIATION_TOMBSTONE_FILE_NAME));
        assert!(matches!(
            store.recover().unwrap(),
            InstallAttemptRecovery::Reconciled(ref tombstone)
                if tombstone.attempt() == &marker
                    && tombstone.disposition() == ReconciliationDisposition::NotApplied
        ));

        file_system.clear_fault();
        assert_eq!(
            store
                .complete_reconciliation(
                    &marker,
                    ReconciliationDisposition::NotApplied,
                    marker.created_at() + 1,
                )
                .unwrap(),
            ReconciliationCommitOutcome::AlreadyCommitted
        );
        assert!(!file_system.contains(INSTALL_ATTEMPT_FILE_NAME));
        assert!(file_system.contains(RECONCILIATION_TOMBSTONE_FILE_NAME));
    }

    #[test]
    fn marker_delete_durability_failure_still_recovers_from_exact_tombstone() {
        let (file_system, store) = store();
        let marker = store.publish(valid_input()).unwrap();
        // complete 内第一次 parent sync 发布 tombstone，第二次确认 marker 删除。
        file_system.arm(FaultPoint::DirectorySync, 2);
        assert_eq!(
            store
                .complete_reconciliation(
                    &marker,
                    ReconciliationDisposition::Applied,
                    marker.created_at() + 1,
                )
                .unwrap_err()
                .code(),
            "UPDATE_INSTALL_ATTEMPT_DIRECTORY_SYNC_FAILED"
        );
        assert!(!file_system.contains(INSTALL_ATTEMPT_FILE_NAME));
        assert!(matches!(
            store.recover().unwrap(),
            InstallAttemptRecovery::Reconciled(_)
        ));
        assert_eq!(
            store
                .complete_reconciliation(
                    &marker,
                    ReconciliationDisposition::Applied,
                    marker.created_at() + 1,
                )
                .unwrap(),
            ReconciliationCommitOutcome::AlreadyCommitted
        );
    }

    #[test]
    fn identity_or_decision_conflicts_fail_closed() {
        let (file_system, store) = store();
        let marker = store.publish(valid_input()).unwrap();
        let mut other_input = valid_input();
        other_input.candidate_id = "08".repeat(32);
        let other = InstallAttemptMarkerV1::derive(other_input).unwrap();
        assert_eq!(
            store
                .complete_reconciliation(
                    &other,
                    ReconciliationDisposition::Applied,
                    marker.created_at() + 1,
                )
                .unwrap_err()
                .code(),
            "UPDATE_INSTALL_ATTEMPT_IDENTITY_CONFLICT"
        );

        file_system.arm(FaultPoint::Remove, 1);
        assert!(store
            .complete_reconciliation(
                &marker,
                ReconciliationDisposition::Applied,
                marker.created_at() + 1,
            )
            .is_err());
        file_system.clear_fault();
        assert_eq!(
            store
                .complete_reconciliation(
                    &marker,
                    ReconciliationDisposition::AuthenticityRejected,
                    marker.created_at() + 1,
                )
                .unwrap_err()
                .code(),
            "UPDATE_INSTALL_ATTEMPT_IDENTITY_CONFLICT"
        );
    }

    #[test]
    fn each_disposition_derives_one_closed_web_and_cache_resolution() {
        let cases = [
            (
                ReconciliationDisposition::Applied,
                WebCheckpointResolution::ConsumeCheckpoint,
                VerifiedCacheResolution::TombstoneInstalledCandidate,
            ),
            (
                ReconciliationDisposition::NotApplied,
                WebCheckpointResolution::RestoreCheckpoint,
                VerifiedCacheResolution::RevalidateReadyToInstall,
            ),
            (
                ReconciliationDisposition::AuthenticityRejected,
                WebCheckpointResolution::RestoreCheckpoint,
                VerifiedCacheResolution::QuarantineAuthenticityRejected,
            ),
        ];

        for (disposition, expected_web, expected_cache) in cases {
            let (file_system, store) = store();
            let marker = store.publish(valid_input()).unwrap();
            store
                .complete_reconciliation(&marker, disposition, marker.created_at() + 1)
                .unwrap();
            let InstallAttemptRecovery::Reconciled(tombstone) = store.recover().unwrap() else {
                panic!("完成后必须只恢复 tombstone");
            };
            assert_eq!(tombstone.disposition(), disposition);
            assert_eq!(tombstone.web_resolution(), expected_web);
            assert_eq!(tombstone.cache_resolution(), expected_cache);
            assert_eq!(
                tombstone.attempt_digest(),
                sha256_hex(&canonical_document(&marker).unwrap())
            );
            assert!(!file_system.contains(INSTALL_ATTEMPT_FILE_NAME));
        }
    }

    #[test]
    fn tampered_tombstone_resolution_or_attempt_digest_fails_closed() {
        for field in ["webResolution", "attemptDigest"] {
            let (file_system, store) = store();
            let marker = store.publish(valid_input()).unwrap();
            store
                .complete_reconciliation(
                    &marker,
                    ReconciliationDisposition::Applied,
                    marker.created_at() + 1,
                )
                .unwrap();
            let raw = file_system.raw(RECONCILIATION_TOMBSTONE_FILE_NAME).unwrap();
            let text = String::from_utf8(raw).unwrap();
            let changed = if field == "webResolution" {
                text.replace(
                    "\"webResolution\":\"consume-checkpoint\"",
                    "\"webResolution\":\"restore-checkpoint\"",
                )
            } else {
                text.replace(
                    &format!(
                        "\"attemptDigest\":\"{}\"",
                        sha256_hex(&canonical_document(&marker).unwrap())
                    ),
                    &format!("\"attemptDigest\":\"{}\"", "09".repeat(32)),
                )
            };
            file_system.write_raw(RECONCILIATION_TOMBSTONE_FILE_NAME, changed.into_bytes());
            assert_eq!(
                store.recover().unwrap_err().code(),
                "UPDATE_INSTALL_ATTEMPT_IDENTITY_CONFLICT"
            );
        }
    }

    #[test]
    fn consume_reconciliation_persists_exact_receipt_before_cleanup() {
        let (file_system, store) = store();
        let marker = store.publish(valid_input()).unwrap();
        store
            .complete_reconciliation(
                &marker,
                ReconciliationDisposition::Applied,
                marker.created_at() + 1,
            )
            .unwrap();
        let InstallAttemptRecovery::Reconciled(reconciliation) = store.recover().unwrap() else {
            panic!("完成后必须恢复 reconciliation");
        };

        assert_eq!(
            store.consume_reconciliation(&reconciliation).unwrap(),
            ReconciliationConsumeOutcome::Consumed
        );
        assert!(!file_system.contains(INSTALL_ATTEMPT_FILE_NAME));
        assert!(!file_system.contains(RECONCILIATION_TOMBSTONE_FILE_NAME));
        assert!(file_system.contains(RECONCILIATION_CONSUMPTION_FILE_NAME));
        assert!(matches!(
            store.recover().unwrap(),
            InstallAttemptRecovery::None
        ));
        assert_eq!(
            store.consume_reconciliation(&reconciliation).unwrap(),
            ReconciliationConsumeOutcome::AlreadyConsumed
        );
    }

    #[test]
    fn every_consumed_receipt_publication_fault_preserves_reconciliation() {
        for point in [
            FaultPoint::Write,
            FaultPoint::FileSync,
            FaultPoint::Rename,
            FaultPoint::DirectorySync,
        ] {
            let (file_system, store) = store();
            let marker = store.publish(valid_input()).unwrap();
            store
                .complete_reconciliation(
                    &marker,
                    ReconciliationDisposition::NotApplied,
                    marker.created_at() + 1,
                )
                .unwrap();
            let InstallAttemptRecovery::Reconciled(reconciliation) = store.recover().unwrap()
            else {
                panic!("完成后必须恢复 reconciliation");
            };
            file_system.arm(point, 1);
            assert!(
                store.consume_reconciliation(&reconciliation).is_err(),
                "{point:?} 应失败"
            );
            assert!(file_system.contains(RECONCILIATION_TOMBSTONE_FILE_NAME));
            assert!(!file_system.contains(RECONCILIATION_CONSUMPTION_FILE_NAME));
            assert!(matches!(
                store.recover().unwrap(),
                InstallAttemptRecovery::Reconciled(existing) if existing == reconciliation
            ));
        }
    }

    #[test]
    fn consumed_receipt_makes_tombstone_cleanup_crashes_idempotent() {
        for fault in [FaultPoint::Remove, FaultPoint::DirectorySync] {
            let (file_system, store) = store();
            let marker = store.publish(valid_input()).unwrap();
            store
                .complete_reconciliation(
                    &marker,
                    ReconciliationDisposition::AuthenticityRejected,
                    marker.created_at() + 1,
                )
                .unwrap();
            let InstallAttemptRecovery::Reconciled(reconciliation) = store.recover().unwrap()
            else {
                panic!("完成后必须恢复 reconciliation");
            };
            let occurrence = if fault == FaultPoint::DirectorySync {
                2
            } else {
                1
            };
            file_system.arm(fault, occurrence);
            assert!(store.consume_reconciliation(&reconciliation).is_err());
            assert!(file_system.contains(RECONCILIATION_CONSUMPTION_FILE_NAME));
            let recovery = store.recover().unwrap();
            if fault == FaultPoint::Remove {
                assert!(matches!(
                    recovery,
                    InstallAttemptRecovery::ConsumedCleanupPending(existing)
                        if existing == reconciliation
                ));
            } else {
                assert!(matches!(recovery, InstallAttemptRecovery::None));
            }
            file_system.clear_fault();
            assert_eq!(
                store.consume_reconciliation(&reconciliation).unwrap(),
                ReconciliationConsumeOutcome::AlreadyConsumed
            );
            assert!(!file_system.contains(RECONCILIATION_TOMBSTONE_FILE_NAME));
        }
    }

    #[test]
    fn consume_is_identity_bound_and_old_receipt_does_not_block_new_attempt() {
        let (_file_system, store) = store();
        let marker = store.publish(valid_input()).unwrap();
        store
            .complete_reconciliation(
                &marker,
                ReconciliationDisposition::Applied,
                marker.created_at() + 1,
            )
            .unwrap();
        let InstallAttemptRecovery::Reconciled(reconciliation) = store.recover().unwrap() else {
            panic!("完成后必须恢复 reconciliation");
        };
        store.consume_reconciliation(&reconciliation).unwrap();

        let mut next_input = valid_input();
        next_input.operation_id = "0a".repeat(16);
        next_input.operation_generation += 1;
        next_input.candidate_id = "0b".repeat(32);
        let next = store.publish(next_input).unwrap();
        assert_eq!(
            store
                .consume_reconciliation(&reconciliation)
                .unwrap_err()
                .code(),
            "UPDATE_INSTALL_ATTEMPT_IDENTITY_CONFLICT"
        );
        assert_eq!(store.load_marker().unwrap(), Some(next));
    }

    #[test]
    fn consumed_attempt_cannot_be_republished_as_a_replay() {
        let (_file_system, store) = store();
        let marker = store.publish(valid_input()).unwrap();
        store
            .complete_reconciliation(
                &marker,
                ReconciliationDisposition::Applied,
                marker.created_at() + 1,
            )
            .unwrap();
        let InstallAttemptRecovery::Reconciled(reconciliation) = store.recover().unwrap() else {
            panic!("完成后必须恢复 reconciliation");
        };
        store.consume_reconciliation(&reconciliation).unwrap();

        assert_eq!(
            store.publish(valid_input()).unwrap_err().code(),
            "UPDATE_INSTALL_ATTEMPT_IDENTITY_CONFLICT"
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_reports_write_through_without_claiming_posix_parent_fsync() {
        let fs = NativeInstallAttemptFileSystem::new(std::env::temp_dir());
        assert_eq!(
            fs.sync_parent().unwrap(),
            ParentDurability::WindowsWriteThroughPublish
        );
    }
}
