import { ProviderIdSchema, TrackSchema, type PlaylistDetail, type ProviderId, type Track } from "@mineradio/shared";
import type {
	ShelfContentKind,
	ShelfContentList,
	ShelfContentRow,
	ShelfOpenDetailContentPayload,
} from "@mineradio/visual-engine";
import { isPlayable, playSearchResult } from "../components/search/play-search-result";
import type { ShelfDetailRowClickPayload } from "./shelf-pointer-interactions";

export interface PlaylistDetailClient {
	playlistDetail(provider: ProviderId, id: string): Promise<PlaylistDetail>;
}

export interface ShelfDetailContentListWriter {
	setRowsForToken(token: number, rows: ShelfContentRow[], kind?: ShelfContentKind): void;
	setErrorForToken(token: number, label: string): void;
}

export interface ShelfDetailContentLoaderOptions {
	client: PlaylistDetailClient | null | undefined;
	getContentList: () => ShelfDetailContentListWriter | ShelfContentList | null | undefined;
}

export type ShelfDetailContentLoader = (payload: ShelfOpenDetailContentPayload) => Promise<void>;

export function mapPlaylistDetailToShelfRows(
	detail: PlaylistDetail,
	fallbackProvider: ProviderId,
): ShelfContentRow[] {
	return detail.tracks.map((track) => ({
		id: track.id,
		name: track.title,
		artist: track.artists.length > 0 ? track.artists.join(" / ") : track.album || track.provider || fallbackProvider,
		cover: track.coverUrl,
		provider: track.provider,
		type: track.playableState,
		sourceId: track.sourceId,
		title: track.title,
		artists: [...track.artists],
		album: track.album,
		coverUrl: track.coverUrl,
		...(track.durationMs === undefined ? {} : { durationMs: track.durationMs }),
		playableState: track.playableState,
		qualityHints: [...track.qualityHints],
	}));
}

export function mapShelfDetailRowToTrack(row: ShelfContentRow): Track | null {
	const parsedProvider = ProviderIdSchema.safeParse(row.provider);
	if (!parsedProvider.success) return null;
	if (!row.id || !row.name) return null;

	const artists = Array.isArray(row.artists)
		? row.artists
		: String(row.artist || "")
			.split("/")
			.map((artist) => artist.trim())
			.filter(Boolean);

	const parsed = TrackSchema.safeParse({
		provider: parsedProvider.data,
		id: row.id,
		sourceId: row.sourceId || row.id,
		title: row.title || row.name,
		artists,
		album: row.album || "",
		coverUrl: row.coverUrl ?? row.cover ?? "",
		durationMs: row.durationMs,
		qualityHints: row.qualityHints ?? [],
		playableState: row.playableState ?? row.type ?? "unknown",
	});
	if (!parsed.success) return null;
	return parsed.data;
}

export function playShelfDetailRow(payload: ShelfDetailRowClickPayload): boolean {
	const track = mapShelfDetailRowToTrack(payload.row);
	if (!track || !isPlayable(track.playableState)) return false;
	playSearchResult(track);
	return true;
}

export function createShelfDetailContentLoader(
	options: ShelfDetailContentLoaderOptions,
): ShelfDetailContentLoader {
	return async (payload) => {
		const list = options.getContentList();
		if (!list) return;
		const parsedProvider = ProviderIdSchema.safeParse(payload.provider);
		if (!options.client || !parsedProvider.success || !payload.playlistId) {
			list.setErrorForToken(payload.requestToken, "歌单信息不完整");
			return;
		}

		try {
			const detail = await options.client.playlistDetail(parsedProvider.data, payload.playlistId);
			const rows = mapPlaylistDetailToShelfRows(detail, parsedProvider.data);
			list.setRowsForToken(payload.requestToken, rows, payload.contentKind);
		} catch {
			list.setErrorForToken(payload.requestToken, "歌单加载失败");
		}
	};
}
