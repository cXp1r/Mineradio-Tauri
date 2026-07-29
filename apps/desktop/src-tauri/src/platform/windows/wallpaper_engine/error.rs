//! Wallpaper Engine Windows Adapter 的稳定错误。

use std::{error::Error, fmt};

/// 平台错误只向上层暴露稳定代码；Win32、路径和签名细节仅保留在本地日志字段。
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WindowsWallpaperError {
    code: &'static str,
    detail: String,
}

impl WindowsWallpaperError {
    pub fn new(code: &'static str, detail: impl Into<String>) -> Self {
        Self {
            code,
            detail: detail.into(),
        }
    }

    pub const fn code(&self) -> &'static str {
        self.code
    }
}

impl fmt::Display for WindowsWallpaperError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.detail.is_empty() {
            formatter.write_str(self.code)
        } else {
            write!(formatter, "{}: {}", self.code, self.detail)
        }
    }
}

impl Error for WindowsWallpaperError {}

pub type WindowsWallpaperResult<T> = Result<T, WindowsWallpaperError>;

pub(crate) fn io_error(
    code: &'static str,
    operation: &str,
    error: impl fmt::Display,
) -> WindowsWallpaperError {
    WindowsWallpaperError::new(code, format!("{operation} 失败：{error}"))
}
