use std::path::{Path, PathBuf};
use std::process::Child;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub const SIDECAR_LOG_FILE_NAME: &str = "sidecar-runtime.log";
pub const SIDECAR_BINARY_ENV: &str = "MINERADIO_SIDECAR_BIN";
pub const BUN_BINARY_ENV: &str = "MINERADIO_BUN_BIN";
pub const SIDECAR_BINARY_BASENAME: &str = "mineradio-sidecar-api";
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Debug, PartialEq, Eq)]
pub struct HealthInfo {
    pub ok: bool,
    pub app_version: String,
    pub api_version: String,
    pub schema_version: String,
    pub providers: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SidecarPhase {
    Starting,
    Ready,
    Recovering,
    Stopped,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarRuntimeSnapshot {
    pub phase: SidecarPhase,
    pub base_url: String,
    pub pid: Option<u32>,
    pub restarts: u32,
    pub last_error: Option<String>,
    pub last_health_ok_ms: Option<u64>,
    pub providers: Vec<String>,
    pub log_path: String,
}

#[derive(Debug)]
pub struct SidecarRuntimeState {
    pub phase: SidecarPhase,
    pub base_url: String,
    pub child: Option<Child>,
    pub restarts: u32,
    pub last_error: Option<String>,
    pub last_health_ok_ms: Option<u64>,
    pub providers: Vec<String>,
    pub log_path: PathBuf,
}

impl SidecarRuntimeState {
    pub fn new(base_url: String, log_path: PathBuf) -> Self {
        Self {
            phase: SidecarPhase::Starting,
            base_url,
            child: None,
            restarts: 0,
            last_error: None,
            last_health_ok_ms: None,
            providers: Vec::new(),
            log_path,
        }
    }

    pub fn snapshot(&self) -> SidecarRuntimeSnapshot {
        SidecarRuntimeSnapshot {
            phase: self.phase.clone(),
            base_url: self.base_url.clone(),
            pid: self.child.as_ref().map(Child::id),
            restarts: self.restarts,
            last_error: self.last_error.clone(),
            last_health_ok_ms: self.last_health_ok_ms,
            providers: self.providers.clone(),
            log_path: self.log_path.to_string_lossy().to_string(),
        }
    }
}

#[derive(Debug)]
pub enum SidecarError {
    Timeout,
    BadUrl,
    Io(String),
    BadStatus,
    Parse(String),
}

impl std::fmt::Display for SidecarError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SidecarError::Timeout => write!(f, "sidecar health check timed out"),
            SidecarError::BadUrl => write!(f, "bad base url"),
            SidecarError::Io(msg) => write!(f, "io error: {}", msg),
            SidecarError::BadStatus => write!(f, "bad http status"),
            SidecarError::Parse(msg) => write!(f, "parse error: {}", msg),
        }
    }
}

impl std::error::Error for SidecarError {}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

pub fn sidecar_log_path(log_dir: &Path) -> PathBuf {
    log_dir.join(SIDECAR_LOG_FILE_NAME)
}

fn bun_executable_name() -> &'static str {
    if cfg!(windows) {
        "bun.exe"
    } else {
        "bun"
    }
}

fn non_empty_env_path(key: &str) -> Option<PathBuf> {
    std::env::var_os(key).and_then(|value| {
        if value.is_empty() {
            None
        } else {
            Some(PathBuf::from(value))
        }
    })
}

fn dev_bun_candidates() -> Vec<PathBuf> {
    let exe = bun_executable_name();
    let mut candidates = Vec::new();
    if let Some(path) = non_empty_env_path(BUN_BINARY_ENV) {
        candidates.push(path);
    }
    if let Some(dir) = non_empty_env_path("BUN_INSTALL") {
        candidates.push(dir.join("bin").join(exe));
    }
    if let Some(dir) = non_empty_env_path("USERPROFILE") {
        candidates.push(dir.join(".bun").join("bin").join(exe));
    }
    if let Some(dir) = non_empty_env_path("HOME") {
        candidates.push(dir.join(".bun").join("bin").join(exe));
    }
    candidates
}

pub fn resolve_dev_bun_program_from_candidates<I>(candidates: I) -> Option<PathBuf>
where
    I: IntoIterator<Item = PathBuf>,
{
    candidates.into_iter().find(|path| path.is_file())
}

