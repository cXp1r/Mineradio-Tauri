use std::{
    error::Error,
    ffi::{OsStr, OsString},
    fmt,
    fs::File,
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};

use semver::Version;
use serde::{Deserialize, Deserializer, Serialize};

use super::managed_fs::StableDirectory;

pub(crate) const UPDATE_POLICY_FILE_NAME: &str = "update-policy-v1.json";
pub(crate) const UPDATE_POLICY_SCHEMA_VERSION: u32 = 1;
const MAX_UPDATE_POLICY_BYTES: u64 = 16 * 1024;
const CANDIDATE_ID_HEX_LENGTH: usize = 64;
const MAX_POLICY_VERSION_LENGTH: usize = 64;
const MAX_QUARANTINE_REASON_LENGTH: usize = 128;
const TEMPORARY_FILE_ATTEMPTS: usize = 4;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct UpdatePolicyReminder {
    pub(crate) candidate_id: String,
    pub(crate) version: String,
    pub(crate) until: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct UpdatePolicyQuarantine {
    pub(crate) candidate_id: String,
    pub(crate) version: String,
    pub(crate) reason: String,
    pub(crate) rejected_at: u64,
}

/// Update Runtime 独占的 v1 策略快照。所有 identity 都是完整值，不允许只按版本猜测候选。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct UpdatePolicySnapshot {
    pub(crate) schema_version: u32,
    #[serde(deserialize_with = "deserialize_required_option")]
    pub(crate) last_successful_check_at: Option<u64>,
    #[serde(deserialize_with = "deserialize_required_option")]
    pub(crate) remind: Option<UpdatePolicyReminder>,
    #[serde(deserialize_with = "deserialize_required_option")]
    pub(crate) skipped_version: Option<String>,
    #[serde(deserialize_with = "deserialize_required_option")]
    pub(crate) quarantine: Option<UpdatePolicyQuarantine>,
}

impl Default for UpdatePolicySnapshot {
    fn default() -> Self {
        Self {
            schema_version: UPDATE_POLICY_SCHEMA_VERSION,
            last_successful_check_at: None,
            remind: None,
            skipped_version: None,
            quarantine: None,
        }
    }
}

fn deserialize_required_option<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct UpdatePolicyStoreError {
    code: &'static str,
    message: String,
}

impl UpdatePolicyStoreError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub(crate) fn code(&self) -> &'static str {
        self.code
    }

    pub(crate) fn runtime(code: &'static str, message: impl Into<String>) -> Self {
        Self::new(code, message)
    }
}

impl fmt::Display for UpdatePolicyStoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl Error for UpdatePolicyStoreError {}

/// 持久化接口保持同步且很小；调用方应在自己的状态提交锁之外执行磁盘 I/O。
pub(crate) trait UpdatePolicyStore: Send + Sync {
    fn load(&self) -> Result<UpdatePolicySnapshot, UpdatePolicyStoreError>;

    fn save(&self, snapshot: &UpdatePolicySnapshot) -> Result<(), UpdatePolicyStoreError>;
}

#[derive(Debug, Default)]
pub(crate) struct MemoryUpdatePolicyStore {
    snapshot: Mutex<UpdatePolicySnapshot>,
}

impl MemoryUpdatePolicyStore {
    pub(crate) fn new(snapshot: UpdatePolicySnapshot) -> Self {
        Self {
            snapshot: Mutex::new(snapshot),
        }
    }
}

impl UpdatePolicyStore for MemoryUpdatePolicyStore {
    fn load(&self) -> Result<UpdatePolicySnapshot, UpdatePolicyStoreError> {
        let snapshot = self
            .snapshot
            .lock()
            .expect("memory update policy store poisoned")
            .clone();
        validate_snapshot(&snapshot)?;
        Ok(snapshot)
    }

