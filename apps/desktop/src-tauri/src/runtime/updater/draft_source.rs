//! 仅供受保护发布工作流使用的 Draft Release transport。
//!
//! 它把 GitHub API 按 release id 下载到 runner 临时目录的字节，映射回生产
//! `GitHubReleaseSource` 所期待的 canonical URL。路径不会进入 candidate identity；
//! manifest、provenance、Minisign 与下载缓存仍由生产实现验证。

use std::{ffi::OsStr, future::Future, io::Read as _, path::PathBuf, pin::Pin, sync::Arc};

use tokio::io::AsyncReadExt as _;

use super::{
    download::{
        InstallerBody, InstallerChunkFuture, InstallerHttpResponse, InstallerHttpTransport,
        InstallerTransportError, StreamingInstallerDownloader,
    },
    github_source::{
        GitHubReleaseSource, ReleaseHttpRequest, ReleaseHttpResourceKind, ReleaseHttpResponse,
        ReleaseHttpTransport, LATEST_MANIFEST_URL, OFFICIAL_REPOSITORY,
    },
    managed_fs::StableDirectory,
    CheckRequest, NormalizedRelease, UpdateSource, UpdateSourceError,
};

const MAX_STAGED_METADATA_BYTES: usize = 256 * 1024;
const INSTALLER_CHUNK_BYTES: usize = 64 * 1024;

fn rejected(code: &'static str, message: &'static str) -> UpdateSourceError {
    UpdateSourceError {
        code: code.to_owned(),
        retryable: false,
        message: message.to_owned(),
    }
}

fn valid_tag(tag: &str) -> bool {
    let Some(version) = tag.strip_prefix('v') else {
        return false;
    };
    let Ok(parsed) = semver::Version::parse(version) else {
        return false;
    };
    parsed.pre.is_empty() && parsed.build.is_empty() && parsed.to_string() == version
}

