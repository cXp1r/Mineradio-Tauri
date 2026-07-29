//! Wallpaper Engine 进程、窗口与 physical rect 身份。

use super::error::{WindowsWallpaperError, WindowsWallpaperResult};
use std::{
    ffi::OsString,
    mem::{size_of, zeroed},
    os::windows::ffi::OsStringExt,
    path::{Path, PathBuf},
};
use windows_sys::{
    core::BOOL,
    Win32::{
        Foundation::{CloseHandle, FILETIME, HWND, INVALID_HANDLE_VALUE, LPARAM, RECT},
        System::{
            Diagnostics::ToolHelp::{
                CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
                TH32CS_SNAPPROCESS,
            },
            Threading::{
                GetProcessTimes, OpenProcess, QueryFullProcessImageNameW,
                PROCESS_QUERY_LIMITED_INFORMATION,
            },
        },
        UI::WindowsAndMessaging::{
            EnumWindows, GetWindowRect, GetWindowTextLengthW, GetWindowTextW,
            GetWindowThreadProcessId, IsWindow,
        },
    },
};

const WINDOWS_TO_UNIX_EPOCH_100NS: u64 = 116_444_736_000_000_000;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PhysicalRect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

impl PhysicalRect {
    pub fn new(x: i32, y: i32, width: i32, height: i32) -> WindowsWallpaperResult<Self> {
        if width <= 0 || height <= 0 {
            return Err(WindowsWallpaperError::new(
                "WALLPAPER_ENGINE_GEOMETRY_INVALID",
                "physical rect 尺寸必须为正数",
            ));
        }
        Ok(Self {
            x,
            y,
            width,
            height,
        })
    }

    pub fn from_native(rect: RECT) -> WindowsWallpaperResult<Self> {
        Self::new(
            rect.left,
            rect.top,
            rect.right.saturating_sub(rect.left),
            rect.bottom.saturating_sub(rect.top),
        )
    }

