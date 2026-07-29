//! 官方 Wallpaper Engine 可执行文件的路径与 Authenticode 信任。

use super::error::{io_error, WindowsWallpaperError, WindowsWallpaperResult};
use std::{
    ffi::{c_void, OsStr, OsString},
    fs,
    mem::size_of,
    os::windows::ffi::{OsStrExt, OsStringExt},
    path::{Path, PathBuf},
    ptr::{null, null_mut},
    time::UNIX_EPOCH,
};
use windows_sys::Win32::Security::{
    Cryptography::{
        CertCloseStore, CertFreeCertificateContext, CertGetNameStringW,
        CertGetSubjectCertificateFromStore, CryptMsgClose, CryptMsgGetParam, CryptQueryObject,
        CERT_INFO, CERT_NAME_SIMPLE_DISPLAY_TYPE, CERT_QUERY_CONTENT_FLAG_PKCS7_SIGNED_EMBED,
        CERT_QUERY_FORMAT_FLAG_BINARY, CERT_QUERY_OBJECT_FILE, CMSG_SIGNER_INFO,
        CMSG_SIGNER_INFO_PARAM, PKCS_7_ASN_ENCODING, X509_ASN_ENCODING,
    },
    WinTrust::{
        WinVerifyTrust, WINTRUST_ACTION_GENERIC_VERIFY_V2, WINTRUST_DATA, WINTRUST_DATA_0,
        WINTRUST_FILE_INFO, WTD_CACHE_ONLY_URL_RETRIEVAL, WTD_CHOICE_FILE,
        WTD_REVOCATION_CHECK_NONE, WTD_REVOKE_NONE, WTD_SAFER_FLAG, WTD_STATEACTION_CLOSE,
        WTD_STATEACTION_VERIFY, WTD_UI_NONE,
    },
};

// 当前官方二进制的 signer oracle。证书轮换必须先核验真实官方文件，再把新的
// exact normalized subject 显式加入此集合；不得恢复 substring/fuzzy 匹配。
const OFFICIAL_SIGNER_SUBJECTS: &[&str] = &["skutta software"];

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TrustedExecutable {
    pub canonical_path: PathBuf,
    pub file_size: u64,
    pub modified_unix_millis: u64,
    /// 只用于本地 diagnostics，不应透传到 Web。
    pub signer_subject: String,
}

pub fn validate_executable_location(
    installation_root: &Path,
    executable: &Path,
) -> WindowsWallpaperResult<(PathBuf, PathBuf)> {
    let root = fs::canonicalize(installation_root).map_err(|error| {
        io_error(
            "WALLPAPER_ENGINE_INSTALLATION_INVALID",
            "规范化 Wallpaper Engine 安装目录",
            error,
        )
    })?;
    let target = fs::canonicalize(executable).map_err(|error| {
        io_error(
            "WALLPAPER_ENGINE_EXECUTABLE_INVALID",
            "规范化 Wallpaper Engine 可执行文件",
            error,
        )
    })?;
    let name = target
        .file_name()
        .and_then(OsStr::to_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    if name != "wallpaper32.exe" && name != "wallpaper64.exe" {
        return Err(WindowsWallpaperError::new(
            "WALLPAPER_ENGINE_EXECUTABLE_INVALID",
            "可执行文件名不在官方白名单",
        ));
    }
    let parent = target.parent().ok_or_else(|| {
        WindowsWallpaperError::new(
            "WALLPAPER_ENGINE_EXECUTABLE_INVALID",
            "可执行文件没有父目录",
        )
    })?;
    if path_key(parent) != path_key(&root) {
        return Err(WindowsWallpaperError::new(
            "WALLPAPER_ENGINE_PROCESS_PATH_MISMATCH",
            "可执行文件不在选定安装目录根部",
        ));
    }
    Ok((root, target))
}

pub fn verify_official_executable(
    installation_root: &Path,
    executable: &Path,
) -> WindowsWallpaperResult<TrustedExecutable> {
    let (_root, target) = validate_executable_location(installation_root, executable)?;
    verify_authenticode_chain(&target)?;
    let signer_subject = authenticode_signer_subject(&target)?;
    if !is_official_signer_subject(&signer_subject) {
        return Err(WindowsWallpaperError::new(
            "WALLPAPER_ENGINE_SIGNATURE_INVALID",
            format!("签名发布者不匹配：{signer_subject}"),
        ));
    }
    let metadata = fs::metadata(&target).map_err(|error| {
        io_error(
            "WALLPAPER_ENGINE_EXECUTABLE_INVALID",
            "读取 Wallpaper Engine 可执行文件元数据",
            error,
        )
    })?;
    let modified_unix_millis = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0);
    Ok(TrustedExecutable {
        canonical_path: target,
        file_size: metadata.len(),
        modified_unix_millis,
        signer_subject,
    })
}