fn valid_commit_sha(commit_sha: &str) -> bool {
    commit_sha.len() == 40
        && commit_sha
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn read_staged_file(directory: &StableDirectory, name: &str) -> Result<Vec<u8>, UpdateSourceError> {
    let mut file = directory
        .open_regular_read(OsStr::new(name))
        .map_err(|_| rejected("UPDATE_DRAFT_STAGING_REJECTED", "无法读取 Draft staging"))?
        .ok_or_else(|| {
            rejected(
                "UPDATE_DRAFT_STAGING_REJECTED",
                "Draft staging 缺少必要资产",
            )
        })?;
    let length = file
        .metadata()
        .map_err(|_| rejected("UPDATE_DRAFT_STAGING_REJECTED", "无法检查 Draft staging"))?
        .len();
    if length == 0 || length > MAX_STAGED_METADATA_BYTES as u64 {
        return Err(rejected(
            "UPDATE_DRAFT_STAGING_REJECTED",
            "Draft staging 元数据大小不受允许",
        ));
    }
    let mut bytes = Vec::with_capacity(length as usize);
    file.read_to_end(&mut bytes)
        .map_err(|_| rejected("UPDATE_DRAFT_STAGING_REJECTED", "无法读取 Draft staging"))?;
    Ok(bytes)
}

#[derive(Debug, Clone)]
pub(crate) struct DraftCandidateConfig {
    pub staging_directory: PathBuf,
    pub tag: String,
    pub commit_sha: String,
}

impl DraftCandidateConfig {
    pub(crate) fn new(
        staging_directory: impl Into<PathBuf>,
        tag: impl Into<String>,
        commit_sha: impl Into<String>,
    ) -> Result<Self, UpdateSourceError> {
        let staging_directory = staging_directory.into();
        let tag = tag.into();
        let commit_sha = commit_sha.into();
        if !staging_directory.is_absolute() || !valid_tag(&tag) || !valid_commit_sha(&commit_sha) {
            return Err(rejected(
                "UPDATE_DRAFT_IDENTITY_REJECTED",
                "Draft release identity 无效",
            ));
        }
        Ok(Self {
            staging_directory,
            tag,
            commit_sha,
        })
    }

    pub(crate) fn version(&self) -> &str {
        self.tag
            .strip_prefix('v')
            .expect("validated draft tag must start with v")
    }

    pub(crate) fn installer_name(&self) -> String {
        format!("MineRadio-Tauri_{}_x64-setup.exe", self.version())
    }

    pub(crate) fn installer_url(&self) -> String {
        format!(
            "https://github.com/{OFFICIAL_REPOSITORY}/releases/download/{}/{}",
            self.tag,
            self.installer_name()
        )
    }
}

struct DraftMetadataTransport {
    directory: Arc<StableDirectory>,
    tag: String,
    commit_sha: String,
    installer_name: String,
}

impl DraftMetadataTransport {
    fn new(config: &DraftCandidateConfig) -> Result<Self, UpdateSourceError> {
        let directory = StableDirectory::open_existing(&config.staging_directory)
            .map_err(|_| rejected("UPDATE_DRAFT_STAGING_REJECTED", "无法打开 Draft staging"))?
            .ok_or_else(|| rejected("UPDATE_DRAFT_STAGING_REJECTED", "Draft staging 目录不存在"))?;
        Ok(Self {
            directory: Arc::new(directory),
            tag: config.tag.clone(),
            commit_sha: config.commit_sha.clone(),
            installer_name: config.installer_name(),
        })
    }

    fn provenance_url(&self) -> String {
        format!(
            "https://github.com/{OFFICIAL_REPOSITORY}/releases/download/{}/release-provenance.json",
            self.tag
        )
    }

    fn installer_url(&self) -> String {
        format!(
            "https://github.com/{OFFICIAL_REPOSITORY}/releases/download/{}/{}",
            self.tag, self.installer_name
        )
    }

    fn resolve(&self, request: &ReleaseHttpRequest) -> Result<Vec<u8>, UpdateSourceError> {
        let installer_signature_url = format!("{}.sig", self.installer_url());
        let provenance_url = self.provenance_url();
        let provenance_signature_url = format!("{provenance_url}.sig");
        let commit_url = format!(
            "https://api.github.com/repos/{OFFICIAL_REPOSITORY}/commits/{}",
            self.tag
        );

        match (request.kind, request.url.as_str()) {
            (ReleaseHttpResourceKind::Manifest, LATEST_MANIFEST_URL) => {
                read_staged_file(&self.directory, "latest.json")
            }
            (ReleaseHttpResourceKind::InstallerSignature, url)
                if url == installer_signature_url =>
            {
                read_staged_file(&self.directory, &format!("{}.sig", self.installer_name))
            }
            (ReleaseHttpResourceKind::Commit, url) if url == commit_url => {
                serde_json::to_vec(&serde_json::json!({ "sha": self.commit_sha })).map_err(|_| {
                    rejected(
                        "UPDATE_DRAFT_STAGING_REJECTED",
                        "无法构造 Draft commit evidence",
                    )
                })
            }
            (ReleaseHttpResourceKind::Provenance, url) if url == provenance_url => {
                read_staged_file(&self.directory, "release-provenance.json")
            }
            (ReleaseHttpResourceKind::ProvenanceSignature, url)
                if url == provenance_signature_url =>
            {
                read_staged_file(&self.directory, "release-provenance.json.sig")
            }
            _ => Err(rejected(
                "UPDATE_DRAFT_REQUEST_REJECTED",
                "Draft source 请求不属于固定 release identity",
            )),
        }
    }
}

impl ReleaseHttpTransport for DraftMetadataTransport {
    fn get(
        &self,
        request: ReleaseHttpRequest,
    ) -> Pin<Box<dyn Future<Output = Result<ReleaseHttpResponse, UpdateSourceError>> + Send + '_>>
    {
        Box::pin(async move {
            Ok(ReleaseHttpResponse {
                status: 200,
                location: None,
                body: self.resolve(&request)?,
            })
        })
    }
}

pub(crate) struct DraftCandidateSource {
    inner: GitHubReleaseSource,
}

impl DraftCandidateSource {
    pub(crate) fn new(
        config: &DraftCandidateConfig,
        encoded_public_key: &str,
    ) -> Result<Self, UpdateSourceError> {
        let transport = Arc::new(DraftMetadataTransport::new(config)?);
        Ok(Self {
            inner: GitHubReleaseSource::with_transport(encoded_public_key, transport)?,
        })
    }
}

impl UpdateSource for DraftCandidateSource {
    fn check(
        &self,
        request: CheckRequest,
    ) -> Pin<
        Box<dyn Future<Output = Result<Option<NormalizedRelease>, UpdateSourceError>> + Send + '_>,
    > {
        self.inner.check(request)
    }
}

struct StagedInstallerBody {
    _directory: Arc<StableDirectory>,
    file: tokio::fs::File,
}

impl InstallerBody for StagedInstallerBody {
    fn next_chunk(&mut self) -> InstallerChunkFuture<'_> {
        Box::pin(async move {
            let mut bytes = vec![0_u8; INSTALLER_CHUNK_BYTES];
            let read = self
                .file
                .read(&mut bytes)
                .await
                .map_err(|_| InstallerTransportError { retryable: false })?;
            if read == 0 {
                return Ok(None);
            }
            bytes.truncate(read);
            Ok(Some(bytes))
        })
    }
}

