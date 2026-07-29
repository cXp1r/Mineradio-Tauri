use crate::{
    app::window_labels as labels,
    runtime::window_adapter::{
        clamp_webview_window_geometry, current_webview_display_geometry,
        current_window_display_geometry, tauri_window_geometry,
        webview_display_geometry_for_bounds,
    },
    AppState, DesktopLyricsPollerChild, DesktopLyricsRuntimeState,
};
use serde::{Deserialize, Serialize};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{
    Emitter, Manager, PhysicalPosition, Position, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};

const DESKTOP_LYRICS_MAX_MOVE_DELTA: f64 = 4096.0;
const DESKTOP_LYRICS_DEFAULT_WIDTH: i32 = 880;
const DESKTOP_LYRICS_DEFAULT_HEIGHT: i32 = 340;
const DESKTOP_LYRICS_MIDDLE_CLICK_DEBOUNCE_MS: u64 = 260;
pub const DESKTOP_LYRICS_PROGRAMMATIC_BOUNDS_GUARD_MS: u64 = 120;

pub fn desktop_lyrics_window_url() -> &'static str {
    "index.html?view=desktop-lyrics"
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

#[cfg(test)]
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
    scale_factor: f64,
) -> DesktopLyricsNativeMiddleClickState {
    DesktopLyricsNativeMiddleClickState {
        enabled: true,
        click_through: lyrics.click_through,
        hot_bounds: lyrics
            .hot_bounds
            .map(|bounds| desktop_lyrics_scale_hot_bounds(bounds, scale_factor)),
        last_middle_at_ms: lyrics.last_middle_at_ms,
    }
}

