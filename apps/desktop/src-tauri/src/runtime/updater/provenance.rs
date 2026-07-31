use std::fmt;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use minisign_verify::{PublicKey, Signature};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const PROVENANCE_SCHEMA_VERSION: u64 = 2;
const CANDIDATE_SCHEMA_VERSION: u64 = 2;
const PROVENANCE_PLATFORM: &str = "windows-x86_64";
const PROVENANCE_PACKAGE_TYPE: &str = "nsis";
const PROVENANCE_INSTALL_MODE: &str = "currentUser";
const RELEASE_TARGET: &str = "windows-x86_64-nsis";
const MAX_SAFE_JSON_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ReleaseCandidateId(String);

impl ReleaseCandidateId {
    pub(crate) fn as_str(&self) -> &str {
        &self.0
    }

    pub(crate) fn into_string(self) -> String {
        self.0
    }

    #[cfg(test)]
    pub(crate) fn fake(value: impl Into<String>) -> Self {
        Self(value.into())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ProvenanceError {
    code: &'static str,
    message: String,
}

impl ProvenanceError {
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ProvenanceInstaller {
    name: String,
    size: u64,
    sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ReleaseProvenanceV2 {
    schema_version: u64,
    repository: String,
    tag: String,
    commit_sha: String,
    platform: String,
    package_type: String,
    install_mode: String,
    installer: ProvenanceInstaller,
}

#[derive(Serialize)]
struct CandidateIdentityV1<'a> {
    schema_version: u64,
    repository: &'a str,
    tag: &'a str,
    version: &'a str,
    asset_name: &'a str,
    target: &'a str,
    provenance_sha256: &'a str,
    installer_signature_sha256: &'a str,
    provenance_signature_sha256: &'a str,
}

impl fmt::Display for ProvenanceError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for ProvenanceError {}

#[derive(Debug, Clone, Copy)]
pub(crate) struct ProvenanceVerificationInput<'a> {
    pub raw_provenance: &'a [u8],
    pub provenance_signature: &'a str,
    pub installer_signature: &'a str,
    pub expected_repository: &'a str,
    pub expected_tag: &'a str,
    pub expected_version: &'a str,
    pub expected_commit_sha: &'a str,
    pub expected_target: &'a str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct VerifiedReleaseEvidence {
    candidate_id: ReleaseCandidateId,
    candidate_identity: Vec<u8>,
    raw_provenance: Vec<u8>,
    repository: String,
    tag: String,
    version: String,
    commit_sha: String,
    target: String,
    installer: ProvenanceInstaller,
    installer_signature: String,
    provenance_signature: String,
    provenance_sha256: String,
    installer_signature_sha256: String,
    provenance_signature_sha256: String,
}

impl VerifiedReleaseEvidence {
    pub(crate) fn candidate_id(&self) -> &ReleaseCandidateId {
        &self.candidate_id
    }

    pub(crate) fn candidate_identity(&self) -> &[u8] {
        &self.candidate_identity
    }

    pub(crate) fn provenance_sha256(&self) -> &str {
        &self.provenance_sha256
    }

    pub(crate) fn repository(&self) -> &str {
        &self.repository
    }

    pub(crate) fn tag(&self) -> &str {
        &self.tag
    }

    pub(crate) fn version(&self) -> &str {
        &self.version
    }

    pub(crate) fn installer_name(&self) -> &str {
        &self.installer.name
    }

    pub(crate) fn verify_installer_measurement(
        &self,
        size: u64,
        sha256: &str,
    ) -> Result<(), ProvenanceError> {
        if size != self.installer.size {
            return Err(ProvenanceError::new(
                "installer-size-mismatch",
                format!(
                    "安装包大小与签名 provenance 不一致: expected={}, actual={size}",
                    self.installer.size
                ),
            ));
        }

        if sha256 != self.installer.sha256 {
            return Err(ProvenanceError::new(
                "installer-sha256-mismatch",
                "安装包 SHA-256 与签名 provenance 不一致",
            ));
        }

        Ok(())
    }
}

pub(crate) struct ProvenanceVerifier {
    public_key: PublicKey,
}

impl ProvenanceVerifier {
    pub(crate) fn from_tauri_pubkey(encoded_public_key: &str) -> Result<Self, ProvenanceError> {
        let public_key_text = decode_tauri_text(encoded_public_key, "invalid-public-key")?;
        let public_key = PublicKey::decode(&public_key_text).map_err(|error| {
            ProvenanceError::new(
                "invalid-public-key",
                format!("Tauri updater 公钥格式无效: {error}"),
            )
        })?;
        Ok(Self { public_key })
    }

    pub(crate) fn verify(
        &self,
        input: ProvenanceVerificationInput<'_>,
    ) -> Result<VerifiedReleaseEvidence, ProvenanceError> {
        let provenance = parse_canonical_provenance(input.raw_provenance)?;
        validate_expected_source(&provenance, &input)?;

        let provenance_signature = decode_tauri_signature(
            input.provenance_signature,
            "provenance",
            "invalid-provenance-signature",
        )?;
        self.public_key
            .verify(input.raw_provenance, &provenance_signature.signature, false)
            .map_err(|error| {
                ProvenanceError::new(
                    "provenance-signature-rejected",
                    format!("provenance 签名验证失败: {error}"),
                )
            })?;

        let installer_signature = decode_tauri_signature(
            input.installer_signature,
            "安装包",
            "invalid-installer-signature",
        )?;
        // 此处只做不需要安装包字节的 key-id 与预哈希算法预检；完整 Minisign 验证由流式下载阶段完成。
        self.public_key
            .verify_stream(&installer_signature.signature)
            .map_err(|error| {
                ProvenanceError::new(
                    "invalid-installer-signature",
                    format!("安装包签名不属于固定 updater 公钥或不是预哈希签名: {error}"),
                )
            })?;
        let provenance_sha256 = sha256_hex(input.raw_provenance);
        let installer_signature_sha256 = sha256_hex(&installer_signature.protected_identity);
        let provenance_signature_sha256 = sha256_hex(&provenance_signature.protected_identity);
        let candidate = CandidateIdentityV1 {
            schema_version: CANDIDATE_SCHEMA_VERSION,
            repository: &provenance.repository,
            tag: &provenance.tag,
            version: input.expected_version,
            asset_name: &provenance.installer.name,
            target: input.expected_target,
            provenance_sha256: &provenance_sha256,
            installer_signature_sha256: &installer_signature_sha256,
            provenance_signature_sha256: &provenance_signature_sha256,
        };
        let mut candidate_identity = serde_json::to_vec(&candidate).map_err(|error| {
            ProvenanceError::new(
                "candidate-serialization-failed",
                format!("candidate identity 序列化失败: {error}"),
            )
        })?;
        candidate_identity.push(b'\n');
        let candidate_id = ReleaseCandidateId(sha256_hex(&candidate_identity));

        Ok(VerifiedReleaseEvidence {
            candidate_id,
            candidate_identity,
            raw_provenance: input.raw_provenance.to_vec(),
            repository: provenance.repository,
            tag: provenance.tag,
            version: input.expected_version.to_owned(),
            commit_sha: provenance.commit_sha,
            target: input.expected_target.to_owned(),
            installer: provenance.installer,
            installer_signature: input.installer_signature.to_owned(),
            provenance_signature: input.provenance_signature.to_owned(),
            provenance_sha256,
            installer_signature_sha256,
            provenance_signature_sha256,
        })
    }
}

fn parse_canonical_provenance(
    raw_provenance: &[u8],
) -> Result<ReleaseProvenanceV2, ProvenanceError> {
    if raw_provenance.starts_with(&[0xef, 0xbb, 0xbf]) {
        return Err(ProvenanceError::new(
            "noncanonical-provenance",
            "provenance v2 不允许 UTF-8 BOM",
        ));
    }

    std::str::from_utf8(raw_provenance).map_err(|error| {
        ProvenanceError::new(
            "invalid-provenance-utf8",
            format!("provenance 不是有效 UTF-8: {error}"),
        )
    })?;

    let provenance: ReleaseProvenanceV2 =
        serde_json::from_slice(raw_provenance).map_err(|error| {
            ProvenanceError::new(
                "invalid-provenance-json",
                format!("provenance v2 JSON 无效: {error}"),
            )
        })?;
    validate_provenance_fields(&provenance)?;

    let mut canonical = serde_json::to_vec(&provenance).map_err(|error| {
        ProvenanceError::new(
            "provenance-serialization-failed",
            format!("provenance v2 序列化失败: {error}"),
        )
    })?;
    canonical.push(b'\n');
    if canonical != raw_provenance {
        return Err(ProvenanceError::new(
            "noncanonical-provenance",
            "provenance 不是 canonical v2 编码",
        ));
    }

    Ok(provenance)
}

fn validate_provenance_fields(provenance: &ReleaseProvenanceV2) -> Result<(), ProvenanceError> {
    if provenance.schema_version != PROVENANCE_SCHEMA_VERSION {
        return Err(ProvenanceError::new(
            "unsupported-provenance-schema",
            "provenance schema_version 必须为 2",
        ));
    }
    if !is_valid_repository(&provenance.repository) {
        return Err(ProvenanceError::new(
            "invalid-provenance-repository",
            "provenance repository 格式无效",
        ));
    }
    if !is_valid_release_tag(&provenance.tag) {
        return Err(ProvenanceError::new(
            "invalid-provenance-tag",
            "provenance tag 格式无效",
        ));
    }
    if !is_lower_hex(&provenance.commit_sha, 40) {
        return Err(ProvenanceError::new(
            "invalid-provenance-commit",
            "provenance commit_sha 必须是 40 位小写十六进制",
        ));
    }
    if provenance.platform != PROVENANCE_PLATFORM
        || provenance.package_type != PROVENANCE_PACKAGE_TYPE
        || provenance.install_mode != PROVENANCE_INSTALL_MODE
    {
        return Err(ProvenanceError::new(
            "unsupported-release-package",
            "provenance 必须绑定 Windows x64 currentUser NSIS",
        ));
    }

    let expected_installer = format!(
        "MineRadio-Tauri_{}_x64-setup.exe",
        provenance.tag.trim_start_matches('v')
    );
    if provenance.installer.name != expected_installer {
        return Err(ProvenanceError::new(
            "invalid-installer-name",
            format!("provenance installer.name 必须为 {expected_installer}"),
        ));
    }
    if provenance.installer.size == 0 || provenance.installer.size > MAX_SAFE_JSON_INTEGER {
        return Err(ProvenanceError::new(
            "invalid-installer-size",
            "provenance installer.size 必须是正安全整数",
        ));
    }
    if !is_lower_hex(&provenance.installer.sha256, 64) {
        return Err(ProvenanceError::new(
            "invalid-installer-sha256",
            "provenance installer.sha256 必须是 64 位小写十六进制",
        ));
    }

    Ok(())
}

fn validate_expected_source(
    provenance: &ReleaseProvenanceV2,
    input: &ProvenanceVerificationInput<'_>,
) -> Result<(), ProvenanceError> {
    let expected_version_from_tag = input
        .expected_tag
        .strip_prefix('v')
        .filter(|_| is_valid_release_tag(input.expected_tag));
    if expected_version_from_tag != Some(input.expected_version) {
        return Err(ProvenanceError::new(
            "source-version-mismatch",
            "expected tag 与 manifest version 不一致",
        ));
    }
    if input.expected_target != RELEASE_TARGET {
        return Err(ProvenanceError::new(
            "source-target-mismatch",
            format!("更新 target 必须为 {RELEASE_TARGET}"),
        ));
    }
    if provenance.repository != input.expected_repository {
        return Err(ProvenanceError::new(
            "source-repository-mismatch",
            "provenance repository 与更新来源不一致",
        ));
    }
    if provenance.tag != input.expected_tag {
        return Err(ProvenanceError::new(
            "source-tag-mismatch",
            "provenance tag 与更新来源不一致",
        ));
    }
    if provenance.commit_sha != input.expected_commit_sha {
        return Err(ProvenanceError::new(
            "source-commit-mismatch",
            "provenance commit_sha 与更新来源不一致",
        ));
    }

    Ok(())
}

fn decode_tauri_text(encoded: &str, error_code: &'static str) -> Result<String, ProvenanceError> {
    let decoded = STANDARD.decode(encoded).map_err(|error| {
        ProvenanceError::new(error_code, format!("Tauri base64 内容无效: {error}"))
    })?;
    String::from_utf8(decoded).map_err(|error| {
        ProvenanceError::new(error_code, format!("Tauri base64 内容不是 UTF-8: {error}"))
    })
}

fn decode_tauri_signature(
    encoded: &str,
    label: &str,
    error_code: &'static str,
) -> Result<DecodedTauriSignature, ProvenanceError> {
    let signature_text = decode_tauri_text(encoded, error_code)?;
    if signature_text.contains('\r') {
        return Err(ProvenanceError::new(
            error_code,
            format!("{label}签名必须使用 canonical LF 换行"),
        ));
    }
    let canonical_text = signature_text.strip_suffix('\n').unwrap_or(&signature_text);
    let lines = canonical_text.split('\n').collect::<Vec<_>>();
    if lines.len() != 4
        || !lines[0].starts_with("untrusted comment: ")
        || !lines[2].starts_with("trusted comment: ")
        || lines.iter().any(|line| line.is_empty())
    {
        return Err(ProvenanceError::new(
            error_code,
            format!("{label}签名必须是 canonical 四行 Minisign 结构"),
        ));
    }
    let signature = Signature::decode(&signature_text).map_err(|error| {
        ProvenanceError::new(error_code, format!("{label}签名格式无效: {error}"))
    })?;
    let protected_identity = format!("{}\n{}\n{}\n", lines[1], lines[2], lines[3]).into_bytes();
    Ok(DecodedTauriSignature {
        signature,
        protected_identity,
    })
}

struct DecodedTauriSignature {
    signature: Signature,
    protected_identity: Vec<u8>,
}

fn sha256_hex(input: &[u8]) -> String {
    format!("{:x}", Sha256::digest(input))
}

pub(super) fn is_lower_hex(value: &str, expected_length: usize) -> bool {
    value.len() == expected_length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn is_valid_release_tag(tag: &str) -> bool {
    let Some(version) = tag.strip_prefix('v') else {
        return false;
    };
    let components = version.split('.').collect::<Vec<_>>();
    components.len() == 3
        && components.iter().all(|component| {
            !component.is_empty()
                && component.bytes().all(|byte| byte.is_ascii_digit())
                && (*component == "0" || !component.starts_with('0'))
        })
}

fn is_valid_repository(repository: &str) -> bool {
    let Some((owner, name)) = repository.split_once('/') else {
        return false;
    };
    if owner.is_empty()
        || owner.len() > 39
        || name.is_empty()
        || name.len() > 100
        || name == "."
        || name == ".."
        || name.contains('/')
    {
        return false;
    }

    let owner_is_valid = owner.split('-').all(|segment| {
        !segment.is_empty() && segment.bytes().all(|byte| byte.is_ascii_alphanumeric())
    });
    let name_is_valid = name
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'));
    owner_is_valid && name_is_valid
}

#[cfg(test)]
mod tests {
    use base64::Engine as _;
    use serde::Deserialize;

    use super::*;

    const RAW_PROVENANCE: &[u8] = include_bytes!("fixtures/provenance-v2.json");
    const CONTRACT_JSON: &str = include_str!("fixtures/provenance-v2-contract.json");
    const WRONG_PUBLIC_KEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEQxRDBGMTI1MkNERkVEQjkKUldTNTdkOHNKZkhRMFQwVzh4WjBmeStXa1hHb0VlU3VlSEszVEVYbWRKVlRON3dvZlBRdm52R0UK";

    #[derive(Debug, Deserialize)]
    struct ContractFixture {
        encoded_public_key: String,
        provenance_signature: String,
        installer_signature: String,
        expected_provenance_sha256: String,
        expected_candidate_identity: String,
        expected_candidate_id: String,
        github_locator: String,
        staging_locator: String,
    }

    fn contract() -> ContractFixture {
        serde_json::from_str(CONTRACT_JSON).expect("共享 provenance contract fixture 应有效")
    }

    fn input<'a>(contract: &'a ContractFixture) -> ProvenanceVerificationInput<'a> {
        ProvenanceVerificationInput {
            raw_provenance: RAW_PROVENANCE,
            provenance_signature: &contract.provenance_signature,
            installer_signature: &contract.installer_signature,
            expected_repository: "zzstar101/Mineradio-Tauri",
            expected_tag: "v1.2.3",
            expected_version: "1.2.3",
            expected_commit_sha: "0123456789abcdef0123456789abcdef01234567",
            expected_target: "windows-x86_64-nsis",
        }
    }

    fn rewrite_tauri_signature(encoded: &str, rewrite: impl FnOnce(&mut Vec<String>)) -> String {
        let decoded = STANDARD
            .decode(encoded)
            .expect("fixture Tauri base64 应有效");
        let text = String::from_utf8(decoded).expect("fixture 签名应为 UTF-8");
        let mut lines = text.lines().map(str::to_owned).collect::<Vec<_>>();
        rewrite(&mut lines);
        STANDARD.encode(format!("{}\n", lines.join("\n")))
    }

    #[test]
    fn signed_shared_fixture_produces_cross_language_digest_and_candidate_id() {
        let contract = contract();
        let verifier = ProvenanceVerifier::from_tauri_pubkey(&contract.encoded_public_key)
            .expect("fixture 公钥应有效");

        let evidence = verifier
            .verify(input(&contract))
            .expect("fixture 应通过验证");

        assert_eq!(
            evidence.provenance_sha256(),
            contract.expected_provenance_sha256
        );
        assert_eq!(
            evidence.candidate_id().as_str(),
            contract.expected_candidate_id
        );
        assert_eq!(
            evidence.candidate_identity(),
            contract.expected_candidate_identity.as_bytes()
        );
        assert_ne!(contract.github_locator, contract.staging_locator);
        assert!(!evidence
            .candidate_identity()
            .windows(contract.github_locator.len())
            .any(|window| window == contract.github_locator.as_bytes()));
        assert!(!evidence
            .candidate_identity()
            .windows(contract.staging_locator.len())
            .any(|window| window == contract.staging_locator.as_bytes()));
    }

    #[test]
    fn noncanonical_or_legacy_payloads_fail_closed() {
        let contract = contract();
        let verifier = ProvenanceVerifier::from_tauri_pubkey(&contract.encoded_public_key)
            .expect("fixture 公钥应有效");
        let canonical_text = std::str::from_utf8(RAW_PROVENANCE).expect("fixture 应为 UTF-8");
        let mut variants = vec![
            format!("\u{feff}{canonical_text}").into_bytes(),
            canonical_text.replace('\n', "\r\n").into_bytes(),
            serde_json::to_string_pretty(
                &serde_json::from_slice::<serde_json::Value>(RAW_PROVENANCE)
                    .expect("fixture JSON 应有效"),
            )
            .expect("pretty fixture 应可序列化")
            .into_bytes(),
            canonical_text
                .replacen("\"schema_version\":2", "\"schema_version\":1", 1)
                .into_bytes(),
            canonical_text
                .replacen("\"repository\":", "\"unexpected\":true,\"repository\":", 1)
                .into_bytes(),
        ];
        variants.push(vec![0xff]);

        for raw_provenance in variants {
            let mut invalid = input(&contract);
            invalid.raw_provenance = &raw_provenance;
            assert!(
                verifier.verify(invalid).is_err(),
                "非 canonical/旧 schema payload 必须 fail closed"
            );
        }
    }

    #[test]
    fn source_fields_and_signatures_fail_closed() {
        let contract = contract();
        let verifier = ProvenanceVerifier::from_tauri_pubkey(&contract.encoded_public_key)
            .expect("fixture 公钥应有效");

        for mutate in [
            |value: &mut ProvenanceVerificationInput<'_>| value.expected_repository = "other/repo",
            |value: &mut ProvenanceVerificationInput<'_>| value.expected_tag = "v1.2.4",
            |value: &mut ProvenanceVerificationInput<'_>| value.expected_version = "1.2.4",
            |value: &mut ProvenanceVerificationInput<'_>| {
                value.expected_commit_sha = "fedcba9876543210fedcba9876543210fedcba98"
            },
            |value: &mut ProvenanceVerificationInput<'_>| value.expected_target = "windows-aarch64",
        ] {
            let mut invalid = input(&contract);
            mutate(&mut invalid);
            assert!(verifier.verify(invalid).is_err());
        }

        let wrong_key = ProvenanceVerifier::from_tauri_pubkey(WRONG_PUBLIC_KEY)
            .expect("错误但格式有效的公钥应可解析");
        assert!(wrong_key.verify(input(&contract)).is_err());

        let mut bad_signature = input(&contract);
        bad_signature.provenance_signature = &contract.installer_signature;
        assert!(verifier.verify(bad_signature).is_err());

        let mut malformed_signature = input(&contract);
        malformed_signature.provenance_signature = "%%%";
        assert_eq!(
            verifier
                .verify(malformed_signature)
                .expect_err("畸形 provenance 签名必须失败")
                .code(),
            "invalid-provenance-signature"
        );
        let mut malformed_installer_signature = input(&contract);
        malformed_installer_signature.installer_signature = "%%%";
        assert_eq!(
            verifier
                .verify(malformed_installer_signature)
                .expect_err("畸形安装包签名必须失败")
                .code(),
            "invalid-installer-signature"
        );
        assert!(ProvenanceVerifier::from_tauri_pubkey("%%%").is_err());
    }

