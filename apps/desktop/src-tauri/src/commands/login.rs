use super::{dialogs::open_external, labels};
use crate::AppState;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::Duration;
use tauri::{Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

const LOGIN_SESSION_HTTP_TIMEOUT_MS: u64 = 3200;
const LOGIN_COOKIE_POLL_ATTEMPTS: usize = 36;
const LOGIN_COOKIE_POLL_INTERVAL_MS: u64 = 1200;
#[allow(dead_code)]
const NETEASE_LOGIN_COOKIE_PRIORITY: &[&str] = &["MUSIC_U", "__csrf", "NMTID"];
#[allow(dead_code)]
const QQ_LOGIN_COOKIE_PRIORITY: &[&str] = &[
    "uin",
    "qqmusic_uin",
    "wxuin",
    "p_uin",
    "qm_keyst",
    "qqmusic_key",
    "music_key",
    "wxskey",
    "p_skey",
    "skey",
];
const NETEASE_LOGIN_COOKIE_PROBE_URLS: &[&str] =
    &["https://music.163.com", "https://interface.music.163.com"];
const QQ_LOGIN_COOKIE_PROBE_URLS: &[&str] = &[
    "https://y.qq.com",
    "https://c.y.qq.com",
    "https://i.y.qq.com",
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginSessionImportResult {
    pub provider: LoginProvider,
    pub stored: bool,
    pub reused: bool,
    pub partial: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LoginProvider {
    Netease,
    Qq,
}

impl LoginProvider {
    pub fn as_route_segment(self) -> &'static str {
        match self {
            LoginProvider::Netease => "netease",
            LoginProvider::Qq => "qq",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LoginWindowConfig {
    pub provider: LoginProvider,
    pub label: &'static str,
    pub url: &'static str,
    pub title: &'static str,
    pub width: f64,
    pub height: f64,
    pub min_width: f64,
    pub min_height: f64,
}

#[allow(dead_code)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoginCookie {
    pub name: String,
    pub value: String,
    pub domain: String,
}

#[derive(Clone, PartialEq, Eq)]
pub struct LoginSessionCookieRequest {
    pub url: String,
    pub host: String,
    pub port: u16,
    pub path: String,
    pub body: String,
}

impl std::fmt::Debug for LoginSessionCookieRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LoginSessionCookieRequest")
            .field("url", &self.url)
            .field("host", &self.host)
            .field("port", &self.port)
            .field("path", &self.path)
            .field("body", &"<redacted>")
            .finish()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoginPopupAction {
    NavigateInLoginWindow,
    OpenExternal,
    Deny,
}

impl LoginCookie {
    #[allow(dead_code)]
    pub fn new(
        name: impl Into<String>,
        value: impl Into<String>,
        domain: impl Into<String>,
    ) -> Self {
        Self {
            name: name.into(),
            value: value.into(),
            domain: domain.into(),
        }
    }
}

pub fn login_window_config(provider: LoginProvider) -> LoginWindowConfig {
    match provider {
        LoginProvider::Netease => LoginWindowConfig {
            provider,
            label: labels::LOGIN_NETEASE,
            url: "https://music.163.com/#/login",
            title: "网易云音乐登录",
            width: 940.0,
            height: 760.0,
            min_width: 780.0,
            min_height: 580.0,
        },
        LoginProvider::Qq => LoginWindowConfig {
            provider,
            label: labels::LOGIN_QQ,
            url: "https://y.qq.com/n/ryqq/profile",
            title: "QQ 音乐登录",
            width: 900.0,
            height: 720.0,
            min_width: 760.0,
            min_height: 560.0,
        },
    }
}

#[allow(dead_code)]
fn parse_cookie_header(cookie_text: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for part in cookie_text.split(';') {
        let raw = part.trim();
        let Some((name, value)) = raw.split_once('=') else {
            continue;
        };
        let name = name.trim();
        if name.is_empty() {
            continue;
        }
        out.insert(name.to_string(), value.trim().to_string());
    }
    out
}

#[allow(dead_code)]
pub fn netease_cookie_has_login(cookie_text: &str) -> bool {
    parse_cookie_header(cookie_text).contains_key("MUSIC_U")
}

#[allow(dead_code)]
pub fn qq_cookie_has_login(cookie_text: &str) -> bool {
    let obj = parse_cookie_header(cookie_text);
    let raw_uin = if obj.get("login_type").and_then(|v| v.parse::<u8>().ok()) == Some(2) {
        obj.get("wxuin")
            .or_else(|| obj.get("uin"))
            .or_else(|| obj.get("p_uin"))
    } else {
        obj.get("uin")
            .or_else(|| obj.get("qqmusic_uin"))
            .or_else(|| obj.get("wxuin"))
            .or_else(|| obj.get("p_uin"))
    };
    let has_uin = raw_uin
        .map(|value| value.chars().any(|c| c.is_ascii_digit()))
        .unwrap_or(false);
    let has_key = [
        "qm_keyst",
        "qqmusic_key",
        "music_key",
        "p_skey",
        "skey",
        "psrf_qqaccess_token",
        "psrf_qqrefresh_token",
        "wxrefresh_token",
        "wxskey",
    ]
    .iter()
    .any(|name| obj.get(*name).map(|v| !v.is_empty()).unwrap_or(false));
    has_uin && has_key
}

#[allow(dead_code)]
pub fn qq_cookie_has_playback_login(cookie_text: &str) -> bool {
    let obj = parse_cookie_header(cookie_text);
    let raw_uin = if obj.get("login_type").and_then(|v| v.parse::<u8>().ok()) == Some(2) {
        obj.get("wxuin")
            .or_else(|| obj.get("uin"))
            .or_else(|| obj.get("p_uin"))
    } else {
        obj.get("uin")
            .or_else(|| obj.get("qqmusic_uin"))
            .or_else(|| obj.get("wxuin"))
            .or_else(|| obj.get("p_uin"))
    };
    let has_uin = raw_uin
        .map(|value| value.chars().any(|c| c.is_ascii_digit()))
        .unwrap_or(false);
    let has_key = ["qm_keyst", "qqmusic_key", "music_key", "wxskey"]
        .iter()
        .any(|name| obj.get(*name).map(|v| !v.is_empty()).unwrap_or(false));
    has_uin && has_key
}

#[allow(dead_code)]
fn normalize_cookie_domain(domain: &str) -> String {
    domain.trim().trim_start_matches('.').to_ascii_lowercase()
}

#[allow(dead_code)]
pub fn is_qq_cookie_domain(domain: &str) -> bool {
    let normalized = normalize_cookie_domain(domain);
    normalized == "qq.com"
        || normalized.ends_with(".qq.com")
        || normalized.ends_with("qqmusic.qq.com")
}

#[allow(dead_code)]
pub fn is_netease_cookie_domain(domain: &str) -> bool {
    let normalized = normalize_cookie_domain(domain);
    normalized == "163.com"
        || normalized.ends_with(".163.com")
        || normalized == "music.163.com"
        || normalized.ends_with(".music.163.com")
        || normalized == "netease.com"
        || normalized.ends_with(".netease.com")
}

pub fn login_popup_action(provider: LoginProvider, url: &str) -> LoginPopupAction {
    let Ok(parsed) = tauri::Url::parse(url) else {
        return LoginPopupAction::Deny;
    };
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return LoginPopupAction::Deny;
    }
    let host = parsed.host_str().unwrap_or_default();
    let provider_domain = match provider {
        LoginProvider::Netease => is_netease_cookie_domain(host),
        LoginProvider::Qq => is_qq_cookie_domain(host),
    };
    if provider_domain {
        LoginPopupAction::NavigateInLoginWindow
    } else {
        LoginPopupAction::OpenExternal
    }
}

#[allow(dead_code)]
pub fn build_login_cookie_header(
    cookies: &[LoginCookie],
    is_allowed_domain: fn(&str) -> bool,
    priority: &[&str],
) -> String {
    let mut picked: HashMap<String, String> = HashMap::new();
    for cookie in cookies {
        if cookie.name.is_empty() || !is_allowed_domain(&cookie.domain) {
            continue;
        }
        picked.insert(cookie.name.clone(), cookie.value.clone());
    }

    let mut ordered = Vec::new();
    for name in priority {
        if let Some(value) = picked.remove(*name) {
            ordered.push(((*name).to_string(), value));
        }
    }
    let mut rest: Vec<(String, String)> = picked.into_iter().collect();
    rest.sort_by(|a, b| a.0.cmp(&b.0));
    ordered.extend(rest);

    ordered
        .into_iter()
        .filter(|(_, value)| !value.is_empty())
        .map(|(name, value)| format!("{}={}", name, value))
        .collect::<Vec<_>>()
        .join("; ")
}

#[allow(dead_code)]
pub fn build_netease_login_cookie_header(cookies: &[LoginCookie]) -> String {
    build_login_cookie_header(
        cookies,
        is_netease_cookie_domain,
        NETEASE_LOGIN_COOKIE_PRIORITY,
    )
}

#[allow(dead_code)]
pub fn build_qq_login_cookie_header(cookies: &[LoginCookie]) -> String {
    build_login_cookie_header(cookies, is_qq_cookie_domain, QQ_LOGIN_COOKIE_PRIORITY)
}

fn login_cookie_has_required_session(provider: LoginProvider, cookie_text: &str) -> bool {
    match provider {
        LoginProvider::Netease => netease_cookie_has_login(cookie_text),
        LoginProvider::Qq => qq_cookie_has_playback_login(cookie_text),
    }
}

fn login_cookie_partial(provider: LoginProvider, cookie_text: &str) -> bool {
    provider == LoginProvider::Qq
        && qq_cookie_has_login(cookie_text)
        && !qq_cookie_has_playback_login(cookie_text)
}

pub fn build_login_session_cookie_request(
    sidecar_base_url: &str,
    provider: LoginProvider,
    cookie_text: &str,
) -> Result<LoginSessionCookieRequest, String> {
    let cookie = cookie_text.trim();
    if cookie.is_empty() {
        return Err("LOGIN_COOKIE_EMPTY".into());
    }
    if !login_cookie_has_required_session(provider, cookie) {
        return Err("LOGIN_COOKIE_NOT_READY".into());
    }
    let base = sidecar_base_url.trim().trim_end_matches('/');
    let Some(authority) = base.strip_prefix("http://") else {
        return Err("LOGIN_SIDECAR_BAD_URL".into());
    };
    let mut host_port = authority.split('/').next().unwrap_or(authority).split(':');
    let host = host_port.next().unwrap_or("").trim();
    let port = host_port
        .next()
        .and_then(|value| value.parse::<u16>().ok())
        .ok_or_else(|| "LOGIN_SIDECAR_BAD_URL".to_string())?;
    if host != "127.0.0.1" && host != "localhost" {
        return Err("LOGIN_SIDECAR_BAD_URL".into());
    }
    let path = format!("/providers/{}/session-cookie", provider.as_route_segment());
    let url = format!("http://{}:{}{}", host, port, path);
    let body = serde_json::json!({ "cookie": cookie }).to_string();
    Ok(LoginSessionCookieRequest {
        url,
        host: host.to_string(),
        port,
        path,
        body,
    })
}

fn post_login_session_cookie_request(
    request: &LoginSessionCookieRequest,
) -> Result<LoginSessionImportResult, String> {
    let mut stream = TcpStream::connect((request.host.as_str(), request.port))
        .map_err(|_| "LOGIN_SIDECAR_UNAVAILABLE".to_string())?;
    let timeout = Some(Duration::from_millis(LOGIN_SESSION_HTTP_TIMEOUT_MS));
    let _ = stream.set_read_timeout(timeout);
    let _ = stream.set_write_timeout(timeout);
    let http = format!(
        "POST {} HTTP/1.1\r\nHost: {}:{}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        request.path,
        request.host,
        request.port,
        request.body.len(),
        request.body
    );
    stream
        .write_all(http.as_bytes())
        .map_err(|_| "LOGIN_SIDECAR_WRITE_FAILED".to_string())?;
    let mut response = String::new();
    stream
        .read_to_string(&mut response)
        .map_err(|_| "LOGIN_SIDECAR_READ_FAILED".to_string())?;
    let Some((head, body)) = response.split_once("\r\n\r\n") else {
        return Err("LOGIN_SIDECAR_BAD_RESPONSE".into());
    };
    if !head.starts_with("HTTP/1.1 2") && !head.starts_with("HTTP/1.0 2") {
        return Err("LOGIN_SIDECAR_REJECTED_COOKIE".into());
    }
    let parsed: serde_json::Value =
        serde_json::from_str(body).map_err(|_| "LOGIN_SIDECAR_BAD_RESPONSE".to_string())?;
    let data = parsed
        .get("data")
        .ok_or_else(|| "LOGIN_SIDECAR_BAD_RESPONSE".to_string())?;
    let stored = data
        .get("stored")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    let provider = match data
        .get("provider")
        .and_then(|value| value.as_str())
        .unwrap_or_default()
    {
        "netease" => LoginProvider::Netease,
        "qq" => LoginProvider::Qq,
        _ => return Err("LOGIN_SIDECAR_BAD_RESPONSE".into()),
    };
    Ok(LoginSessionImportResult {
        provider,
        stored,
        reused: false,
        partial: false,
    })
}

fn inject_login_cookie_into_sidecar(
    sidecar_base_url: &str,
    provider: LoginProvider,
    cookie_text: &str,
) -> Result<LoginSessionImportResult, String> {
    let partial = login_cookie_partial(provider, cookie_text);
    let request = build_login_session_cookie_request(sidecar_base_url, provider, cookie_text)?;
    let mut result = post_login_session_cookie_request(&request)?;
    result.partial = partial;
    Ok(result)
}

fn login_cookie_probe_urls(provider: LoginProvider) -> &'static [&'static str] {
    match provider {
        LoginProvider::Netease => NETEASE_LOGIN_COOKIE_PROBE_URLS,
        LoginProvider::Qq => QQ_LOGIN_COOKIE_PROBE_URLS,
    }
}

fn build_provider_login_cookie_header(provider: LoginProvider, cookies: &[LoginCookie]) -> String {
    match provider {
        LoginProvider::Netease => build_netease_login_cookie_header(cookies),
        LoginProvider::Qq => build_qq_login_cookie_header(cookies),
    }
}

fn collect_login_cookies_for_provider(
    win: &WebviewWindow,
    provider: LoginProvider,
) -> Result<Vec<LoginCookie>, String> {
    let mut out = Vec::new();
    for raw_url in login_cookie_probe_urls(provider) {
        let url = tauri::Url::parse(raw_url).map_err(|e| e.to_string())?;
        let cookies = win.cookies_for_url(url).map_err(|e| e.to_string())?;
        for cookie in cookies {
            let domain = cookie.domain().unwrap_or(raw_url).to_string();
            out.push(LoginCookie::new(cookie.name(), cookie.value(), domain));
        }
    }
    Ok(out)
}

fn read_provider_login_cookie_header(
    win: &WebviewWindow,
    provider: LoginProvider,
) -> Result<String, String> {
    let cookies = collect_login_cookies_for_provider(win, provider)?;
    Ok(build_provider_login_cookie_header(provider, &cookies))
}

async fn poll_login_cookie_header(
    win: WebviewWindow,
    provider: LoginProvider,
) -> Result<String, String> {
    let mut last_cookie = String::new();
    for _ in 0..LOGIN_COOKIE_POLL_ATTEMPTS {
        let cookie = read_provider_login_cookie_header(&win, provider)?;
        if login_cookie_has_required_session(provider, &cookie) {
            return Ok(cookie);
        }
        last_cookie = cookie;
        let _ = tauri::async_runtime::spawn_blocking(|| {
            std::thread::sleep(Duration::from_millis(LOGIN_COOKIE_POLL_INTERVAL_MS));
        })
        .await;
    }
    if login_cookie_partial(provider, &last_cookie) {
        return Err("LOGIN_COOKIE_NOT_PLAYBACK_READY".into());
    }
    Err("LOGIN_COOKIE_NOT_READY".into())
}

async fn complete_provider_login_from_window(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    provider: LoginProvider,
) -> Result<LoginSessionImportResult, String> {
    let win = ensure_login_window(&app, provider)?;
    let initial_cookie = read_provider_login_cookie_header(&win, provider)?;
    let (cookie, reused) = if login_cookie_has_required_session(provider, &initial_cookie) {
        (initial_cookie, true)
    } else {
        if provider == LoginProvider::Qq && qq_cookie_has_login(&initial_cookie) {
            if let Ok(url) = tauri::Url::parse("https://y.qq.com/n/ryqq/player") {
                let _ = win.navigate(url);
            }
        }
        (
            poll_login_cookie_header(win.clone(), provider).await?,
            false,
        )
    };
    let mut result =
        inject_login_cookie_into_sidecar(&state.config.sidecar_base_url, provider, &cookie)?;
    result.reused = reused;
    let _ = win.close();
    Ok(result)
}

fn login_window(app: &tauri::AppHandle, provider: LoginProvider) -> Option<WebviewWindow> {
    app.get_webview_window(login_window_config(provider).label)
}

fn ensure_login_window(
    app: &tauri::AppHandle,
    provider: LoginProvider,
) -> Result<WebviewWindow, String> {
    let config = login_window_config(provider);
    if let Some(win) = login_window(app, provider) {
        win.show().map_err(|e| e.to_string())?;
        win.set_focus().map_err(|e| e.to_string())?;
        return Ok(win);
    }

    let url = tauri::Url::parse(config.url).map_err(|e| e.to_string())?;
    let popup_app = app.clone();
    let popup_provider = provider;
    let popup_label = config.label;
    let win = WebviewWindowBuilder::new(app, config.label, WebviewUrl::External(url))
        .title(config.title)
        .inner_size(config.width, config.height)
        .min_inner_size(config.min_width, config.min_height)
        .resizable(true)
        .decorations(true)
        .on_new_window(move |url, _features| {
            match login_popup_action(popup_provider, url.as_str()) {
                LoginPopupAction::NavigateInLoginWindow => {
                    if let Some(win) = popup_app.get_webview_window(popup_label) {
                        let _ = win.navigate(url);
                    }
                }
                LoginPopupAction::OpenExternal => {
                    let _ = open_external(url.as_str().to_string());
                }
                LoginPopupAction::Deny => {}
            }
            tauri::webview::NewWindowResponse::Deny
        })
        .build()
        .map_err(|e| e.to_string())?;
    win.show().map_err(|e| e.to_string())?;
    Ok(win)
}

#[tauri::command]
pub fn login_netease_show_window(app: tauri::AppHandle) -> Result<(), String> {
    ensure_login_window(&app, LoginProvider::Netease).map(|_| ())
}

#[tauri::command]
pub fn login_qq_show_window(app: tauri::AppHandle) -> Result<(), String> {
    ensure_login_window(&app, LoginProvider::Qq).map(|_| ())
}

#[tauri::command]
pub async fn login_netease_complete(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<LoginSessionImportResult, String> {
    complete_provider_login_from_window(app, state, LoginProvider::Netease).await
}

#[tauri::command]
pub async fn login_qq_complete(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<LoginSessionImportResult, String> {
    complete_provider_login_from_window(app, state, LoginProvider::Qq).await
}

#[tauri::command]
pub fn login_netease_close_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(win) = login_window(&app, LoginProvider::Netease) {
        win.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn login_qq_close_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(win) = login_window(&app, LoginProvider::Qq) {
        win.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn login_window_configs_match_reserved_labels_and_baseline_urls() {
        let netease = login_window_config(LoginProvider::Netease);
        assert_eq!(netease.label, labels::LOGIN_NETEASE);
        assert_eq!(netease.url, "https://music.163.com/#/login");
        assert_eq!(netease.title, "网易云音乐登录");
        assert_eq!((netease.width, netease.height), (940.0, 760.0));

        let qq = login_window_config(LoginProvider::Qq);
        assert_eq!(qq.label, labels::LOGIN_QQ);
        assert_eq!(qq.url, "https://y.qq.com/n/ryqq/profile");
        assert_eq!(qq.title, "QQ 音乐登录");
        assert_eq!((qq.width, qq.height), (900.0, 720.0));
    }

    #[test]
    fn login_cookie_detection_matches_provider_requirements() {
        assert!(netease_cookie_has_login("foo=bar; MUSIC_U=secret"));
        assert!(!netease_cookie_has_login("foo=bar"));
        assert!(qq_cookie_has_login("uin=o12345; skey=abc"));
        assert!(qq_cookie_has_playback_login(
            "wxuin=12345; wxskey=abc; login_type=2"
        ));
        assert!(!qq_cookie_has_playback_login("uin=12345; skey=abc"));
    }

    #[test]
    fn login_cookie_domain_filters_allow_provider_domains_only() {
        assert!(is_netease_cookie_domain(".music.163.com"));
        assert!(is_netease_cookie_domain("api.netease.com"));
        assert!(!is_netease_cookie_domain("qq.com"));

        assert!(is_qq_cookie_domain(".qq.com"));
        assert!(is_qq_cookie_domain("y.qq.com"));
        assert!(!is_qq_cookie_domain("music.163.com"));
    }

    #[test]
    fn login_popup_action_keeps_provider_domains_in_login_window() {
        assert_eq!(
            login_popup_action(LoginProvider::Netease, "https://music.163.com/#/login"),
            LoginPopupAction::NavigateInLoginWindow
        );
        assert_eq!(
            login_popup_action(
                LoginProvider::Netease,
                "https://interface.music.163.com/login"
            ),
            LoginPopupAction::NavigateInLoginWindow
        );
        assert_eq!(
            login_popup_action(LoginProvider::Qq, "https://y.qq.com/n/ryqq/profile"),
            LoginPopupAction::NavigateInLoginWindow
        );
        assert_eq!(
            login_popup_action(LoginProvider::Qq, "https://ptlogin2.qq.com/cgi-bin/login"),
            LoginPopupAction::NavigateInLoginWindow
        );
    }

    #[test]
    fn login_popup_action_opens_cross_provider_http_externally_and_denies_other_schemes() {
        assert_eq!(
            login_popup_action(LoginProvider::Netease, "https://y.qq.com/n/ryqq/profile"),
            LoginPopupAction::OpenExternal
        );
        assert_eq!(
            login_popup_action(LoginProvider::Qq, "https://music.163.com/#/login"),
            LoginPopupAction::OpenExternal
        );
        assert_eq!(
            login_popup_action(LoginProvider::Netease, "https://music.163.com.evil.example"),
            LoginPopupAction::OpenExternal
        );
        assert_eq!(
            login_popup_action(LoginProvider::Qq, "https://qq.com.evil.example"),
            LoginPopupAction::OpenExternal
        );
        assert_eq!(
            login_popup_action(LoginProvider::Qq, "javascript:alert(1)"),
            LoginPopupAction::Deny
        );
        assert_eq!(
            login_popup_action(LoginProvider::Netease, "mineradio://login"),
            LoginPopupAction::Deny
        );
    }

    #[test]
    fn login_cookie_header_builder_filters_domains_and_orders_priority() {
        let cookies = vec![
            LoginCookie::new("foo", "bar", "evil.example"),
            LoginCookie::new("MUSIC_U", "secret", ".music.163.com"),
            LoginCookie::new("__csrf", "csrf", "music.163.com"),
        ];

        let header = build_netease_login_cookie_header(&cookies);

        assert_eq!(header, "MUSIC_U=secret; __csrf=csrf");

        let qq_header = build_qq_login_cookie_header(&[
            LoginCookie::new("qm_keyst", "key", ".qq.com"),
            LoginCookie::new("uin", "123", "qq.com"),
            LoginCookie::new("MUSIC_U", "secret", ".music.163.com"),
        ]);
        assert_eq!(qq_header, "uin=123; qm_keyst=key");
    }

    #[test]
    fn login_session_cookie_request_posts_cookie_without_echoing_it() {
        let request = build_login_session_cookie_request(
            "http://127.0.0.1:42531/",
            LoginProvider::Qq,
            "uin=123; qm_keyst=secret",
        )
        .expect("request");

        assert_eq!(
            request.url,
            "http://127.0.0.1:42531/providers/qq/session-cookie"
        );
        assert_eq!(
            request.body,
            serde_json::json!({ "cookie": "uin=123; qm_keyst=secret" }).to_string()
        );
        assert!(!format!("{:?}", request).contains("qm_keyst=secret"));
    }

    #[test]
    fn login_session_cookie_request_rejects_empty_or_logged_out_cookie() {
        assert_eq!(
            build_login_session_cookie_request(
                "http://127.0.0.1:42531",
                LoginProvider::Netease,
                ""
            )
            .expect_err("empty"),
            "LOGIN_COOKIE_EMPTY"
        );
        assert_eq!(
            build_login_session_cookie_request(
                "http://127.0.0.1:42531",
                LoginProvider::Netease,
                "__csrf=csrf"
            )
            .expect_err("logged out"),
            "LOGIN_COOKIE_NOT_READY"
        );
    }
}