#[allow(dead_code)]
fn store_desktop_lyrics_native_middle_click_state(
    lyrics: &mut DesktopLyricsRuntimeState,
    native: DesktopLyricsNativeMiddleClickState,
) {
    lyrics.click_through = native.click_through;
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

pub fn desktop_lyrics_terminate_poller_child(child: Option<DesktopLyricsPollerChild>) -> bool {
    let Some(child) = child else {
        return false;
    };
    if let Err(e) = child.terminate() {
        eprintln!("desktop lyrics poller terminate failed: {}", e);
    }
    true
}

pub fn desktop_lyrics_position_delta(
    dx: f64,
    dy: f64,
    scale_factor: f64,
) -> Result<(i32, i32), String> {
    if !dx.is_finite() || !dy.is_finite() || !scale_factor.is_finite() || scale_factor <= 0.0 {
        return Err("DESKTOP_LYRICS_INVALID_MOVE_DELTA".into());
    }
    if dx.abs() > DESKTOP_LYRICS_MAX_MOVE_DELTA || dy.abs() > DESKTOP_LYRICS_MAX_MOVE_DELTA {
        return Err("DESKTOP_LYRICS_MOVE_DELTA_OUT_OF_RANGE".into());
    }
    let physical_dx = dx * scale_factor;
    let physical_dy = dy * scale_factor;
    if !physical_dx.is_finite()
        || !physical_dy.is_finite()
        || physical_dx < i32::MIN as f64
        || physical_dx > i32::MAX as f64
        || physical_dy < i32::MIN as f64
        || physical_dy > i32::MAX as f64
    {
        return Err("DESKTOP_LYRICS_MOVE_DELTA_OUT_OF_RANGE".into());
    }
    Ok((physical_dx.round() as i32, physical_dy.round() as i32))
}

pub fn desktop_lyrics_next_position(
    current_x: i32,
    current_y: i32,
    dx: f64,
    dy: f64,
    scale_factor: f64,
) -> Result<(i32, i32), String> {
    let (px, py) = desktop_lyrics_position_delta(dx, dy, scale_factor)?;
    let next_x = current_x
        .checked_add(px)
        .ok_or_else(|| "DESKTOP_LYRICS_POSITION_OVERFLOW".to_string())?;
    let next_y = current_y
        .checked_add(py)
        .ok_or_else(|| "DESKTOP_LYRICS_POSITION_OVERFLOW".to_string())?;
    Ok((next_x, next_y))
}

pub fn desktop_lyrics_mark_programmatic_bounds_change(
    lyrics: &mut DesktopLyricsRuntimeState,
    now_ms: u64,
) {
    lyrics.programmatic_bounds_until_ms =
        now_ms.saturating_add(DESKTOP_LYRICS_PROGRAMMATIC_BOUNDS_GUARD_MS);
}

pub fn desktop_lyrics_observe_window_geometry(
    lyrics: &mut DesktopLyricsRuntimeState,
    now_ms: u64,
    bounds: crate::runtime::window::WindowGeometry,
    monitor_bounds: Option<crate::runtime::window::WindowGeometry>,
    scale_factor: Option<f64>,
) -> bool {
    lyrics.monitor_bounds = monitor_bounds;
    lyrics.scale_factor = scale_factor.filter(|scale| scale.is_finite() && *scale > 0.0);
    if now_ms <= lyrics.programmatic_bounds_until_ms {
        return false;
    }
    lyrics.user_bounds = Some(bounds);
    true
}

pub fn desktop_lyrics_commit_user_geometry(
    lyrics: &mut DesktopLyricsRuntimeState,
    now_ms: u64,
    bounds: crate::runtime::window::WindowGeometry,
    monitor_bounds: Option<crate::runtime::window::WindowGeometry>,
    scale_factor: Option<f64>,
) {
    lyrics.user_bounds = Some(bounds);
    lyrics.monitor_bounds = monitor_bounds;
    lyrics.scale_factor = scale_factor.filter(|scale| scale.is_finite() && *scale > 0.0);
    desktop_lyrics_mark_programmatic_bounds_change(lyrics, now_ms);
}

pub fn desktop_lyrics_cache_payload(
    lyrics: &mut DesktopLyricsRuntimeState,
    payload: serde_json::Value,
) -> serde_json::Value {
    lyrics.payload_generation = lyrics.payload_generation.wrapping_add(1).max(1);
    lyrics.latest_payload = Some(payload.clone());
    payload
}

pub fn desktop_lyrics_cached_replay(
    latest_payload: Option<serde_json::Value>,
    click_through: bool,
) -> (Option<serde_json::Value>, bool) {
    (latest_payload, click_through)
}

pub fn desktop_lyrics_payload_with_runtime_lock(
    mut payload: serde_json::Value,
    click_through: bool,
) -> serde_json::Value {
    if let Some(object) = payload.as_object_mut() {
        object.insert(
            "clickThrough".to_string(),
            serde_json::Value::Bool(click_through),
        );
    }
    payload
}

#[cfg(test)]
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

    let state = app.state::<AppState>();
    let (y_ratio, user_bounds, click_through) = state
        .desktop_lyrics
        .lock()
        .map(|lyrics| {
            (
                lyrics
                    .latest_payload
                    .as_ref()
                    .and_then(|payload| payload.get("y"))
                    .and_then(serde_json::Value::as_f64)
                    .unwrap_or(0.76),
                lyrics.user_bounds,
                lyrics.click_through,
            )
        })
        .unwrap_or((0.76, None, desktop_lyrics_default_click_through()));
    let main_window = app.get_webview_window(labels::MAIN);
    let (geometry, display) = match (main_window.as_ref(), user_bounds) {
        (Some(main), Some(bounds)) => {
            let recovered = clamp_webview_window_geometry(main, bounds, 24);
            let display = webview_display_geometry_for_bounds(main, recovered)
                .or_else(|| current_webview_display_geometry(main));
            (recovered, display)
        }
        (Some(main), None) => {
            let display = current_webview_display_geometry(main);
            let geometry = display
                .map(|display| {
                    crate::runtime::window::desktop_lyrics_default_geometry(display, y_ratio)
                })
                .unwrap_or(crate::runtime::window::WindowGeometry {
                    x: 80,
                    y: 80,
                    width: 880,
                    height: 340,
                });
            (geometry, display)
        }
        (None, Some(bounds)) => (bounds, None),
        (None, None) => (
            crate::runtime::window::WindowGeometry {
                x: 80,
                y: 80,
                width: 880,
                height: 340,
            },
            None,
        ),
    };
    let scale_factor = display
        .map(|display| display.scale_factor)
        .filter(|scale| scale.is_finite() && *scale > 0.0)
        .unwrap_or(1.0);
    let logical = crate::runtime::window::desktop_lyrics_builder_geometry(geometry, scale_factor);
    if let Ok(mut lyrics) = state.desktop_lyrics.lock() {
        desktop_lyrics_mark_programmatic_bounds_change(&mut lyrics, desktop_lyrics_now_ms());
        lyrics.monitor_bounds = display.as_ref().map(crate::runtime::window::display_bounds);
        lyrics.scale_factor = Some(scale_factor);
        lyrics.overlay_ready = false;
    }

    let win = WebviewWindowBuilder::new(
        app,
        labels::DESKTOP_LYRICS,
        WebviewUrl::App(desktop_lyrics_window_url().into()),
    )
    .title("MineRadio-Tauri Desktop Lyrics")
    .decorations(false)
    .always_on_top(true)
    .resizable(false)
    .transparent(true)
    .focused(false)
    .inner_size(logical.width, logical.height)
    .min_inner_size(320.0 / scale_factor, 180.0 / scale_factor)
    .position(logical.x, logical.y)
    .skip_taskbar(true)
    .build()
    .map_err(|e| e.to_string())?;
    if let Ok(mut lyrics) = state.desktop_lyrics.lock() {
        desktop_lyrics_mark_programmatic_bounds_change(&mut lyrics, desktop_lyrics_now_ms());
    }
    // Builder 只接收 logical 单位；创建后再以 physical bounds 校正一次，避免
    // Windows 在相邻混合 DPI 显示器的逻辑坐标区间重叠时选错初始 monitor。
    win.set_position(Position::Physical(PhysicalPosition {
        x: geometry.x,
        y: geometry.y,
    }))
    .map_err(|e| e.to_string())?;
    win.set_size(tauri::Size::Physical(tauri::PhysicalSize {
        width: geometry.width,
        height: geometry.height,
    }))
    .map_err(|e| e.to_string())?;
    win.set_ignore_cursor_events(click_through)
        .map_err(|e| e.to_string())?;
    desktop_lyrics_constrain_window(app)?;
    Ok(win)
}

