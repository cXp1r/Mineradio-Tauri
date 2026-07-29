//! 官方 Wallpaper Engine control、唯一 Scene location 与 exact HWND 生命周期。

use super::{
    discovery::WallpaperEngineInstallation,
    error::{io_error, WindowsWallpaperError, WindowsWallpaperResult},
    identity::{
        find_exact_window, path_key, verify_window_identity, wallpaper_engine_process_identities,
        PhysicalRect, WindowIdentity,
    },
    trust::{verify_official_executable, TrustedExecutable},
};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    fs,
    io::Read,
    mem::{size_of, zeroed},
    os::windows::process::CommandExt,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    ptr::null_mut,
    thread,
    time::{Duration, Instant},
};
use windows_sys::Win32::{
    Foundation::{CloseHandle, HANDLE},
    Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY},
    System::Threading::{GetCurrentProcess, OpenProcessToken, CREATE_NO_WINDOW},
    UI::WindowsAndMessaging::{IsWindow, PostMessageW, WM_CLOSE},
};

const ENGINE_BOOTSTRAP_TIMEOUT: Duration = Duration::from_secs(20);
const ENGINE_STABLE_WINDOW: Duration = Duration::from_millis(720);
const WINDOW_DISCOVERY_TIMEOUT: Duration = Duration::from_secs(15);
const WINDOW_CLOSE_TIMEOUT: Duration = Duration::from_millis(1_800);
const CONTROL_TIMEOUT: Duration = Duration::from_millis(3_500);
const MAX_GEOMETRY_REOPENS: usize = 3;
const GEOMETRY_TOLERANCE: i32 = 2;
const MUTE_RETRY_DELAYS: &[Duration] = &[
    Duration::ZERO,
    Duration::from_millis(120),
    Duration::from_millis(320),
    Duration::from_millis(700),
    Duration::from_millis(1_300),
    Duration::from_millis(2_200),
];

#[derive(Clone, Debug)]
pub struct WindowsSceneRequest {
    pub generation: u64,
    pub project_id: String,
    pub session_id: String,
    pub location: String,
    pub project_file: PathBuf,
    pub scene_package: PathBuf,
    pub mute_properties: BTreeMap<String, Value>,
    pub physical_bounds: PhysicalRect,
}

#[derive(Clone, Debug)]
pub struct PreparedWindowsScene {
    pub request: WindowsSceneRequest,
    pub executable: TrustedExecutable,
}

