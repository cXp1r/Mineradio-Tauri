use crate::runtime::hotkeys;

pub use crate::runtime::hotkeys::{ConfigureGlobalHotkeysResult, GlobalHotkeyBinding};

#[tauri::command]
pub fn configure_global_hotkeys(
    app: tauri::AppHandle,
    bindings: Vec<GlobalHotkeyBinding>,
) -> ConfigureGlobalHotkeysResult {
    hotkeys::configure_global_hotkeys(&app, bindings)
}
