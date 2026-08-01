//! WorkerW/Explorer 的完整桌面平台适配器。
//!
//! 本文件是唯一允许完整桌面模式使用 Win32 `unsafe` 的位置。所有跨进程消息均有
//! 超时；所有 Explorer 修改均以捕获快照为前提，且绝不销毁 Explorer 窗口。

use crate::{
    app::window_labels,
    runtime::{
        full_desktop::{
            Attachment, FullDesktopError, FullDesktopMode, FullDesktopPlatform, IconSnapshot,
            OwnerStatus, PlatformSnapshot, RecoveryJournal, WindowIdentity,
        },
        resources::ProcessIdentity,
        window::DisplayGeometry,
        window_adapter,
    },
};
use serde::{Deserialize, Serialize};
use std::{
    mem::{size_of, zeroed},
    ptr::null_mut,
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager, WebviewWindow};
use windows_sys::core::BOOL;
use windows_sys::Win32::{
    Foundation::{
        CloseHandle, GetLastError, SetLastError, COLORREF, ERROR_INVALID_PARAMETER, FILETIME, HWND,
        INVALID_HANDLE_VALUE, LPARAM, POINT, RECT, WPARAM,
    },
    Graphics::Gdi::{RedrawWindow, ScreenToClient, RDW_ALLCHILDREN, RDW_INVALIDATE},
    System::{
        Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
            TH32CS_SNAPPROCESS,
        },
        Threading::{GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION},
    },
    UI::{
        Controls::{LVM_GETBKCOLOR, LVM_SETBKCOLOR},
        WindowsAndMessaging::{
            EnumWindows, FindWindowExW, GetClassNameW, GetLayeredWindowAttributes, GetParent,
            GetShellWindow, GetWindowLongPtrW, GetWindowPlacement, GetWindowRect,
            GetWindowThreadProcessId, IsWindow, IsWindowVisible, SendMessageTimeoutW,
            SetLayeredWindowAttributes, SetParent, SetWindowLongPtrW, SetWindowPlacement,
            SetWindowPos, ShowWindow, ShowWindowAsync, GWLP_HWNDPARENT, GWL_EXSTYLE, GWL_STYLE,
            HWND_BOTTOM, LWA_COLORKEY, SMTO_ABORTIFHUNG, SWP_FRAMECHANGED, SWP_NOACTIVATE,
            SWP_NOZORDER, SWP_SHOWWINDOW, SW_HIDE, SW_SHOW, WINDOWPLACEMENT, WS_CHILD,
            WS_EX_LAYERED, WS_POPUP,
        },
    },
};

const PROGMAN_SPAWN_WORKERW_MESSAGE: u32 = 0x052c;
const CROSS_PROCESS_TIMEOUT_MS: u32 = 750;
const ICON_VISIBILITY_POLL_INTERVAL: Duration = Duration::from_millis(10);
const SNAPSHOT_VERSION: u32 = 3;
const BLACK_COLORREF: COLORREF = 0;
const ROLLBACK_BUDGET: Duration = Duration::from_secs(5);

#[derive(Clone, Copy)]
struct RollbackBudget {
    started: Instant,
    limit: Duration,
}

impl RollbackBudget {
    fn start() -> Self {
        Self {
            started: Instant::now(),
            limit: ROLLBACK_BUDGET,
        }
    }

    #[cfg(test)]
    fn with_elapsed(elapsed: Duration, limit: Duration) -> Self {
        Self {
            started: Instant::now() - elapsed,
            limit,
        }
    }

    fn check(&self, operation: &str) -> Result<(), FullDesktopError> {
        let elapsed = self.started.elapsed();
        if elapsed >= self.limit {
            Err(platform_error(format!(
                "完整桌面 rollback 超过 {}ms（elapsedMs={} operation={operation}），已停止后续 mutation",
                self.limit.as_millis(),
                elapsed.as_millis(),
            )))
        } else {
            Ok(())
        }
    }

    fn deadline(&self) -> Instant {
        self.started + self.limit
    }
}

#[derive(Default)]
struct RestoreErrors {
    first: Option<FullDesktopError>,
}

impl RestoreErrors {
    fn record(&mut self, result: Result<(), FullDesktopError>) -> bool {
        match result {
            Ok(()) => true,
            Err(error) => {
                if self.first.is_none() {
                    self.first = Some(error);
                }
                false
            }
        }
    }

    fn finish(self) -> Result<(), FullDesktopError> {
        self.first.map_or(Ok(()), Err)
    }
}

/// 使用真实 `AppHandle` 获取 Tauri 主窗口，不缓存裸 HWND，避免窗口重建后误操作旧句柄。
pub struct TauriFullDesktopPlatform {
    app: AppHandle,
    active: Option<ActiveAttachment>,
    attachment_sequence: u64,
}

impl TauriFullDesktopPlatform {
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            active: None,
            attachment_sequence: 0,
        }
    }

    fn main_window(&self) -> Result<WebviewWindow, FullDesktopError> {
        self.app
            .get_webview_window(window_labels::MAIN)
            .ok_or_else(|| platform_error("主窗口不可用"))
    }

    fn main_hwnd(&self) -> Result<HWND, FullDesktopError> {
        let window = self.main_window()?;
        let handle = window
            .hwnd()
            .map_err(|error| platform_error(format!("读取主窗口 HWND 失败：{error}")))?;
        Ok(handle.0 as HWND)
    }

    fn capture_data(&self, mode: FullDesktopMode) -> Result<CapturedDesktop, FullDesktopError> {
        let window = self.main_window()?;
        let main = capture_window_state(self.main_hwnd()?, &window)?;
        let target_display = capture_target_display(&window)?;
        // `0x052c` 只请求 Explorer 创建/暴露 WorkerW；消息失败时不会继续猜测宿主。
        request_workerw_spawn()?;
        let explorer = discover_explorer()?;
        let icons = capture_icon_state(explorer.list_view)?;
        Ok(CapturedDesktop {
            version: SNAPSHOT_VERSION,
            mode,
            main,
            target_display,
            explorer: explorer.identity,
            icons,
        })
    }

    fn active_for_mutation(&self) -> Result<&ActiveAttachment, FullDesktopError> {
        self.active
            .as_ref()
            .ok_or_else(|| platform_error("完整桌面附着不存在"))
    }

    /// diagnostics 专用只读 probe：不枚举或创建 WorkerW，也不调用任何 attach、恢复或
    /// journal 路径。半附着时 active 尚未提交，因此必须复用 mutation 前捕获的宿主。
    fn actual_main_desktop_child(&self, snapshot: &PlatformSnapshot) -> Option<bool> {
        let captured = decode_snapshot(snapshot).ok()?;
        let expected_host = match captured.mode {
            FullDesktopMode::Passive => &captured.explorer.workerw,
            FullDesktopMode::Interactive => &captured.explorer.def_view,
            FullDesktopMode::Disabled => return None,
        };
        let main = self.main_hwnd().ok()?;
        let parent = unsafe { GetParent(main) };
        if parent.is_null() || hwnd_to_u64(parent) != expected_host.handle {
            return Some(false);
        }
        window_identity(parent)
            .ok()
            .map(|actual| same_window_identity(&actual, expected_host))
    }
}

impl FullDesktopPlatform for TauriFullDesktopPlatform {
    fn supported(&self) -> bool {
        true
    }

    fn actual_main_desktop_child(
        &self,
        snapshot: &PlatformSnapshot,
    ) -> Result<Option<bool>, FullDesktopError> {
        Ok(TauriFullDesktopPlatform::actual_main_desktop_child(
            self, snapshot,
        ))
    }

    fn current_owner_identity(&self) -> Result<ProcessIdentity, FullDesktopError> {
        process_identity_for_pid(std::process::id())
    }

    fn owner_status(&self, owner: ProcessIdentity) -> Result<OwnerStatus, FullDesktopError> {
        owner_status(owner)
    }

    fn capture(
        &mut self,
        mode: FullDesktopMode,
    ) -> Result<(PlatformSnapshot, IconSnapshot), FullDesktopError> {
        if !matches!(
            mode,
            FullDesktopMode::Passive | FullDesktopMode::Interactive
        ) {
            return Err(platform_error("不能捕获 disabled 完整桌面模式"));
        }
        let captured = self.capture_data(mode)?;
        let windows = captured.window_identities();
        let icon_snapshot = IconSnapshot {
            visible: captured.icons.visible,
            payload: serde_json::to_value(&captured.icons)
                .map_err(|error| platform_error(format!("编码图标快照失败：{error}")))?,
        };
        let platform_snapshot = PlatformSnapshot {
            windows,
            payload: serde_json::to_value(captured)
                .map_err(|error| platform_error(format!("编码平台快照失败：{error}")))?,
        };
        Ok((platform_snapshot, icon_snapshot))
    }

