//! 同进程 DWM thumbnail surface owner。
//!
//! 该模块只创建一个 click-through top-level HWND。窗口、thumbnail、定时跟随和
//! message pump 全部由同一专用线程拥有，caller 不能直接操作原生资源。

use super::{
    error::{WindowsWallpaperError, WindowsWallpaperResult},
    identity::{verify_window_identity, window_identity, WindowIdentity},
};
use std::{
    ffi::{c_void, OsStr},
    mem::{size_of, zeroed},
    os::windows::ffi::OsStrExt,
    ptr::{null, null_mut},
    sync::{mpsc, Arc, Mutex, MutexGuard},
    thread::{self, JoinHandle},
    time::Duration,
};
use windows_sys::Win32::{
    Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM},
    Graphics::Dwm::{
        DwmRegisterThumbnail, DwmUnregisterThumbnail, DwmUpdateThumbnailProperties,
        DWM_THUMBNAIL_PROPERTIES, DWM_TNP_OPACITY, DWM_TNP_RECTDESTINATION,
        DWM_TNP_SOURCECLIENTAREAONLY, DWM_TNP_VISIBLE,
    },
    System::{LibraryLoader::GetModuleHandleW, Threading::GetCurrentThreadId},
    UI::{
        HiDpi::{SetThreadDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2},
        WindowsAndMessaging::{
            CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, FindWindowExW,
            GetAncestor, GetMessageW, GetWindowLongPtrW, GetWindowRect, GetWindowThreadProcessId,
            IsWindow, KillTimer, PostMessageW, PostQuitMessage, RegisterClassExW, SetTimer,
            SetWindowLongPtrW, SetWindowPos, TranslateMessage, UnregisterClassW, CREATESTRUCTW,
            GA_ROOT, GWLP_USERDATA, HTTRANSPARENT, MSG, SWP_NOACTIVATE, SWP_SHOWWINDOW, WM_APP,
            WM_CLOSE, WM_DESTROY, WM_NCCREATE, WM_NCHITTEST, WM_TIMER, WNDCLASSEXW,
            WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT, WS_POPUP,
        },
    },
};

const FOLLOW_INTERVAL_MILLIS: u32 = 60;
const FOLLOW_TIMER_ID: usize = 1;
const MAX_CONSECUTIVE_FOLLOW_FAILURES: u8 = 8;
const START_TIMEOUT: Duration = Duration::from_secs(5);
const STOP_TIMEOUT: Duration = Duration::from_secs(2);
const COMMAND_TIMEOUT: Duration = Duration::from_millis(800);
const WM_SURFACE_COMMAND: u32 = WM_APP + 0x41;
const SURFACE_TITLE: &str = "Mineradio WE DWM Surface";

