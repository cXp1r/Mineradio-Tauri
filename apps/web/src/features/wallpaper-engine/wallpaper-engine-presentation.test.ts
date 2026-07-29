import { expect, test } from "bun:test";
import type { WallpaperProjectSummary, WallpaperRuntimeState } from "../../ports/wallpaper-engine-runtime-port";
import { resolveWallpaperPresentation } from "./wallpaper-engine-presentation";

const project: WallpaperProjectSummary = {
	id: "a", title: "scene", projectType: "scene", playable: true, enginePlayable: true,
	previewOnly: false, safetyMode: "nativeEngine", source: "local", sourceLabel: "local",
	hasPreview: true, previewAnimated: true, previewMediaType: "video", updatedAt: 1, mediaType: "video", previewUrl: "mineradio-wallpaper://a/preview",
};
const active: WallpaperRuntimeState = {
	available: true, phase: "active", pending: false, active: true, projectId: "a", sessionId: "s",
	sourceId: "s", captureMode: "dwmThumbnail", sourceWindowAligned: true, dwmSurfaceReady: true,
	glassSamplerReady: false, audioMuted: true, cleanupRequired: false, fullDesktopMode: "disabled",
};

test("passive desktop uses a static preview instead of retaining a native Scene", () => {
	expect(resolveWallpaperPresentation(project, active, "passive")).toEqual({
		kind: "video", url: "mineradio-wallpaper://a/preview", staticFallback: true,
	});
});

test("direct media is preferred over its preview outside passive desktop", () => {
	const direct = {
		...project,
		safetyMode: "directMedia" as const,
		enginePlayable: false,
		mediaUrl: "mineradio-wallpaper://a/media",
		previewUrl: "mineradio-wallpaper://a/preview",
		previewMediaType: "image" as const,
	};
	expect(resolveWallpaperPresentation(direct, null, "disabled")).toEqual({
		kind: "video", url: "mineradio-wallpaper://a/media", staticFallback: false,
	});
});

test("native Scene requires an explicitly active matching session outside passive desktop", () => {
	expect(resolveWallpaperPresentation(project, active, "interactive")).toEqual({ kind: "scene", staticFallback: false });
	expect(resolveWallpaperPresentation(project, { ...active, active: false }, "disabled").kind).toBe("video");
});

test("native Scene keeps its registered preview until the DWM surface is ready and aligned", () => {
	expect(resolveWallpaperPresentation(project, { ...active, dwmSurfaceReady: false }, "disabled").kind).toBe("video");
	expect(resolveWallpaperPresentation(project, { ...active, sourceWindowAligned: false }, "disabled").kind).toBe("video");
	expect(resolveWallpaperPresentation(project, { ...active, captureMode: "none" }, "disabled").kind).toBe("video");
});
