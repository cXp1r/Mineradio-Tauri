fn main() {
    if let Err(error) = mineradio_tauri_lib::updater_smoke::run_cli(std::env::args_os().skip(1)) {
        eprintln!("updater smoke 失败: {error}");
        std::process::exit(1);
    }
}
