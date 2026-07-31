pub mod desktop_diagnostics;
pub mod desktop_runtime;
pub mod full_desktop_runtime;
pub mod lifecycle;
pub mod main_window;
pub mod sidecar_owner;
pub mod state;
pub mod tray;
pub mod update_install_gate;
// #54 通过唯一 Runtime worker 接入；Module 本身不依赖 Tauri command/event transport。
#[allow(dead_code)]
pub mod update_install_coordinator;
// #54 production cutover 前保持 transport-neutral；这里只冻结 installer spawn 前后的退出所有权。
#[allow(dead_code)]
pub mod update_install_exit;
// #54 production cutover 前只由测试与 dormant factory 证明组合边界，不从 bootstrap 接线。
#[allow(dead_code)]
pub mod update_install_native;
// #54 才把 native lease 接入唯一 install authority；当前禁止旧 updater 提前调用。
#[allow(dead_code)]
pub mod update_install_quiescence;
pub mod wallpaper_engine_runtime;
pub mod wallpaper_media_protocol;
pub mod window_labels;
