export interface DesktopWindowDisplayBounds {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface DesktopWindowState {
	isMaximized: boolean;
	isNativeFullScreen: boolean;
	isHtmlFullScreen: boolean;
	isWindowFullScreen: boolean;
	isFullScreen: boolean;
	isMinimized: boolean;
	isVisible: boolean;
	isFocused: boolean;
	isPrimaryDisplay: boolean;
	hasDisplayOnLeft: boolean;
	hasDisplayOnRight: boolean;
	displayBounds: DesktopWindowDisplayBounds | null;
}

export type DesktopCloseBehavior = "exit" | "tray";
export type DesktopLifecyclePhase = "running" | "hiddenToTray" | "exiting" | "cleaned";
export type DesktopTrayRuntimePhase = "unavailable" | "ready" | "failed";

export interface DesktopWindowRuntimeState {
	lifecycle: {
		closeBehavior: DesktopCloseBehavior;
		phase: DesktopLifecyclePhase;
		cleanupClaimed: boolean;
	};
	trayPhase: DesktopTrayRuntimePhase;
	debounceGeneration: number;
	debounceWorkerRunning: boolean;
}

export type DesktopCacheCategory = "audio" | "images" | "lyrics" | "beatmaps" | "temp";

export interface DesktopCacheCategoryUsage {
	category: DesktopCacheCategory;
	path: string;
	totalBytes: number;
	fileCount: number;
	directoryCount: number;
	errorCount: number;
	skippedLinkCount: number;
	truncated: boolean;
}

export interface DesktopCacheSnapshot {
	configuredRoot: string;
	activeRoot: string;
	fallbackUsed: boolean;
	fallbackReason: string | null;
	restartRequired: boolean;
	categories: DesktopCacheCategoryUsage[];
	totalBytes: number;
	fileCount: number;
	directoryCount: number;
	errorCount: number;
	skippedLinkCount: number;
	truncated: boolean;
}

export interface DesktopCacheRootDecision {
	desiredRoot: string | null;
	effectiveRoot: string;
	fallbackUsed: boolean;
	fallbackReason: string | null;
	restartRequired: boolean;
}

export interface DesktopCacheClearResult {
	category: DesktopCacheCategory;
	path: string;
	removedBytes: number;
	removedFiles: number;
	removedDirectories: number;
	removedLinks: number;
}

export interface DesktopDiagnosticsSnapshot {
	schemaVersion: number;
	capturedAtMs: number;
	health: "healthy" | "degraded" | "unavailable";
	probes: Array<{
		kind: string;
		status: "healthy" | "unavailable" | "failed";
		capturedAtMs: number;
		value: DesktopJsonValue | null;
		message: string | null;
		error: DesktopJsonValue | null;
	}>;
	recentErrors: DesktopJsonValue[];
}

export interface DesktopResourceGovernanceSnapshot {
	minBackgroundDelayMs: number;
	trimCooldownMs: number;
	trimInFlight: boolean;
	lastAttemptMs: number | null;
	systemPurgePolicy: "disabled" | "unsupported";
}

export type DesktopUnlisten = () => void;
export type DesktopJsonValue = null
	| boolean
	| number
	| string
	| DesktopJsonValue[]
	| { [key: string]: DesktopJsonValue };

export interface DesktopGlobalHotkeyBinding {
	action: string;
	accelerator: string;
}

export interface DesktopGlobalHotkeyConflict {
	sourceName: string;
	sourceIcon: string;
	reason: string;
}

export interface DesktopGlobalHotkeyRegistrationResult {
	action: string;
	accelerator: string;
	ok: boolean;
	conflict?: DesktopGlobalHotkeyConflict;
}

export interface DesktopConfigureGlobalHotkeysResult {
	ok: boolean;
	results: DesktopGlobalHotkeyRegistrationResult[];
}

export interface DesktopGlobalHotkeyEventPayload {
	action: string;
}

export type DesktopProviderLoginId = "netease" | "qq";

export interface DesktopProviderLoginWindowResult {
	provider: DesktopProviderLoginId;
	stored: boolean;
	reused: boolean;
	partial: boolean;
}

export interface DesktopRuntimePort {
	getWindowState(): Promise<DesktopWindowState>;
	listenWindowState(handler: (state: DesktopWindowState) => void): Promise<DesktopUnlisten>;
	minimizeWindow(): Promise<void>;
	toggleWindowMaximize(): Promise<void>;
	toggleWindowFullscreen(): Promise<void>;
	closeWindow(): Promise<void>;
	getWindowRuntimeState(): Promise<DesktopWindowRuntimeState | null>;
	setCloseBehavior(behavior: DesktopCloseBehavior): Promise<DesktopWindowRuntimeState | null>;
	showWindow(): Promise<void>;
	exitApplication(): Promise<void>;
	getCacheSnapshot(): Promise<DesktopCacheSnapshot | null>;
	chooseCacheDirectory(): Promise<string | null>;
	setCacheRoot(path: string | null): Promise<DesktopCacheRootDecision | null>;
	clearCacheCategory(category: DesktopCacheCategory): Promise<DesktopCacheClearResult | null>;
	getDesktopDiagnostics(): Promise<DesktopDiagnosticsSnapshot | null>;
	getResourceGovernance(): Promise<DesktopResourceGovernanceSnapshot | null>;
	trimApplicationWorkingSet(force?: boolean): Promise<DesktopJsonValue | null>;
	purgeSystemMemory(): Promise<DesktopJsonValue | null>;
	openExternalUrl(url: string): Promise<boolean>;
	showDesktopLyricsWindow(): Promise<void>;
	closeDesktopLyricsWindow(): Promise<void>;
	updateDesktopLyricsPayload(payload: DesktopJsonValue): Promise<void>;
	configureGlobalHotkeys(
		bindings: DesktopGlobalHotkeyBinding[],
	): Promise<DesktopConfigureGlobalHotkeysResult>;
	listenGlobalHotkey(
		handler: (payload: DesktopGlobalHotkeyEventPayload) => void,
	): Promise<DesktopUnlisten>;
	listenDesktopLyricsLockChanged(handler: (clickThrough: boolean) => void): Promise<DesktopUnlisten>;
	openProviderLoginWindow(
		provider: DesktopProviderLoginId,
	): Promise<DesktopProviderLoginWindowResult>;
}
