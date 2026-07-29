import type {
	WallpaperFullDesktopMode,
	WallpaperProjectSummary,
	WallpaperRuntimeState,
} from "../../ports/wallpaper-engine-runtime-port";
import { wallpaperEngineMediaUrl } from "./wallpaper-engine-media-url";

export type WallpaperPresentation =
	| { kind: "none" }
	| { kind: "image" | "video"; url: string; staticFallback: boolean }
	| { kind: "scene"; staticFallback: false };

/**
 * passive 桌面只能展示已注册的静态预览，绝不把 native Scene 继续视为可运行。
 * 用户选择仍留在 controller；回到 top-level/interactive 后须由用户显式启动新 session。
 */
export function resolveWallpaperPresentation(
	project: WallpaperProjectSummary | null,
	runtime: WallpaperRuntimeState | null,
	fullDesktopMode: WallpaperFullDesktopMode,
): WallpaperPresentation {
	if (!project) return { kind: "none" };
	const previewUrl = wallpaperEngineMediaUrl(project.previewUrl);
	const mediaUrl = wallpaperEngineMediaUrl(project.mediaUrl);
	if (fullDesktopMode === "passive") {
		const fallbackUrl = previewUrl ?? mediaUrl;
		if (!fallbackUrl) return { kind: "none" };
		const fallbackType = previewUrl ? project.previewMediaType : project.mediaType;
		return { kind: fallbackType === "video" ? "video" : "image", url: fallbackUrl, staticFallback: true };
	}
	if (
		project.safetyMode === "nativeEngine"
		&& runtime?.active
		&& runtime.projectId === project.id
		&& runtime.captureMode === "dwmThumbnail"
		&& runtime.sourceWindowAligned
		&& runtime.dwmSurfaceReady
	) {
		return { kind: "scene", staticFallback: false };
	}
	if (project.safetyMode === "directMedia" && mediaUrl) {
		return { kind: project.mediaType === "video" ? "video" : "image", url: mediaUrl, staticFallback: false };
	}
	if (!previewUrl) return { kind: "none" };
	return { kind: project.previewMediaType === "video" ? "video" : "image", url: previewUrl, staticFallback: false };
}
