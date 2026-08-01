import { createLegacyApplicationRuntime } from "../../adapters/sidecar/legacy-application-runtime";
import { createTauriDesktopRuntime } from "../../adapters/tauri/tauri-desktop-runtime";
import { createTauriFullDesktopRuntime } from "../../adapters/tauri/tauri-full-desktop-runtime";
import { createTauriWallpaperEngineRuntime } from "../../adapters/tauri/tauri-wallpaper-engine-runtime";

export const defaultDesktopRuntime = createTauriDesktopRuntime();
export const defaultFullDesktopRuntime = createTauriFullDesktopRuntime();
export const defaultWallpaperEngineRuntime = createTauriWallpaperEngineRuntime();
export const defaultApplicationRuntime = createLegacyApplicationRuntime();