pub fn desktop_lyrics_constrain_window(app: &tauri::AppHandle) -> Result<(), String> {
    let Some(win) = desktop_lyrics_window(app) else {
        return Ok(());
    };
    let position = win.outer_position().map_err(|e| e.to_string())?;
    let size = win.inner_size().map_err(|e| e.to_string())?;
    let desired = crate::runtime::window::WindowGeometry {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
    };
    let clamped = clamp_webview_window_geometry(&win, desired, 24);
    let display = webview_display_geometry_for_bounds(&win, clamped)
        .or_else(|| current_webview_display_geometry(&win));
    if let Ok(mut lyrics) = app.state::<AppState>().desktop_lyrics.lock() {
        lyrics.monitor_bounds = display.as_ref().map(crate::runtime::window::display_bounds);
        lyrics.scale_factor = display
            .map(|display| display.scale_factor)
            .filter(|scale| scale.is_finite() && *scale > 0.0);
        if clamped != desired {
            desktop_lyrics_mark_programmatic_bounds_change(&mut lyrics, desktop_lyrics_now_ms());
        }
    }
    if clamped.width != desired.width || clamped.height != desired.height {
        win.set_size(tauri::Size::Physical(tauri::PhysicalSize {
            width: clamped.width,
            height: clamped.height,
        }))
        .map_err(|e| e.to_string())?;
    }
    if clamped.x != desired.x || clamped.y != desired.y {
        win.set_position(Position::Physical(PhysicalPosition {
            x: clamped.x,
            y: clamped.y,
        }))
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn persist_desktop_lyrics_user_bounds(
    state: &AppState,
    bounds: crate::runtime::window::WindowGeometry,
) -> Result<(), String> {
    state
        .runtime_settings
        .lock()
        .map_err(|error| error.to_string())?
        .set_desktop_lyrics_bounds(Some(bounds))
        .map_err(|error| error.to_string())
}

pub fn flush_desktop_lyrics_user_bounds(state: &AppState) -> Result<(), String> {
    let bounds = state
        .desktop_lyrics
        .lock()
        .map_err(|error| error.to_string())?
        .user_bounds;
    match bounds {
        Some(bounds) => persist_desktop_lyrics_user_bounds(state, bounds),
        None => Ok(()),
    }
}

pub fn handle_window_geometry_event(
    window: &tauri::Window,
    programmatic: bool,
) -> Result<(), String> {
    let app = window.app_handle();
    let now_ms = desktop_lyrics_now_ms();
    if programmatic {
        let state = app.state::<AppState>();
        let mut lyrics = state.desktop_lyrics.lock().map_err(|e| e.to_string())?;
        desktop_lyrics_mark_programmatic_bounds_change(&mut lyrics, now_ms);
    }
    desktop_lyrics_constrain_window(app)?;
    let bounds = tauri_window_geometry(window);
    let display = current_window_display_geometry(window);
    let should_persist = {
        let state = app.state::<AppState>();
        let mut lyrics = state.desktop_lyrics.lock().map_err(|e| e.to_string())?;
        desktop_lyrics_observe_window_geometry(
            &mut lyrics,
            now_ms,
            bounds,
            display.as_ref().map(crate::runtime::window::display_bounds),
            display.map(|display| display.scale_factor),
        )
    };
    if should_persist {
        persist_desktop_lyrics_user_bounds(app.state::<AppState>().inner(), bounds)?;
    }
    Ok(())
}

pub fn show_window(app: &tauri::AppHandle, state: &AppState) -> Result<(), String> {
    let win = ensure_desktop_lyrics_window(app)?;
    desktop_lyrics_constrain_window(app)?;
    let click_through = state
        .desktop_lyrics
        .lock()
        .map_err(|e| e.to_string())?
        .click_through;
    desktop_lyrics_start_middle_click_poller(app.clone(), state)?;
    win.set_ignore_cursor_events(click_through)
        .map_err(|e| e.to_string())?;
    win.show().map_err(|e| e.to_string())?;
    Ok(())
}

pub fn close_window(app: &tauri::AppHandle, state: &AppState) -> Result<(), String> {
    if let Err(error) = flush_desktop_lyrics_user_bounds(state) {
        state.diagnostics.record_runtime_error(
            crate::runtime::diagnostics::DiagnosticProbeKind::DesktopLyrics,
            desktop_lyrics_now_ms(),
            format!("desktop lyrics bounds persist failed: {error}"),
        );
    }
    {
        let mut lyrics = state.desktop_lyrics.lock().map_err(|e| e.to_string())?;
        lyrics.overlay_ready = false;
        let (_, child) = desktop_lyrics_stop_middle_click_poller_state(&mut lyrics);
        drop(lyrics);
        desktop_lyrics_terminate_poller_child(child);
    }
    if let Some(win) = desktop_lyrics_window(app) {
        win.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn set_click_through(
    app: &tauri::AppHandle,
    state: &AppState,
    click_through: bool,
) -> Result<(), String> {
    let win = ensure_desktop_lyrics_window(app)?;
    desktop_lyrics_constrain_window(app)?;
    desktop_lyrics_start_middle_click_poller(app.clone(), state)?;
    {
        let mut lyrics = state.desktop_lyrics.lock().map_err(|e| e.to_string())?;
        lyrics.click_through = click_through;
    }
    let intent = desktop_lyrics_lock_intent(click_through);
    win.set_ignore_cursor_events(intent.ignore_cursor_events)
        .map_err(|e| e.to_string())?;
    app.emit("desktop-lyrics-lock-changed", click_through)
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn set_hot_bounds(state: &AppState, bounds: DesktopLyricsHotBounds) -> Result<(), String> {
    let logical = desktop_lyrics_relative_hot_bounds(
        bounds.left.into(),
        bounds.top.into(),
        bounds.right.into(),
        bounds.bottom.into(),
    );
    let mut lyrics = state.desktop_lyrics.lock().map_err(|e| e.to_string())?;
    lyrics.hot_bounds = Some(logical);
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
    desktop_lyrics_apply_native_middle_click_event_scaled(
        lyrics,
        now_ms,
        cursor_screen_point,
        window_position,
        1.0,
    )
}

pub fn desktop_lyrics_apply_native_middle_click_event_scaled(
    lyrics: &mut DesktopLyricsRuntimeState,
    now_ms: u64,
    cursor_screen_point: (i32, i32),
    window_position: (i32, i32),
    scale_factor: f64,
) -> Option<bool> {
    let mut native = desktop_lyrics_native_middle_click_state(lyrics, scale_factor);
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
    let scale_factor = win.scale_factor().unwrap_or(1.0);
    let next = {
        let state = app.state::<AppState>();
        let mut lyrics = state.desktop_lyrics.lock().map_err(|e| e.to_string())?;
        desktop_lyrics_apply_native_middle_click_event_scaled(
            &mut lyrics,
            desktop_lyrics_now_ms(),
            cursor_screen_point,
            (position.x, position.y),
            scale_factor,
        )
    };
    if let Some(click_through) = next {
        win.set_ignore_cursor_events(click_through)
            .map_err(|e| e.to_string())?;
        app.emit("desktop-lyrics-lock-changed", click_through)
            .map_err(|e| e.to_string())?;
    }
    Ok(next)
}

#[cfg(target_os = "windows")]
fn desktop_lyrics_spawn_middle_click_poller(
    app: tauri::AppHandle,
) -> Result<DesktopLyricsPollerChild, String> {
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    use windows_sys::Win32::{
        Foundation::POINT,
        UI::{
            Input::KeyboardAndMouse::{GetAsyncKeyState, VK_MBUTTON},
            WindowsAndMessaging::GetCursorPos,
        },
    };

    let stop = Arc::new(AtomicBool::new(false));
    let worker_stop = Arc::clone(&stop);
    let worker = std::thread::Builder::new()
        .name("mineradio-desktop-lyrics-input".to_string())
        .spawn(move || {
            let mut previous_down = false;
            while !worker_stop.load(Ordering::Acquire) {
                // SAFETY: 仅调用只读的 user32 键鼠状态接口，POINT 由当前线程独占。
                let down = unsafe { GetAsyncKeyState(i32::from(VK_MBUTTON)) & i16::MIN } != 0;
                if down && !previous_down {
                    let mut point = POINT { x: 0, y: 0 };
                    // SAFETY: point 是有效且可写的栈地址，调用结束后立即复制坐标。
                    if unsafe { GetCursorPos(&mut point) } != 0 {
                        let _ = desktop_lyrics_apply_native_middle_click_to_window(
                            &app,
                            (point.x, point.y),
                        );
                    }
                }
                previous_down = down;
                std::thread::sleep(Duration::from_millis(24));
            }
        })
        .map_err(|error| error.to_string())?;
    Ok(DesktopLyricsPollerChild::new(stop, worker))
}

#[cfg(not(target_os = "windows"))]
fn desktop_lyrics_spawn_middle_click_poller(
    _app: tauri::AppHandle,
) -> Result<DesktopLyricsPollerChild, String> {
    Err("DESKTOP_LYRICS_POLLER_UNSUPPORTED".into())
}

#[cfg(not(target_os = "windows"))]
fn desktop_lyrics_start_middle_click_poller(
    app: tauri::AppHandle,
    state: &AppState,
) -> Result<(), String> {
    let _ = app;
    let _ = state;
    Ok(())
}

#[cfg(target_os = "windows")]
fn desktop_lyrics_start_middle_click_poller(
    app: tauri::AppHandle,
    state: &AppState,
) -> Result<(), String> {
    let mut lyrics = state.desktop_lyrics.lock().map_err(|e| e.to_string())?;
    if !desktop_lyrics_start_middle_click_poller_state(&mut lyrics, None) {
        return Ok(());
    }
    drop(lyrics);

    let child = match desktop_lyrics_spawn_middle_click_poller(app) {
        Ok(child) => child,
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

pub fn move_by(app: &tauri::AppHandle, dx: f64, dy: f64) -> Result<(), String> {
    let win = ensure_desktop_lyrics_window(app)?;
    let current = win.outer_position().map_err(|e| e.to_string())?;
    let size = win.inner_size().map_err(|e| e.to_string())?;
    let scale_factor = win.scale_factor().unwrap_or(1.0);
    let (x, y) = desktop_lyrics_next_position(current.x, current.y, dx, dy, scale_factor)?;
    let clamped = clamp_webview_window_geometry(
        &win,
        crate::runtime::window::WindowGeometry {
            x,
            y,
            width: size.width,
            height: size.height,
        },
        24,
    );
    let display = webview_display_geometry_for_bounds(&win, clamped)
        .or_else(|| current_webview_display_geometry(&win));
    {
        let state = app.state::<AppState>();
        let mut lyrics = state.desktop_lyrics.lock().map_err(|e| e.to_string())?;
        desktop_lyrics_mark_programmatic_bounds_change(&mut lyrics, desktop_lyrics_now_ms());
    }
    win.set_position(Position::Physical(PhysicalPosition {
        x: clamped.x,
        y: clamped.y,
    }))
    .map_err(|e| e.to_string())?;
    {
        let state = app.state::<AppState>();
        let mut lyrics = state.desktop_lyrics.lock().map_err(|e| e.to_string())?;
        desktop_lyrics_commit_user_geometry(
            &mut lyrics,
            desktop_lyrics_now_ms(),
            clamped,
            display.as_ref().map(crate::runtime::window::display_bounds),
            display.map(|display| display.scale_factor),
        );
    }
    Ok(())
}

pub fn update_payload(
    app: &tauri::AppHandle,
    state: &AppState,
    mut payload: serde_json::Value,
) -> Result<(), String> {
    {
        let mut lyrics = state.desktop_lyrics.lock().map_err(|e| e.to_string())?;
        payload = desktop_lyrics_payload_with_runtime_lock(payload, lyrics.click_through);
        payload = desktop_lyrics_cache_payload(&mut lyrics, payload);
    }
    let win = ensure_desktop_lyrics_window(app)?;
    desktop_lyrics_constrain_window(app)?;
    desktop_lyrics_start_middle_click_poller(app.clone(), state)?;
    win.emit("desktop-lyrics-payload", payload)
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn overlay_ready(app: &tauri::AppHandle, state: &AppState) -> Result<(), String> {
    let Some(win) = desktop_lyrics_window(app) else {
        return Ok(());
    };
    let (latest_payload, click_through) = {
        let mut lyrics = state.desktop_lyrics.lock().map_err(|e| e.to_string())?;
        lyrics.overlay_ready = true;
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
            user_bounds: None,
            programmatic_bounds_until_ms: 0,
            overlay_ready: false,
            payload_generation: 0,
            monitor_bounds: None,
            scale_factor: None,
            last_middle_at_ms: 0,
            poller_running: false,
            poller_starting: false,
            poller_desired: false,
            poller_child: None,
        }
    }

    #[test]
    fn desktop_lyrics_window_url_points_to_overlay_route() {
        assert_eq!(
            desktop_lyrics_window_url(),
            "index.html?view=desktop-lyrics"
        );
    }

    #[test]
    fn desktop_lyrics_lock_intent_maps_to_ignore_cursor_events() {
        assert!(desktop_lyrics_lock_intent(true).ignore_cursor_events);
        assert!(!desktop_lyrics_lock_intent(false).ignore_cursor_events);
    }

    #[test]
    fn desktop_lyrics_default_lock_starts_click_through() {
        assert!(desktop_lyrics_default_click_through());
    }

    #[test]
    fn desktop_lyrics_position_delta_rounds_to_physical_pixels() {
        assert_eq!(desktop_lyrics_position_delta(4.4, -2.6, 1.0), Ok((4, -3)));
        assert_eq!(desktop_lyrics_position_delta(8.0, -4.0, 1.25), Ok((10, -5)));
        assert_eq!(desktop_lyrics_position_delta(8.0, -4.0, 1.5), Ok((12, -6)));
    }

    #[test]
    fn desktop_lyrics_position_delta_rejects_invalid_values() {
        assert!(desktop_lyrics_position_delta(f64::NAN, 0.0, 1.0).is_err());
        assert!(desktop_lyrics_position_delta(f64::INFINITY, 0.0, 1.0).is_err());
        assert!(desktop_lyrics_position_delta(4096.1, 0.0, 1.0).is_err());
        assert!(desktop_lyrics_position_delta(1.0, 1.0, 0.0).is_err());
        assert!(desktop_lyrics_position_delta(1.0, 1.0, f64::NAN).is_err());
    }

    #[test]
    fn desktop_lyrics_next_position_rejects_overflow() {
        assert_eq!(
            desktop_lyrics_next_position(80, 80, 12.0, -3.0, 1.0),
            Ok((92, 77))
        );
        assert_eq!(
            desktop_lyrics_next_position(-1900, 80, 20.0, -10.0, 1.5),
            Ok((-1870, 65))
        );
        assert!(desktop_lyrics_next_position(i32::MAX, 0, 1.0, 0.0, 1.0).is_err());
        assert!(desktop_lyrics_next_position(i32::MIN, 0, -1.0, 0.0, 1.0).is_err());
    }

    #[test]
    fn programmatic_bounds_guard_preserves_user_bounds_but_updates_monitor_diagnostics() {
        let mut lyrics = test_desktop_lyrics_runtime_state();
        let original = crate::runtime::window::WindowGeometry {
            x: -1200,
            y: 300,
            width: 1000,
            height: 340,
        };
        let clamped = crate::runtime::window::WindowGeometry {
            x: 24,
            y: 300,
            width: 1000,
            height: 340,
        };
        let monitor = crate::runtime::window::WindowGeometry {
            x: 0,
            y: 0,
            width: 2560,
            height: 1440,
        };
        lyrics.user_bounds = Some(original);
        desktop_lyrics_mark_programmatic_bounds_change(&mut lyrics, 1_000);

        assert!(!desktop_lyrics_observe_window_geometry(
            &mut lyrics,
            1_120,
            clamped,
            Some(monitor),
            Some(1.5),
        ));
        assert_eq!(lyrics.user_bounds, Some(original));
        assert_eq!(lyrics.monitor_bounds, Some(monitor));
        assert_eq!(lyrics.scale_factor, Some(1.5));

        assert!(desktop_lyrics_observe_window_geometry(
            &mut lyrics,
            1_121,
            clamped,
            Some(monitor),
            Some(1.5),
        ));
        assert_eq!(lyrics.user_bounds, Some(clamped));
    }

    #[test]
    fn payload_generation_and_overlay_ready_track_overlay_lifecycle() {
        let mut lyrics = test_desktop_lyrics_runtime_state();
        desktop_lyrics_cache_payload(&mut lyrics, serde_json::json!({ "line": 1 }));
        desktop_lyrics_cache_payload(&mut lyrics, serde_json::json!({ "line": 2 }));
        lyrics.overlay_ready = true;

        assert_eq!(lyrics.payload_generation, 2);
        assert!(lyrics.overlay_ready);
        assert_eq!(
            lyrics.latest_payload,
            Some(serde_json::json!({ "line": 2 }))
        );

        lyrics.overlay_ready = false;
        assert!(!lyrics.overlay_ready);
    }

    #[test]
    fn desktop_lyrics_cached_replay_keeps_latest_payload_and_lock() {
        let payload = serde_json::json!({ "enabled": true, "text": "cached" });
        let (latest, click_through) = desktop_lyrics_cached_replay(Some(payload.clone()), false);
        assert_eq!(latest, Some(payload));
        assert!(!click_through);
    }

    #[test]
    fn desktop_lyrics_payload_runtime_lock_overrides_stale_renderer_value() {
        let payload = desktop_lyrics_payload_with_runtime_lock(
            serde_json::json!({ "text": "line", "clickThrough": true }),
            false,
        );
        assert_eq!(payload["clickThrough"], serde_json::json!(false));
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
                width: 880,
                height: 340,
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
    fn desktop_lyrics_scaled_native_event_hits_logical_bounds_at_fractional_dpi() {
        let logical_bounds = DesktopLyricsHotBounds {
            left: 10,
            top: 20,
            right: 210,
            bottom: 80,
        };

        for (scale_factor, outside_point, inside_point) in [
            (1.25, (112, 225), (113, 225)),
            (1.5, (114, 230), (115, 230)),
        ] {
            let mut lyrics = test_desktop_lyrics_runtime_state();
            lyrics.hot_bounds = Some(logical_bounds);

            assert_eq!(
                desktop_lyrics_apply_native_middle_click_event_scaled(
                    &mut lyrics,
                    3_000,
                    outside_point,
                    (100, 200),
                    scale_factor,
                ),
                None,
                "scale_factor={scale_factor}"
            );
            assert_eq!(
                desktop_lyrics_apply_native_middle_click_event_scaled(
                    &mut lyrics,
                    3_000,
                    inside_point,
                    (100, 200),
                    scale_factor,
                ),
                Some(false),
                "scale_factor={scale_factor}"
            );
            assert_eq!(
                lyrics.hot_bounds,
                Some(logical_bounds),
                "runtime 必须继续保存 logical hot bounds，scale_factor={scale_factor}"
            );
        }
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
