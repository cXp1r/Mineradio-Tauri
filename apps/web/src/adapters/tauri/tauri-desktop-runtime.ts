import type { DesktopRuntimePort } from "../../ports/desktop-runtime-port";
import {
	chooseCacheDirectory,
	clearCacheCategory,
	closeDesktopLyricsWindow,
	closeWindow,
	configureGlobalHotkeys,
	exitApplication,
	getCacheSnapshot,
	getDesktopDiagnostics,
	getResourceGovernance,
	getWindowRuntimeState,
	getWindowState,
	listenGlobalHotkey,
	listenDesktopLyricsLockChanged,
	listenWindowState,
	minimizeWindow,
	openExternalUrl,
	openProviderLoginWindow,
	purgeSystemMemory,
	setCacheRoot,
	setCloseBehavior,
	showDesktopLyricsWindow,
	showWindow,
	toggleWindowFullscreen,
	toggleWindowMaximize,
	trimApplicationWorkingSet,
	updateDesktopLyricsPayload,
} from "../../tauri/runtime";

export interface TauriDesktopRuntimeDependencies {
	getWindowState: typeof getWindowState;
	listenWindowState: typeof listenWindowState;
	minimizeWindow: typeof minimizeWindow;
	toggleWindowMaximize: typeof toggleWindowMaximize;
	toggleWindowFullscreen: typeof toggleWindowFullscreen;
	closeWindow: typeof closeWindow;
	getWindowRuntimeState: typeof getWindowRuntimeState;
	setCloseBehavior: typeof setCloseBehavior;
	showWindow: typeof showWindow;
	exitApplication: typeof exitApplication;
	getCacheSnapshot: typeof getCacheSnapshot;
	chooseCacheDirectory: typeof chooseCacheDirectory;
	setCacheRoot: typeof setCacheRoot;
	clearCacheCategory: typeof clearCacheCategory;
	getDesktopDiagnostics: typeof getDesktopDiagnostics;
	getResourceGovernance: typeof getResourceGovernance;
	trimApplicationWorkingSet: typeof trimApplicationWorkingSet;
	purgeSystemMemory: typeof purgeSystemMemory;
	openExternalUrl: typeof openExternalUrl;
	showDesktopLyricsWindow: typeof showDesktopLyricsWindow;
	closeDesktopLyricsWindow: typeof closeDesktopLyricsWindow;
	updateDesktopLyricsPayload: typeof updateDesktopLyricsPayload;
	configureGlobalHotkeys: typeof configureGlobalHotkeys;
	listenGlobalHotkey: typeof listenGlobalHotkey;
	listenDesktopLyricsLockChanged: typeof listenDesktopLyricsLockChanged;
	openProviderLoginWindow: typeof openProviderLoginWindow;
}

const defaultDependencies: TauriDesktopRuntimeDependencies = {
	getWindowState,
	listenWindowState,
	minimizeWindow,
	toggleWindowMaximize,
	toggleWindowFullscreen,
	closeWindow,
	getWindowRuntimeState,
	setCloseBehavior,
	showWindow,
	exitApplication,
	getCacheSnapshot,
	chooseCacheDirectory,
	setCacheRoot,
	clearCacheCategory,
	getDesktopDiagnostics,
	getResourceGovernance,
	trimApplicationWorkingSet,
	purgeSystemMemory,
	openExternalUrl,
	showDesktopLyricsWindow,
	closeDesktopLyricsWindow,
	updateDesktopLyricsPayload,
	configureGlobalHotkeys,
	listenGlobalHotkey,
	listenDesktopLyricsLockChanged,
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
		getWindowRuntimeState: () => dependencies.getWindowRuntimeState(),
		setCloseBehavior: (behavior) => dependencies.setCloseBehavior(behavior),
		showWindow: () => dependencies.showWindow(),
		exitApplication: () => dependencies.exitApplication(),
		getCacheSnapshot: () => dependencies.getCacheSnapshot(),
		chooseCacheDirectory: () => dependencies.chooseCacheDirectory(),
		setCacheRoot: (path) => dependencies.setCacheRoot(path),
		clearCacheCategory: (category) => dependencies.clearCacheCategory(category),
		getDesktopDiagnostics: () => dependencies.getDesktopDiagnostics(),
		getResourceGovernance: () => dependencies.getResourceGovernance(),
		trimApplicationWorkingSet: (force) => dependencies.trimApplicationWorkingSet(force),
		purgeSystemMemory: () => dependencies.purgeSystemMemory(),
		openExternalUrl: (url) => dependencies.openExternalUrl(url),
		showDesktopLyricsWindow: () => dependencies.showDesktopLyricsWindow(),
		closeDesktopLyricsWindow: () => dependencies.closeDesktopLyricsWindow(),
		updateDesktopLyricsPayload: (payload) => dependencies.updateDesktopLyricsPayload(payload),
		configureGlobalHotkeys: (bindings) => dependencies.configureGlobalHotkeys(bindings),
		listenGlobalHotkey: (handler) => dependencies.listenGlobalHotkey(handler),
		listenDesktopLyricsLockChanged: (handler) => dependencies.listenDesktopLyricsLockChanged(handler),
		openProviderLoginWindow: (provider) => dependencies.openProviderLoginWindow(provider),
	};
}
