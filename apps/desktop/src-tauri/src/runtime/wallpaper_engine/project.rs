//! Wallpaper Engine 项目清单解析与安全分类。

use std::{
    collections::BTreeMap,
    fmt, fs,
    path::{Component, Path, PathBuf},
    time::UNIX_EPOCH,
};

use serde::{Deserialize, Serialize};

pub const MAX_PROJECT_JSON_BYTES: u64 = 1024 * 1024;

const IMAGE_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png", "webp", "gif"];
const VIDEO_EXTENSIONS: &[&str] = &["mp4", "webm", "m4v", "mov"];
const PREVIEW_EXTENSIONS: &[&str] = &[
    "jpg", "jpeg", "png", "webp", "gif", "mp4", "webm", "m4v", "mov",
];
const SCENE_EXTENSIONS: &[&str] = &["pkg", "pak"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WallpaperMediaType {
    Image,
    Video,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WallpaperSafetyMode {
    DirectMedia,
    NativeEngine,
    PreviewOnly,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProjectSourceKind {
    Workshop,
    Local,
    Imported,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectSource {
    pub root: PathBuf,
    pub kind: ProjectSourceKind,
    pub label: String,
    pub direct: bool,
}

impl ProjectSource {
    pub fn new(
        root: impl Into<PathBuf>,
        kind: ProjectSourceKind,
        label: impl Into<String>,
        direct: bool,
    ) -> Self {
        Self {
            root: root.into(),
            kind,
            label: label.into(),
            direct,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ScenePropertyValue {
    Boolean(bool),
    Number(f64),
    Text(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WallpaperProjectSummary {
    pub id: String,
    pub title: String,
    pub project_type: String,
    pub media_type: Option<WallpaperMediaType>,
    pub playable: bool,
    pub engine_playable: bool,
    pub preview_only: bool,
    pub safety_mode: WallpaperSafetyMode,
    pub source: ProjectSourceKind,
    pub source_label: String,
    pub workshop_id: Option<String>,
    pub has_preview: bool,
    pub preview_animated: bool,
    pub preview_media_type: Option<WallpaperMediaType>,
    pub media_animated: bool,
    pub updated_at: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct WallpaperProjectRecord {
    pub project_root: PathBuf,
    pub project_file: PathBuf,
    pub media: Option<PathBuf>,
    pub preview: Option<PathBuf>,
    pub scene_package: Option<PathBuf>,
    pub mute_properties: BTreeMap<String, ScenePropertyValue>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ClassifiedProject {
    pub summary: WallpaperProjectSummary,
    pub record: WallpaperProjectRecord,
}

#[derive(Debug, Clone, PartialEq)]
pub struct NativeSceneTarget {
    pub id: String,
    pub project_file: PathBuf,
    pub scene_package: PathBuf,
    pub mute_properties: BTreeMap<String, ScenePropertyValue>,
}

#[derive(Debug)]
pub enum ProjectError {
    Io(std::io::Error),
    ManifestTooLarge,
    ManifestInvalid,
    ProjectRootInvalid,
    ScenePackageInvalid,
    SceneManifestInvalid,
    ProjectIdentityMismatch,
}

impl ProjectError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Io(_) => "WALLPAPER_PROJECT_IO_FAILED",
            Self::ManifestTooLarge => "WALLPAPER_PROJECT_MANIFEST_TOO_LARGE",
            Self::ManifestInvalid => "WALLPAPER_PROJECT_MANIFEST_INVALID",
            Self::ProjectRootInvalid => "WALLPAPER_PROJECT_ROOT_INVALID",
            Self::ScenePackageInvalid => "WALLPAPER_SCENE_PACKAGE_INVALID",
            Self::SceneManifestInvalid => "WALLPAPER_SCENE_MANIFEST_INVALID",
            Self::ProjectIdentityMismatch => "WALLPAPER_PROJECT_IDENTITY_MISMATCH",
        }
    }
}

impl fmt::Display for ProjectError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}", self.code())
    }
}

impl std::error::Error for ProjectError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(source) => Some(source),
            _ => None,
        }
    }
}

impl From<std::io::Error> for ProjectError {
    fn from(source: std::io::Error) -> Self {
        Self::Io(source)
    }
}

#[derive(Debug, Deserialize)]
struct ProjectManifest {
    #[serde(default)]
    title: String,
    #[serde(rename = "type", default)]
    project_type: String,
    #[serde(default)]
    file: String,
    #[serde(default)]
    preview: String,
    #[serde(default)]
    cover: String,
    #[serde(default)]
    poster: String,
    #[serde(
        default,
        alias = "workshopId",
        alias = "publishedfileid",
        alias = "publishedFileId"
    )]
    workshopid: serde_json::Value,
    #[serde(default, alias = "workshopUrl")]
    workshopurl: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    general: serde_json::Value,
}