struct StagedInstallerTransport {
    directory: Arc<StableDirectory>,
    expected_url: String,
    installer_name: String,
}

impl StagedInstallerTransport {
    fn new(config: &DraftCandidateConfig) -> Result<Self, UpdateSourceError> {
        let directory = StableDirectory::open_existing(&config.staging_directory)
            .map_err(|_| rejected("UPDATE_DRAFT_STAGING_REJECTED", "无法打开 Draft staging"))?
            .ok_or_else(|| rejected("UPDATE_DRAFT_STAGING_REJECTED", "Draft staging 目录不存在"))?;
        Ok(Self {
            directory: Arc::new(directory),
            expected_url: config.installer_url(),
            installer_name: config.installer_name(),
        })
    }
}

impl InstallerHttpTransport for StagedInstallerTransport {
    fn get(
        &self,
        url: &str,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<InstallerHttpResponse, InstallerTransportError>> + Send + '_,
        >,
    > {
        let accepted = url == self.expected_url;
        Box::pin(async move {
            if !accepted {
                return Err(InstallerTransportError { retryable: false });
            }
            let file = self
                .directory
                .open_regular_read(OsStr::new(&self.installer_name))
                .map_err(|_| InstallerTransportError { retryable: false })?
                .ok_or(InstallerTransportError { retryable: false })?;
            let content_length = file
                .metadata()
                .map_err(|_| InstallerTransportError { retryable: false })?
                .len();
            Ok(InstallerHttpResponse {
                status: 200,
                location: None,
                content_length: Some(content_length),
                body: Box::new(StagedInstallerBody {
                    _directory: self.directory.clone(),
                    file: tokio::fs::File::from_std(file),
                }),
            })
        })
    }
}

pub(crate) fn staged_installer_downloader(
    config: &DraftCandidateConfig,
    updater_directory: impl Into<PathBuf>,
) -> Result<StreamingInstallerDownloader, UpdateSourceError> {
    let transport = Arc::new(StagedInstallerTransport::new(config)?);
    Ok(StreamingInstallerDownloader::with_staged_transport(
        updater_directory,
        transport,
    ))
}

#[cfg(test)]
mod tests {
    use std::{fs, path::Path, time::SystemTime};

    use serde::Deserialize;

    use super::*;

    const RAW_PROVENANCE: &[u8] = include_bytes!("fixtures/provenance-v2.json");
    const CONTRACT_JSON: &str = include_str!("fixtures/provenance-v2-contract.json");
    const TAG: &str = "v1.2.3";
    const COMMIT_SHA: &str = "0123456789abcdef0123456789abcdef01234567";
    const INSTALLER_NAME: &str = "MineRadio-Tauri_1.2.3_x64-setup.exe";

    #[derive(Deserialize)]
    struct ContractFixture {
        encoded_public_key: String,
        provenance_signature: String,
        installer_signature: String,
        expected_candidate_id: String,
        github_locator: String,
        staging_locator: String,
    }

    struct CanonicalGitHubFixtureTransport {
        root: PathBuf,
        tag: String,
        commit_sha: String,
        installer_name: String,
    }