    #[test]
    fn installer_signature_must_match_the_configured_key_before_candidate_creation() {
        let contract = contract();
        let verifier = ProvenanceVerifier::from_tauri_pubkey(&contract.encoded_public_key)
            .expect("fixture 公钥应有效");
        let wrong_key_id = rewrite_tauri_signature(&contract.installer_signature, |lines| {
            let mut payload = STANDARD
                .decode(&lines[1])
                .expect("fixture Minisign payload 应有效");
            payload[2] ^= 0xff;
            lines[1] = STANDARD.encode(payload);
        });
        let mut invalid = input(&contract);
        invalid.installer_signature = &wrong_key_id;

        assert_eq!(
            verifier
                .verify(invalid)
                .expect_err("错误 key id 的安装包签名不得生成 candidate")
                .code(),
            "invalid-installer-signature"
        );
    }

    #[test]
    fn untrusted_signature_comments_do_not_change_candidate_identity() {
        let contract = contract();
        let verifier = ProvenanceVerifier::from_tauri_pubkey(&contract.encoded_public_key)
            .expect("fixture 公钥应有效");
        let baseline = verifier
            .verify(input(&contract))
            .expect("fixture 应通过验证");
        let installer_signature = rewrite_tauri_signature(&contract.installer_signature, |lines| {
            lines[0] = "untrusted comment: 已被替换但不属于签名身份".into();
        });
        let provenance_signature =
            rewrite_tauri_signature(&contract.provenance_signature, |lines| {
                lines[0] = "untrusted comment: 另一条未签名说明".into();
            });
        let mut rewritten = input(&contract);
        rewritten.installer_signature = &installer_signature;
        rewritten.provenance_signature = &provenance_signature;

        let evidence = verifier
            .verify(rewritten)
            .expect("只改变 untrusted comment 不应破坏有效签名");

        assert_eq!(evidence.candidate_id(), baseline.candidate_id());
        assert_eq!(evidence.candidate_identity(), baseline.candidate_identity());
    }

