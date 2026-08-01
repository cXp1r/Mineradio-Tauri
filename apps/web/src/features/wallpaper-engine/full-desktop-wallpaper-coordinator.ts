import type { FullDesktopMode } from "../../ports/full-desktop-runtime-port";

/**
 * 被动桌面会失去 native Scene 的安全 z-order；只有静态 fallback 和 exact stop 都成功后
 * 才允许把意图交给 Full Desktop Runtime。
 */
export async function setFullDesktopModeWithWallpaperFallback(
	mode: FullDesktopMode,
	preparePassiveFallback: () => Promise<void>,
	setFullDesktopMode: (mode: FullDesktopMode) => Promise<void>,
): Promise<void> {
	if (mode === "passive") await preparePassiveFallback();
	await setFullDesktopMode(mode);
}