/// DWM surface 的唯一启动输入。host/source 都必须是启动前已经验证的 exact identity。
#[derive(Clone, Debug)]
pub struct DwmSurfaceRequest {
    pub host: WindowIdentity,
    pub source: WindowIdentity,
    /// `interactive` desktop 模式下要求 Explorer icon host 处于 host 与 surface 之间。
    pub desktop_icon_layering: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DwmSurfaceStatus {
    pub supported: bool,
    pub ready: bool,
    pub retired: bool,
    pub stopped: bool,
    pub surface_window_handle: u64,
    pub surface_thread_id: u32,
    pub desktop_icon_layering: bool,
    pub last_error_code: Option<&'static str>,
}

impl Default for DwmSurfaceStatus {
    fn default() -> Self {
        Self {
            supported: true,
            ready: false,
            retired: false,
            stopped: false,
            surface_window_handle: 0,
            surface_thread_id: 0,
            desktop_icon_layering: false,
            last_error_code: None,
        }
    }
}

/// 专用线程拥有的 DWM surface。`stop` 可重复调用，但只有第一次执行原生释放。
pub struct DwmSurfaceOwner {
    status: Arc<Mutex<DwmSurfaceStatus>>,
    surface_window_handle: u64,
    thread: Option<JoinHandle<()>>,
    commands: mpsc::Sender<SurfaceCommand>,
    stopped: mpsc::Receiver<WindowsWallpaperResult<()>>,
}

impl DwmSurfaceOwner {
    pub fn start(request: DwmSurfaceRequest) -> WindowsWallpaperResult<Self> {
        validate_start_request(&request)?;
        let status = Arc::new(Mutex::new(DwmSurfaceStatus::default()));
        let thread_status = Arc::clone(&status);
        let (started_tx, started_rx) = mpsc::sync_channel(1);
        let (stopped_tx, stopped_rx) = mpsc::sync_channel(1);
        let (commands_tx, commands_rx) = mpsc::channel();
        let thread = thread::Builder::new()
            .name("mineradio-we-dwm-surface".into())
            .spawn(move || {
                let result = run_surface_thread(request, thread_status, commands_rx, started_tx);
                let _ = stopped_tx.send(result);
            })
            .map_err(|error| {
                WindowsWallpaperError::new(
                    "WALLPAPER_ENGINE_DWM_THREAD_FAILED",
                    format!("创建 DWM surface thread 失败：{error}"),
                )
            })?;

        match started_rx.recv_timeout(START_TIMEOUT) {
            Ok(Ok(surface_window_handle)) => Ok(Self {
                status,
                surface_window_handle,
                thread: Some(thread),
                commands: commands_tx,
                stopped: stopped_rx,
            }),
            Ok(Err(error)) => {
                let _ = thread.join();
                Err(error)
            }
            Err(_) => {
                // thread 尚未报告 HWND 时无法向未知窗口发送消息；丢弃 JoinHandle 让调用
                // 有界返回，线程自身的初始化错误路径仍会释放已创建的原生资源。
                drop(thread);
                Err(WindowsWallpaperError::new(
                    "WALLPAPER_ENGINE_DWM_START_TIMEOUT",
                    "DWM surface 未在有界时间内 ready",
                ))
            }
        }
    }

    pub fn status(&self) -> DwmSurfaceStatus {
        lock_status(&self.status).clone()
    }

    pub fn surface_window_handle(&self) -> u64 {
        self.surface_window_handle
    }

    /// 在 surface owner thread 内原位切换 Explorer icon-host layering，并等待确认。
    pub fn set_desktop_icon_layering(&self, enabled: bool) -> WindowsWallpaperResult<()> {
        if self.thread.is_none() {
            return Err(WindowsWallpaperError::new(
                "WALLPAPER_ENGINE_DWM_NOT_ACTIVE",
                "DWM surface thread 已停止",
            ));
        }
        let (reply_tx, reply_rx) = mpsc::sync_channel(1);
        self.commands
            .send(SurfaceCommand::SetDesktopIconLayering {
                enabled,
                reply: reply_tx,
            })
            .map_err(|_| {
                WindowsWallpaperError::new(
                    "WALLPAPER_ENGINE_DWM_COMMAND_FAILED",
                    "DWM surface command channel 已关闭",
                )
            })?;
        let hwnd = raw_hwnd(self.surface_window_handle);
        if !surface_window_is_owned(hwnd, &self.status)
            || unsafe { PostMessageW(hwnd, WM_SURFACE_COMMAND, 0, 0) } == 0
        {
            return Err(WindowsWallpaperError::new(
                "WALLPAPER_ENGINE_DWM_COMMAND_FAILED",
                "无法唤醒 exact DWM surface HWND",
            ));
        }
        reply_rx.recv_timeout(COMMAND_TIMEOUT).map_err(|_| {
            WindowsWallpaperError::new(
                "WALLPAPER_ENGINE_DWM_COMMAND_TIMEOUT",
                "DWM surface 未在有界时间内确认 layering",
            )
        })?
    }

