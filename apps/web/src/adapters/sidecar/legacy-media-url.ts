import type { SidecarClient } from "../../api/sidecar-client";
import type { MediaUrlPort } from "../../ports/media-url-port";

export function createLegacyMediaUrl(
	client: Pick<SidecarClient, "audioProxyUrl" | "proxiedUrl" | "imageProxyUrl">,
): MediaUrlPort {
	return {
		audioProxyUrl: (url) => client.audioProxyUrl(url),
		playableUrl: (url) => client.proxiedUrl(url),
		imageUrl: (url, options) => client.imageProxyUrl(
			url,
			options?.cacheBust ?? false,
			options?.now ?? Date.now(),
		),
	};
}
