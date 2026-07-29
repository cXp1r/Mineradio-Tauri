//! 主窗口创建 Adapter。
//!
//! M6 要求 crash recovery 在主窗口创建前执行，因此主窗口不能再由静态
//! `tauri.conf.json` 提前创建。这里保持原窗口参数不变，只移动 ownership。

use tauri::{WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use super::window_labels;

fn main_navigation_allowed(url: &tauri::Url) -> bool {
    if url.scheme() == "tauri" && url.host_str() == Some("localhost") {
        return true;
    }
    if matches!(url.scheme(), "http" | "https") && url.host_str() == Some("tauri.localhost") {
        return true;
    }
    cfg!(debug_assertions)
        && url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.port() == Some(5173)
}

pub fn create_main_window(app: &tauri::AppHandle) -> tauri::Result<WebviewWindow> {
    let navigation_app = app.clone();
    let window = WebviewWindowBuilder::new(
        app,
        window_labels::MAIN,
        WebviewUrl::App("index.html".into()),
    )
    .title("MineRadio-Tauri")
    .inner_size(1440.0, 1080.0)
    .min_inner_size(960.0, 540.0)
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .on_navigation(move |url| {
        let allowed = main_navigation_allowed(url);
        if !allowed {
            super::wallpaper_engine_runtime::schedule_stop_for_webview_failure(
                navigation_app.clone(),
            );
        }
        allowed
    })
    .build()?;
    super::wallpaper_engine_runtime::install_main_webview_process_failed_handler(&window)
        .map_err(std::io::Error::other)?;
    Ok(window)
}

#[cfg(test)]
mod tests {
    use super::main_navigation_allowed;

    #[test]
    fn main_navigation_guard_allows_only_owned_app_origins() {
        assert!(main_navigation_allowed(
            &tauri::Url::parse("tauri://localhost/index.html").expect("有效 Tauri URL")
        ));
        assert!(main_navigation_allowed(
            &tauri::Url::parse("http://tauri.localhost/index.html").expect("有效生产 URL")
        ));
        assert!(!main_navigation_allowed(
            &tauri::Url::parse("about:blank").expect("有效 about URL")
        ));
        assert!(!main_navigation_allowed(
            &tauri::Url::parse("https://example.test/").expect("有效外部 URL")
        ));
        assert!(!main_navigation_allowed(
            &tauri::Url::parse("file:///C:/Users/example/index.html").expect("有效 file URL")
        ));
    }
}