    /// 先要求 surface thread 注销 thumbnail，再销毁 HWND，并等待 thread 退出确认。
    pub fn stop(&mut self) -> WindowsWallpaperResult<()> {
        let Some(thread) = self.thread.take() else {
            return Ok(());
        };
        let hwnd = raw_hwnd(self.surface_window_handle);
        let already_stopped = lock_status(&self.status).stopped;
        if !already_stopped && !hwnd.is_null() && unsafe { IsWindow(hwnd) } != 0 {
            if !surface_window_is_owned(hwnd, &self.status) {
                self.thread = Some(thread);
                return Err(WindowsWallpaperError::new(
                    "WALLPAPER_ENGINE_DWM_IDENTITY_MISMATCH",
                    "surface HWND 已不属于 owner thread",
                ));
            }
            if unsafe { PostMessageW(hwnd, WM_CLOSE, 0, 0) } == 0 {
                self.thread = Some(thread);
                return Err(WindowsWallpaperError::new(
                    "WALLPAPER_ENGINE_DWM_STOP_FAILED",
                    "无法向 exact DWM surface HWND 请求关闭",
                ));
            }
        }

        match self.stopped.recv_timeout(STOP_TIMEOUT) {
            Ok(result) => {
                thread.join().map_err(|_| {
                    WindowsWallpaperError::new(
                        "WALLPAPER_ENGINE_DWM_THREAD_FAILED",
                        "DWM surface thread panic",
                    )
                })?;
                result
            }
            Err(_) => {
                self.thread = Some(thread);
                Err(WindowsWallpaperError::new(
                    "WALLPAPER_ENGINE_DWM_STOP_TIMEOUT",
                    "DWM surface thread 未在有界时间内确认释放",
                ))
            }
        }
    }
}

impl Drop for DwmSurfaceOwner {
    fn drop(&mut self) {
        if self.thread.is_none() {
            return;
        }
        let hwnd = raw_hwnd(self.surface_window_handle);
        if surface_window_is_owned(hwnd, &self.status) {
            unsafe {
                PostMessageW(hwnd, WM_CLOSE, 0, 0);
            }
        }
        // 正常 shutdown 必须显式调用 `stop` 并检查确认；Drop 不能无限阻塞主线程。
        self.thread.take();
    }
}

type StartSender = mpsc::SyncSender<WindowsWallpaperResult<u64>>;

enum SurfaceCommand {
    SetDesktopIconLayering {
        enabled: bool,
        reply: mpsc::SyncSender<WindowsWallpaperResult<()>>,
    },
}

fn run_surface_thread(
    request: DwmSurfaceRequest,
    status: Arc<Mutex<DwmSurfaceStatus>>,
    commands: mpsc::Receiver<SurfaceCommand>,
    started: StartSender,
) -> WindowsWallpaperResult<()> {
    let previous_dpi =
        unsafe { SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };
    if previous_dpi.is_null() {
        let error = last_win32_error(
            "WALLPAPER_ENGINE_DPI_CONTEXT_FAILED",
            "SetThreadDpiAwarenessContext(PMv2)",
        );
        let _ = started.send(Err(error.clone()));
        let mut current = lock_status(&status);
        current.stopped = true;
        current.last_error_code = Some(error.code());
        return Err(error);
    }
    let result = run_surface_thread_inner(request, Arc::clone(&status), commands, started);
    if !previous_dpi.is_null() {
        unsafe {
            SetThreadDpiAwarenessContext(previous_dpi);
        }
    }
    {
        let mut current = lock_status(&status);
        current.ready = false;
        current.stopped = true;
        if let Err(error) = &result {
            current.last_error_code = Some(error.code());
        }
    }
    result
}

fn run_surface_thread_inner(
    request: DwmSurfaceRequest,
    status: Arc<Mutex<DwmSurfaceStatus>>,
    commands: mpsc::Receiver<SurfaceCommand>,
    started: StartSender,
) -> WindowsWallpaperResult<()> {
    let instance = unsafe { GetModuleHandleW(null()) };
    if instance.is_null() {
        let error = last_win32_error("WALLPAPER_ENGINE_DWM_WINDOW_FAILED", "GetModuleHandleW");
        let _ = started.send(Err(error.clone()));
        return Err(error);
    }
    let class_name = wide_null(format!(
        "MineradioWeDwmSurface-{}-{}",
        std::process::id(),
        unsafe { GetCurrentThreadId() }
    ));
    let window_title = wide_null(SURFACE_TITLE);
    let window_class = WNDCLASSEXW {
        cbSize: size_of::<WNDCLASSEXW>() as u32,
        lpfnWndProc: Some(surface_wnd_proc),
        hInstance: instance,
        lpszClassName: class_name.as_ptr(),
        ..Default::default()
    };
    if unsafe { RegisterClassExW(&window_class) } == 0 {
        let error = last_win32_error("WALLPAPER_ENGINE_DWM_WINDOW_FAILED", "RegisterClassExW");
        let _ = started.send(Err(error.clone()));
        return Err(error);
    }

    let mut state = Box::new(ThreadSurfaceState::new(request, status, commands));
    let initial_rect = state.request.host.rect;
    let hwnd = unsafe {
        CreateWindowExW(
            WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_TRANSPARENT,
            class_name.as_ptr(),
            window_title.as_ptr(),
            WS_POPUP,
            initial_rect.x,
            initial_rect.y,
            initial_rect.width,
            initial_rect.height,
            null_mut(),
            null_mut(),
            instance,
            (&mut *state as *mut ThreadSurfaceState).cast::<c_void>(),
        )
    };
    if hwnd.is_null() {
        let error = last_win32_error("WALLPAPER_ENGINE_DWM_WINDOW_FAILED", "CreateWindowExW");
        let _ = started.send(Err(error.clone()));
        unsafe {
            UnregisterClassW(class_name.as_ptr(), instance);
        }
        return Err(error);
    }
    state.hwnd = hwnd;

    let initialization = state.initialize();
    if let Err(error) = initialization {
        let _ = started.send(Err(error.clone()));
        state.cleanup_native();
        unsafe {
            DestroyWindow(hwnd);
            UnregisterClassW(class_name.as_ptr(), instance);
        }
        return Err(error);
    }
    {
        let mut current = lock_status(&state.status);
        current.ready = true;
        current.surface_window_handle = hwnd_value(hwnd);
        current.surface_thread_id = unsafe { GetCurrentThreadId() };
        current.desktop_icon_layering = state.request.desktop_icon_layering;
    }
    if started.send(Ok(hwnd_value(hwnd))).is_err() {
        state.cleanup_native();
        unsafe {
            DestroyWindow(hwnd);
            UnregisterClassW(class_name.as_ptr(), instance);
        }
        return Err(WindowsWallpaperError::new(
            "WALLPAPER_ENGINE_DWM_START_CANCELED",
            "DWM surface caller 已取消启动",
        ));
    }

    let mut message: MSG = unsafe { zeroed() };
    let loop_result = loop {
        let message_result = unsafe { GetMessageW(&mut message, null_mut(), 0, 0) };
        if message_result > 0 {
            unsafe {
                TranslateMessage(&message);
                DispatchMessageW(&message);
            }
            continue;
        }
        if message_result == 0 {
            break Ok(());
        }
        break Err(last_win32_error(
            "WALLPAPER_ENGINE_DWM_MESSAGE_LOOP_FAILED",
            "GetMessageW",
        ));
    };

    state.cleanup_native();
    if unsafe { IsWindow(hwnd) } != 0 {
        unsafe {
            DestroyWindow(hwnd);
        }
    }
    unsafe {
        UnregisterClassW(class_name.as_ptr(), instance);
    }
    loop_result
}

struct ThreadSurfaceState {
    request: DwmSurfaceRequest,
    status: Arc<Mutex<DwmSurfaceStatus>>,
    hwnd: HWND,
    thumbnail: isize,
    icon_host: Option<WindowIdentity>,
    commands: mpsc::Receiver<SurfaceCommand>,
    follow_failures: FollowFailureBudget,
    cleaned: bool,
}

impl ThreadSurfaceState {
    fn new(
        request: DwmSurfaceRequest,
        status: Arc<Mutex<DwmSurfaceStatus>>,
        commands: mpsc::Receiver<SurfaceCommand>,
    ) -> Self {
        Self {
            request,
            status,
            hwnd: null_mut(),
            thumbnail: 0,
            icon_host: None,
            commands,
            follow_failures: FollowFailureBudget::default(),
            cleaned: false,
        }
    }

