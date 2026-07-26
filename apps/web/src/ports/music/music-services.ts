import type { AccountPort } from "./account-port";
import type { DiscoverPort } from "./discover-port";
import type { LibraryPort } from "./library-port";
import type { LikesPort } from "./likes-port";
import type { LyricsPort } from "./lyrics-port";
import type { PlaybackPort } from "./playback-port";
import type { SearchExperiencePort } from "./search-port";

export interface MusicServices {
	search: SearchExperiencePort;
	playback: PlaybackPort;
	lyrics: LyricsPort;
	accounts: AccountPort;
	library: LibraryPort;
	likes: LikesPort;
	discover: DiscoverPort;
}

export type {
	AccountPort,
	DiscoverPort,
	LibraryPort,
	LikesPort,
	LyricsPort,
	PlaybackPort,
	SearchExperiencePort,
};