fn is_official_signer_subject(subject: &str) -> bool {
    let normalized = subject
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    OFFICIAL_SIGNER_SUBJECTS
        .iter()
        .any(|allowed| normalized == *allowed)
}

fn verify_authenticode_chain(path: &Path) -> WindowsWallpaperResult<()> {
    let path_wide = wide_null(path.as_os_str());
    let mut file = WINTRUST_FILE_INFO {
        cbStruct: size_of::<WINTRUST_FILE_INFO>() as u32,
        pcwszFilePath: path_wide.as_ptr(),
        ..Default::default()
    };
    let mut data = WINTRUST_DATA {
        cbStruct: size_of::<WINTRUST_DATA>() as u32,
        dwUIChoice: WTD_UI_NONE,
        fdwRevocationChecks: WTD_REVOKE_NONE,
        dwUnionChoice: WTD_CHOICE_FILE,
        Anonymous: WINTRUST_DATA_0 { pFile: &mut file },
        dwStateAction: WTD_STATEACTION_VERIFY,
        dwProvFlags: WTD_REVOCATION_CHECK_NONE | WTD_CACHE_ONLY_URL_RETRIEVAL | WTD_SAFER_FLAG,
        ..Default::default()
    };
    let mut action = WINTRUST_ACTION_GENERIC_VERIFY_V2;
    let status = unsafe {
        WinVerifyTrust(
            null_mut(),
            &mut action,
            (&mut data as *mut WINTRUST_DATA).cast::<c_void>(),
        )
    };
    data.dwStateAction = WTD_STATEACTION_CLOSE;
    unsafe {
        WinVerifyTrust(
            null_mut(),
            &mut action,
            (&mut data as *mut WINTRUST_DATA).cast::<c_void>(),
        );
    }
    if status == 0 {
        Ok(())
    } else {
        Err(WindowsWallpaperError::new(
            "WALLPAPER_ENGINE_SIGNATURE_INVALID",
            format!("WinVerifyTrust 返回 0x{:08X}", status as u32),
        ))
    }
}

fn authenticode_signer_subject(path: &Path) -> WindowsWallpaperResult<String> {
    let path_wide = wide_null(path.as_os_str());
    let mut encoding = 0u32;
    let mut content = 0u32;
    let mut format = 0u32;
    let mut store = null_mut();
    let mut message = null_mut();
    let queried = unsafe {
        CryptQueryObject(
            CERT_QUERY_OBJECT_FILE,
            path_wide.as_ptr().cast::<c_void>(),
            CERT_QUERY_CONTENT_FLAG_PKCS7_SIGNED_EMBED,
            CERT_QUERY_FORMAT_FLAG_BINARY,
            0,
            &mut encoding,
            &mut content,
            &mut format,
            &mut store,
            &mut message,
            null_mut(),
        )
    };
    if queried == 0 || store.is_null() || message.is_null() {
        close_crypto_handles(store, message);
        return Err(WindowsWallpaperError::new(
            "WALLPAPER_ENGINE_SIGNATURE_INVALID",
            "无法读取 Authenticode signer",
        ));
    }

    let result = (|| {
        let mut signer_size = 0u32;
        if unsafe {
            CryptMsgGetParam(
                message,
                CMSG_SIGNER_INFO_PARAM,
                0,
                null_mut(),
                &mut signer_size,
            )
        } == 0
            || signer_size < size_of::<CMSG_SIGNER_INFO>() as u32
        {
            return Err(WindowsWallpaperError::new(
                "WALLPAPER_ENGINE_SIGNATURE_INVALID",
                "Signer 信息长度无效",
            ));
        }
        let mut signer_buffer = vec![0u8; signer_size as usize];
        if unsafe {
            CryptMsgGetParam(
                message,
                CMSG_SIGNER_INFO_PARAM,
                0,
                signer_buffer.as_mut_ptr().cast::<c_void>(),
                &mut signer_size,
            )
        } == 0
        {
            return Err(WindowsWallpaperError::new(
                "WALLPAPER_ENGINE_SIGNATURE_INVALID",
                "读取 Signer 信息失败",
            ));
        }
        let signer = unsafe { &*signer_buffer.as_ptr().cast::<CMSG_SIGNER_INFO>() };
        let cert_info = CERT_INFO {
            Issuer: signer.Issuer,
            SerialNumber: signer.SerialNumber,
            ..Default::default()
        };
        let certificate = unsafe {
            CertGetSubjectCertificateFromStore(
                store,
                X509_ASN_ENCODING | PKCS_7_ASN_ENCODING,
                &cert_info,
            )
        };
        if certificate.is_null() {
            return Err(WindowsWallpaperError::new(
                "WALLPAPER_ENGINE_SIGNATURE_INVALID",
                "签名证书不在消息证书库中",
            ));
        }
        let subject = certificate_name(certificate);
        unsafe {
            CertFreeCertificateContext(certificate);
        }
        subject
    })();
    close_crypto_handles(store, message);
    result
}