    impl CanonicalGitHubFixtureTransport {
        fn response(&self, request: &ReleaseHttpRequest) -> Result<Vec<u8>, UpdateSourceError> {
            let installer_url = format!(
                "https://github.com/{OFFICIAL_REPOSITORY}/releases/download/{}/{}",
                self.tag, self.installer_name
            );
            let provenance_url = format!(
                "https://github.com/{OFFICIAL_REPOSITORY}/releases/download/{}/release-provenance.json",
                self.tag
            );
            let commit_url = format!(
                "https://api.github.com/repos/{OFFICIAL_REPOSITORY}/commits/{}",
                self.tag
            );
            let file_name = match (request.kind, request.url.as_str()) {
                (ReleaseHttpResourceKind::Manifest, LATEST_MANIFEST_URL) => Some("latest.json"),
                (ReleaseHttpResourceKind::InstallerSignature, url)
                    if url == format!("{installer_url}.sig") =>
                {
                    return fs::read(self.root.join(format!("{}.sig", self.installer_name)))
                        .map_err(|_| {
                            rejected("UPDATE_TEST_FIXTURE_FAILED", "无法读取生产 fixture")
                        });
                }
                (ReleaseHttpResourceKind::Commit, url) if url == commit_url => {
                    return serde_json::to_vec(&serde_json::json!({ "sha": self.commit_sha }))
                        .map_err(|_| {
                            rejected("UPDATE_TEST_FIXTURE_FAILED", "无法构造生产 commit fixture")
                        });
                }
                (ReleaseHttpResourceKind::Provenance, url) if url == provenance_url => {
                    Some("release-provenance.json")
                }
                (ReleaseHttpResourceKind::ProvenanceSignature, url)
                    if url == format!("{provenance_url}.sig") =>
                {
                    Some("release-provenance.json.sig")
                }
                _ => None,
            }
            .ok_or_else(|| {
                rejected(
                    "UPDATE_TEST_FIXTURE_FAILED",
                    "生产 fixture 收到非 canonical 请求",
                )
            })?;
            fs::read(self.root.join(file_name))
                .map_err(|_| rejected("UPDATE_TEST_FIXTURE_FAILED", "无法读取生产 fixture"))
        }
    }

    impl ReleaseHttpTransport for CanonicalGitHubFixtureTransport {
        fn get(
            &self,
            request: ReleaseHttpRequest,
        ) -> Pin<Box<dyn Future<Output = Result<ReleaseHttpResponse, UpdateSourceError>> + Send + '_>>
        {
            Box::pin(async move {
                Ok(ReleaseHttpResponse {
                    status: 200,
                    location: None,
                    body: self.response(&request)?,
                })
            })
        }
    }

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let unique = SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "mineradio-draft-source-{}-{unique}",
                std::process::id()
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn contract() -> ContractFixture {
        serde_json::from_str(CONTRACT_JSON).unwrap()
    }

