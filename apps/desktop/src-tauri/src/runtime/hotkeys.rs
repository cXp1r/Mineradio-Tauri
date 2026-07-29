use serde::{Deserialize, Serialize};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex, OnceLock,
};
use tauri::Emitter;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

const GLOBAL_HOTKEY_CONFLICT_SOURCE_NAME: &str = "系统 / 其他软件";
const GLOBAL_HOTKEY_CONFLICT_SOURCE_ICON: &str = "warning";
const GLOBAL_HOTKEY_CONFLICT_REASON: &str = "该组合键已被占用或被系统保留";
const FULL_DESKTOP_ESCAPE_ACCELERATOR: &str = "Escape";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalHotkeyBinding {
    pub action: String,
    pub accelerator: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalHotkeyConflict {
    pub source_name: String,
    pub source_icon: String,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalHotkeyRegistrationResult {
    pub action: String,
    pub accelerator: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conflict: Option<GlobalHotkeyConflict>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigureGlobalHotkeysResult {
    pub ok: bool,
    pub results: Vec<GlobalHotkeyRegistrationResult>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HotkeyRuntimeSnapshot {
    pub registered_count: usize,
    pub last_conflict: Option<GlobalHotkeyConflict>,
}

static HOTKEY_RUNTIME: OnceLock<Mutex<HotkeyRuntimeSnapshot>> = OnceLock::new();
static CONFIGURED_BINDINGS: OnceLock<Mutex<Vec<GlobalHotkeyBinding>>> = OnceLock::new();
static FULL_DESKTOP_ESCAPE_OWNED: AtomicBool = AtomicBool::new(false);

fn hotkey_runtime() -> &'static Mutex<HotkeyRuntimeSnapshot> {
    HOTKEY_RUNTIME.get_or_init(|| Mutex::new(HotkeyRuntimeSnapshot::default()))
}

fn configured_bindings() -> &'static Mutex<Vec<GlobalHotkeyBinding>> {
    CONFIGURED_BINDINGS.get_or_init(|| Mutex::new(Vec::new()))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalHotkeyEventPayload {
    pub action: String,
}

pub fn configure_global_hotkeys(
    app: &tauri::AppHandle,
    bindings: Vec<GlobalHotkeyBinding>,
) -> ConfigureGlobalHotkeysResult {
    let manager = app.global_shortcut();
    let _ = manager.unregister_all();
    if let Ok(mut configured) = configured_bindings().lock() {
        *configured = bindings.clone();
    }
    let escape_reserved = crate::app::full_desktop_runtime::native_recovery_required(app);
    let result = build_global_hotkey_registration_results(&bindings, |binding| {
        if escape_reserved && is_escape_binding(binding) {
            return false;
        }
        register_user_binding(app, binding)
    });
    publish_global_hotkey_result(&result);
    // 用户热键重配会 unregister_all；完整桌面 active 时必须立即恢复保留的 Escape
    // 救援入口，同时不把它计入用户绑定统计。
    crate::app::full_desktop_runtime::sync_native_recovery_surfaces(app);
    result
}

pub fn clear_global_hotkeys(app: &tauri::AppHandle) {
    let _ = app.global_shortcut().unregister_all();
    let mut snapshot = hotkey_runtime()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    snapshot.registered_count = 0;
    FULL_DESKTOP_ESCAPE_OWNED.store(false, Ordering::Release);
    if let Ok(mut configured) = configured_bindings().lock() {
        configured.clear();
    }
}

fn is_escape_binding(binding: &GlobalHotkeyBinding) -> bool {
    binding
        .accelerator
        .trim()
        .eq_ignore_ascii_case(FULL_DESKTOP_ESCAPE_ACCELERATOR)
}

fn register_user_binding(app: &tauri::AppHandle, binding: &GlobalHotkeyBinding) -> bool {
    let action = binding.action.clone();
    app.global_shortcut()
        .on_shortcut(
            binding.accelerator.as_str(),
            move |app, _shortcut, event| {
                if event.state != ShortcutState::Released {
                    return;
                }
                let _ = app.emit(
                    "mineradio-global-hotkey",
                    GlobalHotkeyEventPayload {
                        action: action.clone(),
                    },
                );
            },
        )
        .is_ok()
}

/// Full Desktop 对 Escape 拥有显式优先级。若用户配置曾占用 Escape，会先报告冲突，
/// 退出完整桌面后再按最后一次配置恢复用户 binding。
pub fn reserve_full_desktop_escape(app: &tauri::AppHandle) -> Result<(), String> {
    let manager = app.global_shortcut();
    let already_owned = FULL_DESKTOP_ESCAPE_OWNED.load(Ordering::Acquire);
    if already_owned && manager.is_registered(FULL_DESKTOP_ESCAPE_ACCELERATOR) {
        return Ok(());
    }
    let replacing_existing_binding =
        !already_owned && manager.is_registered(FULL_DESKTOP_ESCAPE_ACCELERATOR);
    FULL_DESKTOP_ESCAPE_OWNED.store(false, Ordering::Release);
    if manager.is_registered(FULL_DESKTOP_ESCAPE_ACCELERATOR) {
        manager
            .unregister(FULL_DESKTOP_ESCAPE_ACCELERATOR)
            .map_err(|error| error.to_string())?;
    }
    if replacing_existing_binding {
        let mut snapshot = hotkey_runtime()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        snapshot.last_conflict = Some(global_hotkey_conflict());
    }
    manager
        .on_shortcut(FULL_DESKTOP_ESCAPE_ACCELERATOR, |app, _shortcut, event| {
            if event.state != ShortcutState::Released {
                return;
            }
            let handle = app.clone();
            let _ = app.run_on_main_thread(move || {
                crate::app::full_desktop_runtime::recover_to_normal_window(&handle)
            });
        })
        .map_err(|error| error.to_string())?;
    FULL_DESKTOP_ESCAPE_OWNED.store(true, Ordering::Release);
    Ok(())
}

pub fn release_full_desktop_escape(app: &tauri::AppHandle) {
    if !FULL_DESKTOP_ESCAPE_OWNED.swap(false, Ordering::AcqRel) {
        return;
    }
    let manager = app.global_shortcut();
    if manager.is_registered(FULL_DESKTOP_ESCAPE_ACCELERATOR) {
        let _ = manager.unregister(FULL_DESKTOP_ESCAPE_ACCELERATOR);
    }
    let configured_escape = configured_bindings().lock().ok().and_then(|bindings| {
        bindings
            .iter()
            .find(|binding| is_escape_binding(binding))
            .cloned()
    });
    if let Some(binding) = configured_escape {
        let _ = register_user_binding(app, &binding);
    }
}

pub fn hotkey_runtime_snapshot() -> HotkeyRuntimeSnapshot {
    hotkey_runtime()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
}

fn publish_global_hotkey_result(result: &ConfigureGlobalHotkeysResult) {
    let mut snapshot = hotkey_runtime()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    apply_global_hotkey_result(&mut snapshot, result);
}

fn apply_global_hotkey_result(
    snapshot: &mut HotkeyRuntimeSnapshot,
    result: &ConfigureGlobalHotkeysResult,
) {
    snapshot.registered_count = result.results.iter().filter(|item| item.ok).count();
    if let Some(conflict) = result
        .results
        .iter()
        .rev()
        .find_map(|item| item.conflict.clone())
    {
        snapshot.last_conflict = Some(conflict);
    }
}

pub fn global_hotkey_conflict() -> GlobalHotkeyConflict {
    GlobalHotkeyConflict {
        source_name: GLOBAL_HOTKEY_CONFLICT_SOURCE_NAME.to_string(),
        source_icon: GLOBAL_HOTKEY_CONFLICT_SOURCE_ICON.to_string(),
        reason: GLOBAL_HOTKEY_CONFLICT_REASON.to_string(),
    }
}

pub fn build_global_hotkey_registration_results<F>(
    bindings: &[GlobalHotkeyBinding],
    mut register: F,
) -> ConfigureGlobalHotkeysResult
where
    F: FnMut(&GlobalHotkeyBinding) -> bool,
{
    let mut results = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for binding in bindings {
        let action = binding.action.trim();
        let accelerator = binding.accelerator.trim();
        if action.is_empty() || accelerator.is_empty() || seen.contains(accelerator) {
            continue;
        }
        seen.insert(accelerator.to_string());
        let normalized = GlobalHotkeyBinding {
            action: action.to_string(),
            accelerator: accelerator.to_string(),
        };
        let ok = register(&normalized);
        results.push(GlobalHotkeyRegistrationResult {
            action: normalized.action,
            accelerator: normalized.accelerator,
            ok,
            conflict: if ok {
                None
            } else {
                Some(global_hotkey_conflict())
            },
        });
    }
    ConfigureGlobalHotkeysResult { ok: true, results }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn global_hotkey_conflict_matches_baseline_copy() {
        assert_eq!(
            global_hotkey_conflict(),
            GlobalHotkeyConflict {
                source_name: "系统 / 其他软件".to_string(),
                source_icon: "warning".to_string(),
                reason: "该组合键已被占用或被系统保留".to_string(),
            }
        );
    }

    #[test]
    fn full_desktop_escape_reservation_recognizes_only_plain_escape() {
        assert!(is_escape_binding(&GlobalHotkeyBinding {
            action: "custom".into(),
            accelerator: " escape ".into(),
        }));
        assert!(!is_escape_binding(&GlobalHotkeyBinding {
            action: "custom".into(),
            accelerator: "Control+Escape".into(),
        }));
    }

    #[test]
    fn global_hotkey_registration_results_skip_empty_and_duplicate_accelerators() {
        let bindings = vec![
            GlobalHotkeyBinding {
                action: "togglePlay".to_string(),
                accelerator: "Control+Alt+Space".to_string(),
            },
            GlobalHotkeyBinding {
                action: "".to_string(),
                accelerator: "Control+Alt+Left".to_string(),
            },
            GlobalHotkeyBinding {
                action: "nextTrack".to_string(),
                accelerator: "".to_string(),
            },
            GlobalHotkeyBinding {
                action: "prevTrack".to_string(),
                accelerator: "Control+Alt+Space".to_string(),
            },
            GlobalHotkeyBinding {
                action: "volumeUp".to_string(),
                accelerator: "Control+Alt+Up".to_string(),
            },
        ];

        let result = build_global_hotkey_registration_results(&bindings, |binding| {
            binding.accelerator == "Control+Alt+Space"
        });

        assert_eq!(
            result,
            ConfigureGlobalHotkeysResult {
                ok: true,
                results: vec![
                    GlobalHotkeyRegistrationResult {
                        action: "togglePlay".to_string(),
                        accelerator: "Control+Alt+Space".to_string(),
                        ok: true,
                        conflict: None,
                    },
                    GlobalHotkeyRegistrationResult {
                        action: "volumeUp".to_string(),
                        accelerator: "Control+Alt+Up".to_string(),
                        ok: false,
                        conflict: Some(global_hotkey_conflict()),
                    },
                ],
            }
        );
    }

    #[test]
    fn hotkey_runtime_snapshot_tracks_registration_count_and_keeps_the_latest_conflict() {
        let conflict = global_hotkey_conflict();
        let mut snapshot = HotkeyRuntimeSnapshot::default();
        apply_global_hotkey_result(
            &mut snapshot,
            &ConfigureGlobalHotkeysResult {
                ok: true,
                results: vec![
                    GlobalHotkeyRegistrationResult {
                        action: "togglePlay".to_string(),
                        accelerator: "Control+Alt+Space".to_string(),
                        ok: true,
                        conflict: None,
                    },
                    GlobalHotkeyRegistrationResult {
                        action: "nextTrack".to_string(),
                        accelerator: "Control+Alt+Right".to_string(),
                        ok: false,
                        conflict: Some(conflict.clone()),
                    },
                ],
            },
        );
        assert_eq!(snapshot.registered_count, 1);
        assert_eq!(snapshot.last_conflict, Some(conflict.clone()));

        apply_global_hotkey_result(
            &mut snapshot,
            &ConfigureGlobalHotkeysResult {
                ok: true,
                results: vec![GlobalHotkeyRegistrationResult {
                    action: "togglePlay".to_string(),
                    accelerator: "Control+Alt+Space".to_string(),
                    ok: true,
                    conflict: None,
                }],
            },
        );
        assert_eq!(snapshot.registered_count, 1);
        assert_eq!(snapshot.last_conflict, Some(conflict));
    }
}