#[derive(Clone, Debug)]
pub struct WindowsSceneOwnership {
    pub session_id: String,
    pub location: String,
    pub executable: TrustedExecutable,
    pub window: WindowIdentity,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SceneCloseResult {
    pub location_closed: bool,
    /// 已在有界观察窗口内确认唯一 location 不存在 exact title + executable HWND。
    pub source_absence_confirmed: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct LaunchGeometry {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
}

impl From<PhysicalRect> for LaunchGeometry {
    fn from(value: PhysicalRect) -> Self {
        Self {
            x: value.x,
            y: value.y,
            width: value.width,
            height: value.height,
        }
    }
}

#[derive(Default)]
pub struct SceneController;

impl SceneController {
    pub fn prepare(
        &self,
        request: &WindowsSceneRequest,
        installation: &WallpaperEngineInstallation,
    ) -> WindowsWallpaperResult<PreparedWindowsScene> {
        validate_request(request)?;
        if current_process_is_elevated()? {
            return Err(WindowsWallpaperError::new(
                "WALLPAPER_ENGINE_HOST_ELEVATED",
                "主程序 elevated，拒绝创建无法安全降权的 Scene",
            ));
        }
        validate_scene_package(&request.scene_package)?;
        let executable =
            verify_official_executable(&installation.installation_root, &installation.executable)?;
        ensure_engine_ready(&executable.canonical_path)?;
        Ok(PreparedWindowsScene {
            request: request.clone(),
            executable,
        })
    }

    pub fn open_location(
        &self,
        prepared: &PreparedWindowsScene,
    ) -> WindowsWallpaperResult<WindowsSceneOwnership> {
        validate_scene_package(&prepared.request.scene_package)?;
        let executable = &prepared.executable.canonical_path;
        let expected = prepared.request.physical_bounds;
        let mut launch = LaunchGeometry::from(expected);
        for reopen in 0..=MAX_GEOMETRY_REOPENS {
            spawn_control(executable, &build_open_args(&prepared.request, launch))?;
            let window = wait_for_exact_window(
                &prepared.request.location,
                executable,
                WINDOW_DISCOVERY_TIMEOUT,
            )?;
            if window.rect.aligned_with(expected, GEOMETRY_TOLERANCE) {
                return Ok(WindowsSceneOwnership {
                    session_id: prepared.request.session_id.clone(),
                    location: prepared.request.location.clone(),
                    executable: prepared.executable.clone(),
                    window,
                });
            }
            if reopen == MAX_GEOMETRY_REOPENS {
                return Err(WindowsWallpaperError::new(
                    "WALLPAPER_ENGINE_WINDOW_ISOLATION_FAILED",
                    "Scene HWND 在三次重开后仍未与 host physical rect 对齐",
                ));
            }
            close_exact_window(executable, &prepared.request.location, &window)?;
            launch = corrected_launch_geometry(launch, window.rect, expected)?;
            thread::sleep(Duration::from_millis(180));
        }
        unreachable!("有界 reopen loop 必须返回")
    }

    pub fn apply_location_mute(
        &self,
        prepared: &PreparedWindowsScene,
        ownership: &WindowsSceneOwnership,
    ) -> WindowsWallpaperResult<()> {
        verify_scene_ownership(prepared, ownership)?;
        let started = Instant::now();
        let mut last_error = None;
        for delay in MUTE_RETRY_DELAYS {
            if !delay.is_zero() {
                thread::sleep(*delay);
            }
            match self.reassert_location_mute_once(prepared, ownership) {
                Ok(()) => return Ok(()),
                Err(error) => last_error = Some(error),
            }
            if started.elapsed() >= Duration::from_secs(8) {
                break;
            }
        }
        Err(last_error.unwrap_or_else(|| {
            WindowsWallpaperError::new(
                "WALLPAPER_ENGINE_AUDIO_SUPPRESSION_FAILED",
                "唯一 location 静音未确认",
            )
        }))
    }

    /// 周期 owner 使用的单次有界静音重申。首次 activation 仍调用上面的完整 retry；
    /// 这里每轮只运行一次 3.5 秒上限的 exact-location control。
    pub fn reassert_location_mute_once(
        &self,
        prepared: &PreparedWindowsScene,
        ownership: &WindowsSceneOwnership,
    ) -> WindowsWallpaperResult<()> {
        verify_scene_ownership(prepared, ownership)?;
        verify_window_identity(&ownership.window)?;
        let properties = sanitize_mute_properties(&prepared.request.mute_properties);
        let args = build_mute_args(&ownership.location, &properties)?;
        run_transient_control(&ownership.executable.canonical_path, &args, CONTROL_TIMEOUT)
    }

    pub fn close_location(
        &self,
        ownership: &WindowsSceneOwnership,
    ) -> WindowsWallpaperResult<SceneCloseResult> {
        let Some(verified) =
            find_exact_window(&ownership.location, &ownership.executable.canonical_path)?
        else {
            return Ok(SceneCloseResult {
                location_closed: true,
                source_absence_confirmed: false,
            });
        };
        if !same_window_identity(&verified, &ownership.window) {
            return Err(WindowsWallpaperError::new(
                "WALLPAPER_ENGINE_WINDOW_IDENTITY_MISMATCH",
                "exact location 已由不同 HWND identity 占用",
            ));
        }
        close_exact_window(
            &ownership.executable.canonical_path,
            &ownership.location,
            &verified,
        )?;
        Ok(SceneCloseResult {
            location_closed: true,
            source_absence_confirmed: false,
        })
    }

    pub fn recover_exact_location(
        &self,
        location: &str,
        executable: &TrustedExecutable,
        expected_window: Option<&WindowIdentity>,
    ) -> WindowsWallpaperResult<SceneCloseResult> {
        validate_location(location)?;
        let observed = find_exact_window(location, &executable.canonical_path)?;
        if let Some(expected) = expected_window {
            let Some(observed) = observed else {
                return close_and_confirm_location_absent(location, executable);
            };
            if !same_window_identity(&observed, expected) {
                return Err(WindowsWallpaperError::new(
                    "WALLPAPER_ENGINE_RECOVERY_IDENTITY_UNPROVEN",
                    "journal HWND 与当前窗口身份不一致",
                ));
            }
            close_exact_window(&executable.canonical_path, location, &observed)?;
            return Ok(SceneCloseResult {
                location_closed: true,
                source_absence_confirmed: false,
            });
        }

        close_and_confirm_location_absent(location, executable)
    }
}

/// journal 记录的 HWND 已不存在时，仍需关闭唯一 location 并做有界观察，防止延迟创建
/// 或 Wallpaper Engine 自身换代的 HWND 在即时查询后重新出现。
fn close_and_confirm_location_absent(
    location: &str,
    executable: &TrustedExecutable,
) -> WindowsWallpaperResult<SceneCloseResult> {
    spawn_control(&executable.canonical_path, &build_close_args(location))?;
    let deadline = Instant::now() + WINDOW_CLOSE_TIMEOUT;
    let mut saw_window = false;
    while Instant::now() < deadline {
        match find_exact_window(location, &executable.canonical_path)? {
            Some(window) => {
                saw_window = true;
                let verified = verify_window_identity(&window)?;
                if unsafe { PostMessageW(verified.hwnd(), WM_CLOSE, 0, 0) } == 0 {
                    return Err(WindowsWallpaperError::new(
                        "WALLPAPER_ENGINE_WINDOW_CLOSE_FAILED",
                        "recovery 无法关闭 exact Scene HWND",
                    ));
                }
            }
            None if saw_window => {
                return Ok(SceneCloseResult {
                    location_closed: true,
                    source_absence_confirmed: true,
                });
            }
            None => {}
        }
        thread::sleep(Duration::from_millis(60));
    }
    if find_exact_window(location, &executable.canonical_path)?.is_none() {
        Ok(SceneCloseResult {
            location_closed: true,
            source_absence_confirmed: true,
        })
    } else {
        Err(WindowsWallpaperError::new(
            "WALLPAPER_ENGINE_WINDOW_CLOSE_FAILED",
            "recovery 后 exact Scene HWND 仍存在",
        ))
    }
}

fn validate_location(location: &str) -> WindowsWallpaperResult<()> {
    let Some(session) = location.strip_prefix("Mineradio Wallpaper ") else {
        return Err(WindowsWallpaperError::new(
            "WALLPAPER_ENGINE_SESSION_INVALID",
            "recovery location 前缀无效",
        ));
    };
    if session.len() != 24 || !session.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(WindowsWallpaperError::new(
            "WALLPAPER_ENGINE_SESSION_INVALID",
            "recovery location 不是唯一 24-hex session",
        ));
    }
    Ok(())
}

fn build_open_args(request: &WindowsSceneRequest, launch: LaunchGeometry) -> Vec<String> {
    vec![
        "-control".into(),
        "openWallpaper".into(),
        "-file".into(),
        request.scene_package.to_string_lossy().into_owned(),
        "-playInWindow".into(),
        request.location.clone(),
        "-width".into(),
        launch.width.to_string(),
        "-height".into(),
        launch.height.to_string(),
        "-x".into(),
        launch.x.to_string(),
        "-y".into(),
        launch.y.to_string(),
        "-borderless".into(),
    ]
}

fn build_mute_args(
    location: &str,
    properties: &BTreeMap<String, Value>,
) -> WindowsWallpaperResult<Vec<String>> {
    let encoded = serde_json::to_string(properties).map_err(|error| {
        io_error(
            "WALLPAPER_ENGINE_AUDIO_SUPPRESSION_FAILED",
            "编码 location 静音属性",
            error,
        )
    })?;
    Ok(vec![
        "-control".into(),
        "applyProperties".into(),
        "-properties".into(),
        format!("RAW~({encoded})~END"),
        "-location".into(),
        location.into(),
    ])
}

fn build_close_args(location: &str) -> Vec<String> {
    vec![
        "-control".into(),
        "closeWallpaper".into(),
        "-location".into(),
        location.into(),
    ]
}

fn validate_request(request: &WindowsSceneRequest) -> WindowsWallpaperResult<()> {
    if request.generation == 0 {
        return Err(WindowsWallpaperError::new(
            "WALLPAPER_ENGINE_GENERATION_INVALID",
            "generation 必须为正数",
        ));
    }
    if request.session_id.len() != 24
        || !request
            .session_id
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
        || request.location != format!("Mineradio Wallpaper {}", request.session_id)
    {
        return Err(WindowsWallpaperError::new(
            "WALLPAPER_ENGINE_SESSION_INVALID",
            "session/location 不符合唯一 24-hex 协议",
        ));
    }
    if request.project_id.len() != 24
        || !request
            .project_id
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(WindowsWallpaperError::new(
            "WALLPAPER_SCENE_ID_INVALID",
            "project ID 必须为 24-hex",
        ));
    }
    if !request.project_file.is_absolute() || !request.scene_package.is_absolute() {
        return Err(WindowsWallpaperError::new(
            "WALLPAPER_SCENE_PACKAGE_INVALID",
            "Scene 路径必须为已验证绝对路径",
        ));
    }
    Ok(())
}