    fn write_staging(root: &Path, contract: &ContractFixture) {
        let manifest = serde_json::json!({
            "version": "1.2.3",
            "notes": "修复播放链路",
            "pub_date": "2026-07-31T00:00:00Z",
            "platforms": {
                "windows-x86_64-nsis": {
                    "signature": contract.installer_signature,
                    "url": contract.github_locator,
                },
                "windows-x86_64": {
                    "signature": contract.installer_signature,
                    "url": contract.github_locator,
                }
            }
        });
        fs::write(
            root.join("latest.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        fs::write(
            root.join(format!("{INSTALLER_NAME}.sig")),
            &contract.installer_signature,
        )
        .unwrap();
        fs::write(root.join("release-provenance.json"), RAW_PROVENANCE).unwrap();
        fs::write(
            root.join("release-provenance.json.sig"),
            &contract.provenance_signature,
        )
        .unwrap();
        fs::write(root.join(INSTALLER_NAME), b"installer").unwrap();
    }

    #[test]
    fn draft_source_preserves_github_identity_without_using_local_path() {
        let contract = contract();
        let root = TestDirectory::new();
        write_staging(&root.0, &contract);
        let config = DraftCandidateConfig::new(&root.0, TAG, COMMIT_SHA).unwrap();
        let source = DraftCandidateSource::new(&config, &contract.encoded_public_key).unwrap();

        let release = tauri::async_runtime::block_on(source.check(CheckRequest {
            current_version: "1.2.2".into(),
        }))
        .unwrap()
        .expect("draft 应产生候选");

        assert_eq!(
            release.candidate_id.as_str(),
            contract.expected_candidate_id
        );
        assert_eq!(
            release.verified_asset_url().as_deref(),
            Some(contract.github_locator.as_str())
        );
        assert_ne!(
            release.verified_asset_url().as_deref(),
            Some(contract.staging_locator.as_str())
        );
    }

    #[test]
    fn draft_and_production_sources_normalize_the_same_canonical_release() {
        let contract = contract();
        let root = TestDirectory::new();
        write_staging(&root.0, &contract);
        let config = DraftCandidateConfig::new(&root.0, TAG, COMMIT_SHA).unwrap();
        let draft = DraftCandidateSource::new(&config, &contract.encoded_public_key).unwrap();
        let production = GitHubReleaseSource::with_transport(
            &contract.encoded_public_key,
            Arc::new(CanonicalGitHubFixtureTransport {
                root: root.0.clone(),
                tag: TAG.to_owned(),
                commit_sha: COMMIT_SHA.to_owned(),
                installer_name: INSTALLER_NAME.to_owned(),
            }),
        )
        .unwrap();
        let draft_release = tauri::async_runtime::block_on(draft.check(CheckRequest {
            current_version: "1.2.2".into(),
        }))
        .unwrap()
        .unwrap();
        let production_release = tauri::async_runtime::block_on(production.check(CheckRequest {
            current_version: "1.2.2".into(),
        }))
        .unwrap()
        .unwrap();

        assert_eq!(draft_release, production_release);
        assert_eq!(
            draft_release.candidate_id.as_str(),
            contract.expected_candidate_id
        );
        assert_eq!(
            draft_release.verified_asset_url().as_deref(),
            Some(contract.github_locator.as_str())
        );
    }

    #[test]
    fn draft_source_rejects_missing_or_mismatched_evidence() {
        let contract = contract();
        let root = TestDirectory::new();
        write_staging(&root.0, &contract);
        fs::remove_file(root.0.join("release-provenance.json.sig")).unwrap();
        let config = DraftCandidateConfig::new(&root.0, TAG, COMMIT_SHA).unwrap();
        let source = DraftCandidateSource::new(&config, &contract.encoded_public_key).unwrap();

        let error = tauri::async_runtime::block_on(source.check(CheckRequest {
            current_version: "1.2.2".into(),
        }))
        .expect_err("缺少 provenance signature 必须失败");

        assert_eq!(error.code, "UPDATE_DRAFT_STAGING_REJECTED");
    }

    #[test]
    fn draft_identity_must_be_strict_stable_tag_and_lower_hex_commit() {
        let root = TestDirectory::new();
        for tag in ["1.2.3", "v01.2.3", "v1.2.3-beta.1"] {
            assert!(DraftCandidateConfig::new(&root.0, tag, COMMIT_SHA).is_err());
        }
        assert!(DraftCandidateConfig::new(&root.0, TAG, COMMIT_SHA.to_uppercase()).is_err());
        assert!(DraftCandidateConfig::new("relative-staging", TAG, COMMIT_SHA).is_err());
    }

    #[test]
    fn staged_installer_transport_streams_only_the_canonical_asset() {
        let contract = contract();
        let root = TestDirectory::new();
        write_staging(&root.0, &contract);
        let config = DraftCandidateConfig::new(&root.0, TAG, COMMIT_SHA).unwrap();
        let transport = StagedInstallerTransport::new(&config).unwrap();

        let mut response = tauri::async_runtime::block_on(transport.get(&config.installer_url()))
            .expect("canonical asset 应可读取");
        let first = tauri::async_runtime::block_on(response.body.next_chunk())
            .unwrap()
            .unwrap();
        let end = tauri::async_runtime::block_on(response.body.next_chunk()).unwrap();

        assert_eq!(response.content_length, Some(9));
        assert_eq!(first, b"installer");
        assert_eq!(end, None);
        assert!(
            tauri::async_runtime::block_on(transport.get("https://example.invalid/a")).is_err()
        );
    }
}
