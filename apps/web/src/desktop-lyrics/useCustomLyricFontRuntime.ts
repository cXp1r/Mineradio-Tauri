import { useEffect, useRef } from "react";
import { registerCustomLyricFont } from "./custom-lyric-font";

/**
 * 让当前 WebView 注册已选择的自定义歌词字体。
 * 字体二进制仍只存在同源 storage，不进入 shared DTO 或 Tauri command。
 */
export function useCustomLyricFontRuntime(
	fontKey: unknown,
	onRegistered?: (fontKey: string) => void,
): void {
	const onRegisteredRef = useRef(onRegistered);
	onRegisteredRef.current = onRegistered;
	const normalizedFontKey = String(fontKey || "");

	useEffect(() => {
		if (!normalizedFontKey.startsWith("custom:")) return;
		let disposed = false;
		void registerCustomLyricFont(normalizedFontKey).then((loaded) => {
			if (!disposed && loaded) onRegisteredRef.current?.(normalizedFontKey);
		});
		return () => {
			disposed = true;
		};
	}, [normalizedFontKey]);
}
