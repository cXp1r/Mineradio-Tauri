//! Tauri 窗口 API 适配层。
//!
//! 此模块承接原生窗口、显示器和事件发布细节；command Module 仅 re-export
//! 稳定契约并保留 transport 入口，避免实现细节重新膨胀进命令层。

use crate::{
    runtime::{
        window::{
            clamp_window_to_displays, display_for_window, display_topology, DebounceSchedule,
            DebounceWake, DisplayGeometry, DisplayTopology, WindowGeometry,
            WINDOW_STATE_DEBOUNCE_MS,
        },
        window_contract::{WindowDisplayBounds, WindowStateSnapshot},
    },
    AppState,
};
use std::time::Duration;
use tauri::{Emitter, Manager, WebviewWindow};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowStateEmitMode {
    Now,
    Debounced,
}

pub fn minimize(window: &WebviewWindow) -> Result<(), String> {
    window.minimize().map_err(|error| error.to_string())?;
    emit_window_state(window);
    Ok(())
}

pub fn toggle_maximize(window: &WebviewWindow) -> Result<(), String> {
    if window.is_maximized().unwrap_or(false) {
        window.unmaximize().map_err(|error| error.to_string())?;
    } else {
        window.maximize().map_err(|error| error.to_string())?;
    }
    emit_window_state(window);
    Ok(())
}

pub fn toggle_fullscreen(window: &WebviewWindow) -> Result<(), String> {
    let full_screen = window.is_fullscreen().unwrap_or(false);
    window
        .set_fullscreen(!full_screen)
        .map_err(|error| error.to_string())?;
    emit_window_state(window);
    Ok(())
}

pub fn request_close(window: &WebviewWindow) -> Result<(), String> {
    window.close().map_err(|error| error.to_string())
}

pub fn snapshot_for_webview_window(window: &WebviewWindow) -> WindowStateSnapshot {
    let is_native_full_screen = window.is_fullscreen().unwrap_or(false);
    build_window_state_snapshot_with_topology(
        window.is_maximized().unwrap_or(false),
        is_native_full_screen,
        window.is_minimized().unwrap_or(false),
        window.is_visible().unwrap_or(false),
        window.is_focused().unwrap_or(false),
        is_native_full_screen,
        topology_for_webview_window(window),
    )
}

pub fn emit_window_state(window: &WebviewWindow) {
    let _ = window.emit("desktop-window-state", snapshot_for_webview_window(window));
}

pub fn emit_window_state_for_window(window: &tauri::Window) {
    let _ = window.emit("desktop-window-state", snapshot_for_window(window));
}

/// 高频 move/resize 共用一个 worker；新的事件只提升 generation。
pub fn emit_window_state_debounced(window: tauri::Window) {
    let schedule = {
        let state = window.state::<AppState>();
        let schedule = match state.window_runtime.lock() {
            Ok(mut runtime) => Some(runtime.schedule_state_emit()),
            Err(_) => None,
        };
        schedule
    };
    let Some(DebounceSchedule::StartWorker { mut generation }) = schedule else {
        return;
    };
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(WINDOW_STATE_DEBOUNCE_MS));
        let wake = {
            let state = window.state::<AppState>();
            let wake = match state.window_runtime.lock() {
                Ok(mut runtime) => Some(runtime.wake_state_emit_worker(generation)),
                Err(_) => None,
            };
            wake
        };
        match wake {
            Some(DebounceWake::WaitAgain { generation: latest }) => generation = latest,
            Some(DebounceWake::EmitAndStop) => {
                emit_window_state_for_window(&window);
                break;
            }
            Some(DebounceWake::Disposed) | None => break,
        }
    });
}

pub fn state_emit_mode_for_event(event: &tauri::WindowEvent) -> Option<WindowStateEmitMode> {
    match event {
        tauri::WindowEvent::Resized(_) | tauri::WindowEvent::Moved(_) => {
            Some(WindowStateEmitMode::Debounced)
        }
        tauri::WindowEvent::Focused(_) | tauri::WindowEvent::ScaleFactorChanged { .. } => {
            Some(WindowStateEmitMode::Now)
        }
        _ => None,
    }
}

fn snapshot_for_window(window: &tauri::Window) -> WindowStateSnapshot {
    let is_native_full_screen = window.is_fullscreen().unwrap_or(false);
    build_window_state_snapshot_with_topology(
        window.is_maximized().unwrap_or(false),
        is_native_full_screen,
        window.is_minimized().unwrap_or(false),
        window.is_visible().unwrap_or(false),
        window.is_focused().unwrap_or(false),
        is_native_full_screen,
        topology_for_window(window),
    )
}

fn build_window_state_snapshot_with_topology(
    is_maximized: bool,
    is_native_full_screen: bool,
    is_minimized: bool,
    is_visible: bool,
    is_focused: bool,
    is_window_full_screen: bool,
    topology: DisplayTopology,
) -> WindowStateSnapshot {
    WindowStateSnapshot {
        is_maximized,
        is_native_full_screen,
        is_html_full_screen: false,
        is_window_full_screen,
        is_full_screen: is_native_full_screen || is_window_full_screen,
        is_minimized,
        is_visible,
        is_focused,
        is_primary_display: topology.is_primary,
        has_display_on_left: topology.has_left,
        has_display_on_right: topology.has_right,
        display_bounds: topology.current.map(|bounds| WindowDisplayBounds {
            x: bounds.x,
            y: bounds.y,
            width: bounds.width,
            height: bounds.height,
        }),
    }
}