pub fn classify_project(
    project_root: &Path,
    source: &ProjectSource,
    scene_package_override: Option<&Path>,
) -> Result<Option<ClassifiedProject>, ProjectError> {
    let canonical_root =
        fs::canonicalize(project_root).map_err(|_| ProjectError::ProjectRootInvalid)?;
    if !canonical_root.is_dir() {
        return Err(ProjectError::ProjectRootInvalid);
    }
    let project_file = canonical_root.join("project.json");
    let (manifest, updated_at) = read_manifest(&project_file)?;
    let project_type = normalize_project_type(&manifest.project_type);
    let direct_extension = extension(&manifest.file);
    let inferred_media_type = media_type_for_extension(&direct_extension);
    let direct_media_allowed = matches!(project_type.as_str(), "image" | "video")
        || (project_type.is_empty() && inferred_media_type.is_some());
    let media = if direct_media_allowed {
        resolve_project_file(
            &canonical_root,
            &manifest.file,
            &[IMAGE_EXTENSIONS, VIDEO_EXTENSIONS].concat(),
        )?
    } else {
        None
    };

    let scene_package = if project_type == "scene" {
        let override_relative = scene_package_override
            .and_then(|value| value.strip_prefix(&canonical_root).ok())
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or_default();
        let mut candidates = vec![override_relative];
        if SCENE_EXTENSIONS.contains(&direct_extension.as_str()) {
            candidates.push(manifest.file.clone());
        }
        candidates.extend(["scene.pkg".to_owned(), "scene.pak".to_owned()]);
        first_project_file(&canonical_root, &candidates, SCENE_EXTENSIONS)?
            .filter(|candidate| validate_pkgv_header(candidate).unwrap_or(false))
    } else {
        None
    };

    let preview_candidates = [
        manifest.preview.as_str(),
        manifest.cover.as_str(),
        manifest.poster.as_str(),
        "preview.jpg",
        "preview.jpeg",
        "preview.png",
        "preview.webp",
        "preview.gif",
        "cover.jpg",
        "cover.png",
        "cover.webp",
        "cover.gif",
        "preview.mp4",
        "preview.webm",
        "preview.m4v",
        "preview.mov",
    ];
    let preview = first_project_file(&canonical_root, &preview_candidates, PREVIEW_EXTENSIONS)?;
    if media.is_none() && preview.is_none() && scene_package.is_none() {
        return Ok(None);
    }

    let media_type = media.as_ref().and_then(|candidate| {
        media_type_for_extension(&extension(candidate.to_string_lossy().as_ref()))
    });
    let engine_playable = scene_package.is_some();
    let playable = media.is_some();
    let preview_only = !playable && !engine_playable;
    let project_type = if project_type.is_empty() {
        media_type
            .map(|kind| match kind {
                WallpaperMediaType::Image => "image",
                WallpaperMediaType::Video => "video",
            })
            .unwrap_or("unknown")
            .to_owned()
    } else {
        project_type
    };
    let mute_properties = if project_type == "scene" {
        analyze_mute_properties(&manifest.general)
    } else {
        BTreeMap::new()
    };
    let workshop_id = derive_workshop_id(&manifest, &canonical_root, source.kind);
    let id = stable_project_id(&canonical_root)?;
    let media_animated = media
        .as_ref()
        .is_some_and(|candidate| extension(candidate.to_string_lossy().as_ref()) == "gif");
    let preview_media_type = preview.as_ref().and_then(|candidate| {
        media_type_for_extension(&extension(candidate.to_string_lossy().as_ref()))
    });
    let preview_animated = preview.as_ref().is_some_and(|candidate| {
        extension(candidate.to_string_lossy().as_ref()) == "gif"
            || preview_media_type == Some(WallpaperMediaType::Video)
    });
    let title = sanitize_text(
        &manifest.title,
        canonical_root
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("Wallpaper Engine"),
        160,
    );
    let safety_mode = if playable {
        WallpaperSafetyMode::DirectMedia
    } else if engine_playable {
        WallpaperSafetyMode::NativeEngine
    } else {
        WallpaperSafetyMode::PreviewOnly
    };

    Ok(Some(ClassifiedProject {
        summary: WallpaperProjectSummary {
            id,
            title,
            project_type,
            media_type,
            playable,
            engine_playable,
            preview_only,
            safety_mode,
            source: source.kind,
            source_label: sanitize_text(&source.label, "本地项目", 80),
            workshop_id,
            has_preview: preview.is_some(),
            preview_animated,
            preview_media_type,
            media_animated,
            updated_at,
        },
        record: WallpaperProjectRecord {
            project_root: canonical_root,
            project_file,
            media,
            preview,
            scene_package,
            mute_properties,
        },
    }))
}

