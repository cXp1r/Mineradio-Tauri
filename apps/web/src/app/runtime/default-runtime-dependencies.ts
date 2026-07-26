import { SidecarClient } from "../../api/sidecar-client";
import { createTauriDesktopRuntime } from "../../adapters/tauri/tauri-desktop-runtime";
import type { SidecarRecoveryRuntimeProps } from "./SidecarRecoveryRuntime";

export const defaultDesktopRuntime = createTauriDesktopRuntime();

export const createDefaultSidecarClient: SidecarRecoveryRuntimeProps["createSidecarClient"] =
  (config) => new SidecarClient(config.sidecarBaseUrl);
