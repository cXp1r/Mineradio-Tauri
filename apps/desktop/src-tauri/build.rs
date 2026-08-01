#[allow(dead_code)]
#[path = "src/app/update_distribution.rs"]
mod update_distribution;

fn main() {
    emit_update_distribution_marker();
    ensure_sidecar_binary_for_tauri();
    tauri_build::build();
}

fn emit_update_distribution_marker() {
    println!(
        "cargo:rerun-if-env-changed={}",
        update_distribution::OFFICIAL_DISTRIBUTION_ENV
    );

    let requested = std::env::var(update_distribution::OFFICIAL_DISTRIBUTION_ENV).ok();
    let target = std::env::var("TARGET").expect("TARGET is set by Cargo");
    let mode = update_distribution::classify_build_request(requested.as_deref(), &target);

    // 无论是否命中正式发行条件都注入确定值，避免增量构建沿用旧 marker。
    println!(
        "cargo:rustc-env={}={}",
        update_distribution::COMPILED_DISTRIBUTION_ENV,
        mode.compiled_marker()
    );
}

fn ensure_sidecar_binary_for_tauri() {
    let manifest_dir = std::path::PathBuf::from(
        std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is set by Cargo"),
    );
    let target_triple = std::env::var("TARGET").expect("TARGET is set by Cargo");
    println!(
        "cargo:rerun-if-changed={}",
        manifest_dir.join("../../sidecars/api/src").display()
    );
    println!(
        "cargo:rerun-if-changed={}",
        manifest_dir
            .join("../scripts/build-sidecar-binary.mjs")
            .display()
    );
    let desktop_dir = manifest_dir
        .parent()
        .expect("src-tauri has a desktop package parent");
    let script = desktop_dir.join("scripts/build-sidecar-binary.mjs");
    let status = std::process::Command::new(resolve_bun_program())
        .arg("run")
        .arg(script)
        .env("TAURI_TARGET_TRIPLE", target_triple)
        .current_dir(desktop_dir)
        .status()
        .expect("failed to start bun to build MineRadio-Tauri sidecar binary");
    if !status.success() {
        panic!("failed to build MineRadio-Tauri sidecar binary");
    }
}

fn resolve_bun_program() -> std::path::PathBuf {
    for candidate in bun_candidates() {
        if candidate.is_file() {
            return candidate;
        }
    }
    std::path::PathBuf::from("bun")
}

fn bun_candidates() -> Vec<std::path::PathBuf> {
    let exe = if cfg!(windows) { "bun.exe" } else { "bun" };
    let mut candidates = Vec::new();
    if let Some(path) = non_empty_env_path("MINERADIO_BUN_BIN") {
        candidates.push(path);
    }
    if let Some(dir) = non_empty_env_path("BUN_INSTALL") {
        candidates.push(dir.join("bin").join(exe));
    }
    if let Some(dir) = non_empty_env_path("USERPROFILE") {
        candidates.push(dir.join(".bun").join("bin").join(exe));
    }
    if let Some(dir) = non_empty_env_path("HOME") {
        candidates.push(dir.join(".bun").join("bin").join(exe));
    }
    candidates
}

fn non_empty_env_path(key: &str) -> Option<std::path::PathBuf> {
    std::env::var_os(key).and_then(|value| {
        if value.is_empty() {
            None
        } else {
            Some(std::path::PathBuf::from(value))
        }
    })
}
