/** Wallpaper Engine 仅属于 desktop/Web 边界；不得进入 shared 或 Sidecar DTO。 */
export type WallpaperSafetyMode = "directMedia" | "nativeEngine" | "previewOnly";
export type WallpaperRuntimePhase =
	| "idle"
	| "starting"
	| "active"
	| "stopping"
	| "cleanupRequired"
	| "unavailable";
export type WallpaperFullDesktopMode = "disabled" | "passive" | "interactive";

export interface WallpaperProjectSummary {
	id: string;
	title: string;
	projectType: string;
	mediaType?: "image" | "video";
	playable: boolean;
	enginePlayable: boolean;
	previewOnly: boolean;
	safetyMode: WallpaperSafetyMode;
	source: "workshop" | "local" | "imported";
	sourceLabel: string;
	workshopId?: string;
	hasPreview: boolean;
	previewAnimated: boolean;
	previewMediaType?: "image" | "video";
	updatedAt: number;
	mediaUrl?: string;
	previewUrl?: string;
}

export interface WallpaperLibrarySnapshot {
	projects: WallpaperProjectSummary[];
	roots: WallpaperLibraryRoot[];
	updatedAt: number;
}

/** 不暴露原始路径；仅返回可持久化、可移除的导入根 identity 与展示信息。 */
export interface WallpaperLibraryRoot {
	id: string;
	label: string;
	source: "imported";
	projectCount: number;
}

export interface WallpaperRuntimeState {
	available: boolean;
	phase: WallpaperRuntimePhase;
	pending: boolean;
	active: boolean;
	projectId: string;
	sessionId: string;
	sourceId: string;
	captureMode: "none" | "dwmThumbnail";
	sourceWindowAligned: boolean;
	dwmSurfaceReady: boolean;
	glassSamplerReady: boolean;
	audioMuted: boolean;
	cleanupRequired: boolean;
	fullDesktopMode: WallpaperFullDesktopMode;
	lastError?: string;
}

export interface WallpaperDialogResult {
	ok: boolean;
	canceled: boolean;
	rootId?: string;
}

export interface WallpaperEngineRuntimePort {
	listProjects(request?: { forceRefresh?: boolean }): Promise<WallpaperLibrarySnapshot>;
	getProjectDetails(id: string): Promise<WallpaperProjectSummary | null>;
	chooseDirectory(): Promise<WallpaperDialogResult>;
	chooseProjectFile(): Promise<WallpaperDialogResult>;
	removeDirectory(rootId: string): Promise<WallpaperLibrarySnapshot>;
	getRuntimeStatus(request?: { refresh?: boolean }): Promise<WallpaperRuntimeState>;
	startScene(request: { projectId: string; fps?: number }): Promise<WallpaperRuntimeState>;
	stopScene(request?: { sessionId?: string }): Promise<WallpaperRuntimeState>;
	recover(): Promise<WallpaperRuntimeState>;
}