    fn initialize(&mut self) -> WindowsWallpaperResult<()> {
        verify_window_identity(&self.request.host)?;
        verify_window_identity(&self.request.source)?;
        if self.request.desktop_icon_layering {
            self.icon_host = Some(find_desktop_icon_host()?);
        }
        let result = unsafe {
            DwmRegisterThumbnail(self.hwnd, self.request.source.hwnd(), &mut self.thumbnail)
        };
        if result < 0 || self.thumbnail == 0 {
            return Err(WindowsWallpaperError::new(
                "WALLPAPER_ENGINE_DWM_REGISTER_FAILED",
                format!("DwmRegisterThumbnail 返回 0x{:08X}", result as u32),
            ));
        }
        self.follow_host()?;
        if unsafe { SetTimer(self.hwnd, FOLLOW_TIMER_ID, FOLLOW_INTERVAL_MILLIS, None) } == 0 {
            return Err(last_win32_error(
                "WALLPAPER_ENGINE_DWM_TIMER_FAILED",
                "SetTimer",
            ));
        }
        Ok(())
    }

    fn follow_host(&mut self) -> WindowsWallpaperResult<()> {
        let host = verify_window_identity(&self.request.host)?;
        verify_window_identity(&self.request.source)?;
        let mut host_rect: RECT = unsafe { zeroed() };
        if unsafe { GetWindowRect(host.hwnd(), &mut host_rect) } == 0 {
            return Err(last_win32_error(
                "WALLPAPER_ENGINE_DWM_FOLLOW_FAILED",
                "GetWindowRect(host)",
            ));
        }
        let width = host_rect.right.saturating_sub(host_rect.left);
        let height = host_rect.bottom.saturating_sub(host_rect.top);
        if width <= 0 || height <= 0 {
            return Err(WindowsWallpaperError::new(
                "WALLPAPER_ENGINE_DWM_FOLLOW_FAILED",
                "host physical rect 无效",
            ));
        }

        let host_root = unsafe { GetAncestor(host.hwnd(), GA_ROOT) };
        let host_layer = if host_root.is_null() {
            host.hwnd()
        } else {
            host_root
        };
        let insert_after = if let Some(icon_host) = &self.icon_host {
            let icon_host = verify_window_identity(icon_host)?;
            if host_root != host.hwnd() && host_root != icon_host.hwnd() {
                return Err(WindowsWallpaperError::new(
                    "WALLPAPER_ENGINE_DWM_LAYERING_INVALID",
                    "host child 不属于已验证 Explorer icon host",
                ));
            }
            icon_host.hwnd()
        } else {
            host_layer
        };

        let properties = DWM_THUMBNAIL_PROPERTIES {
            dwFlags: DWM_TNP_RECTDESTINATION
                | DWM_TNP_OPACITY
                | DWM_TNP_VISIBLE
                | DWM_TNP_SOURCECLIENTAREAONLY,
            rcDestination: RECT {
                left: 0,
                top: 0,
                right: width,
                bottom: height,
            },
            opacity: 255,
            fVisible: 1,
            fSourceClientAreaOnly: 1,
            ..Default::default()
        };
        let result = unsafe { DwmUpdateThumbnailProperties(self.thumbnail, &properties) };
        if result < 0 {
            return Err(WindowsWallpaperError::new(
                "WALLPAPER_ENGINE_DWM_UPDATE_FAILED",
                format!("DwmUpdateThumbnailProperties 返回 0x{:08X}", result as u32),
            ));
        }
        // destination 在 hidden 状态先完成首帧 priming，再显示和排序，避免暴露空黑 surface。
        let flags = SWP_NOACTIVATE | SWP_SHOWWINDOW;
        if unsafe {
            SetWindowPos(
                self.hwnd,
                insert_after,
                host_rect.left,
                host_rect.top,
                width,
                height,
                flags,
            )
        } == 0
        {
            return Err(last_win32_error(
                "WALLPAPER_ENGINE_DWM_FOLLOW_FAILED",
                "SetWindowPos(surface)",
            ));
        }
        if unsafe {
            SetWindowPos(
                self.request.source.hwnd(),
                self.hwnd,
                host_rect.left,
                host_rect.top,
                width,
                height,
                flags,
            )
        } == 0
        {
            return Err(last_win32_error(
                "WALLPAPER_ENGINE_DWM_FOLLOW_FAILED",
                "SetWindowPos(source)",
            ));
        }
        self.follow_failures.record_success();
        Ok(())
    }

