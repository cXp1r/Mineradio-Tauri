use base64::{engine::general_purpose::STANDARD, Engine as _};
use minisign_verify::{PublicKey, Signature};
use std::path::Path;

fn decode_base64_text(encoded: &str, label: &str) -> Result<String, String> {
    let decoded = STANDARD
        .decode(encoded)
        .map_err(|error| format!("{label} 不是有效的 base64: {error}"))?;
    String::from_utf8(decoded).map_err(|error| format!("{label} 不是有效的 UTF-8: {error}"))
}

fn verify_updater_signature(
    config_json: &str,
    artifact: &[u8],
    encoded_signature: &str,
) -> Result<(), String> {
    let config: serde_json::Value = serde_json::from_str(config_json)
        .map_err(|error| format!("Tauri 配置不是有效 JSON: {error}"))?;
    let encoded_public_key = config
        .pointer("/plugins/updater/pubkey")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "Tauri 配置缺少字符串 plugins.updater.pubkey".to_string())?;

    let public_key_text = decode_base64_text(encoded_public_key, "updater 公钥")?;
    let public_key = PublicKey::decode(&public_key_text)
        .map_err(|error| format!("updater 公钥格式无效: {error}"))?;
    let signature_text = decode_base64_text(encoded_signature, "updater 签名")?;
    let signature = Signature::decode(&signature_text)
        .map_err(|error| format!("updater 签名格式无效: {error}"))?;

    public_key
        .verify(artifact, &signature, true)
        .map_err(|error| format!("updater 签名验证失败: {error}"))
}

fn verify_files(
    config_path: &Path,
    artifact_path: &Path,
    signature_path: &Path,
) -> Result<(), String> {
    fn read_nonempty(path: &Path, label: &str) -> Result<Vec<u8>, String> {
        let content = std::fs::read(path)
            .map_err(|error| format!("读取 {label} {} 失败: {error}", path.display()))?;
        if content.is_empty() {
            return Err(format!("{label} {} 为空", path.display()));
        }
        Ok(content)
    }

    fn decode_utf8(content: Vec<u8>, path: &Path, label: &str) -> Result<String, String> {
        String::from_utf8(content)
            .map_err(|error| format!("{label} {} 不是有效的 UTF-8: {error}", path.display()))
    }

    let config = decode_utf8(
        read_nonempty(config_path, "Tauri 配置")?,
        config_path,
        "Tauri 配置",
    )?;
    let artifact = read_nonempty(artifact_path, "updater 产物")?;
    let signature = decode_utf8(
        read_nonempty(signature_path, "updater 签名")?,
        signature_path,
        "updater 签名",
    )?;

    verify_updater_signature(&config, &artifact, &signature)
}

fn run() -> Result<(), String> {
    let arguments: Vec<_> = std::env::args_os().skip(1).collect();
    if arguments.len() != 3 {
        return Err(
            "用法: verify_updater_signature <tauri.conf.json> <artifact> <signature>".to_string(),
        );
    }

    verify_files(
        Path::new(&arguments[0]),
        Path::new(&arguments[1]),
        Path::new(&arguments[2]),
    )
}

fn main() {
    if let Err(error) = run() {
        eprintln!("updater 签名验证失败: {error}");
        std::process::exit(1);
    }

    println!("updater 签名验证通过");
}

#[cfg(test)]
mod tests {
    use std::time::{SystemTime, UNIX_EPOCH};

    const VALID_PUBLIC_KEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXkKUldRZjZMUkNHQTlpNTNtbFllY080SXpUNTFUR1Bwdld1Y05TQ2gxQ0JNMFFUYUxuNzNZN0dGTzM=";
    const VALID_SIGNATURE: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIG1pbmlzaWduIHNlY3JldCBrZXkKUldRZjZMUkNHQTlpNTlTTE9GeHo2Tnh2QVNYREplUnR1Wnlrd1FlcGJERUd0ODdpZzFCTnBXYVZXdU5ybTczWWlJaUpicTcxV2krZFA5ZUtMOE9DMzUxdndJYXNTU2JYeHdBPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNTU1Nzc5OTY2CWZpbGU6dGVzdApRdEtNWFd5WWN3ZHBaQWxQRjd0RTJFTkprUmQxdWp2S2psajFtOVJ0SFRCblpQYTVXS1U1dVdSczVHb1A1TS9WcUU4MVFGdU1LSTVrL1NmTlFVYU9BQT09";
    const WRONG_PUBLIC_KEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEQxRDBGMTI1MkNERkVEQjkKUldTNTdkOHNKZkhRMFQwVzh4WjBmeStXa1hHb0VlU3VlSEszVEVYbWRKVlRON3dvZlBRdm52R0UK";

