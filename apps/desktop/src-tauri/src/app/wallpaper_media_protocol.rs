//! Wallpaper Engine direct media 的只读 Tauri custom protocol。

use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
};

use tauri::http::{
    header::{ACCEPT_RANGES, CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE, ETAG},
    Method, Request, Response, StatusCode,
};

use crate::runtime::wallpaper_engine::{
    library::{WallpaperMediaAsset, WallpaperMediaRole},
    project::WallpaperMediaType,
};

const MAX_VIDEO_CHUNK_BYTES: u64 = 8 * 1024 * 1024;
const MAX_IMAGE_RESPONSE_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ByteRange {
    start: u64,
    end: u64,
}

pub fn build_media_response<F>(
    webview_label: &str,
    request: Request<Vec<u8>>,
    resolve: F,
) -> Response<Vec<u8>>
where
    F: FnOnce(&str, WallpaperMediaRole) -> Result<WallpaperMediaAsset, String>,
{
    if webview_label != super::window_labels::MAIN {
        return error_response(StatusCode::FORBIDDEN, "WALLPAPER_MEDIA_WEBVIEW_FORBIDDEN");
    }
    if request.method() != Method::GET && request.method() != Method::HEAD {
        return error_response(
            StatusCode::METHOD_NOT_ALLOWED,
            "WALLPAPER_MEDIA_METHOD_INVALID",
        );
    }
    let Some((project_id, role)) = parse_route(request.uri().path()) else {
        return error_response(StatusCode::NOT_FOUND, "WALLPAPER_MEDIA_ROUTE_INVALID");
    };
    let asset = match resolve(project_id, role) {
        Ok(asset) => asset,
        Err(code) => return error_response(StatusCode::NOT_FOUND, &code),
    };
    let range_header = request
        .headers()
        .get("range")
        .and_then(|value| value.to_str().ok());
    let range = match select_range(&asset, range_header) {
        Ok(range) => range,
        Err(()) => {
            return Response::builder()
                .status(StatusCode::RANGE_NOT_SATISFIABLE)
                .header(CONTENT_RANGE, format!("bytes */{}", asset.content_length))
                .body(b"WALLPAPER_MEDIA_RANGE_INVALID".to_vec())
                .unwrap_or_else(|_| Response::new(Vec::new()));
        }
    };
    let partial = range.start != 0
        || range.end.saturating_add(1) != asset.content_length
        || range_header.is_some();
    let content_length = range.end.saturating_sub(range.start).saturating_add(1);
    let mut response = Response::builder()
        .status(if partial {
            StatusCode::PARTIAL_CONTENT
        } else {
            StatusCode::OK
        })
        .header(ACCEPT_RANGES, "bytes")
        .header(CONTENT_TYPE, content_type(&asset))
        .header(CONTENT_LENGTH, content_length.to_string())
        .header(
            ETAG,
            format!("\"{}-{}\"", asset.revision, asset.content_length),
        );
    if partial {
        response = response.header(
            CONTENT_RANGE,
            format!(
                "bytes {}-{}/{}",
                range.start, range.end, asset.content_length
            ),
        );
    }
    let body = if request.method() == Method::HEAD {
        Vec::new()
    } else {
        match read_range(&asset, range) {
            Ok(bytes) => bytes,
            Err(_) => {
                return error_response(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "WALLPAPER_MEDIA_READ_FAILED",
                );
            }
        }
    };
    response.body(body).unwrap_or_else(|_| {
        error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "WALLPAPER_MEDIA_RESPONSE_FAILED",
        )
    })
}

fn parse_route(path: &str) -> Option<(&str, WallpaperMediaRole)> {
    let mut segments = path.trim_matches('/').split('/');
    if segments.next()? != "project" {
        return None;
    }
    let project_id = segments.next()?;
    if project_id.len() != 24
        || !project_id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return None;
    }
    let role = match segments.next()? {
        "media" => WallpaperMediaRole::Media,
        "preview" => WallpaperMediaRole::Preview,
        _ => return None,
    };
    segments.next().is_none().then_some((project_id, role))
}

fn select_range(asset: &WallpaperMediaAsset, header: Option<&str>) -> Result<ByteRange, ()> {
    if asset.content_length == 0 {
        return Err(());
    }
    let max_chunk = match asset.media_type {
        WallpaperMediaType::Image => MAX_IMAGE_RESPONSE_BYTES,
        WallpaperMediaType::Video => MAX_VIDEO_CHUNK_BYTES,
    };
    if header.is_none()
        && asset.media_type == WallpaperMediaType::Image
        && asset.content_length > MAX_IMAGE_RESPONSE_BYTES
    {
        return Err(());
    }
    let mut range = match header {
        None => ByteRange {
            start: 0,
            end: asset.content_length - 1,
        },
        Some(value) => parse_range_header(value, asset.content_length)?,
    };
    let bounded_end = range
        .start
        .saturating_add(max_chunk.saturating_sub(1))
        .min(asset.content_length - 1);
    range.end = range.end.min(bounded_end);
    Ok(range)
}

