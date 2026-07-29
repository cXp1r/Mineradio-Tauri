import type { FullDesktopRuntimePort } from "../../ports/full-desktop-runtime-port";
import {
	getFullDesktopRuntimeState,
	recoverFullDesktopRuntime,
	setDesktopIconsVisible,
	setFullDesktopInteractionLocked,
	setFullDesktopMode,
} from "../../tauri/runtime";

export interface TauriFullDesktopRuntimeDependencies {
	getFullDesktopRuntimeState: typeof getFullDesktopRuntimeState;
	setFullDesktopMode: typeof setFullDesktopMode;
	setDesktopIconsVisible: typeof setDesktopIconsVisible;
	setFullDesktopInteractionLocked: typeof setFullDesktopInteractionLocked;
	recoverFullDesktopRuntime: typeof recoverFullDesktopRuntime;
}

const defaultDependencies: TauriFullDesktopRuntimeDependencies = {
	getFullDesktopRuntimeState,
	setFullDesktopMode,
	setDesktopIconsVisible,
	setFullDesktopInteractionLocked,
	recoverFullDesktopRuntime,
};

export function createTauriFullDesktopRuntime(
	dependencies: TauriFullDesktopRuntimeDependencies = defaultDependencies,
): FullDesktopRuntimePort {
	return {
		getRuntimeState: () => dependencies.getFullDesktopRuntimeState(),
		setMode: (mode) => dependencies.setFullDesktopMode(mode),
		setIconsVisible: (visible) => dependencies.setDesktopIconsVisible(visible),
		setInteractionLocked: (locked) => dependencies.setFullDesktopInteractionLocked(locked),
		recover: () => dependencies.recoverFullDesktopRuntime(),
	};
}