fn topology_for_webview_window(window: &WebviewWindow) -> DisplayTopology {
    let geometry = webview_window_geometry(window);
    let monitors = window.available_monitors().unwrap_or_default();
    let primary = window.primary_monitor().ok().flatten();
    let displays = monitor_geometries(&monitors, primary.as_ref());
    display_topology(geometry, &displays)
}

pub fn clamp_webview_window_geometry(
    window: &WebviewWindow,
    desired: WindowGeometry,
    margin: u32,
) -> WindowGeometry {
    let monitors = window.available_monitors().unwrap_or_default();
    let primary = window.primary_monitor().ok().flatten();
    let displays = monitor_geometries(&monitors, primary.as_ref());
    clamp_window_to_displays(desired, &displays, margin)
}

pub fn current_webview_display_geometry(window: &WebviewWindow) -> Option<DisplayGeometry> {
    let monitor = window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten())?;
    let primary = window.primary_monitor().ok().flatten();
    Some(display_geometry_from_monitor(&monitor, primary.as_ref()))
}

pub fn webview_display_geometry_for_bounds(
    window: &WebviewWindow,
    bounds: WindowGeometry,
) -> Option<DisplayGeometry> {
    let monitors = window.available_monitors().unwrap_or_default();
    let primary = window.primary_monitor().ok().flatten();
    let displays = monitor_geometries(&monitors, primary.as_ref());
    display_for_window(bounds, &displays)
}

pub fn tauri_window_geometry(window: &tauri::Window) -> WindowGeometry {
    let position = window.outer_position().unwrap_or_default();
    let size = window.inner_size().unwrap_or_default();
    WindowGeometry {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
    }
}

pub fn current_window_display_geometry(window: &tauri::Window) -> Option<DisplayGeometry> {
    let monitor = window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten())?;
    let primary = window.primary_monitor().ok().flatten();
    Some(display_geometry_from_monitor(&monitor, primary.as_ref()))
}

fn topology_for_window(window: &tauri::Window) -> DisplayTopology {
    let geometry = window_geometry(window);
    let monitors = window.available_monitors().unwrap_or_default();
    let primary = window.primary_monitor().ok().flatten();
    let displays = monitor_geometries(&monitors, primary.as_ref());
    display_topology(geometry, &displays)
}

fn webview_window_geometry(window: &WebviewWindow) -> WindowGeometry {
    let position = window.outer_position().unwrap_or_default();
    let size = window.outer_size().unwrap_or_default();
    WindowGeometry {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
    }
}

fn window_geometry(window: &tauri::Window) -> WindowGeometry {
    let position = window.outer_position().unwrap_or_default();
    let size = window.outer_size().unwrap_or_default();
    WindowGeometry {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
    }
}

fn monitor_geometries(
    monitors: &[tauri::window::Monitor],
    primary: Option<&tauri::window::Monitor>,
) -> Vec<DisplayGeometry> {
    monitors
        .iter()
        .map(|monitor| display_geometry_from_monitor(monitor, primary))
        .collect()
}

fn display_geometry_from_monitor(
    monitor: &tauri::window::Monitor,
    primary: Option<&tauri::window::Monitor>,
) -> DisplayGeometry {
    let position = monitor.position();
    let size = monitor.size();
    DisplayGeometry {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
        scale_factor: monitor.scale_factor(),
        primary: primary.is_some_and(|candidate| same_monitor(candidate, monitor)),
    }
}

fn same_monitor(left: &tauri::window::Monitor, right: &tauri::window::Monitor) -> bool {
    left.position() == right.position()
        && left.size() == right.size()
        && left.name() == right.name()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_state_snapshot_matches_electron_baseline_fields() {
        let snapshot = build_window_state_snapshot_with_topology(
            true,
            false,
            false,
            true,
            false,
            true,
            DisplayTopology {
                current: None,
                is_primary: true,
                has_left: false,
                has_right: false,
            },
        );
        assert!(snapshot.is_maximized);
        assert!(!snapshot.is_native_full_screen);
        assert!(snapshot.is_window_full_screen);
        assert!(snapshot.is_full_screen);
        assert!(!snapshot.is_minimized);
        assert!(snapshot.is_visible);
        assert!(!snapshot.is_html_full_screen);
        assert!(snapshot.is_primary_display);
        assert!(!snapshot.has_display_on_left);
        assert!(!snapshot.has_display_on_right);
        assert!(snapshot.display_bounds.is_none());
    }

    #[test]
    fn state_emit_mode_preserves_move_resize_debounce_policy() {
        assert_eq!(
            state_emit_mode_for_event(&tauri::WindowEvent::Moved(tauri::PhysicalPosition::new(
                1, 2
            ))),
            Some(WindowStateEmitMode::Debounced)
        );
        assert_eq!(
            state_emit_mode_for_event(&tauri::WindowEvent::Focused(true)),
            Some(WindowStateEmitMode::Now)
        );
    }
}