    fn attach(
        &mut self,
        mode: FullDesktopMode,
        snapshot: &PlatformSnapshot,
        icons_visible: bool,
        interaction_locked: bool,
    ) -> Result<Attachment, FullDesktopError> {
        let captured = decode_snapshot(snapshot)?;
        let current_main = self.main_hwnd()?;
        verify_window_identity(current_main, &captured.main.identity)?;
        let explorer = discover_explorer()?;
        verify_explorer_identity(&explorer, &captured.explorer)?;
        let plan = plan_attachment(mode, &explorer)?;
        let target_bounds = attach_screen_bounds(captured.target_display);

        // 先把顶层 Tauri 窗口切为 child，再交由目标宿主拥有；失败时 core 会依据 journal
        // 调用 restore，因此任何这里之后的错误都不能清掉捕获数据。
        let child_style = (captured.main.style | WS_CHILD as isize) & !(WS_POPUP as isize);
        set_window_long_ptr(current_main, GWL_STYLE, child_style)?;
        set_parent_checked(current_main, plan.parent)?;

        let mut client_origin = POINT {
            x: target_bounds.left,
            y: target_bounds.top,
        };
        if unsafe { ScreenToClient(plan.parent, &mut client_origin) } == 0 {
            return Err(last_error("将主窗口屏幕坐标转换为宿主客户区坐标失败"));
        }
        set_window_pos_checked(
            current_main,
            HWND_BOTTOM,
            client_origin.x,
            client_origin.y,
            target_bounds.right - target_bounds.left,
            target_bounds.bottom - target_bounds.top,
            SWP_FRAMECHANGED | SWP_NOACTIVATE | SWP_SHOWWINDOW,
        )?;
        show_window_and_ack(current_main, true)?;
        verify_window_rect(current_main, target_bounds, 2, "完整桌面目标显示器矩形")?;

        if plan.requires_interactive_icon_layer {
            apply_interactive_icon_layer(
                explorer.list_view,
                &explorer.identity.list_view,
                icons_visible,
            )?;
        } else {
            set_icon_visibility(explorer.list_view, icons_visible)?;
        }

        let window = self.main_window()?;
        window
            .set_ignore_cursor_events(interaction_locked)
            .map_err(|error| platform_error(format!("设置完整桌面鼠标锁定失败：{error}")))?;
        self.attachment_sequence = self.attachment_sequence.wrapping_add(1);
        let attachment = Attachment {
            id: format!("full-desktop-{}", self.attachment_sequence),
            generation: self.attachment_sequence,
            pending: false,
        };
        self.active = Some(ActiveAttachment {
            attachment: attachment.clone(),
            main: captured.main.identity,
            explorer: captured.explorer,
            target: hwnd_to_u64(plan.parent),
            list_view: hwnd_to_u64(explorer.list_view),
        });
        Ok(attachment)
    }

    fn restore(
        &mut self,
        snapshot: &PlatformSnapshot,
        attachment: &Attachment,
    ) -> Result<(), FullDesktopError> {
        let captured = decode_snapshot(snapshot)?;
        let budget = RollbackBudget::start();
        let mut errors = RestoreErrors::default();
        // Attach 失败时 core 传入 pending attachment；此时允许按照 snapshot 恢复，不能因为
        // 尚未提交 active attachment 而跳过清理。
        if let Some(active) = &self.active {
            errors.record(validate_attachment_match(&active.attachment, attachment));
        }

        // 先尽最大努力恢复图标层；只有完整 identity 或同一份持久化 chain 仍可验证时
        // 才触碰 Explorer。Explorer 已证明换代时旧 ListView 已销毁，可安全跳过。
        let verified_attached_target = match verified_explorer_for_restore(&captured) {
            Ok(Some((list_view, list_identity, target))) => {
                errors.record(restore_icon_state_best_effort(
                    list_view,
                    &list_identity,
                    &captured.icons,
                    &budget,
                ));
                Some(target)
            }
            Ok(None) => None,
            Err(error) => {
                errors.record(Err(error));
                None
            }
        };

        // Main window 与 Explorer 图标层是独立可验证对象；图标恢复失败不能阻止主窗口
        // 回到普通顶层。依赖 SetParent 成功的 style/bounds 步骤仍保持安全顺序。
        match (self.main_hwnd(), self.main_window()) {
            (Ok(main), Ok(window)) => {
                match window_identity(main) {
                    Ok(actual_main)
                        if is_restorable_main_identity(
                            &actual_main,
                            &captured.main.identity,
                            verified_attached_target,
                        ) =>
                    {
                        errors.record(budget.check("解除鼠标锁定").and_then(|_| {
                            window.set_ignore_cursor_events(false).map_err(|error| {
                                platform_error(format!("解除完整桌面鼠标锁定失败：{error}"))
                            })
                        }));
                        let detached = errors.record(
                            budget
                                .check("恢复主窗口父级")
                                .and_then(|_| set_parent_checked(main, null_mut())),
                        );
                        if detached {
                            errors.record(budget.check("恢复主窗口 style").and_then(|_| {
                                set_window_long_ptr(main, GWL_STYLE, captured.main.style)
                            }));
                            errors.record(budget.check("恢复主窗口 extended style").and_then(
                                |_| set_window_long_ptr(main, GWL_EXSTYLE, captured.main.ex_style),
                            ));
                            errors.record(budget.check("恢复主窗口 bounds").and_then(|_| {
                                set_window_pos_checked(
                                    main,
                                    null_mut(),
                                    captured.main.rect.left,
                                    captured.main.rect.top,
                                    captured.main.rect.right - captured.main.rect.left,
                                    captured.main.rect.bottom - captured.main.rect.top,
                                    restore_top_level_position_flags(),
                                )
                            }));
                            errors.record(budget.check("恢复主窗口边框").and_then(|_| {
                                window
                                    .set_decorations(captured.main.tauri.decorated)
                                    .map_err(|error| {
                                        platform_error(format!("恢复主窗口边框失败：{error}"))
                                    })
                            }));
                            errors.record(budget.check("恢复主窗口置顶状态").and_then(|_| {
                                window
                                    .set_always_on_top(captured.main.tauri.always_on_top)
                                    .map_err(|error| {
                                        platform_error(format!("恢复主窗口置顶状态失败：{error}"))
                                    })
                            }));
                            errors.record(
                                budget
                                    .check("恢复主窗口可见性")
                                    .and_then(|_| show_window_and_ack(main, captured.main.visible)),
                            );
                            errors.record(budget.check("恢复主窗口 placement").and_then(|_| {
                                set_window_placement_checked(main, captured.main.placement)
                            }));
                            errors.record(budget.check("验证主窗口恢复状态").and_then(|_| {
                                verify_restored_main_window(main, &window, &captured.main)
                            }));
                            errors.record(budget.check("验证主窗口 identity").and_then(|_| {
                                verify_window_identity(main, &captured.main.identity)
                            }));
                        }
                    }
                    Ok(_) => {
                        errors.record(Err(platform_error(
                            "主窗口不属于原始顶层状态或已验证的 Explorer 宿主",
                        )));
                    }
                    Err(error) => {
                        errors.record(Err(error));
                    }
                }
            }
            (Err(error), _) | (_, Err(error)) => {
                errors.record(Err(error));
            }
        }

        let result = errors.finish();
        if result.is_ok() {
            self.active = None;
        }
        result
    }

