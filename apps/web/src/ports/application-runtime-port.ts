import type { ApiRuntimePort } from "./api-runtime-port";
import type { DesktopRuntimePort } from "./desktop-runtime-port";
import type { MediaUrlPort } from "./media-url-port";
import type { MusicServices } from "./music/music-services";

export interface ApplicationPorts {
	music: MusicServices;
	apiRuntime: ApiRuntimePort;
	mediaUrl: MediaUrlPort;
	desktop: DesktopRuntimePort;
}

export interface ApplicationRuntimePort {
	connect(): Promise<ApplicationPorts | null>;
}