fn certificate_name(
    certificate: *const windows_sys::Win32::Security::Cryptography::CERT_CONTEXT,
) -> WindowsWallpaperResult<String> {
    let required = unsafe {
        CertGetNameStringW(
            certificate,
            CERT_NAME_SIMPLE_DISPLAY_TYPE,
            0,
            null(),
            null_mut(),
            0,
        )
    };
    if required <= 1 {
        return Err(WindowsWallpaperError::new(
            "WALLPAPER_ENGINE_SIGNATURE_INVALID",
            "签名证书 subject 为空",
        ));
    }
    let mut buffer = vec![0u16; required as usize];
    let written = unsafe {
        CertGetNameStringW(
            certificate,
            CERT_NAME_SIMPLE_DISPLAY_TYPE,
            0,
            null(),
            buffer.as_mut_ptr(),
            required,
        )
    };
    if written <= 1 {
        return Err(WindowsWallpaperError::new(
            "WALLPAPER_ENGINE_SIGNATURE_INVALID",
            "读取签名证书 subject 失败",
        ));
    }
    Ok(OsString::from_wide(&buffer[..written as usize - 1])
        .to_string_lossy()
        .into_owned())
}

fn close_crypto_handles(
    store: windows_sys::Win32::Security::Cryptography::HCERTSTORE,
    message: *mut c_void,
) {
    unsafe {
        if !message.is_null() {
            CryptMsgClose(message);
        }
        if !store.is_null() {
            CertCloseStore(store, 0);
        }
    }
}

fn wide_null(value: impl AsRef<OsStr>) -> Vec<u16> {
    value
        .as_ref()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

fn path_key(path: &Path) -> String {
    path.to_string_lossy()
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_ascii_lowercase()
}

#[cfg(test)]
mod tests {
    use super::{is_official_signer_subject, validate_executable_location};
    use std::{fs, time::SystemTime};

    #[test]
    fn executable_must_be_an_official_name_directly_inside_installation_root() {
        let root = std::env::temp_dir().join(format!(
            "mineradio-m7-trust-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .expect("系统时间有效")
                .as_nanos()
        ));
        fs::create_dir_all(root.join("nested")).expect("创建 fixture");
        fs::write(root.join("wallpaper64.exe"), b"fixture").expect("写入 fixture");
        fs::write(root.join("nested").join("wallpaper64.exe"), b"fixture")
            .expect("写入嵌套 fixture");

        validate_executable_location(&root, &root.join("wallpaper64.exe"))
            .expect("根目录官方文件名应通过路径策略");
        let error =
            validate_executable_location(&root, &root.join("nested").join("wallpaper64.exe"))
                .expect_err("嵌套同名文件必须拒绝");
        assert_eq!(error.code(), "WALLPAPER_ENGINE_PROCESS_PATH_MISMATCH");

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn official_signer_subject_allowlist_is_normalized_but_exact() {
        assert!(is_official_signer_subject("Skutta Software"));
        assert!(is_official_signer_subject("  SKUTTA   SOFTWARE  "));

        for untrusted in [
            "Not Skutta Software",
            "Skutta Software LLC",
            "Skutta Software Test Certificate",
            "Skutta-Software",
            "Skutta Softwar",
        ] {
            assert!(
                !is_official_signer_subject(untrusted),
                "相似或扩展 publisher subject 必须拒绝：{untrusted}"
            );
        }
    }
}
