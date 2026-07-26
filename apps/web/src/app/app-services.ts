import type { SidecarClient } from "../api/sidecar-client";
import { createLegacyApiRuntime } from "../adapters/sidecar/legacy-api-runtime";
import { createLegacyMediaUrl } from "../adapters/sidecar/legacy-media-url";
import { createLegacySidecarServices } from "../adapters/sidecar/legacy-sidecar-services";
import { createTauriDesktopRuntime } from "../adapters/tauri/tauri-desktop-runtime";
import type { ApiRuntimePort } from "../ports/api-runtime-port";
import type { DesktopRuntimePort } from "../ports/desktop-runtime-port";
import type { MediaUrlPort } from "../ports/media-url-port";
import type { MusicServices } from "../ports/music/music-services";
import type { RuntimeConfig } from "../tauri/runtime";

export interface AppServices {
	music: MusicServices;
	apiRuntime: ApiRuntimePort;
	mediaUrl: MediaUrlPort;
	desktop: DesktopRuntimePort;
}

export type AppServicesFactory = (
	config: RuntimeConfig,
	client: SidecarClient,
) => AppServices;

export function createLegacyAppServices(
	_config: RuntimeConfig,
	client: SidecarClient,
): AppServices {
	return {
		music: createLegacySidecarServices(client),
		apiRuntime: createLegacyApiRuntime(client),
		mediaUrl: createLegacyMediaUrl(client),
		desktop: createTauriDesktopRuntime(),
	};
}
