//! Steam、Wallpaper Engine 安装与项目根发现。

use super::error::{io_error, WindowsWallpaperError, WindowsWallpaperResult};
use std::{
    collections::HashSet,
    ffi::{c_void, OsStr, OsString},
    fs,
    os::windows::ffi::{OsStrExt, OsStringExt},
    path::{Path, PathBuf},
    ptr::null_mut,
};
use windows_sys::Win32::System::Registry::{
    RegGetValueW, HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ,
    RRF_SUBKEY_WOW6432KEY, RRF_SUBKEY_WOW6464KEY,
};

const WALLPAPER_ENGINE_APP_ID: &str = "431960";

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WallpaperEngineInstallation {
    pub steam_root: PathBuf,
    pub installation_root: PathBuf,
    pub executable: PathBuf,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DiscoveredProjectSourceKind {
    Workshop,
    Local,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DiscoveredProjectSource {
    pub root: PathBuf,
    pub kind: DiscoveredProjectSourceKind,
    pub source_label: String,
}

/// 解析 Valve KeyValues `libraryfolders.vdf` 中的新旧两种 library 表达。
pub fn parse_library_folders_vdf(source: &str) -> WindowsWallpaperResult<Vec<PathBuf>> {
    let tokens = tokenize_key_values(source)?;
    let mut roots = Vec::new();
    let mut index = 0usize;
    while index + 1 < tokens.len() {
        let Token::Text(key) = &tokens[index] else {
            index += 1;
            continue;
        };
        let Token::Text(value) = &tokens[index + 1] else {
            index += 1;
            continue;
        };
        let is_path_property = key.eq_ignore_ascii_case("path");
        let is_legacy_entry = key.bytes().all(|byte| byte.is_ascii_digit());
        if (is_path_property || is_legacy_entry) && looks_like_absolute_windows_path(value) {
            roots.push(PathBuf::from(value));
        }
        index += 2;
    }
    Ok(deduplicate_paths(roots))
}

pub fn discover_steam_library_roots() -> WindowsWallpaperResult<Vec<PathBuf>> {
    let mut candidates = Vec::new();
    for (hive, subkey, value, flags) in [
        (
            HKEY_CURRENT_USER,
            r"Software\Valve\Steam",
            "SteamPath",
            RRF_RT_REG_SZ,
        ),
        (
            HKEY_LOCAL_MACHINE,
            r"SOFTWARE\Valve\Steam",
            "InstallPath",
            RRF_RT_REG_SZ | RRF_SUBKEY_WOW6464KEY,
        ),
        (
            HKEY_LOCAL_MACHINE,
            r"SOFTWARE\Valve\Steam",
            "InstallPath",
            RRF_RT_REG_SZ | RRF_SUBKEY_WOW6432KEY,
        ),
    ] {
        if let Some(value) = read_registry_string(hive, subkey, value, flags) {
            candidates.push(PathBuf::from(value));
        }
    }
    if let Some(program_files_x86) = std::env::var_os("ProgramFiles(x86)") {
        candidates.push(PathBuf::from(program_files_x86).join("Steam"));
    }
    if let Some(program_files) = std::env::var_os("ProgramFiles") {
        candidates.push(PathBuf::from(program_files).join("Steam"));
    }

    let primary_roots = deduplicate_paths(
        candidates
            .into_iter()
            .filter(|path| path.join("steamapps").is_dir())
            .collect(),
    );
    let mut all_roots = primary_roots.clone();
    for root in primary_roots {
        let vdf = root.join("steamapps").join("libraryfolders.vdf");
        let raw = match fs::read_to_string(&vdf) {
            Ok(raw) => raw,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                // 单个 Steam library 不可访问时降级，不能让整个快照失败。
                let _ = io_error("WALLPAPER_ENGINE_VDF_READ_FAILED", "读取 Steam VDF", error);
                continue;
            }
        };
        if let Ok(discovered) = parse_library_folders_vdf(&raw) {
            all_roots.extend(
                discovered
                    .into_iter()
                    .filter(|path| path.join("steamapps").is_dir()),
            );
        }
    }
    Ok(deduplicate_paths(all_roots))
}

pub fn discover_wallpaper_engine_installations(
    steam_roots: &[PathBuf],
) -> Vec<WallpaperEngineInstallation> {
    let executable_names = if cfg!(target_arch = "x86_64") {
        ["wallpaper64.exe", "wallpaper32.exe"]
    } else {
        ["wallpaper32.exe", "wallpaper64.exe"]
    };
    let mut installations = Vec::new();
    for steam_root in steam_roots {
        let installation_root = steam_root
            .join("steamapps")
            .join("common")
            .join("wallpaper_engine");
        for executable_name in executable_names {
            let executable = installation_root.join(executable_name);
            if executable.is_file() {
                installations.push(WallpaperEngineInstallation {
                    steam_root: canonical_or_original(steam_root),
                    installation_root: canonical_or_original(&installation_root),
                    executable: canonical_or_original(&executable),
                });
                break;
            }
        }
    }
    let mut seen = HashSet::new();
    installations.retain(|item| seen.insert(path_key(&item.installation_root)));
    installations
}

pub fn discover_project_sources(steam_roots: &[PathBuf]) -> Vec<DiscoveredProjectSource> {
    let mut sources = Vec::new();
    for steam_root in steam_roots {
        let workshop = steam_root
            .join("steamapps")
            .join("workshop")
            .join("content")
            .join(WALLPAPER_ENGINE_APP_ID);
        if workshop.is_dir() {
            sources.push(DiscoveredProjectSource {
                root: canonical_or_original(&workshop),
                kind: DiscoveredProjectSourceKind::Workshop,
                source_label: "Steam Workshop".into(),
            });
        }
        let local = steam_root
            .join("steamapps")
            .join("common")
            .join("wallpaper_engine")
            .join("projects")
            .join("myprojects");
        if local.is_dir() {
            sources.push(DiscoveredProjectSource {
                root: canonical_or_original(&local),
                kind: DiscoveredProjectSourceKind::Local,
                source_label: "Wallpaper Engine 本地项目".into(),
            });
        }
    }
    let mut seen = HashSet::new();
    sources.retain(|source| seen.insert(path_key(&source.root)));
    sources
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum Token {
    Text(String),
    Open,
    Close,
}

fn tokenize_key_values(source: &str) -> WindowsWallpaperResult<Vec<Token>> {
    let bytes = source.as_bytes();
    let mut output = Vec::new();
    let mut index = 0usize;
    while index < bytes.len() {
        match bytes[index] {
            byte if byte.is_ascii_whitespace() => index += 1,
            b'/' if bytes.get(index + 1) == Some(&b'/') => {
                index += 2;
                while index < bytes.len() && !matches!(bytes[index], b'\r' | b'\n') {
                    index += 1;
                }
            }
            b'{' => {
                output.push(Token::Open);
                index += 1;
            }
            b'}' => {
                output.push(Token::Close);
                index += 1;
            }
            b'"' => {
                index += 1;
                let mut value = String::new();
                let mut closed = false;
                while index < bytes.len() {
                    match bytes[index] {
                        b'"' => {
                            closed = true;
                            index += 1;
                            break;
                        }
                        b'\\' if index + 1 < bytes.len() => {
                            let escaped = bytes[index + 1];
                            match escaped {
                                b'\\' => value.push('\\'),
                                b'"' => value.push('"'),
                                b'n' => value.push('\n'),
                                b'r' => value.push('\r'),
                                b't' => value.push('\t'),
                                _ => {
                                    value.push('\\');
                                    value.push(char::from(escaped));
                                }
                            }
                            index += 2;
                        }
                        byte => {
                            value.push(char::from(byte));
                            index += 1;
                        }
                    }
                }
                if !closed {
                    return Err(WindowsWallpaperError::new(
                        "WALLPAPER_ENGINE_VDF_INVALID",
                        "VDF 字符串未闭合",
                    ));
                }
                output.push(Token::Text(value));
            }
            _ => {
                let start = index;
                while index < bytes.len()
                    && !bytes[index].is_ascii_whitespace()
                    && !matches!(bytes[index], b'{' | b'}')
                {
                    index += 1;
                }
                output.push(Token::Text(
                    String::from_utf8_lossy(&bytes[start..index]).into_owned(),
                ));
            }
        }
    }
    Ok(output)
}

fn read_registry_string(hive: HKEY, subkey: &str, value: &str, flags: u32) -> Option<OsString> {
    let subkey = wide_null(subkey);
    let value = wide_null(value);
    let mut buffer = vec![0u16; 32_768];
    let mut bytes = (buffer.len() * std::mem::size_of::<u16>()) as u32;
    let status = unsafe {
        RegGetValueW(
            hive,
            subkey.as_ptr(),
            value.as_ptr(),
            flags,
            null_mut(),
            buffer.as_mut_ptr().cast::<c_void>(),
            &mut bytes,
        )
    };
    if status != 0 || bytes < 2 {
        return None;
    }
    let units = usize::try_from(bytes).ok()? / std::mem::size_of::<u16>();
    let length = buffer[..units.min(buffer.len())]
        .iter()
        .position(|unit| *unit == 0)
        .unwrap_or(units.min(buffer.len()));
    Some(OsString::from_wide(&buffer[..length]))
}

fn wide_null(value: impl AsRef<OsStr>) -> Vec<u16> {
    value
        .as_ref()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

fn looks_like_absolute_windows_path(value: &str) -> bool {
    let bytes = value.as_bytes();
    (bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'\\' | b'/'))
        || value.starts_with(r"\\")
}

fn deduplicate_paths(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    paths
        .into_iter()
        .map(|path| canonical_or_original(&path))
        .filter(|path| seen.insert(path_key(path)))
        .collect()
}

fn canonical_or_original(path: &Path) -> PathBuf {
    let canonical = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    strip_verbatim_prefix(canonical)
}

fn strip_verbatim_prefix(path: PathBuf) -> PathBuf {
    let units: Vec<u16> = path.as_os_str().encode_wide().collect();
    const VERBATIM: &[u16] = &[b'\\' as u16, b'\\' as u16, b'?' as u16, b'\\' as u16];
    const VERBATIM_UNC: &[u16] = &[
        b'\\' as u16,
        b'\\' as u16,
        b'?' as u16,
        b'\\' as u16,
        b'U' as u16,
        b'N' as u16,
        b'C' as u16,
        b'\\' as u16,
    ];
    if units.starts_with(VERBATIM_UNC) {
        let mut normalized = vec![b'\\' as u16, b'\\' as u16];
        normalized.extend_from_slice(&units[VERBATIM_UNC.len()..]);
        return PathBuf::from(OsString::from_wide(&normalized));
    }
    if units.starts_with(VERBATIM) {
        return PathBuf::from(OsString::from_wide(&units[VERBATIM.len()..]));
    }
    path
}

fn path_key(path: &Path) -> String {
    path.to_string_lossy()
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::parse_library_folders_vdf;

    #[test]
    fn parses_modern_and_legacy_libraryfolders_without_duplicates() {
        let roots = parse_library_folders_vdf(
            r#"
            "libraryfolders"
            {
              "0" "C:\\Program Files (x86)\\Steam"
              "1"
              {
                "path" "D:\\SteamLibrary"
                "apps" { "431960" "123" }
              }
              "2" { "path" "d:\\steamlibrary" }
            }
            "#,
        )
        .expect("有效 VDF 应可解析");

        assert_eq!(roots.len(), 2);
        assert_eq!(roots[0].to_string_lossy(), r"C:\Program Files (x86)\Steam");
        assert_eq!(roots[1].to_string_lossy(), r"D:\SteamLibrary");
    }

    #[test]
    fn rejects_unterminated_vdf_string() {
        let error = parse_library_folders_vdf(r#""libraryfolders" { "path" "D:\broken }"#)
            .expect_err("未闭合字符串必须 fail closed");
        assert_eq!(error.code(), "WALLPAPER_ENGINE_VDF_INVALID");
    }
}