pub fn revalidate_native_scene(
    expected_id: &str,
    record: &WallpaperProjectRecord,
) -> Result<NativeSceneTarget, ProjectError> {
    if stable_project_id(&record.project_root)? != expected_id {
        return Err(ProjectError::ProjectIdentityMismatch);
    }
    let (manifest, _) = read_manifest(&record.project_file)?;
    if normalize_project_type(&manifest.project_type) != "scene" {
        return Err(ProjectError::SceneManifestInvalid);
    }
    let package = record
        .scene_package
        .as_ref()
        .ok_or(ProjectError::ScenePackageInvalid)?;
    let relative = package
        .strip_prefix(&record.project_root)
        .map_err(|_| ProjectError::ScenePackageInvalid)?;
    let validated = resolve_project_file(
        &record.project_root,
        &relative.to_string_lossy(),
        SCENE_EXTENSIONS,
    )?
    .ok_or(ProjectError::ScenePackageInvalid)?;
    if !validate_pkgv_header(&validated)? {
        return Err(ProjectError::ScenePackageInvalid);
    }
    Ok(NativeSceneTarget {
        id: expected_id.to_owned(),
        project_file: record.project_file.clone(),
        scene_package: validated,
        mute_properties: analyze_mute_properties(&manifest.general),
    })
}

pub fn validate_pkgv_header(path: &Path) -> Result<bool, ProjectError> {
    use std::io::Read;

    if !SCENE_EXTENSIONS.contains(&extension(path.to_string_lossy().as_ref()).as_str()) {
        return Ok(false);
    }
    let mut file = fs::File::open(path)?;
    let mut header = [0_u8; 8];
    if file.read_exact(&mut header).is_err() {
        return Ok(false);
    }
    Ok(&header[..4] == b"PKGV" && header[4..].iter().all(u8::is_ascii_digit))
}

