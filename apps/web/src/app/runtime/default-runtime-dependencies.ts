import { SidecarClient } from "../../api/sidecar-client";
import { createTauriDesktopRuntime } from "../../adapters/tauri/tauri-desktop-runtime";
import { createTauriFullDesktopRuntime } from "../../adapters/tauri/tauri-full-desktop-runtime";
import { createTauriWallpaperEngineRuntime } from "../../adapters/tauri/tauri-wallpaper-engine-runtime";
import type { SidecarRecoveryRuntimeProps } from "./SidecarRecoveryRuntime";

export const defaultDesktopRuntime = createTauriDesktopRuntime();
export const defaultFullDesktopRuntime = createTauriFullDesktopRuntime();
export const defaultWallpaperEngineRuntime = createTauriWallpaperEngineRuntime();

export const createDefaultSidecarClient: SidecarRecoveryRuntimeProps["createSidecarClient"] =
  (config) => new SidecarClient(config.sidecarBaseUrl);