fn parse_range_header(value: &str, content_length: u64) -> Result<ByteRange, ()> {
    let spec = value.strip_prefix("bytes=").ok_or(())?;
    if spec.contains(',') || content_length == 0 {
        return Err(());
    }
    let (start, end) = spec.split_once('-').ok_or(())?;
    if start.is_empty() {
        let suffix = end.parse::<u64>().map_err(|_| ())?;
        if suffix == 0 {
            return Err(());
        }
        let start = content_length.saturating_sub(suffix.min(content_length));
        return Ok(ByteRange {
            start,
            end: content_length - 1,
        });
    }
    let start = start.parse::<u64>().map_err(|_| ())?;
    if start >= content_length {
        return Err(());
    }
    let end = if end.is_empty() {
        content_length - 1
    } else {
        end.parse::<u64>().map_err(|_| ())?.min(content_length - 1)
    };
    (start <= end).then_some(ByteRange { start, end }).ok_or(())
}

fn read_range(asset: &WallpaperMediaAsset, range: ByteRange) -> std::io::Result<Vec<u8>> {
    let mut file = File::open(&asset.path)?;
    file.seek(SeekFrom::Start(range.start))?;
    let length = range.end.saturating_sub(range.start).saturating_add(1);
    let mut bytes = Vec::with_capacity(usize::try_from(length).unwrap_or(0));
    file.take(length).read_to_end(&mut bytes)?;
    if u64::try_from(bytes.len()).unwrap_or(u64::MAX) != length {
        return Err(std::io::Error::new(
            std::io::ErrorKind::UnexpectedEof,
            "媒体文件在读取期间发生变化",
        ));
    }
    Ok(bytes)
}

fn content_type(asset: &WallpaperMediaAsset) -> &'static str {
    let extension = asset
        .path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    match extension.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "webm" => "video/webm",
        "m4v" | "mp4" => "video/mp4",
        "mov" => "video/quicktime",
        _ => "application/octet-stream",
    }
}

fn error_response(status: StatusCode, code: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(code.as_bytes().to_vec())
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

#[cfg(test)]
mod tests {
    use super::{build_media_response, parse_range_header, ByteRange};
    use crate::runtime::wallpaper_engine::{
        library::{WallpaperMediaAsset, WallpaperMediaRole},
        project::WallpaperMediaType,
    };
    use std::{fs, time::SystemTime};
    use tauri::http::{Method, Request, StatusCode};

    #[test]
    fn range_parser_supports_open_and_suffix_ranges_but_rejects_multi_range() {
        assert_eq!(
            parse_range_header("bytes=5-9", 20),
            Ok(ByteRange { start: 5, end: 9 })
        );
        assert_eq!(
            parse_range_header("bytes=5-", 20),
            Ok(ByteRange { start: 5, end: 19 })
        );
        assert_eq!(
            parse_range_header("bytes=-4", 20),
            Ok(ByteRange { start: 16, end: 19 })
        );
        assert!(parse_range_header("bytes=0-1,4-5", 20).is_err());
        assert!(parse_range_header("bytes=20-", 20).is_err());
    }

    #[test]
    fn protocol_resolves_only_main_webview_registered_project_routes() {
        let path = std::env::temp_dir().join(format!(
            "mineradio-wallpaper-media-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .expect("系统时间应有效")
                .as_nanos()
        ));
        fs::write(&path, b"0123456789").expect("应创建媒体 fixture");
        let asset = WallpaperMediaAsset {
            path: path.clone(),
            media_type: WallpaperMediaType::Video,
            content_length: 10,
            revision: 7,
        };
        let request = Request::builder()
            .method(Method::GET)
            .uri("http://mineradio-wallpaper.localhost/project/aaaaaaaaaaaaaaaaaaaaaaaa/media")
            .header("range", "bytes=2-5")
            .body(Vec::new())
            .expect("请求应有效");
        let response = build_media_response("main", request, |id, role| {
            assert_eq!(id, "aaaaaaaaaaaaaaaaaaaaaaaa");
            assert_eq!(role, WallpaperMediaRole::Media);
            Ok(asset)
        });
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.body(), b"2345");
        assert_eq!(response.headers()["content-range"], "bytes 2-5/10");

        let forbidden = Request::builder()
            .uri("http://mineradio-wallpaper.localhost/project/aaaaaaaaaaaaaaaaaaaaaaaa/media")
            .body(Vec::new())
            .expect("请求应有效");
        let response = build_media_response("login-qq", forbidden, |_, _| {
            panic!("非 main WebView 不得触发媒体解析")
        });
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        fs::remove_file(path).expect("应清理媒体 fixture");
    }
}