    #[test]
    fn tauri_signature_rejects_trailing_lines_ignored_by_the_minisign_parser() {
        let contract = contract();
        let verifier = ProvenanceVerifier::from_tauri_pubkey(&contract.encoded_public_key)
            .expect("fixture 公钥应有效");
        let trailing = rewrite_tauri_signature(&contract.installer_signature, |lines| {
            lines.push("未签名尾随内容".into());
        });
        let mut invalid = input(&contract);
        invalid.installer_signature = &trailing;

        assert_eq!(
            verifier
                .verify(invalid)
                .expect_err("带尾随行的安装包签名必须失败")
                .code(),
            "invalid-installer-signature"
        );
    }

    #[test]
    fn fixed_package_and_installer_fields_fail_closed() {
        let contract = contract();
        let verifier = ProvenanceVerifier::from_tauri_pubkey(&contract.encoded_public_key)
            .expect("fixture 公钥应有效");
        let canonical_text = std::str::from_utf8(RAW_PROVENANCE).expect("fixture 应为 UTF-8");
        let variants = [
            canonical_text.replacen("windows-x86_64", "linux-x86_64", 1),
            canonical_text.replacen("\"nsis\"", "\"msi\"", 1),
            canonical_text.replacen("currentUser", "perMachine", 1),
            canonical_text.replacen(
                "MineRadio-Tauri_1.2.3_x64-setup.exe",
                "MineRadio-Tauri_1.2.3_x64.msi",
                1,
            ),
            canonical_text.replacen("\"size\":9", "\"size\":0", 1),
            canonical_text.replacen(
                "9c0d294c05fc1d88d698034609bb81c0c69196327594e4c69d2915c80fd9850c",
                "9C0D294C05FC1D88D698034609BB81C0C69196327594E4C69D2915C80FD9850C",
                1,
            ),
        ];

        for raw_provenance in variants {
            let mut invalid = input(&contract);
            invalid.raw_provenance = raw_provenance.as_bytes();
            assert!(
                verifier.verify(invalid).is_err(),
                "固定 package/installer 字段被替换时必须 fail closed"
            );
        }
    }

    #[test]
    fn installer_measurement_must_match_signed_provenance() {
        let contract = contract();
        let verifier = ProvenanceVerifier::from_tauri_pubkey(&contract.encoded_public_key)
            .expect("fixture 公钥应有效");
        let evidence = verifier
            .verify(input(&contract))
            .expect("fixture 应通过验证");

        assert!(evidence
            .verify_installer_measurement(
                9,
                "9c0d294c05fc1d88d698034609bb81c0c69196327594e4c69d2915c80fd9850c",
            )
            .is_ok());
        assert!(evidence
            .verify_installer_measurement(
                10,
                "9c0d294c05fc1d88d698034609bb81c0c69196327594e4c69d2915c80fd9850c",
            )
            .is_err());
        assert!(evidence
            .verify_installer_measurement(9, &"0".repeat(64))
            .is_err());
    }
}
