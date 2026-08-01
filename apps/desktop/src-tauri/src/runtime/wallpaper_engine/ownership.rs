//! Wallpaper Engine session/window/process ownership。

use std::{fmt, path::PathBuf};

use serde::{Deserialize, Serialize};

use super::project::is_valid_project_id;

pub const LOCATION_PREFIX: &str = "Mineradio Wallpaper ";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutableIdentity {
    pub canonical_path: PathBuf,
    pub file_size: u64,
    pub modified_unix_millis: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowIdentity {
    pub handle: u64,
    pub process_id: u32,
    pub process_created_unix_millis: u64,
    pub executable: ExecutableIdentity,
    pub title: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnedProcessIdentity {
    pub process_id: u32,
    pub process_created_unix_millis: u64,
    pub launch_nonce: String,
    pub executable: ExecutableIdentity,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneOwnership {
    pub session_id: String,
    pub location: String,
    pub executable: ExecutableIdentity,
    pub window: Option<WindowIdentity>,
    pub launched_process: Option<OwnedProcessIdentity>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OwnershipError {
    RandomUnavailable,
    SessionInvalid,
    Mismatch,
}

impl OwnershipError {
    pub fn code(self) -> &'static str {
        match self {
            Self::RandomUnavailable => "WALLPAPER_ENGINE_SESSION_RANDOM_UNAVAILABLE",
            Self::SessionInvalid => "WALLPAPER_ENGINE_SESSION_INVALID",
            Self::Mismatch => "WALLPAPER_ENGINE_OWNERSHIP_MISMATCH",
        }
    }
}

impl fmt::Display for OwnershipError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}", self.code())
    }
}

impl std::error::Error for OwnershipError {}