pub fn resolve_dev_bun_program() -> Option<PathBuf> {
    resolve_dev_bun_program_from_candidates(dev_bun_candidates())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SidecarLaunchPlan {
    Dev,
    Bundled(PathBuf),
}

impl SidecarLaunchPlan {
    pub fn dev() -> Self {
        Self::Dev
    }

    pub fn bundled(path: PathBuf) -> Self {
        Self::Bundled(path)
    }

    #[cfg(test)]
    pub fn is_bundled(&self) -> bool {
        matches!(self, Self::Bundled(_))
    }
}

pub fn resolve_sidecar_launch_plan_with_resource_dir(
    resource_dir: Option<&Path>,
) -> SidecarLaunchPlan {
    let env_binary = std::env::var_os(SIDECAR_BINARY_ENV).and_then(|value| {
        if value.is_empty() {
            None
        } else {
            Some(PathBuf::from(value))
        }
    });
    let packaged_binary = resource_dir
        .and_then(find_packaged_sidecar_binary_in_dir)
        .or_else(packaged_sidecar_binary_from_current_exe);
    resolve_sidecar_launch_plan_from_sources(env_binary, packaged_binary)
}

pub fn resolve_sidecar_launch_plan_from_sources(
    env_binary: Option<PathBuf>,
    packaged_binary: Option<PathBuf>,
) -> SidecarLaunchPlan {
    if let Some(path) = env_binary {
        return SidecarLaunchPlan::bundled(path);
    }
    if let Some(path) = packaged_binary {
        return SidecarLaunchPlan::bundled(path);
    }
    SidecarLaunchPlan::dev()
}

pub fn packaged_sidecar_binary_from_current_exe() -> Option<PathBuf> {
    let current_exe = std::env::current_exe().ok()?;
    find_packaged_sidecar_binary_for_exe(&current_exe)
}

pub fn find_packaged_sidecar_binary_for_exe(current_exe: &Path) -> Option<PathBuf> {
    let dir = current_exe.parent()?;
    find_packaged_sidecar_binary_in_dir(dir)
}

pub fn find_packaged_sidecar_binary_in_dir(dir: &Path) -> Option<PathBuf> {
    let mut matches = std::fs::read_dir(dir)
        .ok()?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .map(is_packaged_sidecar_binary_name)
                .unwrap_or(false)
        })
        .collect::<Vec<_>>();
    matches.sort_by_key(|path| {
        path.file_name()
            .and_then(|name| name.to_str())
            .map(packaged_sidecar_binary_sort_key)
            .unwrap_or((2, String::new()))
    });
    matches.into_iter().next()
}

fn is_packaged_sidecar_binary_name(file_name: &str) -> bool {
    let expected_prefix = format!("{SIDECAR_BINARY_BASENAME}-");
    if cfg!(target_os = "windows") {
        file_name == format!("{SIDECAR_BINARY_BASENAME}.exe")
            || (file_name.starts_with(&expected_prefix) && file_name.ends_with(".exe"))
    } else {
        file_name == SIDECAR_BINARY_BASENAME || file_name.starts_with(&expected_prefix)
    }
}

fn packaged_sidecar_binary_sort_key(file_name: &str) -> (u8, String) {
    let unsuffixed = if cfg!(target_os = "windows") {
        format!("{SIDECAR_BINARY_BASENAME}.exe")
    } else {
        SIDECAR_BINARY_BASENAME.to_string()
    };
    if file_name == unsuffixed {
        (1, file_name.to_string())
    } else {
        (0, file_name.to_string())
    }
}

pub fn sidecar_runtime_mark_spawned(
    state: &mut SidecarRuntimeState,
    child: Child,
) -> Option<Child> {
    state.phase = SidecarPhase::Starting;
    state.last_error = None;
    state.child.replace(child)
}

pub fn sidecar_runtime_mark_ready(state: &mut SidecarRuntimeState, health: HealthInfo, at_ms: u64) {
    state.phase = SidecarPhase::Ready;
    state.last_error = None;
    state.last_health_ok_ms = Some(at_ms);
    state.providers = health.providers;
}

pub fn sidecar_runtime_should_probe_health(state: &SidecarRuntimeState) -> bool {
    state.child.is_some()
        && matches!(
            state.phase,
            SidecarPhase::Starting | SidecarPhase::Recovering
        )
}

pub fn sidecar_runtime_mark_start_failed(state: &mut SidecarRuntimeState, error: &SidecarError) {
    state.phase = SidecarPhase::Error;
    state.last_error = Some(error.to_string());
}

pub fn sidecar_runtime_mark_health_failed(state: &mut SidecarRuntimeState, error: &SidecarError) {
    state.phase = SidecarPhase::Recovering;
    state.last_error = Some(error.to_string());
}

pub fn sidecar_runtime_mark_restarting(state: &mut SidecarRuntimeState) {
    state.phase = SidecarPhase::Recovering;
    state.restarts = state.restarts.saturating_add(1);
}

pub fn sidecar_runtime_child_exited(state: &mut SidecarRuntimeState) -> Result<bool, SidecarError> {
    let Some(child) = state.child.as_mut() else {
        return Ok(false);
    };
    match child.try_wait() {
        Ok(Some(status)) => {
            state.child = None;
            state.phase = SidecarPhase::Recovering;
            state.last_error = Some(format!("sidecar exited with status {}", status));
            Ok(true)
        }
        Ok(None) => Ok(false),
        Err(e) => {
            state.phase = SidecarPhase::Error;
            state.last_error = Some(e.to_string());
            Err(SidecarError::Io(e.to_string()))
        }
    }
}