fn validate_scene_package(path: &Path) -> WindowsWallpaperResult<()> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if extension != "pkg" && extension != "pak" {
        return Err(WindowsWallpaperError::new(
            "WALLPAPER_SCENE_PACKAGE_INVALID",
            "Scene 包扩展名不在白名单",
        ));
    }
    let canonical = fs::canonicalize(path)
        .map_err(|error| io_error("WALLPAPER_SCENE_PACKAGE_INVALID", "规范化 Scene 包", error))?;
    let mut file = fs::File::open(&canonical)
        .map_err(|error| io_error("WALLPAPER_SCENE_PACKAGE_INVALID", "打开 Scene 包", error))?;
    let mut header = [0u8; 8];
    file.read_exact(&mut header)
        .map_err(|error| io_error("WALLPAPER_SCENE_PACKAGE_INVALID", "读取 Scene 包头", error))?;
    if &header[..4] != b"PKGV" || !header[4..].iter().all(u8::is_ascii_digit) {
        return Err(WindowsWallpaperError::new(
            "WALLPAPER_SCENE_PACKAGE_FORMAT_UNSUPPORTED",
            "Scene 包头不是 PKGVdddd",
        ));
    }
    Ok(())
}

fn sanitize_mute_properties(input: &BTreeMap<String, Value>) -> BTreeMap<String, Value> {
    let mut output = BTreeMap::from([("volume".into(), Value::from(0))]);
    for (key, value) in input.iter().take(32) {
        if key.eq_ignore_ascii_case("volume") || !safe_property_key(key) {
            continue;
        }
        let accepted = match value {
            Value::Bool(_) => true,
            Value::Number(number) => number.as_f64().is_some_and(f64::is_finite),
            Value::String(value) => {
                !value.is_empty()
                    && value.len() <= 64
                    && value
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || b"_.-".contains(&byte))
            }
            _ => false,
        };
        if accepted {
            output.insert(key.clone(), value.clone());
        }
    }
    output
}