pub fn new_session_id() -> Result<String, OwnershipError> {
    let mut bytes = [0_u8; 12];
    getrandom::fill(&mut bytes).map_err(|_| OwnershipError::RandomUnavailable)?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

pub fn scene_location(session_id: &str) -> Result<String, OwnershipError> {
    if !is_valid_project_id(session_id) {
        return Err(OwnershipError::SessionInvalid);
    }
    Ok(format!("{LOCATION_PREFIX}{session_id}"))
}

pub fn validate_scene_ownership(
    expected: &SceneOwnership,
    observed: &SceneOwnership,
) -> Result<(), OwnershipError> {
    if !is_valid_project_id(&expected.session_id)
        || expected.session_id != observed.session_id
        || expected.location != scene_location(&expected.session_id)?
        || expected.location != observed.location
        || !same_executable(&expected.executable, &observed.executable)
        || expected.launched_process != observed.launched_process
    {
        return Err(OwnershipError::Mismatch);
    }
    let observed_window = observed.window.as_ref().ok_or(OwnershipError::Mismatch)?;
    if observed_window.handle == 0
        || observed_window.process_id == 0
        || observed_window.process_created_unix_millis == 0
        || observed_window.title != expected.location
        || !same_executable(&observed.executable, &observed_window.executable)
    {
        return Err(OwnershipError::Mismatch);
    }
    if let Some(expected_window) = &expected.window {
        if expected_window.handle != observed_window.handle
            || expected_window.process_id != observed_window.process_id
            || expected_window.process_created_unix_millis
                != observed_window.process_created_unix_millis
            || expected_window.title != observed_window.title
            || !same_executable(&expected_window.executable, &observed_window.executable)
        {
            return Err(OwnershipError::Mismatch);
        }
    }
    Ok(())
}

/// 验证同一唯一 location 下的受控 HWND generation 换代。
///
/// 只有 handle/PID/creation-time 可以变化；session、location、可信 executable 与进程
/// ownership 必须保持不变。caller 仍需先把新 identity 写入 recovery journal，才能
/// 对新 HWND 执行 capture 或关闭操作。
pub fn validate_scene_replacement(
    previous: &SceneOwnership,
    replacement: &SceneOwnership,
) -> Result<(), OwnershipError> {
    validate_scene_ownership(previous, previous)?;
    let mut session_anchor = previous.clone();
    session_anchor.window = None;
    validate_scene_ownership(&session_anchor, replacement)
}

pub fn can_terminate_owned_process(
    expected: &OwnedProcessIdentity,
    observed: &OwnedProcessIdentity,
) -> bool {
    expected.process_id > 0
        && expected.process_created_unix_millis > 0
        && !expected.launch_nonce.is_empty()
        && expected.process_id == observed.process_id
        && expected.process_created_unix_millis == observed.process_created_unix_millis
        && expected.launch_nonce == observed.launch_nonce
        && same_executable(&expected.executable, &observed.executable)
}

pub fn same_executable(left: &ExecutableIdentity, right: &ExecutableIdentity) -> bool {
    left.file_size > 0
        && left.file_size == right.file_size
        && left.modified_unix_millis == right.modified_unix_millis
        && path_key(&left.canonical_path) == path_key(&right.canonical_path)
}

fn path_key(path: &std::path::Path) -> String {
    let mut value = path.to_string_lossy().replace('\\', "/");
    while value.ends_with('/') {
        value.pop();
    }
    value.make_ascii_lowercase();
    value
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::{
        can_terminate_owned_process, scene_location, validate_scene_ownership,
        validate_scene_replacement, ExecutableIdentity, OwnedProcessIdentity, SceneOwnership,
        WindowIdentity,
    };

    fn executable() -> ExecutableIdentity {
        ExecutableIdentity {
            canonical_path: PathBuf::from(r"C:\Program Files (x86)\Steam\wallpaper64.exe"),
            file_size: 42,
            modified_unix_millis: 7,
        }
    }

    fn scene() -> SceneOwnership {
        let session_id = "0123456789abcdef01234567".to_owned();
        let executable = executable();
        SceneOwnership {
            session_id: session_id.clone(),
            location: scene_location(&session_id).expect("session 应有效"),
            executable: executable.clone(),
            window: Some(WindowIdentity {
                handle: 100,
                process_id: 20,
                process_created_unix_millis: 500,
                executable,
                title: "Mineradio Wallpaper 0123456789abcdef01234567".to_owned(),
            }),
            launched_process: None,
        }
    }

    #[test]
    fn exact_scene_identity_mismatch_fails_closed() {
        let expected = scene();
        let mut observed = expected.clone();
        observed
            .window
            .as_mut()
            .expect("应有窗口")
            .process_created_unix_millis += 1;

        let error = validate_scene_ownership(&expected, &observed)
            .expect_err("PID generation mismatch 不得被接受");
        assert_eq!(error.code(), "WALLPAPER_ENGINE_OWNERSHIP_MISMATCH");
    }

    #[test]
    fn exact_location_can_adopt_only_a_verified_new_window_generation() {
        let previous = scene();
        let mut replacement = previous.clone();
        let window = replacement
            .window
            .as_mut()
            .expect("应有 replacement window");
        window.handle += 1;
        window.process_id += 1;
        window.process_created_unix_millis += 1;
        assert!(validate_scene_replacement(&previous, &replacement).is_ok());

        replacement.window.as_mut().expect("应有 window").title = "别的 location".to_owned();
        assert_eq!(
            validate_scene_replacement(&previous, &replacement)
                .expect_err("不同 title 不得被接管")
                .code(),
            "WALLPAPER_ENGINE_OWNERSHIP_MISMATCH"
        );
    }

    #[test]
    fn process_termination_requires_pid_creation_nonce_and_executable_match() {
        let expected = OwnedProcessIdentity {
            process_id: 77,
            process_created_unix_millis: 800,
            launch_nonce: "nonce-a".to_owned(),
            executable: executable(),
        };
        assert!(can_terminate_owned_process(&expected, &expected));

        let mut reused_pid = expected.clone();
        reused_pid.process_created_unix_millis += 1;
        assert!(!can_terminate_owned_process(&expected, &reused_pid));
        let mut wrong_nonce = expected.clone();
        wrong_nonce.launch_nonce = "nonce-b".to_owned();
        assert!(!can_terminate_owned_process(&expected, &wrong_nonce));
        let mut wrong_executable = expected.clone();
        wrong_executable.executable.file_size += 1;
        assert!(!can_terminate_owned_process(&expected, &wrong_executable));
    }
}