    fn record_follow_failure(&mut self, error: &WindowsWallpaperError) -> bool {
        {
            let mut current = lock_status(&self.status);
            current.last_error_code = Some(error.code());
        }
        if matches!(
            error.code(),
            "WALLPAPER_ENGINE_WINDOW_IDENTITY_MISMATCH"
                | "WALLPAPER_ENGINE_PROCESS_PATH_MISMATCH"
                | "WALLPAPER_ENGINE_DWM_LAYERING_INVALID"
        ) {
            true
        } else {
            self.follow_failures.record_failure()
        }
    }

    fn handle_commands(&mut self) {
        while let Ok(command) = self.commands.try_recv() {
            match command {
                SurfaceCommand::SetDesktopIconLayering { enabled, reply } => {
                    let result = self.set_desktop_icon_layering(enabled);
                    let _ = reply.send(result);
                }
            }
        }
    }

    fn set_desktop_icon_layering(&mut self, enabled: bool) -> WindowsWallpaperResult<()> {
        if self.request.desktop_icon_layering == enabled {
            return Ok(());
        }
        let old_layering = self.request.desktop_icon_layering;
        let old_icon_host = self.icon_host.clone();
        let next_icon_host = if enabled {
            Some(find_desktop_icon_host()?)
        } else {
            None
        };
        self.request.desktop_icon_layering = enabled;
        self.icon_host = next_icon_host;
        if let Err(error) = self.follow_host() {
            self.request.desktop_icon_layering = old_layering;
            self.icon_host = old_icon_host;
            let _ = self.follow_host();
            return Err(error);
        }
        lock_status(&self.status).desktop_icon_layering = enabled;
        Ok(())
    }

