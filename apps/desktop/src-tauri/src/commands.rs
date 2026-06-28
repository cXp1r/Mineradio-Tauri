//! Tauri command handlers for the Mineradio runtime shell.
//!
//! `export_json_file` and `import_json_file` use Rust-owned JSON file dialogs:
//! the frontend sends data or receives parsed JSON, while paths come only from
//! the native open/save dialog result.

use crate::{AppState, DesktopLyricsPollerChild, DesktopLyricsRuntimeState};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{
    Emitter, Manager, PhysicalPosition, Position, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};
use tauri_plugin_dialog::DialogExt;

const DESKTOP_LYRICS_MAX_MOVE_DELTA: f64 = 4096.0;
const DESKTOP_LYRICS_DEFAULT_WIDTH: i32 = 760;
const DESKTOP_LYRICS_DEFAULT_HEIGHT: i32 = 120;
const DESKTOP_LYRICS_MIDDLE_CLICK_DEBOUNCE_MS: u64 = 260;
const DEFAULT_JSON_EXPORT_FILE_NAME: &str = "mineradio-export.json";
#[allow(dead_code)]
const NETEASE_LOGIN_COOKIE_PRIORITY: &[&str] = &["MUSIC_U", "__csrf", "NMTID"];
#[allow(dead_code)]
const QQ_LOGIN_COOKIE_PRIORITY: &[&str] = &[
    "uin",
    "qqmusic_uin",
    "wxuin",
    "p_uin",
    "qm_keyst",
    "qqmusic_key",
    "music_key",
    "wxskey",
    "p_skey",
    "skey",
];

pub mod labels {
    pub const MAIN: &str = "main";
    pub const DESKTOP_LYRICS: &str = "desktop-lyrics";
    pub const WALLPAPER: &str = "wallpaper";
    pub const LOGIN_NETEASE: &str = "login-netease";
    pub const LOGIN_QQ: &str = "login-qq";
}

#[tauri::command]
pub fn get_runtime_config(state: tauri::State<'_, AppState>) -> crate::RuntimeConfig {
    state.config.clone()
}

fn main_window(app: &tauri::AppHandle) -> Result<tauri::WebviewWindow, String> {
    app.get_webview_window(labels::MAIN)
        .ok_or_else(|| "main window not found".to_string())
}

pub fn desktop_lyrics_window_url() -> &'static str {
    "index.html?view=desktop-lyrics"
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoginProvider {
    Netease,
    Qq,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LoginWindowConfig {
    pub provider: LoginProvider,
    pub label: &'static str,
    pub url: &'static str,
    pub title: &'static str,
    pub width: f64,
    pub height: f64,
    pub min_width: f64,
    pub min_height: f64,
}

#[allow(dead_code)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoginCookie {
    pub name: String,
    pub value: String,
    pub domain: String,
}

impl LoginCookie {
    #[allow(dead_code)]
    pub fn new(
        name: impl Into<String>,
        value: impl Into<String>,
        domain: impl Into<String>,
    ) -> Self {
        Self {
            name: name.into(),
            value: value.into(),
            domain: domain.into(),
        }
    }
}

pub fn login_window_config(provider: LoginProvider) -> LoginWindowConfig {
    match provider {
        LoginProvider::Netease => LoginWindowConfig {
            provider,
            label: labels::LOGIN_NETEASE,
            url: "https://music.163.com/#/login",
            title: "网易云音乐登录",
            width: 940.0,
            height: 760.0,
            min_width: 780.0,
            min_height: 580.0,
        },
        LoginProvider::Qq => LoginWindowConfig {
            provider,
            label: labels::LOGIN_QQ,
            url: "https://y.qq.com/n/ryqq/profile",
            title: "QQ 音乐登录",
            width: 900.0,
            height: 720.0,
            min_width: 760.0,
            min_height: 560.0,
        },
    }
}

#[allow(dead_code)]
fn parse_cookie_header(cookie_text: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for part in cookie_text.split(';') {
        let raw = part.trim();
        let Some((name, value)) = raw.split_once('=') else {
            continue;
        };
        let name = name.trim();
        if name.is_empty() {
            continue;
        }
        out.insert(name.to_string(), value.trim().to_string());
    }
    out
}

#[allow(dead_code)]
pub fn netease_cookie_has_login(cookie_text: &str) -> bool {
    parse_cookie_header(cookie_text).contains_key("MUSIC_U")
}

#[allow(dead_code)]
pub fn qq_cookie_has_login(cookie_text: &str) -> bool {
    let obj = parse_cookie_header(cookie_text);
    let raw_uin = if obj.get("login_type").and_then(|v| v.parse::<u8>().ok()) == Some(2) {
        obj.get("wxuin")
            .or_else(|| obj.get("uin"))
            .or_else(|| obj.get("p_uin"))
    } else {
        obj.get("uin")
            .or_else(|| obj.get("qqmusic_uin"))
            .or_else(|| obj.get("wxuin"))
            .or_else(|| obj.get("p_uin"))
    };
    let has_uin = raw_uin
        .map(|value| value.chars().any(|c| c.is_ascii_digit()))
        .unwrap_or(false);
    let has_key = [
        "qm_keyst",
        "qqmusic_key",
        "music_key",
        "p_skey",
        "skey",
        "psrf_qqaccess_token",
        "psrf_qqrefresh_token",
        "wxrefresh_token",
        "wxskey",
    ]
    .iter()
    .any(|name| obj.get(*name).map(|v| !v.is_empty()).unwrap_or(false));
    has_uin && has_key
}

#[allow(dead_code)]
pub fn qq_cookie_has_playback_login(cookie_text: &str) -> bool {
    let obj = parse_cookie_header(cookie_text);
    let raw_uin = if obj.get("login_type").and_then(|v| v.parse::<u8>().ok()) == Some(2) {
        obj.get("wxuin")
            .or_else(|| obj.get("uin"))
            .or_else(|| obj.get("p_uin"))
    } else {
        obj.get("uin")
            .or_else(|| obj.get("qqmusic_uin"))
            .or_else(|| obj.get("wxuin"))
            .or_else(|| obj.get("p_uin"))
    };
    let has_uin = raw_uin
        .map(|value| value.chars().any(|c| c.is_ascii_digit()))
        .unwrap_or(false);
    let has_key = ["qm_keyst", "qqmusic_key", "music_key", "wxskey"]
        .iter()
        .any(|name| obj.get(*name).map(|v| !v.is_empty()).unwrap_or(false));
    has_uin && has_key
}