pub fn sidecar_runtime_mark_stopped(state: &mut SidecarRuntimeState) -> Option<Child> {
    state.phase = SidecarPhase::Stopped;
    state.child.take()
}

pub fn terminate_sidecar_child(child: Option<Child>) -> bool {
    let Some(mut child) = child else {
        return false;
    };
    let _ = child.kill();
    let _ = child.wait();
    true
}

pub fn allocate_port() -> u16 {
    let listener = std::net::TcpListener::bind("127.0.0.1:0")
        .expect("failed to bind ephemeral port for sidecar allocation");
    let port = listener
        .local_addr()
        .expect("failed to read local addr")
        .port();
    drop(listener);
    port
}

pub fn build_sidecar_command_from_plan(
    plan: &SidecarLaunchPlan,
    port: u16,
    app_data_dir: &Path,
    log_dir: &Path,
    app_version: &str,
) -> std::process::Command {
    let mut cmd = match plan {
        SidecarLaunchPlan::Dev => {
            let mut cmd = resolve_dev_bun_program()
                .map(std::process::Command::new)
                .unwrap_or_else(|| std::process::Command::new("bun"));
            cmd.args(["run", "sidecars/api/src/server.ts"]);
            cmd.current_dir(workspace_root_from_manifest_dir());
            cmd
        }
        SidecarLaunchPlan::Bundled(binary_path) => std::process::Command::new(binary_path),
    };
    cmd.env("MINERADIO_SIDECAR_PORT", port.to_string());
    cmd.env("MINERADIO_APP_DATA_DIR", app_data_dir);
    cmd.env("MINERADIO_LOG_DIR", log_dir);
    cmd.env("MINERADIO_APP_VERSION", app_version);
    cmd.env("MINERADIO_SIDECAR_LOG_FILE", sidecar_log_path(log_dir));
    apply_packaged_sidecar_spawn_options(&mut cmd, plan);
    cmd
}

#[cfg(windows)]
fn apply_packaged_sidecar_spawn_options(cmd: &mut std::process::Command, plan: &SidecarLaunchPlan) {
    if matches!(plan, SidecarLaunchPlan::Bundled(_)) {
        use std::os::windows::process::CommandExt;
        // 打包 sidecar 是控制台子系统时，避免安装版启动时弹出独立控制台窗口。
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
}

#[cfg(not(windows))]
fn apply_packaged_sidecar_spawn_options(
    _cmd: &mut std::process::Command,
    _plan: &SidecarLaunchPlan,
) {
}

pub fn workspace_root_from_manifest_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")))
        .to_path_buf()
}

pub fn spawn_sidecar(mut cmd: std::process::Command) -> Result<std::process::Child, SidecarError> {
    cmd.spawn().map_err(|e| SidecarError::Io(e.to_string()))
}

pub fn spawn_sidecar_into_runtime(
    state: &mut SidecarRuntimeState,
    cmd: std::process::Command,
    wait_deadline: Duration,
) -> Result<(), SidecarError> {
    let child = spawn_sidecar(cmd)?;
    let orphan = sidecar_runtime_mark_spawned(state, child);
    terminate_sidecar_child(orphan);
    match wait_for_health(&state.base_url, wait_deadline) {
        Ok(health) => {
            sidecar_runtime_mark_ready(state, health, now_ms());
            Ok(())
        }
        Err(e) => {
            sidecar_runtime_mark_health_failed(state, &e);
            Err(e)
        }
    }
}

pub fn parse_health_response(body: &[u8]) -> Result<HealthInfo, SidecarError> {
    let text = std::str::from_utf8(body).map_err(|e| SidecarError::Parse(e.to_string()))?;
    let value: serde_json::Value =
        serde_json::from_str(text).map_err(|e| SidecarError::Parse(e.to_string()))?;
    let ok = value
        .get("ok")
        .and_then(|v| v.as_bool())
        .ok_or_else(|| SidecarError::Parse("missing ok".into()))?;
    if !ok {
        return Err(SidecarError::BadStatus);
    }
    let app_version = value
        .get("appVersion")
        .and_then(|v| v.as_str())
        .ok_or_else(|| SidecarError::Parse("missing appVersion".into()))?
        .to_string();
    let api_version = value
        .get("apiVersion")
        .and_then(|v| v.as_str())
        .ok_or_else(|| SidecarError::Parse("missing apiVersion".into()))?
        .to_string();
    let schema_version = value
        .get("schemaVersion")
        .and_then(|v| v.as_str())
        .ok_or_else(|| SidecarError::Parse("missing schemaVersion".into()))?
        .to_string();
    let providers = parse_health_provider_ids(&value);
    Ok(HealthInfo {
        ok,
        app_version,
        api_version,
        schema_version,
        providers,
    })
}

fn provider_ids_from_array(value: Option<&serde_json::Value>) -> Vec<String> {
    match value {
        Some(serde_json::Value::Array(arr)) => arr
            .iter()
            .filter_map(|item| item.as_str().map(|s| s.to_string()))
            .collect(),
        _ => Vec::new(),
    }
}

