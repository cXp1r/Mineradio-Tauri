//! 普通桌面窗口的几何、托盘和事件调度核心。

use crate::app::lifecycle::{CloseBehavior, CloseDecision, LifecycleSnapshot, ShutdownCoordinator};
use serde::{Deserialize, Serialize};

pub const WINDOW_STATE_DEBOUNCE_MS: u64 = 80;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DisplayGeometry {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale_factor: f64,
    pub primary: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowGeometry {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LogicalWindowGeometry {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DisplayTopology {
    pub current: Option<WindowGeometry>,
    pub is_primary: bool,
    pub has_left: bool,
    pub has_right: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TrayRuntimePhase {
    Unavailable,
    Ready,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowRuntimeSnapshot {
    pub lifecycle: LifecycleSnapshot,
    pub tray_phase: TrayRuntimePhase,
    pub debounce_generation: u64,
    pub debounce_worker_running: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DebounceSchedule {
    StartWorker { generation: u64 },
    WorkerAlreadyRunning { generation: u64 },
    Disposed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DebounceWake {
    WaitAgain { generation: u64 },
    EmitAndStop,
    Disposed,
}

#[derive(Debug, Default)]
struct WindowDebounceState {
    generation: u64,
    worker_running: bool,
    disposed: bool,
}

impl WindowDebounceState {
    fn schedule(&mut self) -> DebounceSchedule {
        if self.disposed {
            return DebounceSchedule::Disposed;
        }
        self.generation = self.generation.wrapping_add(1).max(1);
        if self.worker_running {
            DebounceSchedule::WorkerAlreadyRunning {
                generation: self.generation,
            }
        } else {
            self.worker_running = true;
            DebounceSchedule::StartWorker {
                generation: self.generation,
            }
        }
    }

    fn wake(&mut self, observed_generation: u64) -> DebounceWake {
        if self.disposed {
            self.worker_running = false;
            return DebounceWake::Disposed;
        }
        if observed_generation != self.generation {
            return DebounceWake::WaitAgain {
                generation: self.generation,
            };
        }
        self.worker_running = false;
        DebounceWake::EmitAndStop
    }

    fn dispose(&mut self) -> bool {
        if self.disposed {
            return false;
        }
        self.disposed = true;
        self.worker_running = false;
        true
    }
}

/// 普通桌面窗口生命周期的 deep Module。
///
/// 托盘可用性、关闭策略、退出清理状态与事件合并都集中在同一处，避免调用方
/// 了解隐藏窗口和真正退出之间的资源所有权差异。
#[derive(Debug)]
pub struct WindowRuntimeState {
    lifecycle: ShutdownCoordinator,
    tray_phase: TrayRuntimePhase,
    debounce: WindowDebounceState,
}

impl Default for WindowRuntimeState {
    fn default() -> Self {
        Self::new(CloseBehavior::Exit)
    }
}

impl WindowRuntimeState {
    pub fn new(close_behavior: CloseBehavior) -> Self {
        Self {
            lifecycle: ShutdownCoordinator::new(close_behavior),
            tray_phase: TrayRuntimePhase::Unavailable,
            debounce: WindowDebounceState::default(),
        }
    }

    pub fn snapshot(&self) -> WindowRuntimeSnapshot {
        WindowRuntimeSnapshot {
            lifecycle: self.lifecycle.snapshot(),
            tray_phase: self.tray_phase,
            debounce_generation: self.debounce.generation,
            debounce_worker_running: self.debounce.worker_running,
        }
    }

    pub fn set_close_behavior(&mut self, behavior: CloseBehavior) -> bool {
        self.lifecycle.set_close_behavior(behavior)
    }

    pub fn mark_tray_ready(&mut self) {
        self.tray_phase = TrayRuntimePhase::Ready;
    }

    pub fn mark_tray_unavailable(&mut self) {
        self.tray_phase = TrayRuntimePhase::Unavailable;
    }

    pub fn mark_tray_failed(&mut self) {
        self.tray_phase = TrayRuntimePhase::Failed;
    }

    pub fn request_close(&mut self) -> CloseDecision {
        self.lifecycle
            .request_close(self.tray_phase == TrayRuntimePhase::Ready)
    }

    pub fn request_show(&mut self) -> bool {
        self.lifecycle.request_show()
    }

    pub fn request_exit(&mut self) -> bool {
        self.lifecycle.request_exit()
    }

    pub fn cancel_exit(&mut self) -> bool {
        self.lifecycle.cancel_exit()
    }

    pub fn claim_cleanup(&mut self) -> bool {
        self.lifecycle.claim_cleanup()
    }

    pub fn schedule_state_emit(&mut self) -> DebounceSchedule {
        self.debounce.schedule()
    }

    pub fn wake_state_emit_worker(&mut self, observed_generation: u64) -> DebounceWake {
        self.debounce.wake(observed_generation)
    }

    pub fn dispose_state_emit(&mut self) -> bool {
        self.debounce.dispose()
    }
}

pub fn display_topology(window: WindowGeometry, displays: &[DisplayGeometry]) -> DisplayTopology {
    let Some(current) = select_display(window, displays) else {
        return DisplayTopology {
            current: None,
            is_primary: true,
            has_left: false,
            has_right: false,
        };
    };
    let current_bounds = display_bounds(current);
    let center_x = i64::from(current.x) + i64::from(current.width) / 2;
    let mut has_left = false;
    let mut has_right = false;
    for display in displays {
        if std::ptr::eq(display, current) {
            continue;
        }
        let other_center = i64::from(display.x) + i64::from(display.width) / 2;
        has_left |= other_center < center_x;
        has_right |= other_center > center_x;
    }
    DisplayTopology {
        current: Some(current_bounds),
        is_primary: current.primary,
        has_left,
        has_right,
    }
}

pub fn clamp_window_to_displays(
    window: WindowGeometry,
    displays: &[DisplayGeometry],
    margin: u32,
) -> WindowGeometry {
    // 拖动中的窗口只要仍与任一显示器相交，就保留用户目标位置；否则在相邻
    // 显示器交界处会被每个 move 增量反复吸回当前屏幕，永远无法完成跨屏。
    if displays
        .iter()
        .any(|display| intersection_area(window, display) > 0)
    {
        return window;
    }
    let Some(display) = select_display(window, displays) else {
        return window;
    };
    let max_width = display
        .width
        .saturating_sub(margin.saturating_mul(2))
        .max(1);
    let max_height = display
        .height
        .saturating_sub(margin.saturating_mul(2))
        .max(1);
    let width = window.width.min(max_width);
    let height = window.height.min(max_height);
    let min_x = i64::from(display.x) + i64::from(margin);
    let min_y = i64::from(display.y) + i64::from(margin);
    let max_x =
        i64::from(display.x) + i64::from(display.width) - i64::from(margin) - i64::from(width);
    let max_y =
        i64::from(display.y) + i64::from(display.height) - i64::from(margin) - i64::from(height);
    WindowGeometry {
        x: clamp_i64(i64::from(window.x), min_x, max_x) as i32,
        y: clamp_i64(i64::from(window.y), min_y, max_y) as i32,
        width,
        height,
    }
}

pub fn desktop_lyrics_default_geometry(display: DisplayGeometry, y_ratio: f64) -> WindowGeometry {
    let horizontal_margin = 48_u32;
    let vertical_margin = 48_u32;
    let available_width = display
        .width
        .saturating_sub(horizontal_margin.saturating_mul(2))
        .max(320);
    let available_height = display
        .height
        .saturating_sub(vertical_margin.saturating_mul(2))
        .max(180);
    let width = ((display.width as f64 * 0.72).round() as u32)
        .clamp(880_u32.min(available_width), available_width);
    let height = ((display.height as f64 * 0.38).round() as u32)
        .clamp(340_u32.min(available_height), 560_u32.min(available_height));
    let ratio = if y_ratio.is_finite() {
        y_ratio.clamp(0.08, 0.92)
    } else {
        0.76
    };
    let centered_x = i64::from(display.x) + (i64::from(display.width) - i64::from(width)) / 2;
    let desired_y = display.y as f64 + display.height as f64 * ratio - height as f64 / 2.0;
    clamp_window_to_displays(
        WindowGeometry {
            x: centered_x as i32,
            y: desired_y.round() as i32,
            width,
            height,
        },
        &[display],
        48,
    )
}

pub fn desktop_lyrics_builder_geometry(
    physical: WindowGeometry,
    scale_factor: f64,
) -> LogicalWindowGeometry {
    let scale = if scale_factor.is_finite() && scale_factor > 0.0 {
        scale_factor
    } else {
        1.0
    };
    LogicalWindowGeometry {
        x: physical.x as f64 / scale,
        y: physical.y as f64 / scale,
        width: physical.width as f64 / scale,
        height: physical.height as f64 / scale,
    }
}

pub fn display_bounds(display: &DisplayGeometry) -> WindowGeometry {
    WindowGeometry {
        x: display.x,
        y: display.y,
        width: display.width,
        height: display.height,
    }
}

pub fn display_for_window(
    window: WindowGeometry,
    displays: &[DisplayGeometry],
) -> Option<DisplayGeometry> {
    select_display(window, displays).copied()
}

fn select_display(
    window: WindowGeometry,
    displays: &[DisplayGeometry],
) -> Option<&DisplayGeometry> {
    displays
        .iter()
        .max_by_key(|display| intersection_area(window, display))
        .filter(|display| intersection_area(window, display) > 0)
        .or_else(|| displays.iter().find(|display| display.primary))
        .or_else(|| displays.first())
}

fn intersection_area(window: WindowGeometry, display: &DisplayGeometry) -> u64 {
    let left = i64::from(window.x).max(i64::from(display.x));
    let top = i64::from(window.y).max(i64::from(display.y));
    let right = (i64::from(window.x) + i64::from(window.width))
        .min(i64::from(display.x) + i64::from(display.width));
    let bottom = (i64::from(window.y) + i64::from(window.height))
        .min(i64::from(display.y) + i64::from(display.height));
    if right <= left || bottom <= top {
        return 0;
    }
    ((right - left) as u64).saturating_mul((bottom - top) as u64)
}

fn clamp_i64(value: i64, min: i64, max: i64) -> i64 {
    if max < min {
        return min;
    }
    value.clamp(min, max)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn displays() -> Vec<DisplayGeometry> {
        vec![
            DisplayGeometry {
                x: -1920,
                y: 0,
                width: 1920,
                height: 1080,
                scale_factor: 1.25,
                primary: false,
            },
            DisplayGeometry {
                x: 0,
                y: 0,
                width: 2560,
                height: 1440,
                scale_factor: 1.0,
                primary: true,
            },
            DisplayGeometry {
                x: 2560,
                y: -180,
                width: 1600,
                height: 900,
                scale_factor: 1.5,
                primary: false,
            },
        ]
    }

    #[test]
    fn tray_close_keeps_runtime_alive_until_explicit_exit() {
        let mut runtime = WindowRuntimeState::default();
        assert!(runtime.set_close_behavior(CloseBehavior::Tray));
        runtime.mark_tray_ready();

        assert_eq!(runtime.request_close(), CloseDecision::HideToTray);
        assert!(!runtime.claim_cleanup());
        assert!(runtime.request_exit());
        assert!(runtime.claim_cleanup());
        assert!(!runtime.claim_cleanup());
    }

    #[test]
    fn debounce_starts_one_worker_and_emits_only_latest_generation() {
        let mut runtime = WindowRuntimeState::default();
        assert_eq!(
            runtime.schedule_state_emit(),
            DebounceSchedule::StartWorker { generation: 1 }
        );
        for generation in 2..=100 {
            assert_eq!(
                runtime.schedule_state_emit(),
                DebounceSchedule::WorkerAlreadyRunning { generation }
            );
        }
        assert_eq!(
            runtime.wake_state_emit_worker(1),
            DebounceWake::WaitAgain { generation: 100 }
        );
        assert_eq!(
            runtime.wake_state_emit_worker(100),
            DebounceWake::EmitAndStop
        );
        assert!(!runtime.snapshot().debounce_worker_running);
    }

    #[test]
    fn disposed_window_publisher_drops_pending_and_future_emits() {
        let mut runtime = WindowRuntimeState::default();
        assert_eq!(
            runtime.schedule_state_emit(),
            DebounceSchedule::StartWorker { generation: 1 }
        );

        assert!(runtime.dispose_state_emit());
        assert_eq!(runtime.wake_state_emit_worker(1), DebounceWake::Disposed);
        assert_eq!(runtime.schedule_state_emit(), DebounceSchedule::Disposed);
        assert!(!runtime.snapshot().debounce_worker_running);
    }

    #[test]
    fn topology_reports_primary_and_adjacent_displays_with_negative_coordinates() {
        let topology = display_topology(
            WindowGeometry {
                x: -1700,
                y: 100,
                width: 760,
                height: 120,
            },
            &displays(),
        );
        assert_eq!(topology.current.map(|bounds| bounds.x), Some(-1920));
        assert!(!topology.is_primary);
        assert!(!topology.has_left);
        assert!(topology.has_right);
    }

    #[test]
    fn partially_visible_window_is_not_clamped_during_mixed_dpi_drag() {
        let clamped = clamp_window_to_displays(
            WindowGeometry {
                x: 4100,
                y: 600,
                width: 760,
                height: 120,
            },
            &displays(),
            24,
        );
        assert_eq!(clamped.x, 4100);
        assert_eq!(clamped.y, 600);
        assert_eq!(clamped.width, 760);
        assert_eq!(clamped.height, 120);
    }

    #[test]
    fn continuous_drag_can_cross_adjacent_displays_without_edge_snap_back() {
        let mut current = WindowGeometry {
            x: -900,
            y: 160,
            width: 760,
            height: 120,
        };

        for _ in 0..30 {
            let desired = WindowGeometry {
                x: current.x + 40,
                ..current
            };
            current = clamp_window_to_displays(desired, &displays(), 24);
        }

        assert_eq!(current.x, 300);
        assert_eq!(current.y, 160);
    }

    #[test]
    fn clamp_falls_back_to_primary_when_window_is_off_all_displays() {
        let clamped = clamp_window_to_displays(
            WindowGeometry {
                x: 20_000,
                y: 20_000,
                width: 900,
                height: 500,
            },
            &displays(),
            24,
        );
        assert_eq!(clamped.x, 1636);
        assert_eq!(clamped.y, 916);
    }

    #[test]
    fn desktop_lyrics_default_geometry_uses_monitor_relative_size_and_y_ratio() {
        let geometry = desktop_lyrics_default_geometry(
            DisplayGeometry {
                x: -1920,
                y: 0,
                width: 1920,
                height: 1080,
                scale_factor: 1.25,
                primary: false,
            },
            0.76,
        );

        assert_eq!(geometry.width, 1382);
        assert_eq!(geometry.height, 410);
        assert_eq!(geometry.x, -1651);
        assert_eq!(geometry.y, 616);
    }

    #[test]
    fn desktop_lyrics_builder_geometry_converts_physical_units_at_fractional_dpi() {
        let physical = WindowGeometry {
            x: -1651,
            y: 616,
            width: 1382,
            height: 410,
        };
        let at_125 = desktop_lyrics_builder_geometry(physical, 1.25);
        assert!((at_125.x - -1320.8).abs() < 1e-9);
        assert!((at_125.y - 492.8).abs() < 1e-9);
        assert!((at_125.width - 1105.6).abs() < 1e-9);
        assert!((at_125.height - 328.0).abs() < 1e-9);

        let at_150 = desktop_lyrics_builder_geometry(physical, 1.5);
        assert!((at_150.x + 1_100.666_666_666_666_7).abs() < 1e-9);
        assert!((at_150.y - 410.666_666_666_666_7).abs() < 1e-9);
        assert!((at_150.width - 921.333_333_333_333_4).abs() < 1e-9);
        assert!((at_150.height - 273.333_333_333_333_3).abs() < 1e-9);
    }
}