fn safe_property_key(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && !matches!(
            value.to_ascii_lowercase().as_str(),
            "__proto__" | "prototype" | "constructor"
        )
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_.-".contains(&byte))
}

fn ensure_engine_ready(executable: &Path) -> WindowsWallpaperResult<()> {
    let deadline = Instant::now() + ENGINE_BOOTSTRAP_TIMEOUT;
    let mut matching = matching_engine_processes(executable)?;
    if matching.is_empty() {
        spawn_engine(executable)?;
    }

    let mut stable_key = Vec::new();
    let mut stable_since = Instant::now();
    loop {
        matching = matching_engine_processes(executable)?;
        let current_key: Vec<(u32, u64)> = matching
            .iter()
            .map(|identity| (identity.process_id, identity.process_created_unix_millis))
            .collect();
        if !current_key.is_empty() {
            if current_key != stable_key {
                stable_key = current_key;
                stable_since = Instant::now();
            } else if stable_since.elapsed() >= ENGINE_STABLE_WINDOW {
                break;
            }
        }
        if Instant::now() >= deadline {
            return Err(WindowsWallpaperError::new(
                "WALLPAPER_ENGINE_BOOTSTRAP_TIMEOUT",
                "官方核心进程未在有界时间内稳定",
            ));
        }
        thread::sleep(Duration::from_millis(120));
    }

    let mut successes = 0usize;
    while Instant::now() < deadline {
        if run_transient_control(
            executable,
            &[
                "-control".into(),
                "getWallpaper".into(),
                "-monitor".into(),
                "0".into(),
            ],
            CONTROL_TIMEOUT,
        )
        .is_ok()
        {
            successes += 1;
            if successes >= 2 {
                return Ok(());
            }
        } else {
            successes = 0;
        }
        thread::sleep(Duration::from_millis(180));
    }
    Err(WindowsWallpaperError::new(
        "WALLPAPER_ENGINE_CONTROL_NOT_READY",
        "官方 control channel 未连续确认 ready",
    ))
}

