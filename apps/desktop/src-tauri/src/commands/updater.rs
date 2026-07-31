use crate::{
    app::{
        update_web_quiescence::UpdateWebQuiescenceAcknowledgement,
        updater_runtime::ApplicationUpdateRuntime, window_labels,
    },
    runtime::updater::{UpdateDispatchRequest, UpdateReceipt, UpdateSnapshot},
};

fn is_main_update_caller(label: &str) -> bool {
    label == window_labels::MAIN
}

/// Command 只读取 Rust authority；Web 没有第二份可写 updater 状态。
#[tauri::command]
pub fn get_update_runtime_snapshot(
    caller: tauri::WebviewWindow,
    runtime: tauri::State<'_, ApplicationUpdateRuntime>,
) -> UpdateSnapshot {
    if !is_main_update_caller(caller.label()) {
        return runtime.restricted_snapshot();
    }
    runtime.snapshot()
}

#[tauri::command]
pub fn dispatch_update_runtime_intent(
    caller: tauri::WebviewWindow,
    runtime: tauri::State<'_, ApplicationUpdateRuntime>,
    request: UpdateDispatchRequest,
) -> UpdateReceipt {
    if !is_main_update_caller(caller.label()) {
        return UpdateReceipt::RuntimeUnavailable;
    }
    runtime.dispatch(request)
}

#[tauri::command]
pub fn updater_web_quiescence_acknowledge(
    caller: tauri::WebviewWindow,
    runtime: tauri::State<'_, ApplicationUpdateRuntime>,
    acknowledgement: UpdateWebQuiescenceAcknowledgement,
) -> bool {
    if !is_main_update_caller(caller.label()) {
        return false;
    }
    runtime.acknowledge_web(acknowledgement)
}

/// Web Adapter 只有在四个 listener 全部安装完成后才调用这个启动 barrier。
#[tauri::command]
pub fn updater_web_quiescence_reconcile(
    caller: tauri::WebviewWindow,
    runtime: tauri::State<'_, ApplicationUpdateRuntime>,
) {
    if !is_main_update_caller(caller.label()) {
        return;
    }
    runtime.reconcile_web();
}

#[cfg(test)]
mod tests {
    use super::is_main_update_caller;

    #[test]
    fn update_authority_is_available_only_to_the_main_window() {
        assert!(is_main_update_caller("main"));
        for secondary in ["desktop-lyrics", "login-netease", "login-qq", "main-copy"] {
            assert!(!is_main_update_caller(secondary));
        }
    }
}
