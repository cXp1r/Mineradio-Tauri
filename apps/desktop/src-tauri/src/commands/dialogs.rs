use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use tauri_plugin_dialog::DialogExt;

const DEFAULT_JSON_EXPORT_FILE_NAME: &str = "mineradio-export.json";

pub fn is_openable_url(url: &str) -> bool {
    if url.trim() != url {
        return false;
    }
    if url.chars().any(|ch| ch.is_ascii_control()) {
        return false;
    }
    let Ok(parsed) = tauri::Url::parse(url) else {
        return false;
    };
    matches!(parsed.scheme(), "http" | "https") && parsed.host_str().is_some()
}

pub fn external_open_command(url: &str) -> (&'static str, Vec<&str>) {
    if cfg!(target_os = "windows") {
        ("explorer.exe", vec![url])
    } else if cfg!(target_os = "macos") {
        ("open", vec![url])
    } else {
        ("xdg-open", vec![url])
    }
}

#[tauri::command]
pub fn open_external(url: String) -> Result<(), String> {
    if !is_openable_url(&url) {
        return Err("INVALID_URL".into());
    }
    let (program, args) = external_open_command(&url);
    std::process::Command::new(program)
        .args(args)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ExportJsonFileResult {
    pub cancelled: bool,
    pub path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ImportJsonFileResult {
    pub cancelled: bool,
    pub path: Option<String>,
    pub data: Option<serde_json::Value>,
}

pub fn sanitize_json_file_name(file_name: &str) -> String {
    let trimmed = file_name.trim();
    let leaf = trimmed
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("")
        .trim()
        .trim_matches('.');
    let sanitized = leaf
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect::<String>()
        .trim()
        .trim_matches('.')
        .to_string();

    let base = if sanitized.is_empty() {
        DEFAULT_JSON_EXPORT_FILE_NAME.to_string()
    } else {
        sanitized
    };
    if path_has_json_extension(Path::new(&base)) {
        base
    } else {
        format!("{}.json", base)
    }
}

pub fn path_has_json_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("json"))
        .unwrap_or(false)
}

pub fn ensure_json_extension(path: PathBuf) -> PathBuf {
    if path.extension().is_none() {
        path.with_extension("json")
    } else {
        path
    }
}

pub fn serialize_json_pretty(data: &serde_json::Value) -> Result<String, String> {
    serde_json::to_string_pretty(data)
        .map(|text| format!("{}\n", text))
        .map_err(|_| "EXPORT_JSON_SERIALIZE_FAILED".to_string())
}

pub fn parse_imported_json(text: &str) -> Result<serde_json::Value, String> {
    serde_json::from_str(text).map_err(|_| "IMPORT_JSON_INVALID_JSON".to_string())
}

pub fn export_json_cancelled_result() -> ExportJsonFileResult {
    ExportJsonFileResult {
        cancelled: true,
        path: None,
    }
}

pub fn import_json_cancelled_result() -> ImportJsonFileResult {
    ImportJsonFileResult {
        cancelled: true,
        path: None,
        data: None,
    }
}

fn export_json_success_result(path: &Path) -> ExportJsonFileResult {
    ExportJsonFileResult {
        cancelled: false,
        path: Some(path.to_string_lossy().to_string()),
    }
}

fn import_json_success_result(path: &Path, data: serde_json::Value) -> ImportJsonFileResult {
    ImportJsonFileResult {
        cancelled: false,
        path: Some(path.to_string_lossy().to_string()),
        data: Some(data),
    }
}

async fn receive_json_dialog_selection(
    mut rx: tauri::async_runtime::Receiver<Option<tauri_plugin_dialog::FilePath>>,
    error_code: &'static str,
) -> Result<Option<tauri_plugin_dialog::FilePath>, String> {
    rx.recv().await.ok_or_else(|| error_code.to_string())
}

#[tauri::command]
pub async fn export_json_file(
    app: tauri::AppHandle,
    file_name: String,
    data: serde_json::Value,
) -> Result<ExportJsonFileResult, String> {
    let default_file_name = sanitize_json_file_name(&file_name);
    let (tx, rx) = tauri::async_runtime::channel(1);
    app.dialog()
        .file()
        .add_filter("JSON", &["json"])
        .set_file_name(default_file_name)
        .save_file(move |selected_path| {
            let _ = tx.try_send(selected_path);
        });

    let Some(selected_path) =
        receive_json_dialog_selection(rx, "EXPORT_JSON_DIALOG_CLOSED").await?
    else {
        return Ok(export_json_cancelled_result());
    };

    let path = selected_path
        .into_path()
        .map_err(|_| "EXPORT_JSON_INVALID_PATH".to_string())?;
    let path = ensure_json_extension(path);
    if !path_has_json_extension(&path) {
        return Err("EXPORT_JSON_INVALID_EXTENSION".into());
    }
    if path.is_dir() {
        return Err("EXPORT_JSON_PATH_IS_DIRECTORY".into());
    }

    let text = serialize_json_pretty(&data)?;
    let write_path = path.clone();
    tauri::async_runtime::spawn_blocking(move || fs::write(&write_path, text))
        .await
        .map_err(|_| "EXPORT_JSON_WRITE_FAILED".to_string())?
        .map_err(|_| "EXPORT_JSON_WRITE_FAILED".to_string())?;
    Ok(export_json_success_result(&path))
}