    fn save(&self, snapshot: &UpdatePolicySnapshot) -> Result<(), UpdatePolicyStoreError> {
        validate_snapshot(snapshot)?;
        *self
            .snapshot
            .lock()
            .expect("memory update policy store poisoned") = snapshot.clone();
        Ok(())
    }
}

/// 生产文件 Adapter。单个实例串行化 load/save，并拒绝目录、链接和 Windows reparse point。
#[derive(Debug)]
pub(crate) struct NativeUpdatePolicyStore {
    path: PathBuf,
    io_lock: Mutex<()>,
}

impl NativeUpdatePolicyStore {
    pub(crate) fn for_app_data(app_data_dir: impl AsRef<Path>) -> Self {
        Self::with_path(app_data_dir.as_ref().join(UPDATE_POLICY_FILE_NAME))
    }

    pub(crate) fn with_path(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            io_lock: Mutex::new(()),
        }
    }

    pub(crate) fn path(&self) -> &Path {
        &self.path
    }

    fn load_locked(&self) -> Result<UpdatePolicySnapshot, UpdatePolicyStoreError> {
        let (parent, file_name) = policy_location(&self.path)?;
        let Some(directory) = StableDirectory::open_existing(parent).map_err(|error| {
            managed_path_error(
                "UPDATE_POLICY_DIRECTORY_FAILED",
                "打开更新策略目录链",
                error,
            )
        })?
        else {
            return Ok(UpdatePolicySnapshot::default());
        };
        // `directory` 在读取和解析完成前保持完整祖先链的 no-share-delete lease；
        // 最终叶子则由同一 Adapter 以 no-follow handle 打开。
        let Some(mut file) = directory.open_regular_read(file_name).map_err(|error| {
            managed_path_error("UPDATE_POLICY_OPEN_FAILED", "打开更新策略", error)
        })?
        else {
            return Ok(UpdatePolicySnapshot::default());
        };
        let metadata = file
            .metadata()
            .map_err(|error| io_error("UPDATE_POLICY_READ_FAILED", "读取更新策略元数据", error))?;
        if metadata.len() > MAX_UPDATE_POLICY_BYTES {
            return Err(size_error(metadata.len()));
        }

        let mut bytes = Vec::with_capacity(metadata.len() as usize);
        Read::by_ref(&mut file)
            .take(MAX_UPDATE_POLICY_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| io_error("UPDATE_POLICY_READ_FAILED", "读取更新策略", error))?;
        if bytes.len() as u64 > MAX_UPDATE_POLICY_BYTES {
            return Err(size_error(bytes.len() as u64));
        }
        if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
            return Err(UpdatePolicyStoreError::new(
                "UPDATE_POLICY_BOM_REJECTED",
                "更新策略不允许 UTF-8 BOM",
            ));
        }

        let snapshot: UpdatePolicySnapshot = serde_json::from_slice(&bytes).map_err(|error| {
            UpdatePolicyStoreError::new(
                "UPDATE_POLICY_INVALID_JSON",
                format!("更新策略不是严格的 v1 JSON：{error}"),
            )
        })?;
        validate_snapshot(&snapshot)?;
        Ok(snapshot)
    }

    fn save_locked(&self, snapshot: &UpdatePolicySnapshot) -> Result<(), UpdatePolicyStoreError> {
        validate_snapshot(snapshot)?;
        let (parent, file_name) = policy_location(&self.path)?;
        // StableDirectory 在逐级创建缺失目录的同时固定从卷根到最终父目录的
        // 完整链；直到 replace 和目录同步结束都不释放这份 lease。
        let directory = StableDirectory::open_or_create(parent).map_err(|error| {
            managed_path_error(
                "UPDATE_POLICY_DIRECTORY_FAILED",
                "创建更新策略目录链",
                error,
            )
        })?;

        let mut payload = serde_json::to_vec_pretty(snapshot).map_err(|error| {
            UpdatePolicyStoreError::new(
                "UPDATE_POLICY_ENCODE_FAILED",
                format!("编码更新策略失败：{error}"),
            )
        })?;
        payload.push(b'\n');
        if payload.len() as u64 > MAX_UPDATE_POLICY_BYTES {
            return Err(size_error(payload.len() as u64));
        }

        let (temporary_name, mut temporary) = create_temporary_file(&directory, file_name)?;
        let write_result = temporary
            .write_all(&payload)
            .and_then(|()| temporary.sync_all());
        if let Err(error) = write_result {
            drop(temporary);
            let _ = directory.remove_regular(&temporary_name);
            return Err(io_error(
                "UPDATE_POLICY_WRITE_FAILED",
                "写入并同步更新策略临时文件",
                error,
            ));
        }

        // 原子替换由已经写入的同一临时文件 handle 发起；目标存在时
        // publish_replace 会先以 no-follow handle 验证其为普通文件。
        if let Err(error) = directory.publish_replace(&temporary, &temporary_name, file_name) {
            drop(temporary);
            let _ = directory.remove_regular(&temporary_name);
            return Err(managed_path_error(
                "UPDATE_POLICY_REPLACE_FAILED",
                "原子替换更新策略",
                error,
            ));
        }
        drop(temporary);
        sync_parent_directory(parent).map_err(|error| {
            io_error(
                "UPDATE_POLICY_DIRECTORY_SYNC_FAILED",
                "同步更新策略目录",
                error,
            )
        })?;
        Ok(())
    }
}

