import { expect, test } from "bun:test";
import { createTauriWallpaperEngineRuntime } from "./tauri-wallpaper-engine-runtime";

test("Tauri wallpaper adapter preserves the narrow library and scene calls", async () => {
	const calls: string[] = [];
	const runtime = createTauriWallpaperEngineRuntime({
		listWallpaperEngineProjects: async (request) => {
			calls.push(`list:${request?.forceRefresh === true}`);
			return { projects: [], roots: [], updatedAt: 1 };
		},
		getWallpaperEngineProjectDetails: async (id) => ({
			id, title: "scene", projectType: "scene", playable: true, enginePlayable: true,
			previewOnly: false, safetyMode: "nativeEngine", source: "local", sourceLabel: "local",
			hasPreview: false, previewAnimated: false, updatedAt: 1,
		}),
		chooseWallpaperEngineDirectory: async () => ({ ok: true, canceled: true }),
		chooseWallpaperEngineProjectFile: async () => ({ ok: true, canceled: true }),
		removeWallpaperEngineDirectory: async (rootId) => ({ projects: [], roots: [], updatedAt: Number(rootId) }),
		getWallpaperEngineRuntimeStatus: async () => ({
			available: true, phase: "idle", pending: false, active: false, projectId: "", sessionId: "",
			sourceId: "", captureMode: "none", sourceWindowAligned: false, dwmSurfaceReady: false,
			glassSamplerReady: false, audioMuted: false, cleanupRequired: false, fullDesktopMode: "disabled",
		}),
		startWallpaperEngineScene: async ({ projectId }) => ({
			available: true, phase: "active", pending: false, active: true, projectId, sessionId: "s",
			sourceId: "s", captureMode: "dwmThumbnail", sourceWindowAligned: true, dwmSurfaceReady: true,
			glassSamplerReady: false, audioMuted: true, cleanupRequired: false, fullDesktopMode: "disabled",
		}),
		stopWallpaperEngineScene: async () => ({
			available: true, phase: "idle", pending: false, active: false, projectId: "", sessionId: "",
			sourceId: "", captureMode: "none", sourceWindowAligned: false, dwmSurfaceReady: false,
			glassSamplerReady: false, audioMuted: false, cleanupRequired: false, fullDesktopMode: "disabled",
		}),
		recoverWallpaperEngineRuntime: async () => ({
			available: true, phase: "idle", pending: false, active: false, projectId: "", sessionId: "",
			sourceId: "", captureMode: "none", sourceWindowAligned: false, dwmSurfaceReady: false,
			glassSamplerReady: false, audioMuted: false, cleanupRequired: false, fullDesktopMode: "disabled",
		}),
	});

	await runtime.listProjects({ forceRefresh: true });
	const started = await runtime.startScene({ projectId: "a" });
	expect(calls).toEqual(["list:true"]);
	expect(started.projectId).toBe("a");
});
