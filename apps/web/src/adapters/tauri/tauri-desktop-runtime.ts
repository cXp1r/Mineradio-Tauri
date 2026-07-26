import type { DesktopRuntimePort } from "../../ports/desktop-runtime-port";
import {
	closeDesktopLyricsWindow,
	closeWindow,
	configureGlobalHotkeys,
	getWindowState,
	listenGlobalHotkey,
	listenWindowState,
	minimizeWindow,
	openExternalUrl,
	openProviderLoginWindow,
	showDesktopLyricsWindow,
	toggleWindowFullscreen,
	toggleWindowMaximize,
	updateDesktopLyricsPayload,
} from "../../tauri/runtime";

export interface TauriDesktopRuntimeDependencies {
	getWindowState: typeof getWindowState;
	listenWindowState: typeof listenWindowState;
	minimizeWindow: typeof minimizeWindow;
	toggleWindowMaximize: typeof toggleWindowMaximize;
	toggleWindowFullscreen: typeof toggleWindowFullscreen;
	closeWindow: typeof closeWindow;
	openExternalUrl: typeof openExternalUrl;
	showDesktopLyricsWindow: typeof showDesktopLyricsWindow;
	closeDesktopLyricsWindow: typeof closeDesktopLyricsWindow;
	updateDesktopLyricsPayload: typeof updateDesktopLyricsPayload;
	configureGlobalHotkeys: typeof configureGlobalHotkeys;
	listenGlobalHotkey: typeof listenGlobalHotkey;
	openProviderLoginWindow: typeof openProviderLoginWindow;
}

const defaultDependencies: TauriDesktopRuntimeDependencies = {
	getWindowState,
	listenWindowState,
	minimizeWindow,
	toggleWindowMaximize,
	toggleWindowFullscreen,
	closeWindow,
	openExternalUrl,
	showDesktopLyricsWindow,
	closeDesktopLyricsWindow,
	updateDesktopLyricsPayload,
	configureGlobalHotkeys,
	listenGlobalHotkey,
	openProviderLoginWindow,
};

export function createTauriDesktopRuntime(
	dependencies: TauriDesktopRuntimeDependencies = defaultDependencies,
): DesktopRuntimePort {
	return {
		getWindowState: () => dependencies.getWindowState(),
		listenWindowState: (handler) => dependencies.listenWindowState(handler),
		minimizeWindow: () => dependencies.minimizeWindow(),
		toggleWindowMaximize: () => dependencies.toggleWindowMaximize(),
		toggleWindowFullscreen: () => dependencies.toggleWindowFullscreen(),
		closeWindow: () => dependencies.closeWindow(),
		openExternalUrl: (url) => dependencies.openExternalUrl(url),
		showDesktopLyricsWindow: () => dependencies.showDesktopLyricsWindow(),
		closeDesktopLyricsWindow: () => dependencies.closeDesktopLyricsWindow(),
		updateDesktopLyricsPayload: (payload) => dependencies.updateDesktopLyricsPayload(payload),
		configureGlobalHotkeys: (bindings) => dependencies.configureGlobalHotkeys(bindings),
		listenGlobalHotkey: (handler) => dependencies.listenGlobalHotkey(handler),
		openProviderLoginWindow: (provider) => dependencies.openProviderLoginWindow(provider),
	};
}
