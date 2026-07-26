import type { LyricPayload, Track } from "@mineradio/shared";

export interface LyricsPort {
	lyric(track: Track): Promise<LyricPayload>;
}
