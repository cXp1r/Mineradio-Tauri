use crate::{
    app::{
        lifecycle::{CloseBehavior, LifecyclePhase},
        tray,
    },
    runtime::{
        settings::RuntimeSettingsStore,
        window::{WindowRuntimeSnapshot, WindowRuntimeState},
    },
    AppState,
};

fn persist_close_behavior(
    runtime: &mut WindowRuntimeState,
    settings: &mut RuntimeSettingsStore,
    behavior: CloseBehavior,
) -> Result<WindowRuntimeSnapshot, String> {
    if matches!(
        runtime.snapshot().lifecycle.phase,
        LifecyclePhase::Exiting | LifecyclePhase::Cleaned
    ) {
        return Err("WINDOW_RUNTIME_EXIT_IN_PROGRESS".to_string());
    }
    settings
        .set_close_behavior(behavior)
        .map_err(|error| error.to_string())?;
    if !runtime.set_close_behavior(behavior) {
        return Err("WINDOW_RUNTIME_EXIT_IN_PROGRESS".to_string());
    }
    Ok(runtime.snapshot())
}

#[tauri::command]
pub fn get_window_runtime_state(
    state: tauri::State<'_, AppState>,
) -> Result<WindowRuntimeSnapshot, String> {
    let runtime = state
        .window_runtime
        .lock()
        .map_err(|error| error.to_string())?;
    Ok(runtime.snapshot())
}

#[tauri::command]
pub fn set_close_behavior(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    behavior: CloseBehavior,
) -> Result<WindowRuntimeSnapshot, String> {
    let previous_behavior = state
        .window_runtime
        .lock()
        .map_err(|error| error.to_string())?
        .snapshot()
        .lifecycle
        .close_behavior;
    if behavior == CloseBehavior::Tray {
        tray::ensure_main_tray(&app)?;
    }
    let result = {
        let mut runtime = state
            .window_runtime
            .lock()
            .map_err(|error| error.to_string())?;
        let mut settings = state
            .runtime_settings
            .lock()
            .map_err(|error| error.to_string())?;
        persist_close_behavior(&mut runtime, &mut settings, behavior)
    };
    let snapshot = match result {
        Ok(snapshot) => snapshot,
        Err(error) => {
            if behavior == CloseBehavior::Tray && previous_behavior != CloseBehavior::Tray {
                tray::remove_main_tray(&app);
            }
            return Err(error);
        }
    };
    if behavior == CloseBehavior::Exit {
        crate::app::full_desktop_runtime::sync_native_recovery_surfaces(&app);
    }
    Ok(snapshot)
}

#[tauri::command]
pub fn window_show(app: tauri::AppHandle) -> Result<(), String> {
    crate::app::desktop_runtime::show_main_window(&app);
    Ok(())
}

#[tauri::command]
pub fn application_exit(app: tauri::AppHandle) -> Result<(), String> {
    crate::app::desktop_runtime::request_application_exit(&app);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
    };

    static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    fn test_path(label: &str) -> PathBuf {
        let sequence = TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "mineradio-close-policy-{label}-{}-{sequence}",
            std::process::id()
        ))
    }

    #[test]
    fn close_behavior_changes_only_after_native_settings_commit() {
        let root = test_path("commit");
        let _ = fs::remove_dir_all(&root);
        let settings_path = root.join("runtime-settings.json");
        let mut settings = RuntimeSettingsStore::with_path(&settings_path);
        let mut runtime = WindowRuntimeState::default();

        let snapshot = persist_close_behavior(&mut runtime, &mut settings, CloseBehavior::Tray)
            .expect("设置提交成功后应更新窗口状态");

        assert_eq!(snapshot.lifecycle.close_behavior, CloseBehavior::Tray);
        assert_eq!(
            RuntimeSettingsStore::with_path(&settings_path)
                .snapshot()
                .close_behavior,
            CloseBehavior::Tray
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn settings_write_failure_never_reports_or_applies_the_new_close_behavior() {
        let root = test_path("write-failure");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("应创建测试目录");
        let blocked_parent = root.join("not-a-directory");
        fs::write(&blocked_parent, b"file").expect("应创建阻断设置目录的文件");
        let mut settings = RuntimeSettingsStore::with_path(blocked_parent.join("settings.json"));
        let mut runtime = WindowRuntimeState::default();

        let error = persist_close_behavior(&mut runtime, &mut settings, CloseBehavior::Tray)
            .expect_err("写入失败时不得伪报成功");

        assert!(!error.is_empty());
        assert_eq!(
            runtime.snapshot().lifecycle.close_behavior,
            CloseBehavior::Exit
        );
        assert_eq!(settings.snapshot().close_behavior, CloseBehavior::Exit);
        let _ = fs::remove_dir_all(root);
    }
}