#[allow(dead_code)]
fn normalize_cookie_domain(domain: &str) -> String {
    domain.trim().trim_start_matches('.').to_ascii_lowercase()
}

#[allow(dead_code)]
pub fn is_qq_cookie_domain(domain: &str) -> bool {
    let normalized = normalize_cookie_domain(domain);
    normalized == "qq.com"
        || normalized.ends_with(".qq.com")
        || normalized.ends_with("qqmusic.qq.com")
}

#[allow(dead_code)]
pub fn is_netease_cookie_domain(domain: &str) -> bool {
    let normalized = normalize_cookie_domain(domain);
    normalized == "163.com"
        || normalized.ends_with(".163.com")
        || normalized == "music.163.com"
        || normalized.ends_with(".music.163.com")
        || normalized == "netease.com"
        || normalized.ends_with(".netease.com")
}

#[allow(dead_code)]
pub fn build_login_cookie_header(
    cookies: &[LoginCookie],
    is_allowed_domain: fn(&str) -> bool,
    priority: &[&str],
) -> String {
    let mut picked: HashMap<String, String> = HashMap::new();
    for cookie in cookies {
        if cookie.name.is_empty() || !is_allowed_domain(&cookie.domain) {
            continue;
        }
        picked.insert(cookie.name.clone(), cookie.value.clone());
    }

    let mut ordered = Vec::new();
    for name in priority {
        if let Some(value) = picked.remove(*name) {
            ordered.push(((*name).to_string(), value));
        }
    }
    let mut rest: Vec<(String, String)> = picked.into_iter().collect();
    rest.sort_by(|a, b| a.0.cmp(&b.0));
    ordered.extend(rest);

    ordered
        .into_iter()
        .filter(|(_, value)| !value.is_empty())
        .map(|(name, value)| format!("{}={}", name, value))
        .collect::<Vec<_>>()
        .join("; ")
}

#[allow(dead_code)]
pub fn build_netease_login_cookie_header(cookies: &[LoginCookie]) -> String {
    build_login_cookie_header(
        cookies,
        is_netease_cookie_domain,
        NETEASE_LOGIN_COOKIE_PRIORITY,
    )
}

#[allow(dead_code)]
pub fn build_qq_login_cookie_header(cookies: &[LoginCookie]) -> String {
    build_login_cookie_header(cookies, is_qq_cookie_domain, QQ_LOGIN_COOKIE_PRIORITY)
}

fn login_window(app: &tauri::AppHandle, provider: LoginProvider) -> Option<WebviewWindow> {
    app.get_webview_window(login_window_config(provider).label)
}

