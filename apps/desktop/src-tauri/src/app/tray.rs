use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager,
};

pub const MAIN_TRAY_ID: &str = "mineradio-main-tray";
const SHOW_MENU_ID: &str = "mineradio-tray-show";
const PASSIVE_DESKTOP_MENU_ID: &str = "mineradio-tray-full-desktop-passive";
const INTERACTIVE_DESKTOP_MENU_ID: &str = "mineradio-tray-full-desktop-interactive";
const RECOVER_DESKTOP_MENU_ID: &str = "mineradio-tray-full-desktop-recover";
const EXIT_MENU_ID: &str = "mineradio-tray-exit";

/// 按需创建唯一托盘图标。默认退出模式不会创建托盘。
pub fn ensure_main_tray(app: &tauri::AppHandle) -> Result<(), String> {
    if let Some(tray) = app.tray_by_id(MAIN_TRAY_ID) {
        tray.set_visible(true).map_err(|error| error.to_string())?;
        mark_tray_ready(app);
        return Ok(());
    }

    let show = MenuItem::with_id(app, SHOW_MENU_ID, "显示主窗口", true, None::<&str>)
        .map_err(|error| error.to_string())?;
    let passive = MenuItem::with_id(
        app,
        PASSIVE_DESKTOP_MENU_ID,
        "完整桌面（被动）",
        true,
        None::<&str>,
    )
    .map_err(|error| error.to_string())?;
    let interactive = MenuItem::with_id(
        app,
        INTERACTIVE_DESKTOP_MENU_ID,
        "完整桌面（交互）",
        true,
        None::<&str>,
    )
    .map_err(|error| error.to_string())?;
    let recover = MenuItem::with_id(
        app,
        RECOVER_DESKTOP_MENU_ID,
        "恢复普通窗口",
        true,
        None::<&str>,
    )
    .map_err(|error| error.to_string())?;
    let exit = MenuItem::with_id(app, EXIT_MENU_ID, "退出 MineRadio", true, None::<&str>)
        .map_err(|error| error.to_string())?;
    let menu = Menu::with_items(app, &[&show, &passive, &interactive, &recover, &exit])
        .map_err(|error| error.to_string())?;
    let mut builder = TrayIconBuilder::with_id(MAIN_TRAY_ID)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("MineRadio-Tauri")
        .on_menu_event(|app, event| match event.id().as_ref() {
            SHOW_MENU_ID => super::desktop_runtime::show_main_window(app),
            PASSIVE_DESKTOP_MENU_ID => super::full_desktop_runtime::request_mode_from_tray(
                app,
                crate::runtime::full_desktop::FullDesktopMode::Passive,
            ),
            INTERACTIVE_DESKTOP_MENU_ID => super::full_desktop_runtime::request_mode_from_tray(
                app,
                crate::runtime::full_desktop::FullDesktopMode::Interactive,
            ),
            RECOVER_DESKTOP_MENU_ID => super::full_desktop_runtime::recover_to_normal_window(app),
            EXIT_MENU_ID => super::desktop_runtime::request_application_exit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            let should_show = matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } | TrayIconEvent::DoubleClick {
                    button: MouseButton::Left,
                    ..
                }
            );
            if should_show {
                super::desktop_runtime::show_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }
    match builder.build(app) {
        Ok(_) => {
            mark_tray_ready(app);
            Ok(())
        }
        Err(error) => {
            if let Ok(mut runtime) = app.state::<crate::AppState>().window_runtime.lock() {
                runtime.mark_tray_failed();
            }
            Err(error.to_string())
        }
    }
}

pub fn remove_main_tray(app: &tauri::AppHandle) {
    if let Some(tray) = app.tray_by_id(MAIN_TRAY_ID) {
        let _ = tray.set_visible(false);
    }
    let _ = app.remove_tray_by_id(MAIN_TRAY_ID);
    if let Ok(mut runtime) = app.state::<crate::AppState>().window_runtime.lock() {
        runtime.mark_tray_unavailable();
    }
}

fn mark_tray_ready(app: &tauri::AppHandle) {
    if let Ok(mut runtime) = app.state::<crate::AppState>().window_runtime.lock() {
        runtime.mark_tray_ready();
    }
}
