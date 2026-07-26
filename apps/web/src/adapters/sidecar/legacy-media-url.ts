import type { SidecarClient } from "../../api/sidecar-client";
import type { MediaUrlPort } from "../../ports/media-url-port";

export function createLegacyMediaUrl(
	client: Pick<SidecarClient, "audioProxyUrl" | "imageProxyUrl"> &
		Partial<Pick<SidecarClient, "proxiedUrl">>,
): MediaUrlPort {
	return {
		audioProxyUrl: (url) => client.audioProxyUrl(url),
		playableUrl: (url) => typeof client.proxiedUrl === "function"
			? client.proxiedUrl(url)
			: url,
		imageUrl: (url, options) => client.imageProxyUrl(
			url,
			options?.cacheBust ?? false,
			options?.now ?? Date.now(),
		),
	};
}