impl UpdatePolicyStore for NativeUpdatePolicyStore {
    fn load(&self) -> Result<UpdatePolicySnapshot, UpdatePolicyStoreError> {
        let _guard = self
            .io_lock
            .lock()
            .expect("native update policy store poisoned");
        self.load_locked()
    }

    fn save(&self, snapshot: &UpdatePolicySnapshot) -> Result<(), UpdatePolicyStoreError> {
        let _guard = self
            .io_lock
            .lock()
            .expect("native update policy store poisoned");
        self.save_locked(snapshot)
    }
}

fn validate_snapshot(snapshot: &UpdatePolicySnapshot) -> Result<(), UpdatePolicyStoreError> {
    if snapshot.schema_version != UPDATE_POLICY_SCHEMA_VERSION {
        return Err(UpdatePolicyStoreError::new(
            "UPDATE_POLICY_SCHEMA_REJECTED",
            format!(
                "更新策略 schemaVersion {} 不受支持",
                snapshot.schema_version
            ),
        ));
    }

    if let Some(remind) = snapshot.remind.as_ref() {
        validate_candidate_id(&remind.candidate_id, "remind")?;
        validate_stable_version(&remind.version, "remind")?;
    }
    if let Some(version) = snapshot.skipped_version.as_deref() {
        validate_stable_version(version, "skippedVersion")?;
    }
    if let Some(quarantine) = snapshot.quarantine.as_ref() {
        validate_candidate_id(&quarantine.candidate_id, "quarantine")?;
        validate_stable_version(&quarantine.version, "quarantine")?;
        validate_quarantine_reason(&quarantine.reason)?;
    }
    Ok(())
}

fn validate_candidate_id(
    candidate_id: &str,
    field: &'static str,
) -> Result<(), UpdatePolicyStoreError> {
    if candidate_id.len() != CANDIDATE_ID_HEX_LENGTH
        || !candidate_id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(UpdatePolicyStoreError::new(
            "UPDATE_POLICY_CANDIDATE_ID_REJECTED",
            format!("更新策略 {field} candidateId 必须是 64 位小写十六进制 identity"),
        ));
    }
    Ok(())
}

fn validate_stable_version(raw: &str, field: &'static str) -> Result<(), UpdatePolicyStoreError> {
    if raw.is_empty() || raw.len() > MAX_POLICY_VERSION_LENGTH {
        return Err(version_error(field));
    }
    let version = Version::parse(raw).map_err(|_| version_error(field))?;
    if !version.pre.is_empty() || !version.build.is_empty() || version.to_string() != raw {
        return Err(version_error(field));
    }
    Ok(())
}