    pub fn aligned_with(self, other: Self, tolerance: i32) -> bool {
        let tolerance = tolerance.max(0);
        (self.x - other.x).abs() <= tolerance
            && (self.y - other.y).abs() <= tolerance
            && (self.width - other.width).abs() <= tolerance
            && (self.height - other.height).abs() <= tolerance
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProcessIdentity {
    pub process_id: u32,
    pub process_created_unix_millis: u64,
    pub executable: PathBuf,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WindowIdentity {
    pub handle: u64,
    pub thread_id: u32,
    pub process: ProcessIdentity,
    pub title: String,
    pub rect: PhysicalRect,
}

impl WindowIdentity {
    pub fn hwnd(&self) -> HWND {
        self.handle as usize as HWND
    }

    pub fn source_id(&self) -> String {
        format!("window:{}:0", self.handle)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProcessRecord {
    pub process_id: u32,
    pub executable_name: String,
}

pub fn process_identity(process_id: u32) -> WindowsWallpaperResult<ProcessIdentity> {
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, process_id) };
    if handle.is_null() {
        return Err(WindowsWallpaperError::new(
            "WALLPAPER_ENGINE_PROCESS_IDENTITY_UNAVAILABLE",
            format!("无法打开 PID {process_id}"),
        ));
    }
    let result = (|| {
        let mut created: FILETIME = unsafe { zeroed() };
        let mut exited: FILETIME = unsafe { zeroed() };
        let mut kernel: FILETIME = unsafe { zeroed() };
        let mut user: FILETIME = unsafe { zeroed() };
        if unsafe { GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user) }
            == 0
        {
            return Err(WindowsWallpaperError::new(
                "WALLPAPER_ENGINE_PROCESS_IDENTITY_UNAVAILABLE",
                "GetProcessTimes 失败",
            ));
        }
        let mut buffer = vec![0u16; 32_768];
        let mut length = buffer.len() as u32;
        if unsafe { QueryFullProcessImageNameW(handle, 0, buffer.as_mut_ptr(), &mut length) } == 0
            || length == 0
        {
            return Err(WindowsWallpaperError::new(
                "WALLPAPER_ENGINE_PROCESS_IDENTITY_UNAVAILABLE",
                "QueryFullProcessImageNameW 失败",
            ));
        }
        let executable = PathBuf::from(OsString::from_wide(&buffer[..length as usize]));
        Ok(ProcessIdentity {
            process_id,
            process_created_unix_millis: filetime_to_unix_millis(created),
            executable: std::fs::canonicalize(&executable).unwrap_or(executable),
        })
    })();
    unsafe {
        CloseHandle(handle);
    }
    result
}

pub fn window_identity(hwnd: HWND) -> WindowsWallpaperResult<WindowIdentity> {
    if hwnd.is_null() || unsafe { IsWindow(hwnd) } == 0 {
        return Err(WindowsWallpaperError::new(
            "WALLPAPER_ENGINE_WINDOW_IDENTITY_MISMATCH",
            "HWND 不存在",
        ));
    }
    let mut process_id = 0u32;
    let thread_id = unsafe { GetWindowThreadProcessId(hwnd, &mut process_id) };
    if thread_id == 0 || process_id == 0 {
        return Err(WindowsWallpaperError::new(
            "WALLPAPER_ENGINE_WINDOW_IDENTITY_MISMATCH",
            "无法读取 HWND PID/TID",
        ));
    }
    let title = window_title(hwnd)?;
    let mut rect: RECT = unsafe { zeroed() };
    if unsafe { GetWindowRect(hwnd, &mut rect) } == 0 {
        return Err(WindowsWallpaperError::new(
            "WALLPAPER_ENGINE_WINDOW_IDENTITY_MISMATCH",
            "GetWindowRect 失败",
        ));
    }
    Ok(WindowIdentity {
        handle: hwnd as usize as u64,
        thread_id,
        process: process_identity(process_id)?,
        title,
        rect: PhysicalRect::from_native(rect)?,
    })
}

pub fn verify_window_identity(expected: &WindowIdentity) -> WindowsWallpaperResult<WindowIdentity> {
    let observed = window_identity(expected.hwnd())?;
    if observed.handle != expected.handle
        || observed.thread_id != expected.thread_id
        || observed.process.process_id != expected.process.process_id
        || observed.process.process_created_unix_millis
            != expected.process.process_created_unix_millis
        || path_key(&observed.process.executable) != path_key(&expected.process.executable)
        || observed.title != expected.title
    {
        return Err(WindowsWallpaperError::new(
            "WALLPAPER_ENGINE_WINDOW_IDENTITY_MISMATCH",
            "HWND 的 title/PID/TID/creation-time/executable 已变化",
        ));
    }
    Ok(observed)
}

pub fn find_exact_window(
    title: &str,
    expected_executable: &Path,
) -> WindowsWallpaperResult<Option<WindowIdentity>> {
    let mut scan = WindowScan {
        expected_title: title,
        handles: Vec::new(),
    };
    if unsafe { EnumWindows(Some(enum_exact_window), &mut scan as *mut _ as LPARAM) } == 0 {
        return Err(WindowsWallpaperError::new(
            "WALLPAPER_ENGINE_WINDOW_ENUM_FAILED",
            "EnumWindows 失败",
        ));
    }
    let mut matches = Vec::new();
    let mut identity_mismatch = false;
    for hwnd in scan.handles {
        match window_identity(hwnd) {
            Ok(identity)
                if path_key(&identity.process.executable) == path_key(expected_executable) =>
            {
                matches.push(identity);
            }
            Ok(_) | Err(_) => identity_mismatch = true,
        }
    }
    if identity_mismatch {
        return Err(WindowsWallpaperError::new(
            "WALLPAPER_ENGINE_PROCESS_PATH_MISMATCH",
            "发现同 title 但身份不匹配的窗口",
        ));
    }
    match matches.len() {
        0 => Ok(None),
        1 => Ok(matches.pop()),
        _ => Err(WindowsWallpaperError::new(
            "WALLPAPER_ENGINE_WINDOW_IDENTITY_AMBIGUOUS",
            "同一唯一 location 出现多个可信 HWND",
        )),
    }
}

pub fn enumerate_processes() -> WindowsWallpaperResult<Vec<ProcessRecord>> {
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err(WindowsWallpaperError::new(
            "WALLPAPER_ENGINE_PROCESS_PROBE_FAILED",
            "CreateToolhelp32Snapshot 失败",
        ));
    }
    let mut records = Vec::new();
    let mut entry: PROCESSENTRY32W = unsafe { zeroed() };
    entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;
    let mut present = unsafe { Process32FirstW(snapshot, &mut entry) };
    while present != 0 {
        let length = entry
            .szExeFile
            .iter()
            .position(|unit| *unit == 0)
            .unwrap_or(entry.szExeFile.len());
        records.push(ProcessRecord {
            process_id: entry.th32ProcessID,
            executable_name: OsString::from_wide(&entry.szExeFile[..length])
                .to_string_lossy()
                .into_owned(),
        });
        present = unsafe { Process32NextW(snapshot, &mut entry) };
    }
    unsafe {
        CloseHandle(snapshot);
    }
    Ok(records)
}

pub fn wallpaper_engine_process_identities() -> WindowsWallpaperResult<Vec<ProcessIdentity>> {
    let mut identities = Vec::new();
    for record in enumerate_processes()? {
        if !matches!(
            record.executable_name.to_ascii_lowercase().as_str(),
            "wallpaper32.exe" | "wallpaper64.exe"
        ) {
            continue;
        }
        if let Ok(identity) = process_identity(record.process_id) {
            identities.push(identity);
        }
    }
    Ok(identities)
}

struct WindowScan<'a> {
    expected_title: &'a str,
    handles: Vec<HWND>,
}

