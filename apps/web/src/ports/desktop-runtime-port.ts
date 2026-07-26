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
	openProviderLoginWindow(
		provider: DesktopProviderLoginId,
	): Promise<DesktopProviderLoginWindowResult>;
}