fn version_error(field: &'static str) -> UpdatePolicyStoreError {
    UpdatePolicyStoreError::new(
        "UPDATE_POLICY_VERSION_REJECTED",
        format!("更新策略 {field} 版本必须是长度受限的 canonical 稳定 SemVer"),
    )
}

fn validate_quarantine_reason(reason: &str) -> Result<(), UpdatePolicyStoreError> {
    if reason.is_empty()
        || reason.len() > MAX_QUARANTINE_REASON_LENGTH
        || !reason
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
    {
        return Err(UpdatePolicyStoreError::new(
            "UPDATE_POLICY_REASON_REJECTED",
            "更新策略 quarantine reason 必须是长度不超过 128 的大写 ASCII 错误码",
        ));
    }
    Ok(())
}

fn size_error(actual: u64) -> UpdatePolicyStoreError {
    UpdatePolicyStoreError::new(
        "UPDATE_POLICY_SIZE_REJECTED",
        format!("更新策略大小 {actual} 字节超过固定上限 {MAX_UPDATE_POLICY_BYTES} 字节"),
    )
}

fn io_error(
    code: &'static str,
    operation: &'static str,
    error: io::Error,
) -> UpdatePolicyStoreError {
    // 错误文本不带完整用户路径，路径只留在 Store 内部。
    UpdatePolicyStoreError::new(code, format!("{operation}失败：{error}"))
}

fn unsafe_path(reason: impl AsRef<str>) -> UpdatePolicyStoreError {
    UpdatePolicyStoreError::new(
        "UPDATE_POLICY_UNSAFE_PATH",
        format!("更新策略路径不安全：{}", reason.as_ref()),
    )
}

fn policy_location(path: &Path) -> Result<(&Path, &OsStr), UpdatePolicyStoreError> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .ok_or_else(|| unsafe_path("策略文件必须具有绝对父目录"))?;
    let file_name = path
        .file_name()
        .filter(|name| !name.is_empty())
        .ok_or_else(|| unsafe_path("策略文件名无效"))?;
    Ok((parent, file_name))
}

fn managed_path_error(
    code: &'static str,
    operation: &'static str,
    error: io::Error,
) -> UpdatePolicyStoreError {
    if matches!(
        error.kind(),
        io::ErrorKind::InvalidInput | io::ErrorKind::PermissionDenied | io::ErrorKind::IsADirectory
    ) {
        // managed_fs 用这些类别表达 lexical escape、reparse point 和非普通叶子。
        // 不回显完整用户路径。
        return unsafe_path(error.to_string());
    }
    io_error(code, operation, error)
}

fn create_temporary_file(
    directory: &StableDirectory,
    destination_name: &OsStr,
) -> Result<(OsString, File), UpdatePolicyStoreError> {
    let file_name = destination_name.to_string_lossy();
    for _ in 0..TEMPORARY_FILE_ATTEMPTS {
        let mut nonce = [0_u8; 16];
        getrandom::fill(&mut nonce).map_err(|error| {
            UpdatePolicyStoreError::new(
                "UPDATE_POLICY_ENTROPY_FAILED",
                format!("生成更新策略临时文件名失败：{error}"),
            )
        })?;
        let suffix = nonce
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let temporary_name = OsString::from(format!(".{file_name}.tmp-{suffix}"));
        match directory.create_new_renameable(&temporary_name) {
            Ok(file) => return Ok((temporary_name, file)),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(managed_path_error(
                    "UPDATE_POLICY_TEMP_CREATE_FAILED",
                    "创建更新策略临时文件",
                    error,
                ));
            }
        }
    }
    Err(UpdatePolicyStoreError::new(
        "UPDATE_POLICY_TEMP_COLLISION",
        "无法创建唯一的更新策略临时文件",
    ))
}

#[cfg(windows)]
fn sync_parent_directory(_path: &Path) -> io::Result<()> {
    // Windows rename 前后已对同一个 source handle FlushFileBuffers；目录链也仍由
    // StableDirectory 固定。Win32 不支持对目录 handle 做通用 FlushFileBuffers。
    Ok(())
}

