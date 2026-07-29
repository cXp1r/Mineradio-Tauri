import type {
	WallpaperFullDesktopMode,
	WallpaperProjectSummary,
	WallpaperRuntimeState,
} from "../../ports/wallpaper-engine-runtime-port";
import { resolveWallpaperPresentation } from "./wallpaper-engine-presentation";

export interface WallpaperEngineBackgroundProps {
	project: WallpaperProjectSummary | null;
	runtime: WallpaperRuntimeState | null;
	fullDesktopMode: WallpaperFullDesktopMode;
}

/**
 * Wallpaper Engine 的实际应用背景层。控制面只负责选择与状态展示，媒体不在控制面内承担呈现职责。
 * native Scene 由窗口下方的 DWM surface 提供；此处只留下透明 marker 以启用对应视觉策略。
 */
export function WallpaperEngineBackground({
	project,
	runtime,
	fullDesktopMode,
}: WallpaperEngineBackgroundProps) {
	const presentation = resolveWallpaperPresentation(project, runtime, fullDesktopMode);
	if (presentation.kind === "none") return null;

	if (presentation.kind === "scene") {
		return <div
			className="wallpaper-engine-background wallpaper-engine-background-scene"
			data-wallpaper-engine-background="scene"
			aria-hidden="true"
		/>;
	}

	const className = "wallpaper-engine-background-media";
	return <div
		className="wallpaper-engine-background"
		data-wallpaper-engine-background={presentation.kind}
		data-wallpaper-engine-static-fallback={presentation.staticFallback ? "true" : "false"}
		aria-hidden="true"
	>
		{presentation.kind === "image" ? <img
			className={className}
			src={presentation.url}
			alt=""
			decoding="async"
		/> : <video
			className={className}
			src={presentation.url}
			muted
			loop={!presentation.staticFallback}
			autoPlay={!presentation.staticFallback}
			playsInline
			preload={presentation.staticFallback ? "metadata" : "auto"}
		/>}
	</div>;
}