    fn retire(&mut self) {
        {
            let mut current = lock_status(&self.status);
            current.ready = false;
            current.retired = true;
        }
        self.cleanup_native();
    }

    fn cleanup_native(&mut self) {
        if self.cleaned {
            return;
        }
        self.cleaned = true;
        if !self.hwnd.is_null() {
            unsafe {
                KillTimer(self.hwnd, FOLLOW_TIMER_ID);
            }
        }
        if self.thumbnail != 0 {
            unsafe {
                DwmUnregisterThumbnail(self.thumbnail);
            }
            self.thumbnail = 0;
        }
        let mut current = lock_status(&self.status);
        current.ready = false;
        current.desktop_icon_layering = false;
    }
}

#[derive(Default)]
struct FollowFailureBudget {
    consecutive: u8,
}

impl FollowFailureBudget {
    fn record_success(&mut self) {
        self.consecutive = 0;
    }

    /// 返回 `true` 表示已经达到退休阈值。
    fn record_failure(&mut self) -> bool {
        self.consecutive = self.consecutive.saturating_add(1);
        self.consecutive >= MAX_CONSECUTIVE_FOLLOW_FAILURES
    }
}

unsafe extern "system" fn surface_wnd_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if message == WM_NCCREATE {
        let created = &*(lparam as *const CREATESTRUCTW);
        SetWindowLongPtrW(hwnd, GWLP_USERDATA, created.lpCreateParams as isize);
        return 1;
    }
    let state_ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut ThreadSurfaceState;
    match message {
        WM_NCHITTEST => HTTRANSPARENT as LRESULT,
        WM_TIMER if wparam == FOLLOW_TIMER_ID => {
            if state_ptr.is_null() {
                return 0;
            }
            let should_retire = {
                let state = &mut *state_ptr;
                match state.follow_host() {
                    Ok(()) => false,
                    Err(error) => state.record_follow_failure(&error),
                }
            };
            if should_retire {
                (&mut *state_ptr).retire();
                DestroyWindow(hwnd);
            }
            0
        }
        WM_SURFACE_COMMAND => {
            if !state_ptr.is_null() {
                (&mut *state_ptr).handle_commands();
            }
            0
        }
        WM_CLOSE => {
            if !state_ptr.is_null() {
                (&mut *state_ptr).cleanup_native();
            }
            DestroyWindow(hwnd);
            0
        }
        WM_DESTROY => {
            if !state_ptr.is_null() {
                let state = &mut *state_ptr;
                state.cleanup_native();
                let mut current = lock_status(&state.status);
                current.ready = false;
                current.stopped = true;
            }
            PostQuitMessage(0);
            0
        }
        _ => DefWindowProcW(hwnd, message, wparam, lparam),
    }
}