#[cfg(not(windows))]
fn sync_parent_directory(path: &Path) -> io::Result<()> {
    File::open(path)?.sync_all()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    struct TestDirectory {
        path: PathBuf,
    }

    impl TestDirectory {
        fn new(label: &str) -> Self {
            for _ in 0..8 {
                let mut nonce = [0_u8; 16];
                getrandom::fill(&mut nonce).expect("应生成 128-bit 策略测试目录随机数");
                let suffix = nonce
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect::<String>();
                let path =
                    std::env::temp_dir().join(format!("mineradio-update-policy-{label}-{suffix}"));
                match fs::create_dir(&path) {
                    Ok(()) => return Self { path },
                    Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                    Err(error) => panic!("应创建策略测试目录：{error}"),
                }
            }
            panic!("连续碰撞后仍无法创建唯一的策略测试目录")
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn complete_snapshot() -> UpdatePolicySnapshot {
        UpdatePolicySnapshot {
            schema_version: UPDATE_POLICY_SCHEMA_VERSION,
            last_successful_check_at: Some(1_800_000_000_000),
            remind: Some(UpdatePolicyReminder {
                candidate_id: "1111111111111111111111111111111111111111111111111111111111111111"
                    .into(),
                version: "1.2.3".into(),
                until: 1_800_086_400_000,
            }),
            skipped_version: Some("1.1.0".into()),
            quarantine: Some(UpdatePolicyQuarantine {
                candidate_id: "abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd"
                    .into(),
                version: "1.2.2".into(),
                reason: "UPDATE_INSTALLER_SIGNATURE_INVALID".into(),
                rejected_at: 1_799_999_999_000,
            }),
        }
    }

    #[test]
    fn memory_adapter_round_trips_the_complete_typed_snapshot() {
        let store = MemoryUpdatePolicyStore::default();
        let snapshot = complete_snapshot();

        store.save(&snapshot).expect("内存 Store 应接受 v1 快照");

        assert_eq!(store.load().expect("应读取内存策略"), snapshot);
    }

    #[test]
    fn native_adapter_defaults_when_missing_and_round_trips_atomically() {
        let directory = TestDirectory::new("round-trip");
        let path = directory.path.join("nested").join(UPDATE_POLICY_FILE_NAME);
        let store = NativeUpdatePolicyStore::with_path(&path);
        assert_eq!(store.path(), path);
        assert_eq!(
            store.load().expect("缺失策略应使用安全默认值"),
            UpdatePolicySnapshot::default()
        );

        store
            .save(&complete_snapshot())
            .expect("应原子写入完整策略");
        let replacement = UpdatePolicySnapshot {
            last_successful_check_at: Some(1_900_000_000_000),
            skipped_version: Some("2.0.0".into()),
            ..UpdatePolicySnapshot::default()
        };
        store.save(&replacement).expect("应原子替换旧策略");

        let reopened = NativeUpdatePolicyStore::with_path(&path);
        assert_eq!(reopened.load().expect("重启后应读取新策略"), replacement);
        let raw = fs::read(&path).expect("应读取持久化策略");
        assert!(!raw.starts_with(&[0xEF, 0xBB, 0xBF]));
        let json: serde_json::Value = serde_json::from_slice(&raw).expect("策略应为 JSON");
        assert_eq!(json["schemaVersion"], UPDATE_POLICY_SCHEMA_VERSION);
        assert_eq!(json["lastSuccessfulCheckAt"], 1_900_000_000_000_u64);
        assert_eq!(json["skippedVersion"], "2.0.0");
        assert_eq!(
            fs::read_dir(path.parent().expect("策略应有父目录"))
                .expect("应读取策略目录")
                .filter_map(Result::ok)
                .filter(|entry| entry.file_name().to_string_lossy().contains(".tmp-"))
                .count(),
            0
        );
    }

    #[test]
    fn native_adapter_rejects_bom_unknown_fields_and_unsupported_schema() {
        let cases: [(&str, Vec<u8>, &str); 5] = [
            (
                "bom",
                b"\xEF\xBB\xBF{\"schemaVersion\":1,\"lastSuccessfulCheckAt\":null,\"remind\":null,\"skippedVersion\":null,\"quarantine\":null}".to_vec(),
                "UPDATE_POLICY_BOM_REJECTED",
            ),
            (
                "unknown-root",
                br#"{"schemaVersion":1,"lastSuccessfulCheckAt":null,"remind":null,"skippedVersion":null,"quarantine":null,"future":true}"#.to_vec(),
                "UPDATE_POLICY_INVALID_JSON",
            ),
            (
                "unknown-nested",
                br#"{"schemaVersion":1,"lastSuccessfulCheckAt":null,"remind":{"candidateId":"candidate","version":"1.2.3","until":42,"future":true},"skippedVersion":null,"quarantine":null}"#.to_vec(),
                "UPDATE_POLICY_INVALID_JSON",
            ),
            (
                "schema",
                br#"{"schemaVersion":2,"lastSuccessfulCheckAt":null,"remind":null,"skippedVersion":null,"quarantine":null}"#.to_vec(),
                "UPDATE_POLICY_SCHEMA_REJECTED",
            ),
            (
                "missing-field",
                br#"{"schemaVersion":1,"lastSuccessfulCheckAt":null,"remind":null,"skippedVersion":null}"#.to_vec(),
                "UPDATE_POLICY_INVALID_JSON",
            ),
        ];

        for (label, bytes, expected_code) in cases {
            let directory = TestDirectory::new(label);
            let path = directory.path.join(UPDATE_POLICY_FILE_NAME);
            fs::write(&path, bytes).expect("应写入无效策略 fixture");
            let error = NativeUpdatePolicyStore::with_path(path)
                .load()
                .expect_err("无效策略必须 fail closed");
            assert_eq!(error.code(), expected_code, "fixture: {label}");
        }
    }

    #[test]
    fn native_adapter_rejects_oversized_documents_without_parsing_them() {
        let directory = TestDirectory::new("oversized");
        let path = directory.path.join(UPDATE_POLICY_FILE_NAME);
        fs::write(&path, vec![b' '; MAX_UPDATE_POLICY_BYTES as usize + 1])
            .expect("应写入超限策略 fixture");

        let error = NativeUpdatePolicyStore::with_path(path)
            .load()
            .expect_err("超限策略必须 fail closed");

        assert_eq!(error.code(), "UPDATE_POLICY_SIZE_REJECTED");
    }

    #[test]
    fn adapters_reject_a_snapshot_with_the_wrong_schema_on_save() {
        let snapshot = UpdatePolicySnapshot {
            schema_version: 9,
            ..UpdatePolicySnapshot::default()
        };
        let memory_error = MemoryUpdatePolicyStore::new(UpdatePolicySnapshot::default())
            .save(&snapshot)
            .expect_err("内存 Adapter 不得掩盖错误 schema");
        assert_eq!(memory_error.code(), "UPDATE_POLICY_SCHEMA_REJECTED");
        let memory_load_error = MemoryUpdatePolicyStore::new(snapshot.clone())
            .load()
            .expect_err("内存 Adapter 的初始 fixture 也必须服从 schema 约束");
        assert_eq!(memory_load_error.code(), "UPDATE_POLICY_SCHEMA_REJECTED");

        let directory = TestDirectory::new("wrong-schema-save");
        let native_error =
            NativeUpdatePolicyStore::with_path(directory.path.join(UPDATE_POLICY_FILE_NAME))
                .save(&snapshot)
                .expect_err("文件 Adapter 不得写入错误 schema");
        assert_eq!(native_error.code(), "UPDATE_POLICY_SCHEMA_REJECTED");
    }

    #[test]
    fn adapters_reject_noncanonical_or_unstable_versions_on_load_and_save() {
        for (label, version) in [
            ("leading-zero", "01.2.3"),
            ("prerelease", "1.2.3-rc.1"),
            ("build", "1.2.3+build.1"),
            ("whitespace", " 1.2.3"),
        ] {
            let mut snapshot = complete_snapshot();
            snapshot.remind.as_mut().expect("应有提醒策略").version = version.into();
            assert_snapshot_rejected_by_load_and_save(
                label,
                snapshot,
                "UPDATE_POLICY_VERSION_REJECTED",
            );
        }

        let mut skipped = complete_snapshot();
        skipped.skipped_version = Some("2.0.0-pre".into());
        assert_snapshot_rejected_by_load_and_save(
            "skipped-prerelease",
            skipped,
            "UPDATE_POLICY_VERSION_REJECTED",
        );
    }

    #[test]
    fn adapters_require_complete_lowercase_candidate_identities() {
        for (label, candidate_id) in [
            ("short", "abc"),
            (
                "uppercase",
                "ABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCD",
            ),
            (
                "non-hex",
                "gggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggg",
            ),
        ] {
            let mut snapshot = complete_snapshot();
            snapshot.remind.as_mut().expect("应有提醒策略").candidate_id = candidate_id.into();
            assert_snapshot_rejected_by_load_and_save(
                label,
                snapshot,
                "UPDATE_POLICY_CANDIDATE_ID_REJECTED",
            );
        }

        let mut quarantine = complete_snapshot();
        quarantine
            .quarantine
            .as_mut()
            .expect("应有隔离策略")
            .candidate_id = String::new();
        assert_snapshot_rejected_by_load_and_save(
            "quarantine-missing-identity",
            quarantine,
            "UPDATE_POLICY_CANDIDATE_ID_REJECTED",
        );
    }

    #[test]
    fn adapters_reject_unsafe_or_unbounded_quarantine_reason_codes() {
        for (label, reason) in [
            ("empty", String::new()),
            ("lowercase", "update_signature_invalid".into()),
            ("punctuation", "UPDATE/SIGNATURE".into()),
            ("control", "UPDATE_SIGNATURE\nINVALID".into()),
            ("too-long", "A".repeat(129)),
        ] {
            let mut snapshot = complete_snapshot();
            snapshot.quarantine.as_mut().expect("应有隔离策略").reason = reason;
            assert_snapshot_rejected_by_load_and_save(
                label,
                snapshot,
                "UPDATE_POLICY_REASON_REJECTED",
            );
        }
    }

    fn assert_snapshot_rejected_by_load_and_save(
        label: &str,
        snapshot: UpdatePolicySnapshot,
        expected_code: &str,
    ) {
        let memory_load_error = MemoryUpdatePolicyStore::new(snapshot.clone())
            .load()
            .expect_err("内存 Adapter 不得读取语义无效策略");
        assert_eq!(memory_load_error.code(), expected_code, "fixture: {label}");

        let memory_save_error = MemoryUpdatePolicyStore::default()
            .save(&snapshot)
            .expect_err("内存 Adapter 不得保存语义无效策略");
        assert_eq!(memory_save_error.code(), expected_code, "fixture: {label}");

        let directory = TestDirectory::new(label);
        let path = directory.path.join(UPDATE_POLICY_FILE_NAME);
        let payload = serde_json::to_vec(&snapshot).expect("应编码语义无效策略 fixture");
        fs::write(&path, payload).expect("应写入语义无效策略 fixture");
        let native_load_error = NativeUpdatePolicyStore::with_path(&path)
            .load()
            .expect_err("文件 Adapter 不得读取语义无效策略");
        assert_eq!(native_load_error.code(), expected_code, "fixture: {label}");

        let valid_directory = TestDirectory::new(&format!("{label}-save"));
        let native_save_error =
            NativeUpdatePolicyStore::with_path(valid_directory.path.join(UPDATE_POLICY_FILE_NAME))
                .save(&snapshot)
                .expect_err("文件 Adapter 不得保存语义无效策略");
        assert_eq!(native_save_error.code(), expected_code, "fixture: {label}");
    }

    #[test]
    fn native_adapter_never_reads_or_replaces_a_directory_as_the_policy_file() {
        let directory = TestDirectory::new("directory-target");
        let path = directory.path.join(UPDATE_POLICY_FILE_NAME);
        fs::create_dir(&path).expect("应创建伪装成策略文件的目录");
        let store = NativeUpdatePolicyStore::with_path(path);

        assert_eq!(
            store.load().expect_err("目录不能被当成策略文件").code(),
            "UPDATE_POLICY_UNSAFE_PATH"
        );
        assert_eq!(
            store
                .save(&UpdatePolicySnapshot::default())
                .expect_err("不能用 rename 覆盖目录")
                .code(),
            "UPDATE_POLICY_UNSAFE_PATH"
        );
        assert_eq!(
            fs::read_dir(&directory.path)
                .expect("应枚举策略测试目录")
                .filter_map(Result::ok)
                .filter(|entry| entry.file_name().to_string_lossy().contains(".tmp-"))
                .count(),
            0,
            "拒绝替换后不得遗留临时文件"
        );
    }

    #[cfg(windows)]
    #[test]
    fn native_adapter_rejects_a_policy_file_reparse_point_when_supported() {
        use std::os::windows::fs::symlink_file;

        let directory = TestDirectory::new("file-reparse");
        let target = directory.path.join("real-policy.json");
        fs::write(
            &target,
            serde_json::to_vec(&UpdatePolicySnapshot::default()).expect("应编码策略"),
        )
        .expect("应写入真实策略");
        let link = directory.path.join(UPDATE_POLICY_FILE_NAME);
        if symlink_file(&target, &link).is_err() {
            // 未开启 Developer Mode 的 Windows CI 无权创建 symlink；其余安全测试仍然有效。
            return;
        }

        let store = NativeUpdatePolicyStore::with_path(link);
        let error = store.load().expect_err("reparse point 不能成为策略文件");
        assert_eq!(error.code(), "UPDATE_POLICY_UNSAFE_PATH");
        let save_error = store
            .save(&UpdatePolicySnapshot::default())
            .expect_err("原子 replace 不能覆盖 reparse point");
        assert_eq!(save_error.code(), "UPDATE_POLICY_UNSAFE_PATH");
        assert_eq!(
            fs::read(target).expect("reparse point 目标必须保持不变"),
            serde_json::to_vec(&UpdatePolicySnapshot::default()).expect("应编码策略")
        );
    }

    #[cfg(windows)]
    #[test]
    fn native_adapter_rejects_a_reparse_point_anywhere_in_the_parent_chain() {
        use std::os::windows::fs::symlink_dir;

        let directory = TestDirectory::new("parent-reparse");
        let real_parent = directory.path.join("real-parent");
        fs::create_dir(&real_parent).expect("应创建真实父目录");
        let linked_parent = directory.path.join("linked-parent");
        if symlink_dir(&real_parent, &linked_parent).is_err() {
            // 未开启 Developer Mode 的 Windows CI 无权创建 symlink；其余安全测试仍然有效。
            return;
        }
        let store = NativeUpdatePolicyStore::with_path(
            linked_parent.join("nested").join(UPDATE_POLICY_FILE_NAME),
        );

        assert_eq!(
            store
                .load()
                .expect_err("读取不能穿过父目录 reparse point")
                .code(),
            "UPDATE_POLICY_UNSAFE_PATH"
        );
        assert_eq!(
            store
                .save(&UpdatePolicySnapshot::default())
                .expect_err("写入不能穿过父目录 reparse point")
                .code(),
            "UPDATE_POLICY_UNSAFE_PATH"
        );
        assert!(!real_parent.join("nested").exists());
    }
}