fn matching_engine_processes(
    expected_executable: &Path,
) -> WindowsWallpaperResult<Vec<super::identity::ProcessIdentity>> {
    let observed = wallpaper_engine_process_identities()?;
    if observed
        .iter()
        .any(|identity| path_key(&identity.executable) != path_key(expected_executable))
    {
        return Err(WindowsWallpaperError::new(
            "WALLPAPER_ENGINE_PROCESS_PATH_MISMATCH",
            "发现同名但不属于选定官方安装的核心进程",
        ));
    }
    Ok(observed)
}

fn spawn_engine(executable: &Path) -> WindowsWallpaperResult<()> {
    let mut command = Command::new(executable);
    configure_command(&mut command);
    command
        .spawn()
        .map(|_| ())
        .map_err(|error| io_error("WALLPAPER_ENGINE_CONTROL_FAILED", "启动官方核心", error))
}

fn spawn_control(executable: &Path, args: &[String]) -> WindowsWallpaperResult<()> {
    let mut command = Command::new(executable);
    command.args(args);
    configure_command(&mut command);
    command.spawn().map(|_| ()).map_err(|error| {
        io_error(
            "WALLPAPER_ENGINE_CONTROL_FAILED",
            "创建 Wallpaper Engine control 调用",
            error,
        )
    })
}

fn run_transient_control(
    executable: &Path,
    args: &[String],
    timeout: Duration,
) -> WindowsWallpaperResult<()> {
    let mut command = Command::new(executable);
    command.args(args);
    configure_command(&mut command);
    let mut child = command.spawn().map_err(|error| {
        io_error(
            "WALLPAPER_ENGINE_CONTROL_FAILED",
            "创建 Wallpaper Engine control 调用",
            error,
        )
    })?;
    wait_transient_child(&mut child, timeout)
}

fn configure_command(command: &mut Command) {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW);
}

fn wait_transient_child(
    child: &mut std::process::Child,
    timeout: Duration,
) -> WindowsWallpaperResult<()> {
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return Ok(()),
            Ok(Some(status)) => {
                return Err(WindowsWallpaperError::new(
                    "WALLPAPER_ENGINE_CONTROL_FAILED",
                    format!("control 退出码 {:?}", status.code()),
                ));
            }
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(20)),
            Ok(None) => {
                // control child 可能已经成为或连接到共享 Wallpaper Engine 核心。
                // 超时只关闭本进程持有的 Child handle，绝不终止该进程。
                return Err(WindowsWallpaperError::new(
                    "WALLPAPER_ENGINE_CONTROL_TIMEOUT",
                    "control child 超时",
                ));
            }
            Err(error) => {
                return Err(io_error(
                    "WALLPAPER_ENGINE_CONTROL_FAILED",
                    "等待 control child",
                    error,
                ));
            }
        }
    }
}