    #[test]
    fn accepts_tauri_encoded_valid_signature() {
        let config = format!(r#"{{"plugins":{{"updater":{{"pubkey":"{VALID_PUBLIC_KEY}"}}}}}}"#);

        let result = super::verify_updater_signature(&config, b"test", VALID_SIGNATURE);

        assert!(result.is_ok(), "有效 updater 签名应通过验证: {result:?}");
    }

    #[test]
    fn rejects_modified_artifact() {
        let config = format!(r#"{{"plugins":{{"updater":{{"pubkey":"{VALID_PUBLIC_KEY}"}}}}}}"#);

        let result = super::verify_updater_signature(&config, b"tampered", VALID_SIGNATURE);

        assert!(result.is_err(), "被修改的 updater 产物必须验证失败");
    }

    #[test]
    fn rejects_signature_from_wrong_public_key() {
        let config = format!(r#"{{"plugins":{{"updater":{{"pubkey":"{WRONG_PUBLIC_KEY}"}}}}}}"#);

        let result = super::verify_updater_signature(&config, b"test", VALID_SIGNATURE);

        let error = result.expect_err("错误公钥不能验证 updater 签名");
        assert!(
            error.contains("different key"),
            "应进入有效但不匹配的 Minisign 公钥路径: {error}"
        );
    }

    #[test]
    fn rejects_malformed_updater_config() {
        let malformed_configs = [
            "not-json",
            r#"{"plugins":{"updater":{}}}"#,
            r#"{"plugins":{"updater":{"pubkey":"%%%"}}}"#,
            r#"{"plugins":{"updater":{"pubkey":"bm90IGEgbWluaXNpZ24ga2V5"}}}"#,
        ];

        for config in malformed_configs {
            let result = super::verify_updater_signature(config, b"test", VALID_SIGNATURE);
            assert!(result.is_err(), "畸形 updater 配置必须验证失败: {config}");
        }
    }

    #[test]
    fn rejects_malformed_signature_file() {
        let config = format!(r#"{{"plugins":{{"updater":{{"pubkey":"{VALID_PUBLIC_KEY}"}}}}}}"#);
        let malformed_signatures = ["%%%", "/w==", "bm90IGEgbWluaXNpZ24gc2lnbmF0dXJl"];

        for signature in malformed_signatures {
            let result = super::verify_updater_signature(&config, b"test", signature);
            assert!(
                result.is_err(),
                "畸形 updater 签名必须验证失败: {signature}"
            );
        }
    }

    #[test]
    fn verifies_updater_signature_from_three_paths() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("系统时间应晚于 Unix epoch")
            .as_nanos();
        let prefix = format!("mineradio-updater-verifier-{}-{unique}", std::process::id());
        let temporary_directory = std::env::temp_dir();
        let config_path = temporary_directory.join(format!("{prefix}-tauri.conf.json"));
        let artifact_path = temporary_directory.join(format!("{prefix}-artifact.exe"));
        let signature_path = temporary_directory.join(format!("{prefix}-artifact.exe.sig"));
        let config = format!(r#"{{"plugins":{{"updater":{{"pubkey":"{VALID_PUBLIC_KEY}"}}}}}}"#);

        std::fs::write(&config_path, config).expect("应能写入临时 Tauri 配置");
        std::fs::write(&artifact_path, b"test").expect("应能写入临时 updater 产物");
        std::fs::write(&signature_path, VALID_SIGNATURE).expect("应能写入临时 updater 签名");

        let result = super::verify_files(&config_path, &artifact_path, &signature_path);

        for path in [&config_path, &artifact_path, &signature_path] {
            let _ = std::fs::remove_file(path);
        }
        assert!(result.is_ok(), "CLI 三路径验签应通过: {result:?}");
    }

    #[test]
    fn rejects_any_empty_input_before_signature_verification() {
        let config = format!(r#"{{"plugins":{{"updater":{{"pubkey":"{VALID_PUBLIC_KEY}"}}}}}}"#);

        for empty_input in ["config", "artifact", "signature"] {
            let unique = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("系统时间应晚于 Unix epoch")
                .as_nanos();
            let prefix = format!(
                "mineradio-updater-verifier-{}-{unique}-{empty_input}",
                std::process::id()
            );
            let temporary_directory = std::env::temp_dir();
            let config_path = temporary_directory.join(format!("{prefix}-tauri.conf.json"));
            let artifact_path = temporary_directory.join(format!("{prefix}-artifact.exe"));
            let signature_path = temporary_directory.join(format!("{prefix}-artifact.exe.sig"));

            let config_content = if empty_input == "config" {
                &[][..]
            } else {
                config.as_bytes()
            };
            let artifact_content = if empty_input == "artifact" {
                &[][..]
            } else {
                &b"test"[..]
            };
            let signature_content = if empty_input == "signature" {
                &[][..]
            } else {
                VALID_SIGNATURE.as_bytes()
            };

            std::fs::write(&config_path, config_content).expect("应能写入临时 Tauri 配置");
            std::fs::write(&artifact_path, artifact_content).expect("应能写入临时 updater 产物");
            std::fs::write(&signature_path, signature_content).expect("应能写入临时 updater 签名");

            let result = super::verify_files(&config_path, &artifact_path, &signature_path);

            for path in [&config_path, &artifact_path, &signature_path] {
                let _ = std::fs::remove_file(path);
            }
            let error = result.expect_err("空 CLI 输入必须被拒绝");
            assert!(error.contains("为空"), "应明确报告空 CLI 输入: {error}");
        }
    }
}