pub fn stable_project_id(project_root: &Path) -> Result<String, ProjectError> {
    let canonical = fs::canonicalize(project_root).map_err(|_| ProjectError::ProjectRootInvalid)?;
    let mut key = canonical.to_string_lossy().replace('\\', "/");
    while key.ends_with('/') {
        key.pop();
    }
    key.make_ascii_lowercase();
    let digest = sha256(key.as_bytes());
    Ok(digest[..12]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

pub fn is_valid_project_id(value: &str) -> bool {
    value.len() == 24 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn read_manifest(path: &Path) -> Result<(ProjectManifest, u64), ProjectError> {
    let metadata = fs::metadata(path).map_err(|_| ProjectError::ManifestInvalid)?;
    if !metadata.is_file() || metadata.len() == 0 {
        return Err(ProjectError::ManifestInvalid);
    }
    if metadata.len() > MAX_PROJECT_JSON_BYTES {
        return Err(ProjectError::ManifestTooLarge);
    }
    let canonical_root = fs::canonicalize(path.parent().ok_or(ProjectError::ManifestInvalid)?)
        .map_err(|_| ProjectError::ManifestInvalid)?;
    let canonical_file = fs::canonicalize(path).map_err(|_| ProjectError::ManifestInvalid)?;
    if !canonical_file.starts_with(&canonical_root) {
        return Err(ProjectError::ManifestInvalid);
    }
    let bytes = fs::read(&canonical_file)?;
    let bytes = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(&bytes);
    let manifest = serde_json::from_slice::<ProjectManifest>(bytes)
        .map_err(|_| ProjectError::ManifestInvalid)?;
    let updated_at = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| u64::try_from(value.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0);
    Ok((manifest, updated_at))
}

fn resolve_project_file(
    root: &Path,
    value: &str,
    allowed_extensions: &[&str],
) -> Result<Option<PathBuf>, ProjectError> {
    let Some(relative) = normalize_relative_path(value) else {
        return Ok(None);
    };
    if !allowed_extensions.contains(&extension(relative.to_string_lossy().as_ref()).as_str()) {
        return Ok(None);
    }
    let canonical_root = fs::canonicalize(root).map_err(|_| ProjectError::ProjectRootInvalid)?;
    let target = canonical_root.join(relative);
    let canonical_target = match fs::canonicalize(&target) {
        Ok(value) => value,
        Err(_) => return Ok(None),
    };
    if !canonical_target.starts_with(&canonical_root) {
        return Ok(None);
    }
    let metadata = match fs::metadata(&canonical_target) {
        Ok(value) => value,
        Err(_) => return Ok(None),
    };
    Ok((metadata.is_file() && metadata.len() > 0).then_some(canonical_target))
}

fn first_project_file<T: AsRef<str>>(
    root: &Path,
    candidates: &[T],
    allowed_extensions: &[&str],
) -> Result<Option<PathBuf>, ProjectError> {
    for candidate in candidates {
        if let Some(path) = resolve_project_file(root, candidate.as_ref(), allowed_extensions)? {
            return Ok(Some(path));
        }
    }
    Ok(None)
}

fn normalize_relative_path(value: &str) -> Option<PathBuf> {
    let value = value.trim().replace('/', std::path::MAIN_SEPARATOR_STR);
    if value.is_empty() || value.contains('\0') || value.contains(':') {
        return None;
    }
    let path = Path::new(&value);
    if path.is_absolute() {
        return None;
    }
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(value) => normalized.push(value),
            Component::CurDir => {}
            Component::ParentDir => {
                if !normalized.pop() {
                    return None;
                }
            }
            Component::Prefix(_) | Component::RootDir => return None,
        }
    }
    (!normalized.as_os_str().is_empty()).then_some(normalized)
}

fn extension(value: &str) -> String {
    Path::new(value)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
}

fn media_type_for_extension(extension: &str) -> Option<WallpaperMediaType> {
    if IMAGE_EXTENSIONS.contains(&extension) {
        Some(WallpaperMediaType::Image)
    } else if VIDEO_EXTENSIONS.contains(&extension) {
        Some(WallpaperMediaType::Video)
    } else {
        None
    }
}

fn normalize_project_type(value: &str) -> String {
    value
        .trim()
        .to_ascii_lowercase()
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-'))
        .take(32)
        .collect()
}

fn sanitize_text(value: &str, fallback: &str, maximum: usize) -> String {
    let cleaned = value
        .chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let source = if cleaned.is_empty() {
        fallback
    } else {
        &cleaned
    };
    source.chars().take(maximum).collect()
}

fn derive_workshop_id(
    manifest: &ProjectManifest,
    root: &Path,
    source_kind: ProjectSourceKind,
) -> Option<String> {
    let direct = match &manifest.workshopid {
        serde_json::Value::String(value) => value.clone(),
        serde_json::Value::Number(value) => value.to_string(),
        _ => String::new(),
    };
    if valid_workshop_id(&direct) {
        return Some(direct);
    }
    for value in [&manifest.workshopurl, &manifest.url] {
        if let Some(id) = workshop_id_from_url(value) {
            return Some(id);
        }
    }
    let directory = root
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    (source_kind == ProjectSourceKind::Workshop && valid_workshop_id(directory))
        .then(|| directory.to_owned())
}

fn valid_workshop_id(value: &str) -> bool {
    (5..=32).contains(&value.len()) && value.bytes().all(|byte| byte.is_ascii_digit())
}

fn workshop_id_from_url(value: &str) -> Option<String> {
    for marker in ["?id=", "&id=", "/filedetails/"] {
        if let Some(index) = value.to_ascii_lowercase().find(marker) {
            let digits = value[index + marker.len()..]
                .chars()
                .take_while(char::is_ascii_digit)
                .collect::<String>();
            if valid_workshop_id(&digits) {
                return Some(digits);
            }
        }
    }
    None
}

fn analyze_mute_properties(value: &serde_json::Value) -> BTreeMap<String, ScenePropertyValue> {
    let mut output = BTreeMap::from([("volume".to_owned(), ScenePropertyValue::Number(0.0))]);
    let Some(properties) = value
        .get("properties")
        .and_then(serde_json::Value::as_object)
    else {
        return output;
    };
    for (key, property) in properties.iter().take(256) {
        if key.is_empty()
            || key.len() > 128
            || !key
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-'))
            || matches!(
                key.to_ascii_lowercase().as_str(),
                "__proto__" | "prototype" | "constructor"
            )
        {
            continue;
        }
        let normalized = key.replace(['_', '.', '-'], "").to_ascii_lowercase();
        let label = property
            .get("text")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_ascii_lowercase();
        let audio_related = normalized.contains("volume")
            || normalized.contains("mute")
            || normalized.starts_with("audio")
            || normalized.starts_with("music")
            || normalized.starts_with("sound")
            || normalized.starts_with("bgm")
            || ["音量", "静音", "音乐", "声音", "音频"]
                .iter()
                .any(|hint| label.contains(hint));
        if !audio_related {
            continue;
        }
        let property_type = property
            .get("type")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_ascii_lowercase();
        let mute_value = if property_type == "bool"
            || property
                .get("value")
                .is_some_and(serde_json::Value::is_boolean)
        {
            Some(ScenePropertyValue::Boolean(normalized.contains("mute")))
        } else if property_type == "slider"
            || property
                .get("value")
                .is_some_and(serde_json::Value::is_number)
        {
            let minimum = property.get("min").and_then(serde_json::Value::as_f64);
            let decibel =
                normalized.contains("dbvolume") || label.contains("db") || label.contains("分贝");
            Some(ScenePropertyValue::Number(if decibel {
                minimum.unwrap_or(-60.0)
            } else {
                0.0
            }))
        } else {
            None
        };
        if let Some(mute_value) = mute_value {
            output.insert(key.clone(), mute_value);
        }
    }
    output
}

// 项目 ID 需要稳定 SHA-256，但不应为了这一个非密钥用途扩大依赖面。
fn sha256(input: &[u8]) -> [u8; 32] {
    const INITIAL: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];

    let bit_len = (input.len() as u64).wrapping_mul(8);
    let mut padded = input.to_vec();
    padded.push(0x80);
    while padded.len() % 64 != 56 {
        padded.push(0);
    }
    padded.extend_from_slice(&bit_len.to_be_bytes());
    let mut state = INITIAL;
    for chunk in padded.chunks_exact(64) {
        let mut words = [0_u32; 64];
        for (index, bytes) in chunk.chunks_exact(4).enumerate() {
            words[index] = u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
        }
        for index in 16..64 {
            let s0 = words[index - 15].rotate_right(7)
                ^ words[index - 15].rotate_right(18)
                ^ (words[index - 15] >> 3);
            let s1 = words[index - 2].rotate_right(17)
                ^ words[index - 2].rotate_right(19)
                ^ (words[index - 2] >> 10);
            words[index] = words[index - 16]
                .wrapping_add(s0)
                .wrapping_add(words[index - 7])
                .wrapping_add(s1);
        }
        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut h] = state;
        for index in 0..64 {
            let sigma1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let choice = (e & f) ^ ((!e) & g);
            let temp1 = h
                .wrapping_add(sigma1)
                .wrapping_add(choice)
                .wrapping_add(K[index])
                .wrapping_add(words[index]);
            let sigma0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let majority = (a & b) ^ (a & c) ^ (b & c);
            let temp2 = sigma0.wrapping_add(majority);
            h = g;
            g = f;
            f = e;
            e = d.wrapping_add(temp1);
            d = c;
            c = b;
            b = a;
            a = temp1.wrapping_add(temp2);
        }
        state[0] = state[0].wrapping_add(a);
        state[1] = state[1].wrapping_add(b);
        state[2] = state[2].wrapping_add(c);
        state[3] = state[3].wrapping_add(d);
        state[4] = state[4].wrapping_add(e);
        state[5] = state[5].wrapping_add(f);
        state[6] = state[6].wrapping_add(g);
        state[7] = state[7].wrapping_add(h);
    }
    let mut output = [0_u8; 32];
    for (index, word) in state.into_iter().enumerate() {
        output[index * 4..index * 4 + 4].copy_from_slice(&word.to_be_bytes());
    }
    output
}

