import type {
	PlaybackQualityRequest,
	SongUrlResult,
	Track,
	TrackQualityAvailability,
} from "@mineradio/shared";

export interface PlaybackPort {
	songUrl(track: Track, quality?: PlaybackQualityRequest): Promise<SongUrlResult>;
	resolveSongUrl(track: Track, quality?: PlaybackQualityRequest): Promise<SongUrlResult>;
	trackQualities(track: Track): Promise<TrackQualityAvailability>;
}
