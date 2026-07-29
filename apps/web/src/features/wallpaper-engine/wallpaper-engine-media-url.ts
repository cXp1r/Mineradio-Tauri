/**
 * M7 自定义协议仅按已注册 project ID/role 返回媒体。WebView2 会把该协议暴露为
 * `http://mineradio-wallpaper.localhost/...` origin；这是 WebView protocol mapping，
 * 不是 TCP localhost 服务，不能回退到 Sidecar URL。
 */
export function wallpaperEngineMediaUrl(value: string | undefined): string | undefined {
	if (!value) return undefined;
	try {
		const url = new URL(value);
		if (url.protocol === "mineradio-wallpaper:") return value;
		if (url.protocol === "http:" && url.hostname === "mineradio-wallpaper.localhost") return value;
	} catch {
		return undefined;
	}
	return undefined;
}
