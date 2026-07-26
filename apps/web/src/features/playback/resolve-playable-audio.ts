import type {
	PlaybackQualityRequest,
	SongUrlResult,
	Track,
} from "@mineradio/shared";
import type { MediaUrlPort } from "../../ports/media-url-port";
import type { PlaybackPort } from "../../ports/music/playback-port";

export interface ResolvedPlayableAudio {
	result: SongUrlResult;
	audioUrl: string;
}

export async function resolvePlayableAudio(input: {
	playback: PlaybackPort;
	mediaUrl: MediaUrlPort;
	track: Track;
	quality?: PlaybackQualityRequest;
}): Promise<ResolvedPlayableAudio> {
	const result = await input.playback.resolveSongUrl(input.track, input.quality);
	if (!result.url) throw new Error(result.message || "播放地址不可用");
	return {
		result,
		audioUrl: result.proxied
			? input.mediaUrl.playableUrl(result.url)
			: input.mediaUrl.audioProxyUrl(result.url),
	};
}