fn validate_start_request(request: &DwmSurfaceRequest) -> WindowsWallpaperResult<()> {
    if request.host.handle == 0
        || request.source.handle == 0
        || request.host.handle == request.source.handle
    {
        return Err(WindowsWallpaperError::new(
            "WALLPAPER_ENGINE_DWM_IDENTITY_INVALID",
            "host/source HWND 必须非零且不同",
        ));
    }
    Ok(())
}

fn find_desktop_icon_host() -> WindowsWallpaperResult<WindowIdentity> {
    let progman = find_top_level_by_class("Progman", null_mut());
    if contains_desktop_icon_view(progman) {
        return window_identity(progman);
    }
    let mut worker = null_mut();
    loop {
        worker = find_top_level_by_class("WorkerW", worker);
        if worker.is_null() {
            break;
        }
        if contains_desktop_icon_view(worker) {
            return window_identity(worker);
        }
    }
    Err(WindowsWallpaperError::new(
        "WALLPAPER_ENGINE_DESKTOP_ICON_HOST_UNAVAILABLE",
        "未找到包含 SHELLDLL_DefView 的 Explorer host",
    ))
}

fn find_top_level_by_class(class_name: &str, after: HWND) -> HWND {
    let class_name = wide_null(class_name);
    unsafe { FindWindowExW(null_mut(), after, class_name.as_ptr(), null()) }
}

fn contains_desktop_icon_view(candidate: HWND) -> bool {
    if candidate.is_null() || unsafe { IsWindow(candidate) } == 0 {
        return false;
    }
    let class_name = wide_null("SHELLDLL_DefView");
    !unsafe { FindWindowExW(candidate, null_mut(), class_name.as_ptr(), null()) }.is_null()
}

fn lock_status(status: &Arc<Mutex<DwmSurfaceStatus>>) -> MutexGuard<'_, DwmSurfaceStatus> {
    status
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn raw_hwnd(value: u64) -> HWND {
    value as usize as HWND
}

fn surface_window_is_owned(hwnd: HWND, status: &Arc<Mutex<DwmSurfaceStatus>>) -> bool {
    if hwnd.is_null() || unsafe { IsWindow(hwnd) } == 0 {
        return false;
    }
    let expected_thread = lock_status(status).surface_thread_id;
    if expected_thread == 0 {
        return false;
    }
    let mut process_id = 0;
    let thread_id = unsafe { GetWindowThreadProcessId(hwnd, &mut process_id) };
    thread_id == expected_thread && process_id == std::process::id()
}

fn hwnd_value(hwnd: HWND) -> u64 {
    hwnd as usize as u64
}

fn wide_null(value: impl AsRef<OsStr>) -> Vec<u16> {
    value
        .as_ref()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

fn last_win32_error(code: &'static str, operation: &str) -> WindowsWallpaperError {
    WindowsWallpaperError::new(
        code,
        format!("{operation} 失败：{}", std::io::Error::last_os_error()),
    )
}

#[cfg(test)]
mod tests {
    use super::{FollowFailureBudget, MAX_CONSECUTIVE_FOLLOW_FAILURES};

    #[test]
    fn follow_surface_retires_only_after_eight_consecutive_failures() {
        let mut budget = FollowFailureBudget::default();
        for _ in 1..MAX_CONSECUTIVE_FOLLOW_FAILURES {
            assert!(!budget.record_failure());
        }
        assert!(budget.record_failure());

        budget.record_success();
        assert!(!budget.record_failure(), "成功一次必须重置连续失败预算");
    }
}
