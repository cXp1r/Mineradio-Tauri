import type {
	ProviderId,
	SongLikeAck,
	SongLikeCheckAck,
} from "@mineradio/shared";

export interface LikesPort {
	likeSong(provider: ProviderId, id: string, liked: boolean): Promise<SongLikeAck>;
	checkSongLikes(provider: ProviderId, ids: string[]): Promise<SongLikeCheckAck>;
}
