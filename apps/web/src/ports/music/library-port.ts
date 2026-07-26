import type {
	PlaylistAddSongAck,
	PlaylistDetail,
	PlaylistSummary,
	ProviderId,
	SharedPlaylistImportRequest,
	SharedPlaylistImportResult,
} from "@mineradio/shared";

export interface LibraryPort {
	playlistList(provider: ProviderId): Promise<PlaylistSummary[]>;
	playlistDetail(provider: ProviderId, id: string): Promise<PlaylistDetail>;
	importSharedPlaylist(input: SharedPlaylistImportRequest): Promise<SharedPlaylistImportResult>;
	addSongToPlaylist(
		provider: ProviderId,
		playlistId: string,
		trackId: string,
	): Promise<PlaylistAddSongAck>;
}