fn parse_health_provider_ids(value: &serde_json::Value) -> Vec<String> {
    let status_ids = value
        .get("providerStatus")
        .and_then(|status| status.get("providers"))
        .and_then(|providers| providers.as_array())
        .map(|providers| {
            providers
                .iter()
                .filter_map(|item| {
                    item.get("providerId")
                        .and_then(|provider_id| provider_id.as_str())
                        .map(|provider_id| provider_id.to_string())
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if !status_ids.is_empty() {
        return status_ids;
    }
    // Older sidecar builds omit providerStatus; fall back to the legacy id array.
    provider_ids_from_array(value.get("providers"))
}

fn parse_base_url(base_url: &str) -> Result<(String, u16), SidecarError> {
    let rest = base_url
        .strip_prefix("http://")
        .ok_or(SidecarError::BadUrl)?;
    let host_port = rest.split('/').next().ok_or(SidecarError::BadUrl)?;
    let (host, port) = match host_port.rsplit_once(':') {
        Some((h, p)) => (
            h.to_string(),
            p.parse::<u16>().map_err(|_| SidecarError::BadUrl)?,
        ),
        None => return Err(SidecarError::BadUrl),
    };
    if host.is_empty() {
        return Err(SidecarError::BadUrl);
    }
    Ok((host, port))
}

fn find_header_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n")
}

fn content_length_from_headers(header_str: &str) -> Option<usize> {
    header_str.lines().skip(1).find_map(|line| {
        let (name, value) = line.split_once(':')?;
        if name.trim().eq_ignore_ascii_case("content-length") {
            value.trim().parse::<usize>().ok()
        } else {
            None
        }
    })
}

fn complete_content_length_body_range(buf: &[u8]) -> Result<Option<(usize, usize)>, SidecarError> {
    let Some(header_end) = find_header_end(buf) else {
        return Ok(None);
    };
    let header_bytes = &buf[..header_end];
    let header_str =
        std::str::from_utf8(header_bytes).map_err(|e| SidecarError::Parse(e.to_string()))?;
    let status_line = header_str.lines().next().unwrap_or("");
    if !status_line.contains(" 200 ") {
        return Err(SidecarError::BadStatus);
    }
    let Some(content_length) = content_length_from_headers(header_str) else {
        return Ok(None);
    };
    let body_start = header_end + 4;
    let body_end = body_start
        .checked_add(content_length)
        .ok_or_else(|| SidecarError::Parse("content-length overflow".into()))?;
    if buf.len() >= body_end {
        return Ok(Some((body_start, body_end)));
    }
    Ok(None)
}

fn try_health_once(host: &str, port: u16) -> Result<HealthInfo, SidecarError> {
    use std::io::{Read, Write};
    let mut stream =
        std::net::TcpStream::connect((host, port)).map_err(|e| SidecarError::Io(e.to_string()))?;
    stream
        .set_read_timeout(Some(std::time::Duration::from_secs(2)))
        .ok();
    let req = format!(
        "GET /health HTTP/1.1\r\nHost: {}\r\nConnection: close\r\n\r\n",
        host
    );
    stream
        .write_all(req.as_bytes())
        .map_err(|e| SidecarError::Io(e.to_string()))?;
    let mut buf = Vec::new();
    let mut chunk = [0u8; 1024];
    loop {
        let n = match stream.read(&mut chunk) {
            Ok(n) => n,
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                if let Some((body_start, body_end)) = complete_content_length_body_range(&buf)? {
                    return parse_health_response(&buf[body_start..body_end]);
                }
                return Err(SidecarError::Io(e.to_string()));
            }
            Err(e) => return Err(SidecarError::Io(e.to_string())),
        };
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
        if buf.len() > (1 << 20) {
            return Err(SidecarError::Parse("response too large".into()));
        }
        if let Some((body_start, body_end)) = complete_content_length_body_range(&buf)? {
            return parse_health_response(&buf[body_start..body_end]);
        }
    }
    let header_end =
        find_header_end(&buf).ok_or_else(|| SidecarError::Parse("no header terminator".into()))?;
    let header_bytes = &buf[..header_end];
    let header_str =
        std::str::from_utf8(header_bytes).map_err(|e| SidecarError::Parse(e.to_string()))?;
    let status_line = header_str.lines().next().unwrap_or("");
    if !status_line.contains(" 200 ") {
        return Err(SidecarError::BadStatus);
    }
    let body = &buf[header_end + 4..];
    parse_health_response(body)
}

pub fn wait_for_health(base_url: &str, deadline: Duration) -> Result<HealthInfo, SidecarError> {
    let (host, port) = parse_base_url(base_url)?;
    let start = std::time::Instant::now();
    loop {
        match try_health_once(&host, port) {
            Ok(info) => return Ok(info),
            Err(_) => {
                if start.elapsed() >= deadline {
                    return Err(SidecarError::Timeout);
                }
                std::thread::sleep(Duration::from_millis(200));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::process::{Child, Command};

    fn spawn_sleeping_test_child() -> Child {
        if cfg!(target_os = "windows") {
            Command::new("cmd")
                .args(["/C", "ping 127.0.0.1 -n 3 > nul"])
                .spawn()
                .expect("spawn sleeping child")
        } else {
            Command::new("sh")
                .args(["-c", "sleep 2"])
                .spawn()
                .expect("spawn sleeping child")
        }
    }

    fn spawn_exiting_test_child() -> Child {
        if cfg!(target_os = "windows") {
            Command::new("cmd")
                .args(["/C", "exit 7"])
                .spawn()
                .expect("spawn exiting child")
        } else {
            Command::new("sh")
                .args(["-c", "exit 7"])
                .spawn()
                .expect("spawn exiting child")
        }
    }

    #[test]
    fn allocate_port_returns_nonzero() {
        let port = allocate_port();
        assert!(port > 0);
    }

    #[test]
    fn build_sidecar_command_uses_dev_bun_entry_when_no_bundled_binary_is_configured() {
        let plan = SidecarLaunchPlan::dev();
        let cmd = build_sidecar_command_from_plan(
            &plan,
            54321,
            Path::new("/tmp/data"),
            Path::new("/tmp/logs"),
            "1.2.3",
        );
        let program = cmd.get_program();
        let program_text = program.to_string_lossy().replace('\\', "/");
        assert!(
            program == std::ffi::OsStr::new("bun")
                || program_text.ends_with("/.bun/bin/bun.exe")
                || program_text.ends_with("/.bun/bin/bun")
        );

        let args: Vec<String> = cmd
            .get_args()
            .map(|a| a.to_str().unwrap().to_string())
            .collect();
        assert_eq!(args, vec!["run", "sidecars/api/src/server.ts"]);
        assert_eq!(
            cmd.get_current_dir(),
            Some(workspace_root_from_manifest_dir().as_path())
        );
        assert!(!plan.is_bundled());

        let envs: Vec<(&std::ffi::OsStr, Option<&std::ffi::OsStr>)> = cmd.get_envs().collect();
        let get = |key: &str| -> Option<String> {
            envs.iter().find_map(|(k, v)| {
                if k.to_str() == Some(key) {
                    v.as_ref().and_then(|x| x.to_str()).map(|s| s.to_string())
                } else {
                    None
                }
            })
        };
        assert_eq!(get("MINERADIO_SIDECAR_PORT"), Some("54321".to_string()));
        assert_eq!(get("MINERADIO_APP_VERSION"), Some("1.2.3".to_string()));
        assert_eq!(get("MINERADIO_APP_DATA_DIR"), Some("/tmp/data".to_string()));
        assert_eq!(get("MINERADIO_LOG_DIR"), Some("/tmp/logs".to_string()));
        assert_eq!(
            get("MINERADIO_SIDECAR_LOG_FILE"),
            Some(
                sidecar_log_path(Path::new("/tmp/logs"))
                    .to_string_lossy()
                    .to_string()
            )
        );
    }

    #[test]
    fn resolve_dev_bun_program_uses_first_existing_candidate() {
        let dir = std::env::temp_dir().join(format!("mineradio-bun-candidate-{}", now_ms()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let missing = dir.join("missing").join(bun_executable_name());
        let existing = dir.join(bun_executable_name());
        std::fs::write(&existing, b"").expect("bun marker");

        let resolved = resolve_dev_bun_program_from_candidates(vec![missing, existing.clone()]);

        assert_eq!(resolved, Some(existing));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn build_sidecar_command_uses_bundled_binary_without_workspace_path() {
        let plan =
            SidecarLaunchPlan::bundled(PathBuf::from("/opt/mineradio/mineradio-sidecar-api"));
        let cmd = build_sidecar_command_from_plan(
            &plan,
            54321,
            Path::new("/tmp/data"),
            Path::new("/tmp/logs"),
            "1.2.3",
        );
        assert_eq!(
            cmd.get_program(),
            std::ffi::OsStr::new("/opt/mineradio/mineradio-sidecar-api")
        );
        assert_eq!(cmd.get_args().count(), 0);
        assert_eq!(cmd.get_current_dir(), None);
        assert!(plan.is_bundled());
    }

    #[test]
    fn resolve_sidecar_launch_plan_prefers_env_then_packaged_binary_then_dev() {
        let env_path = PathBuf::from("/opt/mineradio/custom-sidecar");
        let packaged_path =
            PathBuf::from("/opt/mineradio/mineradio-sidecar-api-x86_64-pc-windows-msvc.exe");

        assert_eq!(
            resolve_sidecar_launch_plan_from_sources(
                Some(env_path.clone()),
                Some(packaged_path.clone())
            ),
            SidecarLaunchPlan::bundled(env_path)
        );
        assert_eq!(
            resolve_sidecar_launch_plan_from_sources(None, Some(packaged_path.clone())),
            SidecarLaunchPlan::bundled(packaged_path)
        );
        assert_eq!(
            resolve_sidecar_launch_plan_from_sources(None, None),
            SidecarLaunchPlan::dev()
        );
    }

    #[test]
    fn find_packaged_sidecar_binary_for_exe_finds_tauri_external_bin_sibling() {
        let root = std::env::temp_dir().join(format!("mineradio-sidecar-test-{}", now_ms()));
        let exe_path = root.join(if cfg!(target_os = "windows") {
            "MineRadio-Tauri.exe"
        } else {
            "MineRadio-Tauri"
        });
        std::fs::create_dir_all(&root).expect("create temp dir");
        std::fs::write(&exe_path, b"app").expect("write fake exe");

        let sidecar_file_name = if cfg!(target_os = "windows") {
            "mineradio-sidecar-api-x86_64-pc-windows-msvc.exe"
        } else {
            "mineradio-sidecar-api-aarch64-apple-darwin"
        };
        let sidecar_path = root.join(sidecar_file_name);
        std::fs::write(&sidecar_path, b"sidecar").expect("write fake sidecar");
        std::fs::write(root.join("mineradio-sidecar-api.exe"), b"wrong suffix")
            .expect("write wrong sidecar");

        assert_eq!(
            find_packaged_sidecar_binary_for_exe(&exe_path),
            Some(sidecar_path)
        );

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn find_packaged_sidecar_binary_accepts_installed_unsuffixed_binary() {
        let root =
            std::env::temp_dir().join(format!("mineradio-installed-sidecar-test-{}", now_ms()));
        let exe_path = root.join(if cfg!(target_os = "windows") {
            "MineRadio-Tauri.exe"
        } else {
            "MineRadio-Tauri"
        });
        std::fs::create_dir_all(&root).expect("create temp dir");
        std::fs::write(&exe_path, b"app").expect("write fake exe");

        let sidecar_file_name = if cfg!(target_os = "windows") {
            "mineradio-sidecar-api.exe"
        } else {
            "mineradio-sidecar-api"
        };
        let sidecar_path = root.join(sidecar_file_name);
        std::fs::write(&sidecar_path, b"sidecar").expect("write installed sidecar");

        assert_eq!(
            find_packaged_sidecar_binary_for_exe(&exe_path),
            Some(sidecar_path)
        );

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn sidecar_log_path_uses_runtime_log_file_name() {
        assert_eq!(
            sidecar_log_path(Path::new("/tmp/mineradio-logs")),
            PathBuf::from("/tmp/mineradio-logs/sidecar-runtime.log")
        );
    }

    #[test]
    fn sidecar_runtime_tracks_ready_health_snapshot() {
        let mut runtime = SidecarRuntimeState::new(
            "http://127.0.0.1:38123".to_string(),
            PathBuf::from("/tmp/logs/sidecar-runtime.log"),
        );
        sidecar_runtime_mark_ready(
            &mut runtime,
            HealthInfo {
                ok: true,
                app_version: "0.1.0".to_string(),
                api_version: "0.1.0".to_string(),
                schema_version: "0.1.0".to_string(),
                providers: vec!["netease".to_string(), "qq".to_string()],
            },
            123_456,
        );

        let snapshot = runtime.snapshot();
        assert_eq!(snapshot.phase, SidecarPhase::Ready);
        assert_eq!(snapshot.base_url, "http://127.0.0.1:38123");
        assert_eq!(snapshot.pid, None);
        assert_eq!(snapshot.restarts, 0);
        assert_eq!(snapshot.last_error, None);
        assert_eq!(snapshot.last_health_ok_ms, Some(123_456));
        assert_eq!(
            snapshot.providers,
            vec!["netease".to_string(), "qq".to_string()]
        );
        assert_eq!(snapshot.log_path, "/tmp/logs/sidecar-runtime.log");
    }

    #[test]
    fn sidecar_runtime_retains_child_handle_and_replaces_orphan() {
        let mut runtime = SidecarRuntimeState::new(
            "http://127.0.0.1:38123".to_string(),
            PathBuf::from("/tmp/logs/sidecar-runtime.log"),
        );
        let first = spawn_sleeping_test_child();
        let first_id = first.id();

        assert!(sidecar_runtime_mark_spawned(&mut runtime, first).is_none());
        assert_eq!(runtime.snapshot().pid, Some(first_id));

        let second = spawn_sleeping_test_child();
        let second_id = second.id();
        let orphan = sidecar_runtime_mark_spawned(&mut runtime, second);
        assert_eq!(orphan.as_ref().map(Child::id), Some(first_id));
        assert!(terminate_sidecar_child(orphan));
        assert_eq!(runtime.snapshot().pid, Some(second_id));

        assert!(terminate_sidecar_child(sidecar_runtime_mark_stopped(
            &mut runtime
        )));
    }

    #[test]
    fn sidecar_runtime_child_exit_marks_recovering_for_restart() {
        let mut runtime = SidecarRuntimeState::new(
            "http://127.0.0.1:38123".to_string(),
            PathBuf::from("/tmp/logs/sidecar-runtime.log"),
        );
        let child = spawn_exiting_test_child();
        let orphan = sidecar_runtime_mark_spawned(&mut runtime, child);
        terminate_sidecar_child(orphan);

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        let mut observed_exit = false;
        while std::time::Instant::now() < deadline {
            if sidecar_runtime_child_exited(&mut runtime).expect("child exit check") {
                observed_exit = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert!(
            observed_exit,
            "sidecar test child exit was not observed within 2 seconds"
        );
        assert!(runtime.child.is_none());
        assert_eq!(runtime.phase, SidecarPhase::Recovering);
        assert!(runtime
            .last_error
            .as_deref()
            .unwrap_or_default()
            .contains("sidecar exited with status"));
    }

    #[test]
    fn sidecar_runtime_mark_stopped_returns_child_for_shutdown_cleanup() {
        let mut runtime = SidecarRuntimeState::new(
            "http://127.0.0.1:38123".to_string(),
            PathBuf::from("/tmp/logs/sidecar-runtime.log"),
        );
        let child = spawn_sleeping_test_child();
        let orphan = sidecar_runtime_mark_spawned(&mut runtime, child);
        terminate_sidecar_child(orphan);

        let child = sidecar_runtime_mark_stopped(&mut runtime);
        assert!(child.is_some());
        assert_eq!(runtime.phase, SidecarPhase::Stopped);
        assert!(runtime.child.is_none());
        assert!(terminate_sidecar_child(child));
        assert!(!terminate_sidecar_child(None));
    }

    #[test]
    fn sidecar_runtime_records_failures_and_restart_intent() {
        let mut runtime = SidecarRuntimeState::new(
            "http://127.0.0.1:38123".to_string(),
            PathBuf::from("/tmp/logs/sidecar-runtime.log"),
        );

        sidecar_runtime_mark_start_failed(&mut runtime, &SidecarError::Io("spawn failed".into()));
        assert_eq!(runtime.phase, SidecarPhase::Error);
        assert_eq!(
            runtime.last_error.as_deref(),
            Some("io error: spawn failed")
        );

        sidecar_runtime_mark_health_failed(&mut runtime, &SidecarError::Timeout);
        assert_eq!(runtime.phase, SidecarPhase::Recovering);
        assert_eq!(
            runtime.last_error.as_deref(),
            Some("sidecar health check timed out")
        );

        sidecar_runtime_mark_restarting(&mut runtime);
        assert_eq!(runtime.phase, SidecarPhase::Recovering);
        assert_eq!(runtime.restarts, 1);
    }

    #[test]
    fn sidecar_runtime_probes_recovering_live_child_and_marks_ready() {
        let mut runtime = SidecarRuntimeState::new(
            "http://127.0.0.1:38123".to_string(),
            PathBuf::from("/tmp/logs/sidecar-runtime.log"),
        );
        assert!(!sidecar_runtime_should_probe_health(&runtime));

        let child = std::process::Command::new(std::env::current_exe().unwrap())
            .arg("--sidecar-runtime-probe-test-child")
            .spawn()
            .expect("spawn test child");
        let orphan = sidecar_runtime_mark_spawned(&mut runtime, child);
        terminate_sidecar_child(orphan);
        sidecar_runtime_mark_health_failed(&mut runtime, &SidecarError::Timeout);
        assert!(sidecar_runtime_should_probe_health(&runtime));

        sidecar_runtime_mark_ready(
            &mut runtime,
            HealthInfo {
                ok: true,
                app_version: "0.1.0".into(),
                api_version: "0.1.0".into(),
                schema_version: "0.1.0".into(),
                providers: vec!["netease".into(), "qq".into()],
            },
            456,
        );
        assert_eq!(runtime.phase, SidecarPhase::Ready);
        assert!(!sidecar_runtime_should_probe_health(&runtime));
        assert_eq!(runtime.last_health_ok_ms, Some(456));
        assert_eq!(
            runtime.providers,
            vec!["netease".to_string(), "qq".to_string()]
        );
        terminate_sidecar_child(sidecar_runtime_mark_stopped(&mut runtime));
    }

    #[test]
    fn sidecar_runtime_stop_without_child_is_idempotent() {
        let mut runtime = SidecarRuntimeState::new(
            "http://127.0.0.1:38123".to_string(),
            PathBuf::from("/tmp/logs/sidecar-runtime.log"),
        );
        assert!(sidecar_runtime_mark_stopped(&mut runtime).is_none());
        assert_eq!(runtime.phase, SidecarPhase::Stopped);
        assert!(sidecar_runtime_mark_stopped(&mut runtime).is_none());
        assert_eq!(runtime.phase, SidecarPhase::Stopped);
    }

    #[test]
    fn parse_health_response_ok_body() {
        let body = br#"{"ok":true,"appVersion":"x","apiVersion":"0.1.0","schemaVersion":"0.1.0","providers":["netease","qq"]}"#;
        let info = parse_health_response(body).expect("should parse");
        assert!(info.ok);
        assert_eq!(info.app_version, "x");
        assert_eq!(info.api_version, "0.1.0");
        assert_eq!(info.schema_version, "0.1.0");
        assert_eq!(
            info.providers,
            vec!["netease".to_string(), "qq".to_string()]
        );
    }

    #[test]
    fn parse_health_response_extracts_provider_ids_from_status_matrix() {
        let body = r#"{
            "ok": true,
            "appVersion": "x",
            "apiVersion": "0.1.0",
            "schemaVersion": "0.1.0",
            "providers": [],
            "providerStatus": {
                "version": "0.1.0",
                "providers": [
                    {
                        "providerId": "netease",
                        "available": true,
                        "capabilities": ["search"],
                        "message": "online"
                    },
                    {
                        "providerId": "qq",
                        "available": true,
                        "capabilities": ["search"],
                        "message": "online"
                    }
                ]
            }
        }"#;
        let info = parse_health_response(body.as_bytes()).expect("should parse");
        assert_eq!(
            info.providers,
            vec!["netease".to_string(), "qq".to_string()]
        );
    }

    #[test]
    fn parse_health_response_tolerates_missing_providers() {
        let body = br#"{"ok":true,"appVersion":"x","apiVersion":"0.1.0","schemaVersion":"0.1.0"}"#;
        let info = parse_health_response(body).expect("should parse");
        assert!(info.providers.is_empty());
    }

    #[test]
    fn parse_health_response_tolerates_non_array_providers() {
        let body = br#"{"ok":true,"appVersion":"x","apiVersion":"0.1.0","schemaVersion":"0.1.0","providers":"netease"}"#;
        let info = parse_health_response(body).expect("should parse");
        assert!(info.providers.is_empty());
    }

    #[test]
    fn parse_health_response_rejects_ok_false() {
        let body = br#"{"ok":false,"appVersion":"x","apiVersion":"0.1.0","schemaVersion":"0.1.0"}"#;
        let err = parse_health_response(body).expect_err("should reject");
        assert!(matches!(err, SidecarError::BadStatus));
    }

    #[test]
    fn parse_health_response_rejects_garbage() {
        let err = parse_health_response(b"not json").expect_err("should reject");
        assert!(matches!(err, SidecarError::Parse(_)));
    }

    #[test]
    fn wait_for_health_succeeds_against_test_listener() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let body = br#"{"ok":true,"appVersion":"x","apiVersion":"0.1.0","schemaVersion":"0.1.0","providers":[]}"#.to_vec();
        std::thread::spawn(move || {
            for mut stream in listener.incoming().flatten() {
                let mut req = [0u8; 4096];
                let _ = std::io::Read::read(&mut stream, &mut req);
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(resp.as_bytes());
                let _ = stream.write_all(&body);
                let _ = stream.flush();
                let _ = stream.shutdown(std::net::Shutdown::Both);
            }
        });
        let base_url = format!("http://127.0.0.1:{}", port);
        let info = wait_for_health(&base_url, std::time::Duration::from_secs(3))
            .expect("should succeed against in-test listener");
        assert!(info.ok);
        assert_eq!(info.app_version, "x");
        assert_eq!(info.api_version, "0.1.0");
        assert_eq!(info.schema_version, "0.1.0");
    }

    #[test]
    fn wait_for_health_uses_content_length_before_socket_close() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let body = br#"{"ok":true,"appVersion":"x","apiVersion":"0.1.0","schemaVersion":"0.1.0","providers":["netease"]}"#.to_vec();
        std::thread::spawn(move || {
            let Ok((mut stream, _)) = listener.accept() else {
                return;
            };
            let mut req = [0u8; 4096];
            let _ = std::io::Read::read(&mut stream, &mut req);
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: keep-alive\r\n\r\n",
                body.len()
            );
            let _ = stream.write_all(resp.as_bytes());
            let _ = stream.write_all(&body);
            let _ = stream.flush();
            std::thread::sleep(std::time::Duration::from_secs(2));
        });
        let base_url = format!("http://127.0.0.1:{}", port);
        let started_at = std::time::Instant::now();
        let info = wait_for_health(&base_url, std::time::Duration::from_secs(3))
            .expect("should parse complete body before socket close");
        assert!(started_at.elapsed() < std::time::Duration::from_millis(800));
        assert_eq!(info.providers, vec!["netease"]);
    }

    #[test]
    fn wait_for_health_times_out_against_unbound_port() {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        drop(l);
        let base_url = format!("http://127.0.0.1:{}", port);
        let result = wait_for_health(&base_url, std::time::Duration::from_millis(150));
        assert!(matches!(result, Err(SidecarError::Timeout)));
    }

    #[test]
    fn wait_for_health_rejects_bad_url() {
        let result = wait_for_health("not-a-url", std::time::Duration::from_millis(50));
        assert!(matches!(result, Err(SidecarError::BadUrl)));
    }
}
