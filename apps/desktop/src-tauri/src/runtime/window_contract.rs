//! 主窗口运行时对外快照契约。
//!
//! Command 层仅 re-export 这些稳定 DTO；窗口实现不再反向依赖 transport Module。

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowDisplayBounds {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowStateSnapshot {
    pub is_maximized: bool,
    pub is_native_full_screen: bool,
    pub is_html_full_screen: bool,
    pub is_window_full_screen: bool,
    pub is_full_screen: bool,
    pub is_minimized: bool,
    pub is_visible: bool,
    pub is_focused: bool,
    pub is_primary_display: bool,
    pub has_display_on_left: bool,
    pub has_display_on_right: bool,
    pub display_bounds: Option<WindowDisplayBounds>,
}