#[cfg(test)]
mod tests {
    use std::{fs, path::PathBuf, time::SystemTime};

    use super::{
        classify_project, revalidate_native_scene, ProjectSource, ProjectSourceKind,
        WallpaperMediaType, WallpaperSafetyMode,
    };

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new(label: &str) -> Self {
            let mut path = std::env::temp_dir();
            path.push(format!(
                "mineradio-m7-project-{label}-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(SystemTime::UNIX_EPOCH)
                    .expect("系统时间应有效")
                    .as_nanos()
            ));
            fs::create_dir_all(&path).expect("应创建项目测试目录");
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn image_project_is_classified_as_direct_media_with_stable_24_hex_id() {
        let directory = TestDirectory::new("image");
        fs::write(directory.0.join("wallpaper.jpg"), b"image").expect("应写入图片 fixture");
        fs::write(
            directory.0.join("project.json"),
            r#"{"title":"测试图片","type":"image","file":"wallpaper.jpg"}"#.as_bytes(),
        )
        .expect("应写入 project.json");

        let project = classify_project(
            &directory.0,
            &ProjectSource::new(&directory.0, ProjectSourceKind::Imported, "手动导入", false),
            None,
        )
        .expect("图片项目应可解析")
        .expect("图片项目应进入库");

        assert_eq!(project.summary.media_type, Some(WallpaperMediaType::Image));
        assert!(project.summary.playable);
        assert!(!project.summary.engine_playable);
        assert_eq!(project.summary.id.len(), 24);
        assert!(project
            .summary
            .id
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit()));

        let repeated = classify_project(
            &directory.0,
            &ProjectSource::new(&directory.0, ProjectSourceKind::Imported, "手动导入", false),
            None,
        )
        .expect("重复解析应成功")
        .expect("重复解析应保留项目");
        assert_eq!(repeated.summary.id, project.summary.id);
    }

