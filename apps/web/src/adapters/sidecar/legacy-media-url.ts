import type { SidecarClient } from "../../api/sidecar-client";
import type {
	MediaImageSource,
	MediaUrlOptions,
	MediaUrlPort,
} from "../../ports/media-url-port";

export function createLegacyMediaUrl(
	client: Pick<SidecarClient, "audioProxyUrl" | "imageProxyUrl"> &
		Partial<Pick<SidecarClient, "proxiedUrl">>,
): MediaUrlPort {
	const imageSource = (
		url: string,
		options?: MediaUrlOptions,
	): MediaImageSource => {
		const uri = client.imageProxyUrl(
			url,
			options?.cacheBust ?? false,
			options?.now ?? Date.now(),
		);
		const fallbackUri = uri && uri !== url && /^https?:\/\//i.test(url)
			? url
			: undefined;
		return {
			uri,
			...(fallbackUri ? { fallbackUri } : {}),
		};
	};
	return {
		audioProxyUrl: (url) => client.audioProxyUrl(url),
		playableUrl: (url) => typeof client.proxiedUrl === "function"
			? client.proxiedUrl(url)
			: url,
		imageSource,
		imageUrl: (url, options) => imageSource(url, options).uri,
	};
}