#[tauri::command]
pub async fn import_json_file(app: tauri::AppHandle) -> Result<ImportJsonFileResult, String> {
    let (tx, rx) = tauri::async_runtime::channel(1);
    app.dialog()
        .file()
        .add_filter("JSON", &["json"])
        .pick_file(move |selected_path| {
            let _ = tx.try_send(selected_path);
        });

    let Some(selected_path) =
        receive_json_dialog_selection(rx, "IMPORT_JSON_DIALOG_CLOSED").await?
    else {
        return Ok(import_json_cancelled_result());
    };

    let path = selected_path
        .into_path()
        .map_err(|_| "IMPORT_JSON_INVALID_PATH".to_string())?;
    if !path_has_json_extension(&path) {
        return Err("IMPORT_JSON_INVALID_EXTENSION".into());
    }
    if !path.is_file() {
        return Err("IMPORT_JSON_PATH_NOT_FILE".into());
    }

    let read_path = path.clone();
    let text = tauri::async_runtime::spawn_blocking(move || fs::read_to_string(&read_path))
        .await
        .map_err(|_| "IMPORT_JSON_READ_FAILED".to_string())?
        .map_err(|_| "IMPORT_JSON_READ_FAILED".to_string())?;
    let data = parse_imported_json(&text)?;
    Ok(import_json_success_result(&path, data))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn openable_url_accepts_http_and_https() {
        assert!(is_openable_url("http://example.com"));
        assert!(is_openable_url("https://example.com/path"));
        assert!(is_openable_url("https://example.com.evil/path"));
    }

    #[test]
    fn openable_url_rejects_non_http_schemes() {
        assert!(!is_openable_url("file:///etc/passwd"));
        assert!(!is_openable_url("javascript:alert(1)"));
        assert!(!is_openable_url("ftp://example.com"));
        assert!(!is_openable_url(""));
        assert!(!is_openable_url("data:text/plain,hi"));
        assert!(!is_openable_url("http://"));
        assert!(!is_openable_url("https://"));
        assert!(!is_openable_url(" https://example.com"));
        assert!(!is_openable_url("https://example.com\n--bad"));
    }

    #[test]
    fn external_open_command_avoids_shell_interpolation() {
        let url = "https://example.com/release?x=1&y=2";
        let (program, args) = external_open_command(url);
        if cfg!(target_os = "windows") {
            assert_eq!(program, "explorer.exe");
        } else if cfg!(target_os = "macos") {
            assert_eq!(program, "open");
        } else {
            assert_eq!(program, "xdg-open");
        }
        assert_eq!(args, vec![url]);
    }

    #[test]
    fn json_export_default_file_name_is_sanitized_and_gets_json_extension() {
        assert_eq!(
            sanitize_json_file_name(" ../视觉/存档:name "),
            "存档_name.json"
        );
        assert_eq!(sanitize_json_file_name("preset.JSON"), "preset.JSON");
        assert_eq!(sanitize_json_file_name(""), "mineradio-export.json");
    }

    #[test]
    fn json_extension_guard_accepts_json_paths_only() {
        assert!(path_has_json_extension(std::path::Path::new("preset.json")));
        assert!(path_has_json_extension(std::path::Path::new("PRESET.JSON")));
        assert!(!path_has_json_extension(std::path::Path::new("preset.txt")));
        assert!(!path_has_json_extension(std::path::Path::new("preset")));
    }

    #[test]
    fn json_export_path_appends_extension_when_missing() {
        assert_eq!(
            ensure_json_extension(std::path::PathBuf::from("preset")),
            std::path::PathBuf::from("preset.json")
        );
        assert_eq!(
            ensure_json_extension(std::path::PathBuf::from("preset.JSON")),
            std::path::PathBuf::from("preset.JSON")
        );
    }

    #[test]
    fn json_pretty_serialization_uses_utf8_pretty_json() {
        let value = serde_json::json!({ "name": "视觉", "items": [1, 2] });
        let text = serialize_json_pretty(&value).expect("pretty json");

        assert!(text.contains("\n  \"name\": \"视觉\""));
        assert!(text.ends_with('\n'));
    }

    #[test]
    fn json_import_parse_returns_json_or_error_code() {
        assert_eq!(
            parse_imported_json("{\"enabled\":true}").expect("json"),
            serde_json::json!({ "enabled": true })
        );
        assert_eq!(
            parse_imported_json("{bad").expect_err("invalid json"),
            "IMPORT_JSON_INVALID_JSON"
        );
    }

    #[test]
    fn json_dialog_cancel_results_do_not_include_data() {
        assert_eq!(
            export_json_cancelled_result(),
            ExportJsonFileResult {
                cancelled: true,
                path: None,
            }
        );
        assert_eq!(
            import_json_cancelled_result(),
            ImportJsonFileResult {
                cancelled: true,
                path: None,
                data: None,
            }
        );
    }

    #[test]
    fn json_dialog_selection_receiver_resolves_cancelled_selection() {
        tauri::async_runtime::block_on(async {
            let (tx, rx) = tauri::async_runtime::channel(1);
            tx.try_send(None).expect("send cancelled selection");

            let selected = receive_json_dialog_selection(rx, "TEST_DIALOG_CLOSED")
                .await
                .expect("selection result");

            assert!(selected.is_none());
        });
    }
}