fn wait_for_exact_window(
    title: &str,
    executable: &Path,
    timeout: Duration,
) -> WindowsWallpaperResult<WindowIdentity> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(window) = find_exact_window(title, executable)? {
            return Ok(window);
        }
        if Instant::now() >= deadline {
            return Err(WindowsWallpaperError::new(
                "WALLPAPER_ENGINE_WINDOW_TIMEOUT",
                "唯一 Scene HWND 未出现",
            ));
        }
        thread::sleep(Duration::from_millis(60));
    }
}

fn close_exact_window(
    executable: &Path,
    location: &str,
    expected: &WindowIdentity,
) -> WindowsWallpaperResult<()> {
    verify_window_identity(expected)?;
    let _ = spawn_control(executable, &build_close_args(location));
    let deadline = Instant::now() + WINDOW_CLOSE_TIMEOUT;
    while Instant::now() < deadline {
        if unsafe { IsWindow(expected.hwnd()) } == 0 {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(40));
    }
    verify_window_identity(expected)?;
    if unsafe { PostMessageW(expected.hwnd(), WM_CLOSE, 0, 0) } == 0 {
        return Err(WindowsWallpaperError::new(
            "WALLPAPER_ENGINE_WINDOW_CLOSE_FAILED",
            "向 exact Scene HWND 发送 WM_CLOSE 失败",
        ));
    }
    let deadline = Instant::now() + WINDOW_CLOSE_TIMEOUT;
    while Instant::now() < deadline {
        if unsafe { IsWindow(expected.hwnd()) } == 0 {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(40));
    }
    Err(WindowsWallpaperError::new(
        "WALLPAPER_ENGINE_WINDOW_CLOSE_FAILED",
        "exact Scene HWND 未确认关闭",
    ))
}

fn corrected_launch_geometry(
    current: LaunchGeometry,
    actual: PhysicalRect,
    expected: PhysicalRect,
) -> WindowsWallpaperResult<LaunchGeometry> {
    let width = current
        .width
        .saturating_sub(actual.width.saturating_sub(expected.width));
    let height = current
        .height
        .saturating_sub(actual.height.saturating_sub(expected.height));
    if width < 64 || height < 64 || width > 7_680 || height > 4_320 {
        return Err(WindowsWallpaperError::new(
            "WALLPAPER_ENGINE_GEOMETRY_INVALID",
            "自适应重开尺寸超出安全边界",
        ));
    }
    Ok(LaunchGeometry {
        x: current
            .x
            .saturating_add(expected.x.saturating_sub(actual.x)),
        y: current
            .y
            .saturating_add(expected.y.saturating_sub(actual.y)),
        width,
        height,
    })
}

fn verify_scene_ownership(
    prepared: &PreparedWindowsScene,
    ownership: &WindowsSceneOwnership,
) -> WindowsWallpaperResult<()> {
    if ownership.session_id != prepared.request.session_id
        || ownership.location != prepared.request.location
        || path_key(&ownership.executable.canonical_path)
            != path_key(&prepared.executable.canonical_path)
    {
        return Err(WindowsWallpaperError::new(
            "WALLPAPER_ENGINE_WINDOW_IDENTITY_MISMATCH",
            "Scene ownership 与 prepared request 不一致",
        ));
    }
    verify_window_identity(&ownership.window).map(|_| ())
}

fn same_window_identity(left: &WindowIdentity, right: &WindowIdentity) -> bool {
    left.handle == right.handle
        && left.thread_id == right.thread_id
        && left.process.process_id == right.process.process_id
        && left.process.process_created_unix_millis == right.process.process_created_unix_millis
        && path_key(&left.process.executable) == path_key(&right.process.executable)
        && left.title == right.title
}