fn ensure_login_window(
    app: &tauri::AppHandle,
    provider: LoginProvider,
) -> Result<WebviewWindow, String> {
    let config = login_window_config(provider);
    if let Some(win) = login_window(app, provider) {
        win.show().map_err(|e| e.to_string())?;
        win.set_focus().map_err(|e| e.to_string())?;
        return Ok(win);
    }

    let url = tauri::Url::parse(config.url).map_err(|e| e.to_string())?;
    let win = WebviewWindowBuilder::new(app, config.label, WebviewUrl::External(url))
        .title(config.title)
        .inner_size(config.width, config.height)
        .min_inner_size(config.min_width, config.min_height)
        .resizable(true)
        .decorations(true)
        .build()
        .map_err(|e| e.to_string())?;
    win.show().map_err(|e| e.to_string())?;
    Ok(win)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DesktopLyricsLockIntent {
    pub ignore_cursor_events: bool,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct DesktopLyricsHotBounds {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DesktopLyricsScreenBounds {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DesktopLyricsNativeMiddleClickState {
    pub enabled: bool,
    pub click_through: bool,
    pub hot_bounds: Option<DesktopLyricsHotBounds>,
    pub last_middle_at_ms: u64,
}

pub fn desktop_lyrics_lock_intent(click_through: bool) -> DesktopLyricsLockIntent {
    DesktopLyricsLockIntent {
        ignore_cursor_events: click_through,
    }
}

pub fn desktop_lyrics_default_click_through() -> bool {
    true
}

fn clamp_hot_bound(value: f64, fallback: i32) -> i32 {
    if !value.is_finite() {
        return fallback;
    }
    (value.round() as i32).clamp(-2000, 6000)
}

pub fn desktop_lyrics_relative_hot_bounds(
    left: f64,
    top: f64,
    right: f64,
    bottom: f64,
) -> DesktopLyricsHotBounds {
    let left = clamp_hot_bound(left, 0);
    let top = clamp_hot_bound(top, 0);
    let right = clamp_hot_bound(right, 1).max(left + 1);
    let bottom = clamp_hot_bound(bottom, 1).max(top + 1);
    DesktopLyricsHotBounds {
        left,
        top,
        right,
        bottom,
    }
}

pub fn desktop_lyrics_scale_hot_bounds(
    bounds: DesktopLyricsHotBounds,
    scale_factor: f64,
) -> DesktopLyricsHotBounds {
    let scale = if scale_factor.is_finite() && scale_factor > 0.0 {
        scale_factor
    } else {
        1.0
    };
    desktop_lyrics_relative_hot_bounds(
        bounds.left as f64 * scale,
        bounds.top as f64 * scale,
        bounds.right as f64 * scale,
        bounds.bottom as f64 * scale,
    )
}

#[allow(dead_code)]
pub fn desktop_lyrics_hot_bounds_on_screen(
    window_position: (i32, i32),
    hot_bounds: Option<DesktopLyricsHotBounds>,
) -> DesktopLyricsScreenBounds {
    match hot_bounds {
        Some(bounds) => DesktopLyricsScreenBounds {
            x: window_position.0 + bounds.left,
            y: window_position.1 + bounds.top,
            width: (bounds.right - bounds.left).max(1),
            height: (bounds.bottom - bounds.top).max(1),
        },
        None => DesktopLyricsScreenBounds {
            x: window_position.0,
            y: window_position.1,
            width: DESKTOP_LYRICS_DEFAULT_WIDTH,
            height: DESKTOP_LYRICS_DEFAULT_HEIGHT,
        },
    }
}

#[allow(dead_code)]
pub fn desktop_lyrics_point_in_bounds(
    point: (i32, i32),
    bounds: DesktopLyricsScreenBounds,
) -> bool {
    point.0 >= bounds.x
        && point.0 <= bounds.x + bounds.width
        && point.1 >= bounds.y
        && point.1 <= bounds.y + bounds.height
}

#[allow(dead_code)]
pub fn desktop_lyrics_handle_middle_click(
    state: &mut DesktopLyricsNativeMiddleClickState,
    now_ms: u64,
    cursor_screen_point: (i32, i32),
    window_position: (i32, i32),
) -> Option<bool> {
    if !state.enabled {
        return None;
    }
    if now_ms.saturating_sub(state.last_middle_at_ms) < DESKTOP_LYRICS_MIDDLE_CLICK_DEBOUNCE_MS {
        return None;
    }
    let bounds = desktop_lyrics_hot_bounds_on_screen(window_position, state.hot_bounds);
    if !desktop_lyrics_point_in_bounds(cursor_screen_point, bounds) {
        return None;
    }
    state.last_middle_at_ms = now_ms;
    state.click_through = !state.click_through;
    Some(state.click_through)
}

pub fn desktop_lyrics_parse_poller_line(line: &str) -> Option<(i32, i32)> {
    let mut parts = line.split_whitespace();
    if parts.next()? != "MMB" {
        return None;
    }
    let x = parts.next()?.parse::<i32>().ok()?;
    let y = parts.next()?.parse::<i32>().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some((x, y))
}

pub fn desktop_lyrics_now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

#[allow(dead_code)]
fn desktop_lyrics_native_middle_click_state(
    lyrics: &DesktopLyricsRuntimeState,
) -> DesktopLyricsNativeMiddleClickState {
    DesktopLyricsNativeMiddleClickState {
        enabled: true,
        click_through: lyrics.click_through,
        hot_bounds: lyrics.hot_bounds,
        last_middle_at_ms: lyrics.last_middle_at_ms,
    }
}

#[allow(dead_code)]
fn store_desktop_lyrics_native_middle_click_state(
    lyrics: &mut DesktopLyricsRuntimeState,
    native: DesktopLyricsNativeMiddleClickState,
) {
    lyrics.click_through = native.click_through;
    lyrics.hot_bounds = native.hot_bounds;
    lyrics.last_middle_at_ms = native.last_middle_at_ms;
}

pub fn desktop_lyrics_start_middle_click_poller_state(
    lyrics: &mut DesktopLyricsRuntimeState,
    child: Option<DesktopLyricsPollerChild>,
) -> bool {
    if lyrics.poller_running || lyrics.poller_starting || lyrics.poller_child.is_some() {
        return false;
    }
    lyrics.poller_desired = true;
    if child.is_none() {
        lyrics.poller_starting = true;
        return true;
    }
    lyrics.poller_running = true;
    lyrics.poller_starting = false;
    lyrics.poller_child = child;
    true
}

pub fn desktop_lyrics_finish_middle_click_poller_start_state(
    lyrics: &mut DesktopLyricsRuntimeState,
    child: DesktopLyricsPollerChild,
) -> Option<DesktopLyricsPollerChild> {
    lyrics.poller_starting = false;
    if !lyrics.poller_desired || lyrics.poller_running || lyrics.poller_child.is_some() {
        return Some(child);
    }
    lyrics.poller_running = true;
    lyrics.poller_child = Some(child);
    None
}

pub fn desktop_lyrics_cancel_middle_click_poller_start_state(
    lyrics: &mut DesktopLyricsRuntimeState,
) {
    lyrics.poller_starting = false;
}

pub fn desktop_lyrics_stop_middle_click_poller_state(
    lyrics: &mut DesktopLyricsRuntimeState,
) -> (bool, Option<DesktopLyricsPollerChild>) {
    let was_running =
        lyrics.poller_running || lyrics.poller_starting || lyrics.poller_child.is_some();
    let child = lyrics.poller_child.take();
    lyrics.poller_running = false;
    lyrics.poller_starting = false;
    lyrics.poller_desired = false;
    (was_running, child)
}

fn desktop_lyrics_terminate_poller_child(child: Option<DesktopLyricsPollerChild>) -> bool {
    let Some(child) = child else {
        return false;
    };
    if let Err(e) = child.terminate() {
        eprintln!("desktop lyrics poller terminate failed: {}", e);
    }
    true
}

pub fn desktop_lyrics_position_delta(dx: f64, dy: f64) -> Result<(i32, i32), String> {
    if !dx.is_finite() || !dy.is_finite() {
        return Err("DESKTOP_LYRICS_INVALID_MOVE_DELTA".into());
    }
    if dx.abs() > DESKTOP_LYRICS_MAX_MOVE_DELTA || dy.abs() > DESKTOP_LYRICS_MAX_MOVE_DELTA {
        return Err("DESKTOP_LYRICS_MOVE_DELTA_OUT_OF_RANGE".into());
    }
    Ok((dx.round() as i32, dy.round() as i32))
}

pub fn desktop_lyrics_next_position(
    current_x: i32,
    current_y: i32,
    dx: f64,
    dy: f64,
) -> Result<(i32, i32), String> {
    let (px, py) = desktop_lyrics_position_delta(dx, dy)?;
    let next_x = current_x
        .checked_add(px)
        .ok_or_else(|| "DESKTOP_LYRICS_POSITION_OVERFLOW".to_string())?;
    let next_y = current_y
        .checked_add(py)
        .ok_or_else(|| "DESKTOP_LYRICS_POSITION_OVERFLOW".to_string())?;
    Ok((next_x, next_y))
}

pub fn desktop_lyrics_cached_replay(
    latest_payload: Option<serde_json::Value>,
    click_through: bool,
) -> (Option<serde_json::Value>, bool) {
    (latest_payload, click_through)
}

pub fn desktop_lyrics_show_click_through_state() -> bool {
    desktop_lyrics_default_click_through()
}

fn desktop_lyrics_window(app: &tauri::AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(labels::DESKTOP_LYRICS)
}

fn ensure_desktop_lyrics_window(app: &tauri::AppHandle) -> Result<WebviewWindow, String> {
    if let Some(win) = desktop_lyrics_window(app) {
        return Ok(win);
    }

    let win = WebviewWindowBuilder::new(
        app,
        labels::DESKTOP_LYRICS,
        WebviewUrl::App(desktop_lyrics_window_url().into()),
    )
    .title("Mineradio Desktop Lyrics")
    .transparent(true)
    .decorations(false)
    .always_on_top(true)
    .resizable(false)
    .inner_size(760.0, 120.0)
    .position(80.0, 80.0)
    .skip_taskbar(true)
    .build()
    .map_err(|e| e.to_string())?;
    win.set_ignore_cursor_events(desktop_lyrics_default_click_through())
        .map_err(|e| e.to_string())?;
    Ok(win)
}

#[tauri::command]
pub fn window_minimize(app: tauri::AppHandle) -> Result<(), String> {
    let win = main_window(&app)?;
    win.minimize().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn window_toggle_maximize(app: tauri::AppHandle) -> Result<(), String> {
    let win = main_window(&app)?;
    if win.is_maximized().unwrap_or(false) {
        win.unmaximize().map_err(|e| e.to_string())?;
    } else {
        win.maximize().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn window_toggle_fullscreen(app: tauri::AppHandle) -> Result<(), String> {
    let win = main_window(&app)?;
    let fs = win.is_fullscreen().unwrap_or(false);
    win.set_fullscreen(!fs).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn window_close(app: tauri::AppHandle) -> Result<(), String> {
    let win = main_window(&app)?;
    win.close().map_err(|e| e.to_string())
}

pub fn is_openable_url(url: &str) -> bool {
    url.starts_with("http://") || url.starts_with("https://")
}

#[tauri::command]
pub fn open_external(url: String) -> Result<(), String> {
    if !is_openable_url(&url) {
        return Err("INVALID_URL".into());
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &url])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&url)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ExportJsonFileResult {
    pub cancelled: bool,
    pub path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ImportJsonFileResult {
    pub cancelled: bool,
    pub path: Option<String>,
    pub data: Option<serde_json::Value>,
}

pub fn sanitize_json_file_name(file_name: &str) -> String {
    let trimmed = file_name.trim();
    let leaf = trimmed
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("")
        .trim()
        .trim_matches('.');
    let sanitized = leaf
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect::<String>()
        .trim()
        .trim_matches('.')
        .to_string();

    let base = if sanitized.is_empty() {
        DEFAULT_JSON_EXPORT_FILE_NAME.to_string()
    } else {
        sanitized
    };
    if path_has_json_extension(Path::new(&base)) {
        base
    } else {
        format!("{}.json", base)
    }
}

pub fn path_has_json_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("json"))
        .unwrap_or(false)
}

pub fn ensure_json_extension(path: PathBuf) -> PathBuf {
    if path.extension().is_none() {
        path.with_extension("json")
    } else {
        path
    }
}

pub fn serialize_json_pretty(data: &serde_json::Value) -> Result<String, String> {
    serde_json::to_string_pretty(data)
        .map(|text| format!("{}\n", text))
        .map_err(|_| "EXPORT_JSON_SERIALIZE_FAILED".to_string())
}

pub fn parse_imported_json(text: &str) -> Result<serde_json::Value, String> {
    serde_json::from_str(text).map_err(|_| "IMPORT_JSON_INVALID_JSON".to_string())
}

pub fn export_json_cancelled_result() -> ExportJsonFileResult {
    ExportJsonFileResult {
        cancelled: true,
        path: None,
    }
}

pub fn import_json_cancelled_result() -> ImportJsonFileResult {
    ImportJsonFileResult {
        cancelled: true,
        path: None,
        data: None,
    }
}

fn export_json_success_result(path: &Path) -> ExportJsonFileResult {
    ExportJsonFileResult {
        cancelled: false,
        path: Some(path.to_string_lossy().to_string()),
    }
}

fn import_json_success_result(path: &Path, data: serde_json::Value) -> ImportJsonFileResult {
    ImportJsonFileResult {
        cancelled: false,
        path: Some(path.to_string_lossy().to_string()),
        data: Some(data),
    }
}

async fn receive_json_dialog_selection(
    mut rx: tauri::async_runtime::Receiver<Option<tauri_plugin_dialog::FilePath>>,
    error_code: &'static str,
) -> Result<Option<tauri_plugin_dialog::FilePath>, String> {
    rx.recv().await.ok_or_else(|| error_code.to_string())
}

#[tauri::command]
pub async fn export_json_file(
    app: tauri::AppHandle,
    file_name: String,
    data: serde_json::Value,
) -> Result<ExportJsonFileResult, String> {
    let default_file_name = sanitize_json_file_name(&file_name);
    let (tx, rx) = tauri::async_runtime::channel(1);
    app.dialog()
        .file()
        .add_filter("JSON", &["json"])
        .set_file_name(default_file_name)
        .save_file(move |selected_path| {
            let _ = tx.try_send(selected_path);
        });

    let Some(selected_path) =
        receive_json_dialog_selection(rx, "EXPORT_JSON_DIALOG_CLOSED").await?
    else {
        return Ok(export_json_cancelled_result());
    };

    let path = selected_path
        .into_path()
        .map_err(|_| "EXPORT_JSON_INVALID_PATH".to_string())?;
    let path = ensure_json_extension(path);
    if !path_has_json_extension(&path) {
        return Err("EXPORT_JSON_INVALID_EXTENSION".into());
    }
    if path.is_dir() {
        return Err("EXPORT_JSON_PATH_IS_DIRECTORY".into());
    }

    let text = serialize_json_pretty(&data)?;
    let write_path = path.clone();
    tauri::async_runtime::spawn_blocking(move || fs::write(&write_path, text))
        .await
        .map_err(|_| "EXPORT_JSON_WRITE_FAILED".to_string())?
        .map_err(|_| "EXPORT_JSON_WRITE_FAILED".to_string())?;
    Ok(export_json_success_result(&path))
}

#[tauri::command]
pub async fn import_json_file(app: tauri::AppHandle) -> Result<ImportJsonFileResult, String> {
    let (tx, rx) = tauri::async_runtime::channel(1);
    app.dialog()
        .file()
        .add_filter("JSON", &["json"])
        .pick_file(move |selected_path| {
            let _ = tx.try_send(selected_path);
        });

    let Some(selected_path) =
        receive_json_dialog_selection(rx, "IMPORT_JSON_DIALOG_CLOSED").await?
    else {
        return Ok(import_json_cancelled_result());
    };

    let path = selected_path
        .into_path()
        .map_err(|_| "IMPORT_JSON_INVALID_PATH".to_string())?;
    if !path_has_json_extension(&path) {
        return Err("IMPORT_JSON_INVALID_EXTENSION".into());
    }
    if !path.is_file() {
        return Err("IMPORT_JSON_PATH_NOT_FILE".into());
    }

    let read_path = path.clone();
    let text = tauri::async_runtime::spawn_blocking(move || fs::read_to_string(&read_path))
        .await
        .map_err(|_| "IMPORT_JSON_READ_FAILED".to_string())?
        .map_err(|_| "IMPORT_JSON_READ_FAILED".to_string())?;
    let data = parse_imported_json(&text)?;
    Ok(import_json_success_result(&path, data))
}

#[tauri::command]
pub fn desktop_lyrics_show_window(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let win = ensure_desktop_lyrics_window(&app)?;
    let click_through = desktop_lyrics_show_click_through_state();
    {
        let mut lyrics = state.desktop_lyrics.lock().map_err(|e| e.to_string())?;
        lyrics.click_through = click_through;
    }
    desktop_lyrics_start_middle_click_poller(app.clone(), state)?;
    win.set_ignore_cursor_events(click_through)
        .map_err(|e| e.to_string())?;
    win.show().map_err(|e| e.to_string())?;
    win.set_focus().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn desktop_lyrics_close_window(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    {
        let mut lyrics = state.desktop_lyrics.lock().map_err(|e| e.to_string())?;
        let (_, child) = desktop_lyrics_stop_middle_click_poller_state(&mut lyrics);
        drop(lyrics);
        desktop_lyrics_terminate_poller_child(child);
    }
    if let Some(win) = desktop_lyrics_window(&app) {
        win.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn login_netease_show_window(app: tauri::AppHandle) -> Result<(), String> {
    ensure_login_window(&app, LoginProvider::Netease).map(|_| ())
}

#[tauri::command]
pub fn login_qq_show_window(app: tauri::AppHandle) -> Result<(), String> {
    ensure_login_window(&app, LoginProvider::Qq).map(|_| ())
}

#[tauri::command]
pub fn login_netease_close_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(win) = login_window(&app, LoginProvider::Netease) {
        win.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn login_qq_close_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(win) = login_window(&app, LoginProvider::Qq) {
        win.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn desktop_lyrics_set_click_through(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    click_through: bool,
) -> Result<(), String> {
    let win = ensure_desktop_lyrics_window(&app)?;
    desktop_lyrics_start_middle_click_poller(app.clone(), state.clone())?;
    {
        let mut lyrics = state.desktop_lyrics.lock().map_err(|e| e.to_string())?;
        lyrics.click_through = click_through;
    }
    let intent = desktop_lyrics_lock_intent(click_through);
    win.set_ignore_cursor_events(intent.ignore_cursor_events)
        .map_err(|e| e.to_string())?;
    win.emit("desktop-lyrics-lock-changed", click_through)
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn desktop_lyrics_set_hot_bounds(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    bounds: DesktopLyricsHotBounds,
) -> Result<(), String> {
    let logical = desktop_lyrics_relative_hot_bounds(
        bounds.left.into(),
        bounds.top.into(),
        bounds.right.into(),
        bounds.bottom.into(),
    );
    let scale_factor = desktop_lyrics_window(&app)
        .and_then(|win| win.scale_factor().ok())
        .unwrap_or(1.0);
    let normalized = desktop_lyrics_scale_hot_bounds(logical, scale_factor);
    let mut lyrics = state.desktop_lyrics.lock().map_err(|e| e.to_string())?;
    lyrics.hot_bounds = Some(normalized);
    Ok(())
}

#[allow(dead_code)]
pub fn desktop_lyrics_native_middle_click_toggle(
    lyrics: &mut DesktopLyricsRuntimeState,
    now_ms: u64,
    cursor_screen_point: (i32, i32),
    window_position: (i32, i32),
) -> Option<bool> {
    desktop_lyrics_apply_native_middle_click_event(
        lyrics,
        now_ms,
        cursor_screen_point,
        window_position,
    )
}

pub fn desktop_lyrics_apply_native_middle_click_event(
    lyrics: &mut DesktopLyricsRuntimeState,
    now_ms: u64,
    cursor_screen_point: (i32, i32),
    window_position: (i32, i32),
) -> Option<bool> {
    let mut native = desktop_lyrics_native_middle_click_state(lyrics);
    let result = desktop_lyrics_handle_middle_click(
        &mut native,
        now_ms,
        cursor_screen_point,
        window_position,
    );
    store_desktop_lyrics_native_middle_click_state(lyrics, native);
    result
}

fn desktop_lyrics_apply_native_middle_click_to_window(
    app: &tauri::AppHandle,
    cursor_screen_point: (i32, i32),
) -> Result<Option<bool>, String> {
    let Some(win) = desktop_lyrics_window(app) else {
        return Ok(None);
    };
    let position = win.outer_position().map_err(|e| e.to_string())?;
    let next = {
        let state = app.state::<AppState>();
        let mut lyrics = state.desktop_lyrics.lock().map_err(|e| e.to_string())?;
        desktop_lyrics_apply_native_middle_click_event(
            &mut lyrics,
            desktop_lyrics_now_ms(),
            cursor_screen_point,
            (position.x, position.y),
        )
    };
    if let Some(click_through) = next {
        win.set_ignore_cursor_events(click_through)
            .map_err(|e| e.to_string())?;
        win.emit("desktop-lyrics-lock-changed", click_through)
            .map_err(|e| e.to_string())?;
    }
    Ok(next)
}

#[cfg(target_os = "windows")]
fn desktop_lyrics_spawn_middle_click_poller(app: tauri::AppHandle) -> Result<Child, String> {
    let script = r#"
$ErrorActionPreference = "SilentlyContinue"
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class MineradioMousePoll {
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT lpPoint);
  public struct POINT { public int X; public int Y; }
}
"@
$prev = $false
while ($true) {
  $down = (([MineradioMousePoll]::GetAsyncKeyState(4) -band 0x8000) -ne 0)
  if ($down -and -not $prev) {
    $pt = New-Object MineradioMousePoll+POINT
    if ([MineradioMousePoll]::GetCursorPos([ref]$pt)) {
      [Console]::Out.WriteLine("MMB {0} {1}" -f $pt.X, $pt.Y)
      [Console]::Out.Flush()
    }
  }
  $prev = $down
  Start-Sleep -Milliseconds 24
}
"#;
    let mut child = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-WindowStyle",
            "Hidden",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            script,
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;

    if let Some(stdout) = child.stdout.take() {
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().map_while(Result::ok) {
                let Some(point) = desktop_lyrics_parse_poller_line(&line) else {
                    continue;
                };
                let _ = desktop_lyrics_apply_native_middle_click_to_window(&app, point);
            }
        });
    }

    Ok(child)
}

#[cfg(not(target_os = "windows"))]
fn desktop_lyrics_spawn_middle_click_poller(_app: tauri::AppHandle) -> Result<Child, String> {
    Err("DESKTOP_LYRICS_POLLER_UNSUPPORTED".into())
}

fn desktop_lyrics_start_middle_click_poller(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
        let _ = state;
        return Ok(());
    }

    #[cfg(target_os = "windows")]
    {
        let mut lyrics = state.desktop_lyrics.lock().map_err(|e| e.to_string())?;
        if !desktop_lyrics_start_middle_click_poller_state(&mut lyrics, None) {
            return Ok(());
        }
    }

    let child = match desktop_lyrics_spawn_middle_click_poller(app) {
        Ok(child) => DesktopLyricsPollerChild::new(child),
        Err(e) => {
            let mut lyrics = state
                .desktop_lyrics
                .lock()
                .map_err(|lock_err| lock_err.to_string())?;
            desktop_lyrics_cancel_middle_click_poller_start_state(&mut lyrics);
            return Err(e);
        }
    };
    let mut lyrics = state.desktop_lyrics.lock().map_err(|e| e.to_string())?;
    let orphan = desktop_lyrics_finish_middle_click_poller_start_state(&mut lyrics, child);
    drop(lyrics);
    desktop_lyrics_terminate_poller_child(orphan);
    Ok(())
}

#[tauri::command]
pub fn desktop_lyrics_move_by(app: tauri::AppHandle, dx: f64, dy: f64) -> Result<(), String> {
    let win = ensure_desktop_lyrics_window(&app)?;
    let current = win.outer_position().map_err(|e| e.to_string())?;
    let (x, y) = desktop_lyrics_next_position(current.x, current.y, dx, dy)?;
    win.set_position(Position::Physical(PhysicalPosition { x, y }))
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn desktop_lyrics_update_payload(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    payload: serde_json::Value,
) -> Result<(), String> {
    {
        let mut lyrics = state.desktop_lyrics.lock().map_err(|e| e.to_string())?;
        lyrics.latest_payload = Some(payload.clone());
    }
    let win = ensure_desktop_lyrics_window(&app)?;
    desktop_lyrics_start_middle_click_poller(app.clone(), state)?;
    win.emit("desktop-lyrics-payload", payload)
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn desktop_lyrics_overlay_ready(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let Some(win) = desktop_lyrics_window(&app) else {
        return Ok(());
    };
    let (latest_payload, click_through) = {
        let lyrics = state.desktop_lyrics.lock().map_err(|e| e.to_string())?;
        desktop_lyrics_cached_replay(lyrics.latest_payload.clone(), lyrics.click_through)
    };
    if let Some(payload) = latest_payload {
        win.emit("desktop-lyrics-payload", payload)
            .map_err(|e| e.to_string())?;
    }
    win.emit("desktop-lyrics-lock-changed", click_through)
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_desktop_lyrics_runtime_state() -> DesktopLyricsRuntimeState {
        DesktopLyricsRuntimeState {
            latest_payload: None,
            click_through: true,
            hot_bounds: None,
            last_middle_at_ms: 0,
            poller_running: false,
            poller_starting: false,
            poller_desired: false,
            poller_child: None,
        }
    }

    #[test]
    fn openable_url_accepts_http_and_https() {
        assert!(is_openable_url("http://example.com"));
        assert!(is_openable_url("https://example.com/path"));
    }

    #[test]
    fn openable_url_rejects_non_http_schemes() {
        assert!(!is_openable_url("file:///etc/passwd"));
        assert!(!is_openable_url("javascript:alert(1)"));
        assert!(!is_openable_url("ftp://example.com"));
        assert!(!is_openable_url(""));
        assert!(!is_openable_url("data:text/plain,hi"));
    }

    #[test]
    fn json_export_default_file_name_is_sanitized_and_gets_json_extension() {
        assert_eq!(
            sanitize_json_file_name(" ../视觉/存档:name "),
            "存档_name.json"
        );
        assert_eq!(sanitize_json_file_name("preset.JSON"), "preset.JSON");
        assert_eq!(sanitize_json_file_name(""), "mineradio-export.json");
    }

    #[test]
    fn json_extension_guard_accepts_json_paths_only() {
        assert!(path_has_json_extension(std::path::Path::new("preset.json")));
        assert!(path_has_json_extension(std::path::Path::new("PRESET.JSON")));
        assert!(!path_has_json_extension(std::path::Path::new("preset.txt")));
        assert!(!path_has_json_extension(std::path::Path::new("preset")));
    }

    #[test]
    fn json_export_path_appends_extension_when_missing() {
        assert_eq!(
            ensure_json_extension(std::path::PathBuf::from("preset")),
            std::path::PathBuf::from("preset.json")
        );
        assert_eq!(
            ensure_json_extension(std::path::PathBuf::from("preset.JSON")),
            std::path::PathBuf::from("preset.JSON")
        );
    }

    #[test]
    fn json_pretty_serialization_uses_utf8_pretty_json() {
        let value = serde_json::json!({ "name": "视觉", "items": [1, 2] });
        let text = serialize_json_pretty(&value).expect("pretty json");

        assert!(text.contains("\n  \"name\": \"视觉\""));
        assert!(text.ends_with('\n'));
    }

    #[test]
    fn json_import_parse_returns_json_or_error_code() {
        assert_eq!(
            parse_imported_json("{\"enabled\":true}").expect("json"),
            serde_json::json!({ "enabled": true })
        );
        assert_eq!(
            parse_imported_json("{bad").expect_err("invalid json"),
            "IMPORT_JSON_INVALID_JSON"
        );
    }

    #[test]
    fn json_dialog_cancel_results_do_not_include_data() {
        assert_eq!(
            export_json_cancelled_result(),
            ExportJsonFileResult {
                cancelled: true,
                path: None,
            }
        );
        assert_eq!(
            import_json_cancelled_result(),
            ImportJsonFileResult {
                cancelled: true,
                path: None,
                data: None,
            }
        );
    }

    #[test]
    fn json_dialog_selection_receiver_resolves_cancelled_selection() {
        tauri::async_runtime::block_on(async {
            let (tx, rx) = tauri::async_runtime::channel(1);
            tx.try_send(None).expect("send cancelled selection");

            let selected = receive_json_dialog_selection(rx, "TEST_DIALOG_CLOSED")
                .await
                .expect("selection result");

            assert!(selected.is_none());
        });
    }

    #[test]
    fn desktop_lyrics_window_url_points_to_overlay_route() {
        assert_eq!(
            desktop_lyrics_window_url(),
            "index.html?view=desktop-lyrics"
        );
    }

    #[test]
    fn login_window_configs_match_reserved_labels_and_baseline_urls() {
        let netease = login_window_config(LoginProvider::Netease);
        assert_eq!(netease.label, labels::LOGIN_NETEASE);
        assert_eq!(netease.url, "https://music.163.com/#/login");
        assert_eq!(netease.title, "网易云音乐登录");
        assert_eq!((netease.width, netease.height), (940.0, 760.0));

        let qq = login_window_config(LoginProvider::Qq);
        assert_eq!(qq.label, labels::LOGIN_QQ);
        assert_eq!(qq.url, "https://y.qq.com/n/ryqq/profile");
        assert_eq!(qq.title, "QQ 音乐登录");
        assert_eq!((qq.width, qq.height), (900.0, 720.0));
    }

    #[test]
    fn login_cookie_detection_matches_provider_requirements() {
        assert!(netease_cookie_has_login("foo=bar; MUSIC_U=secret"));
        assert!(!netease_cookie_has_login("foo=bar"));
        assert!(qq_cookie_has_login("uin=o12345; skey=abc"));
        assert!(qq_cookie_has_playback_login(
            "wxuin=12345; wxskey=abc; login_type=2"
        ));
        assert!(!qq_cookie_has_playback_login("uin=12345; skey=abc"));
    }

    #[test]
    fn login_cookie_domain_filters_allow_provider_domains_only() {
        assert!(is_netease_cookie_domain(".music.163.com"));
        assert!(is_netease_cookie_domain("api.netease.com"));
        assert!(!is_netease_cookie_domain("qq.com"));

        assert!(is_qq_cookie_domain(".qq.com"));
        assert!(is_qq_cookie_domain("y.qq.com"));
        assert!(!is_qq_cookie_domain("music.163.com"));
    }

    #[test]
    fn login_cookie_header_builder_filters_domains_and_orders_priority() {
        let cookies = vec![
            LoginCookie::new("foo", "bar", "evil.example"),
            LoginCookie::new("MUSIC_U", "secret", ".music.163.com"),
            LoginCookie::new("__csrf", "csrf", "music.163.com"),
        ];

        let header = build_netease_login_cookie_header(&cookies);

        assert_eq!(header, "MUSIC_U=secret; __csrf=csrf");

        let qq_header = build_qq_login_cookie_header(&[
            LoginCookie::new("qm_keyst", "key", ".qq.com"),
            LoginCookie::new("uin", "123", "qq.com"),
            LoginCookie::new("MUSIC_U", "secret", ".music.163.com"),
        ]);
        assert_eq!(qq_header, "uin=123; qm_keyst=key");
    }

    #[test]
    fn desktop_lyrics_lock_intent_maps_to_ignore_cursor_events() {
        assert_eq!(desktop_lyrics_lock_intent(true).ignore_cursor_events, true);
        assert_eq!(
            desktop_lyrics_lock_intent(false).ignore_cursor_events,
            false
        );
    }

    #[test]
    fn desktop_lyrics_default_lock_starts_click_through() {
        assert_eq!(desktop_lyrics_default_click_through(), true);
    }

    #[test]
    fn desktop_lyrics_position_delta_rounds_to_physical_pixels() {
        assert_eq!(desktop_lyrics_position_delta(4.4, -2.6), Ok((4, -3)));
    }

    #[test]
    fn desktop_lyrics_position_delta_rejects_invalid_values() {
        assert!(desktop_lyrics_position_delta(f64::NAN, 0.0).is_err());
        assert!(desktop_lyrics_position_delta(f64::INFINITY, 0.0).is_err());
        assert!(desktop_lyrics_position_delta(4096.1, 0.0).is_err());
    }

    #[test]
    fn desktop_lyrics_next_position_rejects_overflow() {
        assert_eq!(
            desktop_lyrics_next_position(80, 80, 12.0, -3.0),
            Ok((92, 77))
        );
        assert!(desktop_lyrics_next_position(i32::MAX, 0, 1.0, 0.0).is_err());
        assert!(desktop_lyrics_next_position(i32::MIN, 0, -1.0, 0.0).is_err());
    }

    #[test]
    fn desktop_lyrics_cached_replay_keeps_latest_payload_and_lock() {
        let payload = serde_json::json!({ "enabled": true, "text": "cached" });
        let (latest, click_through) = desktop_lyrics_cached_replay(Some(payload.clone()), false);
        assert_eq!(latest, Some(payload));
        assert!(!click_through);
    }

    #[test]
    fn desktop_lyrics_show_click_through_state_matches_native_default() {
        assert_eq!(
            desktop_lyrics_show_click_through_state(),
            desktop_lyrics_default_click_through()
        );
    }

    #[test]
    fn desktop_lyrics_relative_hot_bounds_are_clamped_and_ordered() {
        assert_eq!(
            desktop_lyrics_relative_hot_bounds(-5000.0, 20.4, -4999.0, 20.6),
            DesktopLyricsHotBounds {
                left: -2000,
                top: 20,
                right: -1999,
                bottom: 21,
            }
        );
        assert_eq!(
            desktop_lyrics_relative_hot_bounds(f64::NAN, f64::INFINITY, f64::NEG_INFINITY, 0.0),
            DesktopLyricsHotBounds {
                left: 0,
                top: 0,
                right: 1,
                bottom: 1,
            }
        );
    }

    #[test]
    fn desktop_lyrics_hot_bounds_convert_to_screen_bounds() {
        let rel = DesktopLyricsHotBounds {
            left: 10,
            top: 20,
            right: 210,
            bottom: 80,
        };

        assert_eq!(
            desktop_lyrics_hot_bounds_on_screen((100, 200), Some(rel)),
            DesktopLyricsScreenBounds {
                x: 110,
                y: 220,
                width: 200,
                height: 60,
            }
        );
        assert_eq!(
            desktop_lyrics_hot_bounds_on_screen((100, 200), None),
            DesktopLyricsScreenBounds {
                x: 100,
                y: 200,
                width: 760,
                height: 120,
            }
        );
    }

    #[test]
    fn desktop_lyrics_point_in_bounds_uses_inclusive_edges() {
        let bounds = DesktopLyricsScreenBounds {
            x: 10,
            y: 20,
            width: 100,
            height: 40,
        };

        assert!(desktop_lyrics_point_in_bounds((10, 20), bounds));
        assert!(desktop_lyrics_point_in_bounds((110, 60), bounds));
        assert!(!desktop_lyrics_point_in_bounds((111, 60), bounds));
        assert!(!desktop_lyrics_point_in_bounds((110, 61), bounds));
    }

    #[test]
    fn desktop_lyrics_middle_click_toggle_debounces_and_updates_cache() {
        let hot_bounds = DesktopLyricsHotBounds {
            left: 10,
            top: 20,
            right: 210,
            bottom: 80,
        };
        let mut state = DesktopLyricsNativeMiddleClickState {
            enabled: true,
            click_through: true,
            hot_bounds: Some(hot_bounds),
            last_middle_at_ms: 0,
        };

        let first = desktop_lyrics_handle_middle_click(&mut state, 1_000, (150, 250), (100, 200));
        assert_eq!(first, Some(false));
        assert!(!state.click_through);
        assert_eq!(state.last_middle_at_ms, 1_000);

        let debounced =
            desktop_lyrics_handle_middle_click(&mut state, 1_200, (150, 250), (100, 200));
        assert_eq!(debounced, None);
        assert!(!state.click_through);

        let outside = desktop_lyrics_handle_middle_click(&mut state, 1_300, (500, 500), (100, 200));
        assert_eq!(outside, None);
        assert!(!state.click_through);

        let second = desktop_lyrics_handle_middle_click(&mut state, 1_300, (150, 250), (100, 200));
        assert_eq!(second, Some(true));
        assert!(state.click_through);
        assert_eq!(state.last_middle_at_ms, 1_300);
    }

    #[test]
    fn desktop_lyrics_middle_click_toggle_writes_runtime_state_cache() {
        let mut lyrics = test_desktop_lyrics_runtime_state();
        lyrics.latest_payload = Some(serde_json::json!({ "enabled": true, "text": "cached" }));
        lyrics.hot_bounds = Some(DesktopLyricsHotBounds {
            left: 10,
            top: 20,
            right: 210,
            bottom: 80,
        });

        let toggled =
            desktop_lyrics_native_middle_click_toggle(&mut lyrics, 2_000, (150, 250), (100, 200));

        assert_eq!(toggled, Some(false));
        assert!(!lyrics.click_through);
        assert_eq!(lyrics.last_middle_at_ms, 2_000);
        assert_eq!(
            lyrics.latest_payload,
            Some(serde_json::json!({ "enabled": true, "text": "cached" }))
        );
    }

    #[test]
    fn desktop_lyrics_poller_state_start_stop_is_idempotent() {
        let mut lyrics = test_desktop_lyrics_runtime_state();

        assert!(desktop_lyrics_start_middle_click_poller_state(
            &mut lyrics,
            None
        ));
        assert!(lyrics.poller_desired);
        assert!(lyrics.poller_starting);
        assert!(!lyrics.poller_running);
        assert!(!desktop_lyrics_start_middle_click_poller_state(
            &mut lyrics,
            None
        ));
        assert!(lyrics.poller_starting);
        let (was_running, child) = desktop_lyrics_stop_middle_click_poller_state(&mut lyrics);
        assert!(was_running);
        assert!(child.is_none());
        assert!(!lyrics.poller_desired);
        assert!(!lyrics.poller_starting);
        assert!(!lyrics.poller_running);
        let (was_running, child) = desktop_lyrics_stop_middle_click_poller_state(&mut lyrics);
        assert!(!was_running);
        assert!(child.is_none());
    }

    #[test]
    fn desktop_lyrics_finish_poller_start_drops_orphan_when_stop_wins_race() {
        let mut lyrics = test_desktop_lyrics_runtime_state();
        assert!(desktop_lyrics_start_middle_click_poller_state(
            &mut lyrics,
            None
        ));
        let (was_running, child) = desktop_lyrics_stop_middle_click_poller_state(&mut lyrics);
        assert!(was_running);
        assert!(child.is_none());

        let child = DesktopLyricsPollerChild::empty_for_test();
        let orphan = desktop_lyrics_finish_middle_click_poller_start_state(&mut lyrics, child);
        assert!(orphan.is_some());
        assert!(!lyrics.poller_running);
        assert!(lyrics.poller_child.is_none());
    }

    #[test]
    fn desktop_lyrics_poller_line_parser_accepts_mmb_coordinates() {
        assert_eq!(
            desktop_lyrics_parse_poller_line("MMB 123 -45"),
            Some((123, -45))
        );
        assert_eq!(
            desktop_lyrics_parse_poller_line("  MMB 0 9  "),
            Some((0, 9))
        );
        assert_eq!(desktop_lyrics_parse_poller_line("MMB"), None);
        assert_eq!(desktop_lyrics_parse_poller_line("MMB x 9"), None);
        assert_eq!(desktop_lyrics_parse_poller_line("CLICK 1 2"), None);
    }

    #[test]
    fn desktop_lyrics_scale_hot_bounds_converts_logical_css_to_physical() {
        assert_eq!(
            desktop_lyrics_scale_hot_bounds(
                DesktopLyricsHotBounds {
                    left: 10,
                    top: 20,
                    right: 210,
                    bottom: 80,
                },
                1.25,
            ),
            DesktopLyricsHotBounds {
                left: 13,
                top: 25,
                right: 263,
                bottom: 100,
            }
        );
        assert_eq!(
            desktop_lyrics_scale_hot_bounds(
                DesktopLyricsHotBounds {
                    left: 10,
                    top: 20,
                    right: 210,
                    bottom: 80,
                },
                1.5,
            ),
            DesktopLyricsHotBounds {
                left: 15,
                top: 30,
                right: 315,
                bottom: 120,
            }
        );
    }

    #[test]
    fn desktop_lyrics_apply_native_event_toggles_runtime_lock_state() {
        let mut lyrics = test_desktop_lyrics_runtime_state();
        lyrics.latest_payload = Some(serde_json::json!({ "enabled": true, "text": "cached" }));
        lyrics.hot_bounds = Some(DesktopLyricsHotBounds {
            left: 10,
            top: 20,
            right: 210,
            bottom: 80,
        });
        lyrics.poller_running = true;

        let toggled = desktop_lyrics_apply_native_middle_click_event(
            &mut lyrics,
            3_000,
            (150, 250),
            (100, 200),
        );

        assert_eq!(toggled, Some(false));
        assert!(!lyrics.click_through);
        assert_eq!(lyrics.last_middle_at_ms, 3_000);
        assert_eq!(
            lyrics.latest_payload,
            Some(serde_json::json!({ "enabled": true, "text": "cached" }))
        );
    }
}