unsafe extern "system" fn enum_exact_window(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let scan = &mut *(lparam as *mut WindowScan<'_>);
    if window_title(hwnd).is_ok_and(|title| title == scan.expected_title) {
        scan.handles.push(hwnd);
    }
    1
}

fn window_title(hwnd: HWND) -> WindowsWallpaperResult<String> {
    let length = unsafe { GetWindowTextLengthW(hwnd) };
    if length < 0 {
        return Err(WindowsWallpaperError::new(
            "WALLPAPER_ENGINE_WINDOW_IDENTITY_MISMATCH",
            "GetWindowTextLengthW 失败",
        ));
    }
    let mut buffer = vec![0u16; length as usize + 1];
    let written = unsafe { GetWindowTextW(hwnd, buffer.as_mut_ptr(), buffer.len() as i32) };
    if written < 0 {
        return Err(WindowsWallpaperError::new(
            "WALLPAPER_ENGINE_WINDOW_IDENTITY_MISMATCH",
            "GetWindowTextW 失败",
        ));
    }
    Ok(String::from_utf16_lossy(&buffer[..written as usize]))
}

fn filetime_to_unix_millis(value: FILETIME) -> u64 {
    let ticks = (u64::from(value.dwHighDateTime) << 32) | u64::from(value.dwLowDateTime);
    ticks
        .saturating_sub(WINDOWS_TO_UNIX_EPOCH_100NS)
        .saturating_div(10_000)
}

pub fn path_key(path: &Path) -> String {
    path.to_string_lossy()
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_ascii_lowercase()
}

#[cfg(test)]
mod tests {
    use super::PhysicalRect;

    #[test]
    fn geometry_uses_two_pixel_inclusive_tolerance() {
        let expected = PhysicalRect::new(-1920, 0, 1920, 1080).expect("fixture 有效");
        assert!(expected.aligned_with(
            PhysicalRect::new(-1918, 2, 1918, 1082).expect("fixture 有效"),
            2
        ));
        assert!(!expected.aligned_with(
            PhysicalRect::new(-1917, 0, 1920, 1080).expect("fixture 有效"),
            2
        ));
    }
}