    fn recover_stale(&mut self, journal: &RecoveryJournal) -> Result<(), FullDesktopError> {
        let captured = decode_snapshot(&journal.platform_snapshot)?;
        let current_shell = current_shell_identity()?;
        let captured_process = captured
            .explorer
            .shell
            .process
            .ok_or_else(|| platform_error("恢复快照缺少 Explorer 进程 identity"))?;
        let current_process = current_shell
            .process
            .ok_or_else(|| platform_error("当前 Explorer Shell 缺少进程 identity"))?;
        if shell_process_generation_changed(current_process, captured_process) {
            // 只有进程 creation identity 已证明换代，才能确认旧 ListView 随旧 Explorer
            // 销毁并安全 no-op；临时枚举失败绝不能当作恢复成功。
            self.active = None;
            return Ok(());
        }
        if current_shell != captured.explorer.shell {
            return Err(platform_error(
                "同代 Explorer Shell identity 不完整，拒绝猜测 stale recovery",
            ));
        }
        let current = discover_explorer()?;
        verify_explorer_identity(&current, &captured.explorer)?;
        restore_icon_state_best_effort(
            current.list_view,
            &current.identity.list_view,
            &captured.icons,
            &RollbackBudget::start(),
        )?;
        self.active = None;
        Ok(())
    }

    fn validate_attachment(&mut self, attachment: &Attachment) -> Result<(), FullDesktopError> {
        let active = self.active_for_mutation()?;
        validate_attachment_match(&active.attachment, attachment)?;
        let main = self.main_hwnd()?;
        let target = u64_to_hwnd(active.target);
        let list_view = u64_to_hwnd(active.list_view);
        let actual_main = window_identity(main)?;
        if !is_attached_main_identity(&actual_main, &active.main, active.target) {
            return Err(platform_error("主窗口不再附着于已验证的 Explorer 宿主"));
        }
        if unsafe { IsWindow(target) } == 0 || unsafe { IsWindow(list_view) } == 0 {
            return Err(platform_error("Explorer 宿主窗口已失效"));
        }
        let explorer = discover_explorer()?;
        verify_explorer_identity(&explorer, &active.explorer)?;
        if hwnd_to_u64(explorer.list_view) != active.list_view {
            return Err(platform_error("Explorer 图标层句柄已改变"));
        }
        Ok(())
    }

    fn set_icons_visible(&mut self, visible: bool) -> Result<(), FullDesktopError> {
        let active = self.active_for_mutation()?;
        set_icon_visibility(u64_to_hwnd(active.list_view), visible)
    }