    #[test]
    fn web_and_application_projects_never_execute_declared_files() {
        for project_type in ["web", "application"] {
            let directory = TestDirectory::new(project_type);
            fs::write(directory.0.join("unsafe.exe"), b"not executable")
                .expect("应写入危险 fixture");
            fs::write(directory.0.join("preview.png"), b"preview").expect("应写入预览 fixture");
            fs::write(
                directory.0.join("project.json"),
                format!(
                    r#"{{"title":"安全预览","type":"{project_type}","file":"unsafe.exe","preview":"preview.png"}}"#
                ),
            )
            .expect("应写入 project.json");

            let project = classify_project(
                &directory.0,
                &ProjectSource::new(&directory.0, ProjectSourceKind::Imported, "手动导入", false),
                None,
            )
            .expect("安全预览项目应可解析")
            .expect("有预览的项目应进入库");

            assert!(!project.summary.playable);
            assert!(!project.summary.engine_playable);
            assert!(project.summary.preview_only);
            assert_eq!(
                project.summary.safety_mode,
                WallpaperSafetyMode::PreviewOnly
            );
            assert!(project.record.media.is_none());
        }
    }

    #[test]
    fn scene_requires_valid_pkgv_header_and_is_revalidated_before_start() {
        let directory = TestDirectory::new("scene");
        let package = directory.0.join("scene.pkg");
        fs::write(&package, b"PKGV0001payload").expect("应写入 PKGV fixture");
        fs::write(
            directory.0.join("project.json"),
            r#"{"title":"Scene","type":"scene","file":"scene.pkg"}"#,
        )
        .expect("应写入 Scene project.json");
        let project = classify_project(
            &directory.0,
            &ProjectSource::new(&directory.0, ProjectSourceKind::Imported, "手动导入", false),
            None,
        )
        .expect("Scene 应可解析")
        .expect("有效 Scene 应进入库");
        assert!(project.summary.engine_playable);

        let target = revalidate_native_scene(&project.summary.id, &project.record)
            .expect("启动前有效 Scene 应通过复验");
        assert_eq!(
            target.scene_package,
            fs::canonicalize(&package).expect("应规范化包路径")
        );

        fs::write(&package, b"not-a-pkgv-package").expect("应损坏 Scene 包");
        let error = revalidate_native_scene(&project.summary.id, &project.record)
            .expect_err("包头变化后启动必须 fail closed");
        assert_eq!(error.code(), "WALLPAPER_SCENE_PACKAGE_INVALID");
    }