fn current_process_is_elevated() -> WindowsWallpaperResult<bool> {
    let mut token: HANDLE = null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0
        || token.is_null()
    {
        return Err(WindowsWallpaperError::new(
            "WALLPAPER_ENGINE_ELEVATION_PROBE_FAILED",
            "OpenProcessToken 失败",
        ));
    }
    let mut elevation: TOKEN_ELEVATION = unsafe { zeroed() };
    let mut returned = 0u32;
    let ok = unsafe {
        GetTokenInformation(
            token,
            TokenElevation,
            (&mut elevation as *mut TOKEN_ELEVATION).cast(),
            size_of::<TOKEN_ELEVATION>() as u32,
            &mut returned,
        )
    };
    unsafe {
        CloseHandle(token);
    }
    if ok == 0 {
        return Err(WindowsWallpaperError::new(
            "WALLPAPER_ENGINE_ELEVATION_PROBE_FAILED",
            "GetTokenInformation(TokenElevation) 失败",
        ));
    }
    Ok(elevation.TokenIsElevated != 0)
}

#[cfg(test)]
mod tests {
    use super::{
        build_mute_args, build_open_args, corrected_launch_geometry, sanitize_mute_properties,
        LaunchGeometry, WindowsSceneRequest,
    };
    use crate::platform::windows::wallpaper_engine::identity::PhysicalRect;
    use serde_json::json;
    use std::{collections::BTreeMap, path::PathBuf};

    fn request() -> WindowsSceneRequest {
        WindowsSceneRequest {
            generation: 7,
            project_id: "ab".repeat(12),
            session_id: "cd".repeat(12),
            location: format!("Mineradio Wallpaper {}", "cd".repeat(12)),
            project_file: PathBuf::from(r"C:\fixture\project.json"),
            scene_package: PathBuf::from(r"C:\fixture\scene.pkg"),
            mute_properties: BTreeMap::new(),
            physical_bounds: PhysicalRect::new(-1920, 0, 1920, 1080).expect("fixture 有效"),
        }
    }

    #[test]
    fn open_control_is_exact_location_scoped_and_uses_physical_geometry() {
        let request = request();
        let args = build_open_args(&request, request.physical_bounds.into());
        assert_eq!(args[0..2], ["-control", "openWallpaper"]);
        assert_eq!(
            args[args
                .iter()
                .position(|item| item == "-playInWindow")
                .unwrap()
                + 1],
            request.location
        );
        assert_eq!(
            args[args.iter().position(|item| item == "-x").unwrap() + 1],
            "-1920"
        );
        assert_eq!(
            args[args.iter().position(|item| item == "-width").unwrap() + 1],
            "1920"
        );
        assert_eq!(args.last().map(String::as_str), Some("-borderless"));
    }

    #[test]
    fn mute_control_keeps_only_bounded_safe_properties_and_never_uses_global_mute() {
        let properties = BTreeMap::from([
            ("volume".into(), json!(99)),
            ("music_enabled".into(), json!(false)),
            ("constructor".into(), json!(0)),
            ("unsafe value".into(), json!("no")),
        ]);
        let sanitized = sanitize_mute_properties(&properties);
        assert_eq!(sanitized.get("volume"), Some(&json!(0)));
        assert_eq!(sanitized.get("music_enabled"), Some(&json!(false)));
        assert!(!sanitized.contains_key("constructor"));
        let args = build_mute_args("Mineradio Wallpaper fixture", &sanitized).expect("编码成功");
        assert_eq!(args[0..2], ["-control", "applyProperties"]);
        assert!(!args.iter().any(|item| item == "mute"));
        assert_eq!(
            args[args.iter().position(|item| item == "-location").unwrap() + 1],
            "Mineradio Wallpaper fixture"
        );
    }

    #[test]
    fn geometry_correction_is_bounded_and_converges_toward_host_rect() {
        let current = LaunchGeometry {
            x: 100,
            y: 80,
            width: 1280,
            height: 720,
        };
        let actual = PhysicalRect::new(104, 83, 1290, 728).expect("fixture 有效");
        let expected = PhysicalRect::new(100, 80, 1280, 720).expect("fixture 有效");
        assert_eq!(
            corrected_launch_geometry(current, actual, expected).expect("修正有效"),
            LaunchGeometry {
                x: 96,
                y: 77,
                width: 1270,
                height: 712,
            }
        );
    }
}