    fn set_interaction_locked(&mut self, locked: bool) -> Result<(), FullDesktopError> {
        self.active_for_mutation()?;
        self.main_window()?
            .set_ignore_cursor_events(locked)
            .map_err(|error| platform_error(format!("设置完整桌面鼠标锁定失败：{error}")))
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CapturedDesktop {
    version: u32,
    mode: FullDesktopMode,
    main: CapturedMainWindow,
    target_display: PhysicalDisplayBounds,
    explorer: ExplorerDesktop,
    icons: CapturedIconState,
}

impl CapturedDesktop {
    fn window_identities(&self) -> Vec<WindowIdentity> {
        vec![
            self.main.identity.clone(),
            self.explorer.shell.clone(),
            self.explorer.progman.clone(),
            self.explorer.top_level.clone(),
            self.explorer.def_view.clone(),
            self.explorer.list_view.clone(),
            self.explorer.workerw.clone(),
        ]
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CapturedMainWindow {
    identity: WindowIdentity,
    parent: u64,
    style: isize,
    ex_style: isize,
    rect: SavedRect,
    placement: SavedWindowPlacement,
    visible: bool,
    tauri: TauriWindowProperties,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct SavedRect {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}

/// `WINDOWPLACEMENT` 不能直接持久化；保存其稳定字段可令最小化/最大化时的
/// `showCmd` 与 `rcNormalPosition` 在完整桌面往返后对称恢复。
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct SavedWindowPlacement {
    flags: u32,
    show_cmd: u32,
    min_position: SavedPoint,
    max_position: SavedPoint,
    normal_position: SavedRect,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct SavedPoint {
    x: i32,
    y: i32,
}

/// attach 使用 Tauri monitor API 返回的物理像素 bounds；scale/primary 一同落盘，
/// 让 journal 与 diagnostics 能说明这次附着选择了哪个显示器。
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct PhysicalDisplayBounds {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    scale_factor: f64,
    primary: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct TauriWindowProperties {
    decorated: bool,
    always_on_top: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExplorerDesktop {
    shell: WindowIdentity,
    progman: WindowIdentity,
    top_level: WindowIdentity,
    def_view: WindowIdentity,
    list_view: WindowIdentity,
    workerw: WindowIdentity,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CapturedIconState {
    handle: u64,
    ex_style: isize,
    layered: Option<LayeredAttributes>,
    background_color: u32,
    visible: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct LayeredAttributes {
    color_key: u32,
    alpha: u8,
    flags: u32,
}

#[derive(Clone)]
struct ActiveAttachment {
    attachment: Attachment,
    main: WindowIdentity,
    explorer: ExplorerDesktop,
    target: u64,
    list_view: u64,
}

#[derive(Clone, Copy)]
struct AttachmentPlan {
    parent: HWND,
    requires_interactive_icon_layer: bool,
}

fn plan_attachment(
    mode: FullDesktopMode,
    explorer: &ExplorerHandles,
) -> Result<AttachmentPlan, FullDesktopError> {
    match mode {
        FullDesktopMode::Passive => Ok(AttachmentPlan {
            parent: explorer.workerw,
            requires_interactive_icon_layer: false,
        }),
        FullDesktopMode::Interactive => Ok(AttachmentPlan {
            parent: explorer.def_view,
            requires_interactive_icon_layer: true,
        }),
        FullDesktopMode::Disabled => Err(platform_error("disabled 模式没有 Explorer 宿主")),
    }
}

#[derive(Clone)]
struct ExplorerHandles {
    top_level: HWND,
    def_view: HWND,
    list_view: HWND,
    workerw: HWND,
    identity: ExplorerDesktop,
}

fn capture_window_state(
    hwnd: HWND,
    window: &WebviewWindow,
) -> Result<CapturedMainWindow, FullDesktopError> {
    let identity = window_identity(hwnd)?;
    // M6 只接管无 owner/parent 的正常 Tauri 主窗口。若初始就存在外部 owner，恢复协议的
    // `SetParent(NULL)` 无法无损重建原 parent chain，必须在首次 mutation 前 fail-closed。
    if identity.parent_handle != 0 {
        return Err(platform_error("完整桌面只支持无父级的主窗口"));
    }
    let mut rect: RECT = unsafe { zeroed() };
    if unsafe { GetWindowRect(hwnd, &mut rect) } == 0 {
        return Err(last_error("读取主窗口矩形失败"));
    }
    Ok(CapturedMainWindow {
        identity,
        parent: get_window_long_ptr(hwnd, GWLP_HWNDPARENT)? as usize as u64,
        style: get_window_long_ptr(hwnd, GWL_STYLE)?,
        ex_style: get_window_long_ptr(hwnd, GWL_EXSTYLE)?,
        rect: SavedRect {
            left: rect.left,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
        },
        placement: capture_window_placement(hwnd)?,
        visible: window.is_visible().unwrap_or(false),
        tauri: TauriWindowProperties {
            decorated: window.is_decorated().unwrap_or(true),
            always_on_top: window.is_always_on_top().unwrap_or(false),
        },
    })
}

fn capture_window_placement(hwnd: HWND) -> Result<SavedWindowPlacement, FullDesktopError> {
    let mut placement: WINDOWPLACEMENT = unsafe { zeroed() };
    placement.length = size_of::<WINDOWPLACEMENT>() as u32;
    if unsafe { GetWindowPlacement(hwnd, &mut placement) } == 0 {
        return Err(last_error("读取主窗口 placement 失败"));
    }
    Ok(saved_window_placement(&placement))
}

fn saved_window_placement(placement: &WINDOWPLACEMENT) -> SavedWindowPlacement {
    SavedWindowPlacement {
        flags: placement.flags,
        show_cmd: placement.showCmd,
        min_position: SavedPoint {
            x: placement.ptMinPosition.x,
            y: placement.ptMinPosition.y,
        },
        max_position: SavedPoint {
            x: placement.ptMaxPosition.x,
            y: placement.ptMaxPosition.y,
        },
        normal_position: SavedRect {
            left: placement.rcNormalPosition.left,
            top: placement.rcNormalPosition.top,
            right: placement.rcNormalPosition.right,
            bottom: placement.rcNormalPosition.bottom,
        },
    }
}

fn native_window_placement(saved: SavedWindowPlacement) -> WINDOWPLACEMENT {
    WINDOWPLACEMENT {
        length: size_of::<WINDOWPLACEMENT>() as u32,
        flags: saved.flags,
        showCmd: saved.show_cmd,
        ptMinPosition: POINT {
            x: saved.min_position.x,
            y: saved.min_position.y,
        },
        ptMaxPosition: POINT {
            x: saved.max_position.x,
            y: saved.max_position.y,
        },
        rcNormalPosition: RECT {
            left: saved.normal_position.left,
            top: saved.normal_position.top,
            right: saved.normal_position.right,
            bottom: saved.normal_position.bottom,
        },
    }
}

fn capture_target_display(
    window: &WebviewWindow,
) -> Result<PhysicalDisplayBounds, FullDesktopError> {
    let display = window_adapter::current_webview_display_geometry(window)
        .ok_or_else(|| platform_error("无法确定完整桌面目标显示器"))?;
    target_display_bounds(display)
}

fn target_display_bounds(
    display: DisplayGeometry,
) -> Result<PhysicalDisplayBounds, FullDesktopError> {
    if !display.scale_factor.is_finite() || display.scale_factor <= 0.0 {
        return Err(platform_error("目标显示器缩放比例无效"));
    }
    let width = i32::try_from(display.width)
        .map_err(|_| platform_error("目标显示器宽度超出 Win32 范围"))?;
    let height = i32::try_from(display.height)
        .map_err(|_| platform_error("目标显示器高度超出 Win32 范围"))?;
    if width <= 0 || height <= 0 {
        return Err(platform_error("目标显示器尺寸无效"));
    }
    let right = i64::from(display.x) + i64::from(width);
    let bottom = i64::from(display.y) + i64::from(height);
    if right > i64::from(i32::MAX)
        || right < i64::from(i32::MIN)
        || bottom > i64::from(i32::MAX)
        || bottom < i64::from(i32::MIN)
    {
        return Err(platform_error("目标显示器边界超出 Win32 范围"));
    }
    Ok(PhysicalDisplayBounds {
        x: display.x,
        y: display.y,
        width,
        height,
        scale_factor: display.scale_factor,
        primary: display.primary,
    })
}

fn attach_screen_bounds(display: PhysicalDisplayBounds) -> SavedRect {
    SavedRect {
        left: display.x,
        top: display.y,
        right: display.x + display.width,
        bottom: display.y + display.height,
    }
}

fn request_workerw_spawn() -> Result<(), FullDesktopError> {
    let shell = unsafe { GetShellWindow() };
    if shell.is_null() {
        return Err(platform_error("未找到 Explorer Shell 窗口"));
    }
    let shell_identity = window_identity(shell)?;
    let explorer_process = shell_identity
        .process
        .ok_or_else(|| platform_error("Explorer Shell 缺少进程身份"))?;
    let progman = find_unique_top_level_window("Progman", explorer_process)?;
    send_message_timeout(progman, PROGMAN_SPAWN_WORKERW_MESSAGE, 0, 0)?;
    Ok(())
}

/// 读取当前 Explorer Shell 的完整窗口身份。stale recovery 只能在确认仍是同一 Shell
/// generation 后继续；Shell 缺失或身份读取失败都必须保留 journal 并重试。
fn current_shell_identity() -> Result<WindowIdentity, FullDesktopError> {
    let shell = unsafe { GetShellWindow() };
    if shell.is_null() {
        return Err(platform_error("无法验证当前 Explorer Shell generation"));
    }
    window_identity(shell)
}

/// 仅当 Explorer Shell 仍是捕获时的同一进程 generation，且完整 Explorer 窗口链可以
/// 重新验证时，才允许恢复图标层。进程创建时间不同证明旧 Explorer 已销毁，因此安全
/// no-op；同代但任何 identity 不确定时一律拒绝修改当前桌面。
fn verified_explorer_for_restore(
    captured: &CapturedDesktop,
) -> Result<Option<(HWND, WindowIdentity, u64)>, FullDesktopError> {
    let current_shell = current_shell_identity()?;
    let captured_process = captured
        .explorer
        .shell
        .process
        .ok_or_else(|| platform_error("恢复快照缺少 Explorer 进程 identity"))?;
    let current_process = current_shell
        .process
        .ok_or_else(|| platform_error("当前 Explorer Shell 缺少进程 identity"))?;
    if shell_process_generation_changed(current_process, captured_process) {
        return Ok(None);
    }
    if current_shell != captured.explorer.shell {
        return Err(platform_error(
            "同代 Explorer Shell identity 不完整，拒绝猜测恢复目标",
        ));
    }

    let current = discover_explorer()?;
    verify_explorer_identity(&current, &captured.explorer)?;
    let plan = plan_attachment(captured.mode, &current)?;
    Ok(Some((
        current.list_view,
        current.identity.list_view.clone(),
        hwnd_to_u64(plan.parent),
    )))
}

/// PID 相同不足以证明仍是同一个 Explorer；进程创建时间或父链变化均视为新 generation。
fn shell_process_generation_changed(current: ProcessIdentity, captured: ProcessIdentity) -> bool {
    current != captured
}

fn discover_explorer() -> Result<ExplorerHandles, FullDesktopError> {
    let shell = unsafe { GetShellWindow() };
    if shell.is_null() {
        return Err(platform_error("未找到 Explorer Shell 窗口"));
    }
    let shell_identity = window_identity(shell)?;
    let explorer_process = shell_identity
        .process
        .ok_or_else(|| platform_error("Explorer Shell 缺少进程身份"))?;
    let progman = find_unique_top_level_window("Progman", explorer_process)?;
    let progman_identity = window_identity(progman)?;

    let mut scan = ExplorerScan::default();
    let result = unsafe {
        EnumWindows(
            Some(enum_windows_for_def_view),
            &mut scan as *mut _ as LPARAM,
        )
    };
    if result == 0 {
        return Err(last_error("枚举 Explorer 顶层窗口失败"));
    }
    let candidate = select_unique_explorer_candidate(scan.candidates, explorer_process)?;
    let workerw = unsafe {
        FindWindowExW(
            null_mut(),
            candidate.top_level,
            wide("WorkerW").as_ptr(),
            null_mut(),
        )
    };
    if workerw.is_null() {
        return Err(platform_error("未找到 DefView 后的 WorkerW 宿主"));
    }
    let workerw_identity = window_identity(workerw)?;
    if workerw_identity.process != Some(explorer_process) {
        return Err(platform_error("WorkerW 不属于当前 Explorer 进程"));
    }
    let def_view_identity = window_identity(candidate.def_view)?;
    let list_view_identity = window_identity(candidate.list_view)?;
    let top_level_identity = window_identity(candidate.top_level)?;
    if def_view_identity.process != Some(explorer_process)
        || list_view_identity.process != Some(explorer_process)
    {
        return Err(platform_error("DefView 或图标层不属于当前 Explorer 进程"));
    }
    let identity = ExplorerDesktop {
        shell: shell_identity,
        progman: progman_identity,
        top_level: top_level_identity,
        def_view: def_view_identity,
        list_view: list_view_identity,
        workerw: workerw_identity,
    };
    let handles = ExplorerHandles {
        top_level: candidate.top_level,
        def_view: candidate.def_view,
        list_view: candidate.list_view,
        workerw,
        identity,
    };
    verify_explorer_shape(&handles)?;
    Ok(handles)
}

#[derive(Default)]
struct ExplorerScan {
    candidates: Vec<ExplorerCandidate>,
}

#[derive(Clone)]
struct ExplorerCandidate {
    top_level: HWND,
    def_view: HWND,
    list_view: HWND,
    process: ProcessIdentity,
}

/// Explorer 可能短暂保留旧 WorkerW；多个同进程 DefView 候选时无法证明哪一个安全，
/// 因此宁可拒绝附着，也不做“第一个匹配”式猜测。
fn select_unique_explorer_candidate(
    candidates: Vec<ExplorerCandidate>,
    explorer_process: ProcessIdentity,
) -> Result<ExplorerCandidate, FullDesktopError> {
    let mut matching = candidates
        .into_iter()
        .filter(|candidate| candidate.process == explorer_process);
    let Some(candidate) = matching.next() else {
        return Err(platform_error(
            "未找到 Explorer DefView/SysListView32 图标层",
        ));
    };
    if matching.next().is_some() {
        return Err(platform_error(
            "检测到多个 Explorer DefView/SysListView32 候选，拒绝猜测宿主",
        ));
    }
    Ok(candidate)
}

fn find_unique_top_level_window(
    class_name: &str,
    process: ProcessIdentity,
) -> Result<HWND, FullDesktopError> {
    let mut scan = ClassScan {
        class_name: class_name.to_owned(),
        windows: Vec::new(),
    };
    if unsafe { EnumWindows(Some(enum_windows_for_class), &mut scan as *mut _ as LPARAM) } == 0 {
        return Err(last_error("枚举指定窗口类失败"));
    }
    let mut matching = scan
        .windows
        .into_iter()
        .filter_map(|hwnd| window_identity(hwnd).ok().map(|identity| (hwnd, identity)))
        .filter(|(_, identity)| identity.process == Some(process));
    let Some((hwnd, _)) = matching.next() else {
        return Err(platform_error(format!(
            "未找到属于当前 Explorer 的 {class_name} 窗口"
        )));
    };
    if matching.next().is_some() {
        return Err(platform_error(format!(
            "检测到多个属于当前 Explorer 的 {class_name} 窗口，拒绝猜测"
        )));
    }
    Ok(hwnd)
}

struct ClassScan {
    class_name: String,
    windows: Vec<HWND>,
}

unsafe extern "system" fn enum_windows_for_class(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let scan = &mut *(lparam as *mut ClassScan);
    if window_class_name(hwnd)
        .map(|class_name| class_name == scan.class_name)
        .unwrap_or(false)
    {
        scan.windows.push(hwnd);
    }
    1
}

fn verify_explorer_shape(handles: &ExplorerHandles) -> Result<(), FullDesktopError> {
    let expected_process = handles
        .identity
        .shell
        .process
        .ok_or_else(|| platform_error("Explorer Shell 缺少进程身份"))?;
    let windows = [
        (&handles.identity.shell, "Progman"),
        (&handles.identity.progman, "Progman"),
        (&handles.identity.def_view, "SHELLDLL_DefView"),
        (&handles.identity.list_view, "SysListView32"),
        (&handles.identity.workerw, "WorkerW"),
    ];
    for (identity, class_name) in windows {
        if identity.class_name != class_name || identity.process != Some(expected_process) {
            return Err(platform_error("Explorer 窗口类名或进程身份不匹配"));
        }
    }
    if handles.identity.top_level.process != Some(expected_process)
        || handles.identity.top_level.parent_handle != 0
        || handles.identity.shell.parent_handle != 0
        || handles.identity.progman.parent_handle != 0
        || handles.identity.workerw.parent_handle != 0
        || handles.identity.def_view.parent_handle != hwnd_to_u64(handles.top_level)
        || handles.identity.list_view.parent_handle != hwnd_to_u64(handles.def_view)
        || hwnd_to_u64(handles.list_view) != handles.identity.list_view.handle
        || hwnd_to_u64(handles.workerw) != handles.identity.workerw.handle
    {
        return Err(platform_error("Explorer 窗口父链或句柄关系不匹配"));
    }
    Ok(())
}

unsafe extern "system" fn enum_windows_for_def_view(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let scan = &mut *(lparam as *mut ExplorerScan);
    let def_view = FindWindowExW(
        hwnd,
        null_mut(),
        wide("SHELLDLL_DefView").as_ptr(),
        null_mut(),
    );
    if def_view.is_null() {
        return 1;
    }
    let list_view = FindWindowExW(
        def_view,
        null_mut(),
        wide("SysListView32").as_ptr(),
        null_mut(),
    );
    if list_view.is_null() {
        return 1;
    }
    if let Ok(identity) = window_identity(hwnd) {
        if let Some(process) = identity.process {
            scan.candidates.push(ExplorerCandidate {
                top_level: hwnd,
                def_view,
                list_view,
                process,
            });
        }
    }
    1
}

fn capture_icon_state(list_view: HWND) -> Result<CapturedIconState, FullDesktopError> {
    let ex_style = get_window_long_ptr(list_view, GWL_EXSTYLE)?;
    let layered = if (ex_style as u32 & WS_EX_LAYERED) != 0 {
        let mut color_key = 0;
        let mut alpha = 0;
        let mut flags = 0;
        if unsafe { GetLayeredWindowAttributes(list_view, &mut color_key, &mut alpha, &mut flags) }
            == 0
        {
            return Err(last_error("读取桌面图标透明属性失败"));
        }
        Some(LayeredAttributes {
            color_key,
            alpha,
            flags,
        })
    } else {
        None
    };
    Ok(CapturedIconState {
        handle: hwnd_to_u64(list_view),
        ex_style,
        layered,
        background_color: send_message_timeout(list_view, LVM_GETBKCOLOR, 0, 0)? as u32,
        visible: unsafe { IsWindowVisible(list_view) } != 0,
    })
}

fn apply_interactive_icon_layer(
    list_view: HWND,
    expected_identity: &WindowIdentity,
    visible: bool,
) -> Result<(), FullDesktopError> {
    verify_window_identity(list_view, expected_identity)?;
    let ex_style = get_window_long_ptr(list_view, GWL_EXSTYLE)?;
    set_window_long_ptr(list_view, GWL_EXSTYLE, ex_style | WS_EX_LAYERED as isize)?;
    if unsafe { SetLayeredWindowAttributes(list_view, BLACK_COLORREF, 0, LWA_COLORKEY) } == 0 {
        return Err(last_error("设置桌面图标黑色透明键失败"));
    }
    send_message_timeout(list_view, LVM_SETBKCOLOR, 0, BLACK_COLORREF as LPARAM)?;
    let restored_color = send_message_timeout(list_view, LVM_GETBKCOLOR, 0, 0)? as u32;
    if restored_color != BLACK_COLORREF {
        return Err(platform_error("桌面图标背景未确认写入黑色"));
    }
    let mut color_key = 0;
    let mut alpha = 0;
    let mut flags = 0;
    if unsafe { GetLayeredWindowAttributes(list_view, &mut color_key, &mut alpha, &mut flags) } == 0
        || color_key != BLACK_COLORREF
        || flags & LWA_COLORKEY == 0
    {
        return Err(platform_error("桌面图标透明键未确认生效"));
    }
    set_icon_visibility(list_view, visible)?;
    redraw_verified_icon_layer(list_view, expected_identity)
}

#[expect(
    dead_code,
    reason = "保留严格全量回滚实现，供未来需要原子恢复的路径复用"
)]
fn restore_icon_state(
    list_view: HWND,
    expected_identity: &WindowIdentity,
    snapshot: &CapturedIconState,
) -> Result<(), FullDesktopError> {
    if hwnd_to_u64(list_view) != snapshot.handle {
        return Err(platform_error("拒绝向非快照图标层恢复状态"));
    }
    verify_window_identity(list_view, expected_identity)?;
    send_message_timeout(
        list_view,
        LVM_SETBKCOLOR,
        0,
        snapshot.background_color as LPARAM,
    )?;
    set_window_long_ptr(list_view, GWL_EXSTYLE, snapshot.ex_style)?;
    if let Some(layered) = snapshot.layered {
        if unsafe {
            SetLayeredWindowAttributes(list_view, layered.color_key, layered.alpha, layered.flags)
        } == 0
        {
            return Err(last_error("恢复桌面图标透明属性失败"));
        }
    }
    set_icon_visibility(list_view, snapshot.visible)?;
    redraw_verified_icon_layer(list_view, expected_identity)
}

/// rollback 必须尽力恢复每个可独立验证的图标属性：某一步失败不能掩盖后续恢复机会。
/// 但超过总预算后立即停止，防止已经不可信的 Explorer 状态继续接受 mutation。
fn restore_icon_state_best_effort(
    list_view: HWND,
    expected_identity: &WindowIdentity,
    snapshot: &CapturedIconState,
    budget: &RollbackBudget,
) -> Result<(), FullDesktopError> {
    if hwnd_to_u64(list_view) != snapshot.handle {
        return Err(platform_error("拒绝向非快照图标层恢复状态"));
    }
    verify_window_identity(list_view, expected_identity)?;
    let mut errors = RestoreErrors::default();

    macro_rules! restore_step {
        ($operation:literal, $mutation:expr) => {{
            budget.check($operation)?;
            // 每次跨进程 mutation 前重新校验 identity，避免 Explorer 重启或 HWND 复用后
            // 将后续回滚写入无关窗口。
            errors.record(
                verify_window_identity(list_view, expected_identity).and_then(|_| $mutation),
            );
        }};
    }

    restore_step!(
        "恢复桌面图标背景",
        send_message_timeout(
            list_view,
            LVM_SETBKCOLOR,
            0,
            snapshot.background_color as LPARAM,
        )
        .map(|_| ())
    );
    restore_step!(
        "恢复桌面图标 extended style",
        set_window_long_ptr(list_view, GWL_EXSTYLE, snapshot.ex_style)
    );
    if let Some(layered) = snapshot.layered {
        restore_step!("恢复桌面图标透明属性", {
            if unsafe {
                SetLayeredWindowAttributes(
                    list_view,
                    layered.color_key,
                    layered.alpha,
                    layered.flags,
                )
            } == 0
            {
                Err(last_error("恢复桌面图标透明属性失败"))
            } else {
                Ok(())
            }
        });
    }
    restore_step!(
        "恢复桌面图标可见性",
        set_icon_visibility_with_budget(list_view, snapshot.visible, budget)
    );
    restore_step!(
        "确认桌面图标重画",
        redraw_verified_icon_layer(list_view, expected_identity)
    );
    errors.finish()
}

fn set_icon_visibility(list_view: HWND, visible: bool) -> Result<(), FullDesktopError> {
    let deadline = icon_visibility_deadline(Instant::now(), None);
    set_icon_visibility_until(list_view, visible, deadline)
}

/// Explorer 图标层属于其他进程，不能同步调用 `ShowWindow`。异步请求后仅在有界窗口内
/// 轮询可见性；超时由调用方当作恢复失败处理，进而保留 journal。
fn set_icon_visibility_with_budget(
    list_view: HWND,
    visible: bool,
    budget: &RollbackBudget,
) -> Result<(), FullDesktopError> {
    budget.check("恢复桌面图标可见性确认")?;
    let deadline = icon_visibility_deadline(Instant::now(), Some(budget.deadline()));
    set_icon_visibility_until(list_view, visible, deadline)
}

fn icon_visibility_deadline(now: Instant, rollback_deadline: Option<Instant>) -> Instant {
    let native_deadline = now + Duration::from_millis(u64::from(CROSS_PROCESS_TIMEOUT_MS));
    rollback_deadline.map_or(native_deadline, |deadline| deadline.min(native_deadline))
}

fn set_icon_visibility_until(
    list_view: HWND,
    visible: bool,
    deadline: Instant,
) -> Result<(), FullDesktopError> {
    // `ShowWindowAsync` 没有可靠的成功返回值；以 IsWindow + IsWindowVisible 的有界确认
    // 作为唯一结果判据，避免跨进程同步调用把主 UI 卡在 Explorer 上。
    unsafe { ShowWindowAsync(list_view, if visible { SW_SHOW } else { SW_HIDE }) };
    loop {
        if unsafe { IsWindow(list_view) } == 0 {
            return Err(platform_error("Explorer 图标层在可见性确认期间已失效"));
        }
        if (unsafe { IsWindowVisible(list_view) } != 0) == visible {
            return Ok(());
        }
        let now = Instant::now();
        if now >= deadline {
            return Err(platform_error("Explorer 图标层可见性确认超时"));
        }
        thread::sleep(ICON_VISIBILITY_POLL_INTERVAL.min(deadline.duration_since(now)));
    }
}

/// 图标层 style/background 修改后同步请求 Explorer 重画。调用前后均验证完整 window
/// identity，避免 Explorer 重启或 PID/句柄复用时向无关窗口发送 redraw。
fn redraw_verified_icon_layer(
    list_view: HWND,
    expected_identity: &WindowIdentity,
) -> Result<(), FullDesktopError> {
    verify_window_identity(list_view, expected_identity)?;
    if unsafe {
        // 不带 RDW_UPDATENOW，避免同步进入 Explorer 的重画路径；随后以 timeout 消息确认
        // 图标层仍可响应，既请求重画也不把桌面 shell 卡在本进程调用上。
        RedrawWindow(
            list_view,
            std::ptr::null(),
            null_mut(),
            RDW_INVALIDATE | RDW_ALLCHILDREN,
        )
    } == 0
    {
        return Err(last_error("请求 Explorer 图标层重画失败"));
    }
    let _ = send_message_timeout(list_view, LVM_GETBKCOLOR, 0, 0)?;
    verify_window_identity(list_view, expected_identity)
}

fn explorer_identity_matches(current: &ExplorerHandles, expected: &ExplorerDesktop) -> bool {
    current.identity.shell == expected.shell
        && current.identity.progman == expected.progman
        && current.identity.def_view == expected.def_view
        && current.identity.list_view == expected.list_view
        && current.identity.workerw == expected.workerw
}

fn verify_explorer_identity(
    current: &ExplorerHandles,
    expected: &ExplorerDesktop,
) -> Result<(), FullDesktopError> {
    if explorer_identity_matches(current, expected) {
        Ok(())
    } else {
        Err(platform_error("Explorer 身份已变化，拒绝附着或恢复"))
    }
}

fn decode_snapshot(snapshot: &PlatformSnapshot) -> Result<CapturedDesktop, FullDesktopError> {
    let captured: CapturedDesktop = serde_json::from_value(snapshot.payload.clone())
        .map_err(|error| platform_error(format!("读取完整桌面平台快照失败：{error}")))?;
    if captured.version != SNAPSHOT_VERSION {
        return Err(platform_error(format!(
            "不支持完整桌面平台快照版本 {}",
            captured.version
        )));
    }
    Ok(captured)
}

fn window_identity(hwnd: HWND) -> Result<WindowIdentity, FullDesktopError> {
    if hwnd.is_null() || unsafe { IsWindow(hwnd) } == 0 {
        return Err(platform_error("窗口句柄无效"));
    }
    let mut pid = 0;
    let thread_id = unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
    if pid == 0 {
        return Err(last_error("读取窗口所属进程失败"));
    }
    if thread_id == 0 {
        return Err(last_error("读取窗口所属线程失败"));
    }
    Ok(WindowIdentity {
        handle: hwnd_to_u64(hwnd),
        parent_handle: hwnd_to_u64(unsafe { GetParent(hwnd) }),
        thread_id,
        process: Some(process_identity_for_pid(pid)?),
        class_name: window_class_name(hwnd)?,
    })
}

fn verify_window_identity(hwnd: HWND, expected: &WindowIdentity) -> Result<(), FullDesktopError> {
    let actual = window_identity(hwnd)?;
    if same_window_identity(&actual, expected) {
        Ok(())
    } else {
        Err(platform_error("窗口句柄、类名或进程创建时间不再匹配"))
    }
}

fn same_window_identity(actual: &WindowIdentity, expected: &WindowIdentity) -> bool {
    actual.handle == expected.handle
        && actual.parent_handle == expected.parent_handle
        && actual.thread_id == expected.thread_id
        && actual.class_name == expected.class_name
        && actual.process == expected.process
}

/// 主窗口跨 `SetParent` 时，句柄、类名、线程与完整进程身份必须保持不变；parent 则由
/// attach/restore 的阶段性约束单独校验，不能把附着本身误判成 PID/句柄复用。
fn same_stable_window_identity(actual: &WindowIdentity, expected: &WindowIdentity) -> bool {
    actual.handle == expected.handle
        && actual.thread_id == expected.thread_id
        && actual.class_name == expected.class_name
        && actual.process == expected.process
}

fn is_attached_main_identity(
    actual: &WindowIdentity,
    captured: &WindowIdentity,
    verified_target: u64,
) -> bool {
    same_stable_window_identity(actual, captured) && actual.parent_handle == verified_target
}

fn is_restorable_main_identity(
    actual: &WindowIdentity,
    captured: &WindowIdentity,
    verified_attached_target: Option<u64>,
) -> bool {
    same_stable_window_identity(actual, captured)
        && (actual.parent_handle == captured.parent_handle
            || verified_attached_target == Some(actual.parent_handle))
}

fn restore_top_level_position_flags() -> u32 {
    SWP_FRAMECHANGED | SWP_NOACTIVATE | SWP_NOZORDER
}

fn validate_attachment_match(
    expected: &Attachment,
    actual: &Attachment,
) -> Result<(), FullDesktopError> {
    if expected.id == actual.id
        && expected.generation == actual.generation
        && expected.pending == actual.pending
    {
        Ok(())
    } else {
        Err(platform_error("完整桌面附着 identity 不匹配"))
    }
}

fn process_identity_for_pid(pid: u32) -> Result<ProcessIdentity, FullDesktopError> {
    let parent_before = parent_pid_from_snapshot(pid)?;
    let creation_time_100ns = process_creation_time(pid)?;
    let parent_after = parent_pid_from_snapshot(pid)?;
    if parent_before != parent_after {
        return Err(platform_error("进程 PID 在身份读取期间发生复用或父链变化"));
    }
    Ok(ProcessIdentity {
        pid,
        parent_pid: parent_after,
        creation_time_100ns,
    })
}

fn owner_status(owner: ProcessIdentity) -> Result<OwnerStatus, FullDesktopError> {
    let creation = match process_creation_time_if_alive(owner.pid) {
        Ok(Some(creation)) => creation,
        Ok(None) => return Ok(OwnerStatus::Dead),
        Err(_) => return Ok(OwnerStatus::Uncertain),
    };
    let parent_before = match parent_pid_from_snapshot(owner.pid) {
        Ok(parent) => parent,
        // ToolHelp 无法可靠枚举时不能把存活 owner 误判为 dead；保留 journal 等待下次启动。
        Err(_) => return Ok(OwnerStatus::Uncertain),
    };
    let parent_after = match parent_pid_from_snapshot(owner.pid) {
        Ok(parent) => parent,
        Err(_) => return Ok(OwnerStatus::Uncertain),
    };
    if parent_before != parent_after {
        return Ok(OwnerStatus::Uncertain);
    }
    if creation == owner.creation_time_100ns && parent_after == owner.parent_pid {
        Ok(OwnerStatus::Live)
    } else {
        Ok(OwnerStatus::Dead)
    }
}

fn process_creation_time(pid: u32) -> Result<u64, FullDesktopError> {
    process_creation_time_if_alive(pid)?.ok_or_else(|| platform_error(format!("进程 {pid} 已退出")))
}

/// `OpenProcess(ERROR_INVALID_PARAMETER)` 是 PID 不存在；其他访问和系统失败必须保守处理。
fn process_creation_time_if_alive(pid: u32) -> Result<Option<u64>, FullDesktopError> {
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
        if unsafe { GetLastError() } == ERROR_INVALID_PARAMETER {
            return Ok(None);
        }
        return Err(last_error("打开进程以读取创建时间失败"));
    }
    let mut created: FILETIME = unsafe { zeroed() };
    let mut exited: FILETIME = unsafe { zeroed() };
    let mut kernel: FILETIME = unsafe { zeroed() };
    let mut user: FILETIME = unsafe { zeroed() };
    let result =
        unsafe { GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user) };
    unsafe { CloseHandle(handle) };
    if result == 0 {
        return Err(last_error("读取进程创建时间失败"));
    }
    Ok(Some(
        ((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64,
    ))
}

fn parent_pid_from_snapshot(pid: u32) -> Result<u32, FullDesktopError> {
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err(last_error("创建进程快照失败"));
    }
    let mut entry: PROCESSENTRY32W = unsafe { zeroed() };
    entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;
    let mut found = None;
    let mut next = unsafe { Process32FirstW(snapshot, &mut entry) };
    while next != 0 {
        if entry.th32ProcessID == pid {
            found = Some(entry.th32ParentProcessID);
            break;
        }
        next = unsafe { Process32NextW(snapshot, &mut entry) };
    }
    unsafe { CloseHandle(snapshot) };
    found.ok_or_else(|| platform_error(format!("进程 {pid} 不在 ToolHelp 快照中")))
}

fn window_class_name(hwnd: HWND) -> Result<String, FullDesktopError> {
    let mut buffer = [0u16; 256];
    let length = unsafe { GetClassNameW(hwnd, buffer.as_mut_ptr(), buffer.len() as i32) };
    if length <= 0 {
        return Err(last_error("读取窗口类名失败"));
    }
    Ok(String::from_utf16_lossy(&buffer[..length as usize]))
}

fn get_window_long_ptr(hwnd: HWND, index: i32) -> Result<isize, FullDesktopError> {
    unsafe { SetLastError(0) };
    let value = unsafe { GetWindowLongPtrW(hwnd, index) };
    if value == 0 && unsafe { GetLastError() } != 0 {
        return Err(last_error("读取窗口样式失败"));
    }
    Ok(value)
}

fn set_window_long_ptr(hwnd: HWND, index: i32, value: isize) -> Result<(), FullDesktopError> {
    unsafe { SetLastError(0) };
    let previous = unsafe { SetWindowLongPtrW(hwnd, index, value) };
    if previous == 0 && unsafe { GetLastError() } != 0 {
        return Err(last_error("写入窗口样式失败"));
    }
    Ok(())
}

fn set_parent_checked(child: HWND, parent: HWND) -> Result<(), FullDesktopError> {
    unsafe { SetLastError(0) };
    let previous = unsafe { SetParent(child, parent) };
    if previous.is_null() && unsafe { GetLastError() } != 0 {
        return Err(last_error("设置窗口父级失败"));
    }
    Ok(())
}

fn set_window_pos_checked(
    hwnd: HWND,
    insert_after: HWND,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    flags: u32,
) -> Result<(), FullDesktopError> {
    if unsafe { SetWindowPos(hwnd, insert_after, x, y, width, height, flags) } == 0 {
        return Err(last_error("设置窗口位置失败"));
    }
    Ok(())
}

fn set_window_placement_checked(
    hwnd: HWND,
    placement: SavedWindowPlacement,
) -> Result<(), FullDesktopError> {
    let native = native_window_placement(placement);
    if unsafe { SetWindowPlacement(hwnd, &native) } == 0 {
        return Err(last_error("恢复主窗口 placement 失败"));
    }
    Ok(())
}

fn show_window_and_ack(hwnd: HWND, visible: bool) -> Result<(), FullDesktopError> {
    unsafe { ShowWindow(hwnd, if visible { SW_SHOW } else { SW_HIDE }) };
    if (unsafe { IsWindowVisible(hwnd) } != 0) != visible {
        return Err(platform_error("窗口可见性未确认生效"));
    }
    Ok(())
}

fn verify_window_rect(
    hwnd: HWND,
    expected: SavedRect,
    tolerance_px: i32,
    label: &str,
) -> Result<(), FullDesktopError> {
    let mut rect: RECT = unsafe { zeroed() };
    if unsafe { GetWindowRect(hwnd, &mut rect) } == 0 {
        return Err(last_error("读取窗口矩形确认失败"));
    }
    let tolerance = i64::from(tolerance_px.max(0));
    let values = [
        (rect.left, expected.left),
        (rect.top, expected.top),
        (rect.right, expected.right),
        (rect.bottom, expected.bottom),
    ];
    if values
        .into_iter()
        .any(|(actual, wanted)| (i64::from(actual) - i64::from(wanted)).abs() > tolerance)
    {
        return Err(platform_error(format!("{label}未确认写入")));
    }
    Ok(())
}

fn verify_restored_main_window(
    hwnd: HWND,
    window: &WebviewWindow,
    expected: &CapturedMainWindow,
) -> Result<(), FullDesktopError> {
    if get_window_long_ptr(hwnd, GWL_STYLE)? != expected.style
        || get_window_long_ptr(hwnd, GWL_EXSTYLE)? != expected.ex_style
    {
        return Err(platform_error("主窗口样式未确认恢复"));
    }
    let mut rect: RECT = unsafe { zeroed() };
    if unsafe { GetWindowRect(hwnd, &mut rect) } == 0 {
        return Err(last_error("验证主窗口恢复矩形失败"));
    }
    if rect.left != expected.rect.left
        || rect.top != expected.rect.top
        || rect.right != expected.rect.right
        || rect.bottom != expected.rect.bottom
    {
        return Err(platform_error("主窗口矩形未确认恢复"));
    }
    if window.is_decorated().unwrap_or(!expected.tauri.decorated) != expected.tauri.decorated
        || window
            .is_always_on_top()
            .unwrap_or(!expected.tauri.always_on_top)
            != expected.tauri.always_on_top
    {
        return Err(platform_error("Tauri 主窗口属性未确认恢复"));
    }
    if (unsafe { IsWindowVisible(hwnd) } != 0) != expected.visible {
        return Err(platform_error("主窗口可见性未确认恢复"));
    }
    let restored_placement = capture_window_placement(hwnd)?;
    if restored_placement != expected.placement {
        return Err(platform_error("主窗口 placement 未确认恢复"));
    }
    Ok(())
}

fn send_message_timeout(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> Result<usize, FullDesktopError> {
    let mut result = 0;
    if unsafe {
        SendMessageTimeoutW(
            hwnd,
            message,
            wparam,
            lparam,
            SMTO_ABORTIFHUNG,
            CROSS_PROCESS_TIMEOUT_MS,
            &mut result,
        )
    } == 0
    {
        return Err(last_error("跨进程窗口消息超时或失败"));
    }
    Ok(result)
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}

fn hwnd_to_u64(hwnd: HWND) -> u64 {
    hwnd as usize as u64
}

fn u64_to_hwnd(hwnd: u64) -> HWND {
    hwnd as usize as HWND
}

fn platform_error(message: impl Into<String>) -> FullDesktopError {
    FullDesktopError::Platform(message.into())
}

fn last_error(operation: &str) -> FullDesktopError {
    platform_error(format!("{operation}：{}", std::io::Error::last_os_error()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity(handle: u64, creation: u64) -> WindowIdentity {
        WindowIdentity {
            handle,
            parent_handle: 0,
            thread_id: 11,
            process: Some(ProcessIdentity {
                pid: 42,
                parent_pid: 7,
                creation_time_100ns: creation,
            }),
            class_name: "WorkerW".into(),
        }
    }

    #[test]
    fn window_identity_rejects_pid_reuse_even_when_handle_and_pid_match() {
        assert!(!same_window_identity(&identity(9, 101), &identity(9, 100)));
    }

    #[test]
    fn window_identity_rejects_parent_or_thread_mismatch() {
        let expected = identity(9, 100);
        let mut moved = expected.clone();
        moved.parent_handle = 7;
        assert!(!same_window_identity(&moved, &expected));

        let mut other_thread = expected.clone();
        other_thread.thread_id = 12;
        assert!(!same_window_identity(&other_thread, &expected));
    }

    #[test]
    fn attached_identity_requires_verified_desktop_parent_but_keeps_stable_identity() {
        let captured = identity(9, 100);
        let mut attached = captured.clone();
        attached.parent_handle = 77;
        assert!(is_attached_main_identity(&attached, &captured, 77));
        assert!(!is_attached_main_identity(&attached, &captured, 78));
    }

    #[test]
    fn restore_identity_allows_original_or_verified_pending_host_only() {
        let captured = identity(9, 100);
        assert!(is_restorable_main_identity(&captured, &captured, Some(77)));

        let mut attached = captured.clone();
        attached.parent_handle = 77;
        assert!(is_restorable_main_identity(&attached, &captured, Some(77)));
        assert!(!is_restorable_main_identity(&attached, &captured, Some(78)));
        assert!(!is_restorable_main_identity(&attached, &captured, None));
    }

    #[test]
    fn top_level_restore_preserves_z_order() {
        assert_ne!(restore_top_level_position_flags() & SWP_NOZORDER, 0);
    }

    #[test]
    fn target_display_keeps_negative_physical_origin_and_one_point_five_scale() {
        let bounds = target_display_bounds(DisplayGeometry {
            x: -1920,
            y: 0,
            width: 1920,
            height: 1080,
            scale_factor: 1.5,
            primary: false,
        })
        .expect("valid physical display");
        assert_eq!(bounds.x, -1920);
        assert_eq!(bounds.width, 1920);
        assert_eq!(bounds.scale_factor, 1.5);
        assert!(!bounds.primary);
    }

    #[test]
    fn invalid_or_overflowing_target_display_fails_closed() {
        assert!(target_display_bounds(DisplayGeometry {
            x: i32::MAX,
            y: 0,
            width: 2,
            height: 100,
            scale_factor: 1.0,
            primary: true,
        })
        .is_err());
        assert!(target_display_bounds(DisplayGeometry {
            x: 0,
            y: 0,
            width: 100,
            height: 100,
            scale_factor: 0.0,
            primary: true,
        })
        .is_err());
    }

    #[test]
    fn attach_uses_target_display_not_original_main_window_rect() {
        let target = PhysicalDisplayBounds {
            x: -1920,
            y: 40,
            width: 1920,
            height: 1080,
            scale_factor: 1.5,
            primary: false,
        };
        let original = SavedRect {
            left: 120,
            top: 80,
            right: 1520,
            bottom: 900,
        };
        assert_ne!(attach_screen_bounds(target), original);
        assert_eq!(attach_screen_bounds(target).left, -1920);
        assert_eq!(attach_screen_bounds(target).right, 0);
    }

    #[test]
    fn multiple_explorer_candidates_fail_closed_instead_of_selecting_first() {
        let process = ProcessIdentity {
            pid: 42,
            parent_pid: 7,
            creation_time_100ns: 100,
        };
        let candidates = vec![
            ExplorerCandidate {
                top_level: 1 as HWND,
                def_view: 2 as HWND,
                list_view: 3 as HWND,
                process,
            },
            ExplorerCandidate {
                top_level: 4 as HWND,
                def_view: 5 as HWND,
                list_view: 6 as HWND,
                process,
            },
        ];
        assert!(select_unique_explorer_candidate(candidates, process).is_err());
    }

    #[test]
    fn interactive_plan_uses_defview_and_enables_icon_layer() {
        let explorer = ExplorerHandles {
            top_level: 2 as HWND,
            def_view: 3 as HWND,
            list_view: 4 as HWND,
            workerw: 5 as HWND,
            identity: ExplorerDesktop {
                shell: identity(1, 1),
                progman: identity(2, 1),
                top_level: identity(2, 1),
                def_view: identity(3, 1),
                list_view: identity(4, 1),
                workerw: identity(5, 1),
            },
        };
        let plan = plan_attachment(FullDesktopMode::Interactive, &explorer).expect("plan");
        assert_eq!(plan.parent, explorer.def_view);
        assert!(plan.requires_interactive_icon_layer);
    }

    #[test]
    fn passive_plan_uses_workerw_without_touching_icon_layer() {
        let explorer = ExplorerHandles {
            top_level: 2 as HWND,
            def_view: 3 as HWND,
            list_view: 4 as HWND,
            workerw: 5 as HWND,
            identity: ExplorerDesktop {
                shell: identity(1, 1),
                progman: identity(2, 1),
                top_level: identity(2, 1),
                def_view: identity(3, 1),
                list_view: identity(4, 1),
                workerw: identity(5, 1),
            },
        };
        let plan = plan_attachment(FullDesktopMode::Passive, &explorer).expect("plan");
        assert_eq!(plan.parent, explorer.workerw);
        assert!(!plan.requires_interactive_icon_layer);
    }

    #[test]
    fn rollback_budget_stops_mutations_after_five_seconds() {
        let error = RollbackBudget::with_elapsed(Duration::from_secs(6), ROLLBACK_BUDGET)
            .check("恢复主窗口 style")
            .expect_err("deadline must stop later mutations");
        assert!(
            matches!(error, FullDesktopError::Platform(message) if message.contains("elapsedMs="))
        );
    }

    #[test]
    fn stale_recovery_only_noops_after_explorer_generation_changes() {
        let captured = identity(1, 100).process.expect("test identity has process");
        assert!(!shell_process_generation_changed(captured, captured));

        let mut restarted = captured;
        restarted.creation_time_100ns = 101;
        assert!(shell_process_generation_changed(restarted, captured));
    }

    #[test]
    fn window_placement_serialization_preserves_normal_and_show_state() {
        let saved = SavedWindowPlacement {
            flags: 2,
            show_cmd: 3,
            min_position: SavedPoint { x: -10, y: 20 },
            max_position: SavedPoint { x: 30, y: 40 },
            normal_position: SavedRect {
                left: -1920,
                top: 50,
                right: -320,
                bottom: 950,
            },
        };

        assert_eq!(
            saved_window_placement(&native_window_placement(saved)),
            saved
        );
    }

    #[test]
    fn icon_visibility_confirmation_never_outlives_rollback_budget() {
        let now = Instant::now();
        let rollback_deadline = now + Duration::from_millis(50);
        assert_eq!(
            icon_visibility_deadline(now, Some(rollback_deadline)),
            rollback_deadline
        );
    }
}