    #[test]
    fn scene_video_preview_is_classified_as_registered_video_media() {
        let directory = TestDirectory::new("scene-video-preview");
        let package = directory.0.join("scene.pkg");
        let preview = directory.0.join("preview.webm");
        fs::write(&package, b"PKGV0001payload").expect("应写入 Scene fixture");
        fs::write(&preview, b"webm-preview").expect("应写入视频预览 fixture");
        fs::write(
            directory.0.join("project.json"),
            r#"{"title":"Scene Video Preview","type":"scene","file":"scene.pkg","preview":"preview.webm"}"#,
        )
        .expect("应写入 Scene project.json");

        let project = classify_project(
            &directory.0,
            &ProjectSource::new(&directory.0, ProjectSourceKind::Imported, "手动导入", false),
            None,
        )
        .expect("带视频预览的 Scene 应可解析")
        .expect("带视频预览的 Scene 应进入库");

        assert!(project.summary.has_preview);
        assert!(project.summary.preview_animated);
        assert_eq!(
            project.summary.preview_media_type,
            Some(WallpaperMediaType::Video)
        );
        assert_eq!(
            project.record.preview,
            Some(fs::canonicalize(preview).expect("应规范化视频预览路径"))
        );
    }

    #[test]
    fn lexical_parent_escape_is_rejected() {
        let parent = TestDirectory::new("containment");
        let project_root = parent.0.join("project");
        fs::create_dir_all(&project_root).expect("应创建项目目录");
        fs::write(parent.0.join("outside.mp4"), b"outside").expect("应写入外部文件");
        fs::write(project_root.join("preview.jpg"), b"preview").expect("应写入预览文件");
        fs::write(
            project_root.join("project.json"),
            r#"{"title":"Escape","type":"video","file":"../outside.mp4","preview":"preview.jpg"}"#,
        )
        .expect("应写入越界 manifest");

        let project = classify_project(
            &project_root,
            &ProjectSource::new(
                &project_root,
                ProjectSourceKind::Imported,
                "手动导入",
                false,
            ),
            None,
        )
        .expect("含越界引用的项目应安全降级")
        .expect("预览仍应可进入库");
        assert!(!project.summary.playable);
        assert!(project.summary.preview_only);
        assert!(project.record.media.is_none());
    }

    #[test]
    fn canonical_symlink_escape_is_rejected_when_symlinks_are_available() {
        let parent = TestDirectory::new("symlink-containment");
        let project_root = parent.0.join("project");
        fs::create_dir_all(&project_root).expect("应创建项目目录");
        let outside = parent.0.join("outside.mp4");
        fs::write(&outside, b"outside").expect("应写入外部文件");
        fs::write(project_root.join("preview.jpg"), b"preview").expect("应写入预览");
        let link = project_root.join("linked.mp4");
        #[cfg(windows)]
        if std::os::windows::fs::symlink_file(&outside, &link).is_err() {
            return;
        }
        #[cfg(unix)]
        if std::os::unix::fs::symlink(&outside, &link).is_err() {
            return;
        }
        #[cfg(not(any(windows, unix)))]
        return;
        fs::write(
            project_root.join("project.json"),
            r#"{"title":"Symlink","type":"video","file":"linked.mp4","preview":"preview.jpg"}"#,
        )
        .expect("应写入 manifest");
        let project = classify_project(
            &project_root,
            &ProjectSource::new(
                &project_root,
                ProjectSourceKind::Imported,
                "手动导入",
                false,
            ),
            None,
        )
        .expect("含 symlink escape 的项目应安全降级")
        .expect("预览仍应进入库");
        assert!(!project.summary.playable);
        assert!(project.record.media.is_none());
    }
}
