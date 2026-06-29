import {
	ProviderIdSchema,
	TrackSchema,
	type PlaylistDetail,
	type PodcastMyItemsResponse,
	type PodcastProgram,
	type PodcastProgramsResponse,
	type PodcastRadio,
	type ProviderId,
	type Track,
} from "@mineradio/shared";
import type {
	ShelfContentKind,
	ShelfContentList,
	ShelfContentRow,
	ShelfOpenDetailContentPayload,
} from "@mineradio/visual-engine";
import { usePlaybackStore } from "../stores/playback-store";
import { isPlayable, playSearchResult } from "../components/search/play-search-result";
import type { ShelfDetailRowClickPayload } from "./shelf-pointer-interactions";

export interface ShelfDetailMutationClient {
	likeSong?(provider: ProviderId, id: string, liked: boolean): Promise<unknown>;
	addSongToPlaylist?(provider: ProviderId, playlistId: string, trackId: string): Promise<unknown>;
}

export interface ShelfDetailRowActionPayload extends ShelfDetailRowClickPayload {
	client?: ShelfDetailMutationClient | null;
	isLiked?: (track: Track) => boolean;
	onResult?: (message: string, tone?: "good" | "fail") => void;
	onOpenCollect?: (track: Track) => void;
	onOpenPodcastRadio?: (radioId: string, title: string) => void;
}

export interface PlaylistDetailClient {
	playlistDetail(provider: ProviderId, id: string): Promise<PlaylistDetail>;
	podcastMyItems?(key: string, limit?: number, offset?: number): Promise<PodcastMyItemsResponse>;
	podcastPrograms?(id: string, limit?: number, offset?: number): Promise<PodcastProgramsResponse>;
}

export interface ShelfDetailContentListWriter {
	setRowsForToken(token: number, rows: ShelfContentRow[], kind?: ShelfContentKind): void;
	setErrorForToken(token: number, label: string): void;
}

export type ShelfDetailContentListController = ShelfDetailContentListWriter & Pick<ShelfContentList, "open">;

export interface ShelfDetailContentLoaderOptions {
	client: PlaylistDetailClient | null | undefined;
	getContentList: () => ShelfDetailContentListWriter | ShelfContentList | null | undefined;
}

export type ShelfDetailContentLoader = (payload: ShelfOpenDetailContentPayload) => Promise<void>;

export interface PodcastRadioDetailOpenerOptions {
	getContentList: () => ShelfDetailContentListController | null | undefined;
	load: ShelfDetailContentLoader;
}

export function createPodcastRadioDetailOpener(
	options: PodcastRadioDetailOpenerOptions,
): (radioId: string, title: string) => void {
	return (radioId, title) => {
		const contentList = options.getContentList();
		if (!contentList || !radioId) return;
		const playlistId = `podcast-radio:${radioId}`;
		const requestToken = contentList.open({
			playlistId,
			title,
			kind: "podcast",
			sourceCard: null,
		});
		void options.load({
			playlistId,
			title,
			contentKind: "podcast",
			requestToken,
			sourceCard: null,
		});
	};
}

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

export function mapPodcastItemsToShelfRows(
	detail: PodcastMyItemsResponse | PodcastProgramsResponse,
): ShelfContentRow[] {
	const items = "items" in detail ? detail.items : detail.programs;
	return items.map((item) => {
		if (isPodcastProgram(item)) return mapPodcastProgramToShelfRow(item);
		return mapPodcastRadioToShelfRow(item);
	});
}

function mapPodcastProgramToShelfRow(program: PodcastProgram): ShelfContentRow {
	return {
		id: program.id,
		name: program.title,
		artist: program.artists.length > 0 ? program.artists.join(" / ") : program.album || program.radioName || "Podcast",
		cover: program.coverUrl,
		provider: program.provider,
		type: program.playableState,
		sourceId: program.sourceId,
		title: program.title,
		artists: [...program.artists],
		album: program.album,
		coverUrl: program.coverUrl,
		...(program.durationMs === undefined ? {} : { durationMs: program.durationMs }),
		playableState: program.playableState,
		qualityHints: [...program.qualityHints],
	};
}

function mapPodcastRadioToShelfRow(radio: PodcastRadio): ShelfContentRow {
	const artist = [
		radio.djName || "Podcast",
		radio.programCount ? `${radio.programCount} 集` : "",
	].filter(Boolean).join(" · ");
	return {
		id: radio.id || radio.rid,
		name: radio.name,
		artist,
		cover: radio.coverUrl,
		provider: "netease",
		type: "podcast-radio",
		sourceId: radio.rid || radio.id,
		title: radio.name,
		artists: [radio.djName || "Podcast"],
		album: "Podcast",
		coverUrl: radio.coverUrl,
		playableState: "unavailable",
		qualityHints: [],
	};
}

function isPodcastProgram(item: PodcastRadio | PodcastProgram): item is PodcastProgram {
	return "type" in item && item.type === "podcast";
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

export async function handleShelfDetailRowAction(payload: ShelfDetailRowActionPayload): Promise<boolean> {
	const action = payload.action ?? "row";
	if (payload.row.type === "podcast-radio") {
		const radioId = payload.row.sourceId || payload.row.id || "";
		if (!radioId || !payload.onOpenPodcastRadio) return false;
		payload.onOpenPodcastRadio(radioId, payload.row.title || payload.row.name);
		return true;
	}

	const track = mapShelfDetailRowToTrack(payload.row);
	if (!track) return false;

	if (action === "collect") {
		if (!payload.onOpenCollect) return false;
		payload.onOpenCollect(track);
		return true;
	}

	if (!isPlayable(track.playableState)) return false;

	if (action === "like") {
		if (track.provider !== "netease" || !payload.client?.likeSong) {
			payload.onResult?.("当前来源暂不支持红心同步", "fail");
			return false;
		}
		const liked = !(payload.isLiked?.(track) ?? false);
		try {
			await payload.client.likeSong(track.provider, track.id, liked);
			payload.onResult?.(liked ? "已加入红心喜欢" : "已取消红心", "good");
			return true;
		} catch {
			payload.onResult?.("红心操作失败", "fail");
			return false;
		}
	}

	if (action === "next") {
		usePlaybackStore.getState().insertNext(track);
		return true;
	}

	playSearchResult(track);
	return true;
}

export function createShelfDetailContentLoader(
	options: ShelfDetailContentLoaderOptions,
): ShelfDetailContentLoader {
	return async (payload) => {
		const list = options.getContentList();
		if (!list) return;
		if (payload.contentKind === "podcast" || payload.playlistId.startsWith("podcast:") || payload.playlistId.startsWith("podcast-radio:")) {
			if (!options.client) {
				list.setErrorForToken(payload.requestToken, "播客信息不完整");
				return;
			}
			try {
				if (payload.playlistId.startsWith("podcast-radio:")) {
					const id = payload.playlistId.slice("podcast-radio:".length);
					if (!id || !options.client.podcastPrograms) {
						list.setErrorForToken(payload.requestToken, "播客信息不完整");
						return;
					}
					const detail = await options.client.podcastPrograms(id, 36, 0);
					list.setRowsForToken(payload.requestToken, mapPodcastItemsToShelfRows(detail), "podcast");
					return;
				}
				const key = payload.playlistId.replace(/^podcast:/, "");
				if (!key || !options.client.podcastMyItems) {
					list.setErrorForToken(payload.requestToken, "播客信息不完整");
					return;
				}
				const detail = await options.client.podcastMyItems(key, 36, 0);
				list.setRowsForToken(payload.requestToken, mapPodcastItemsToShelfRows(detail), "podcast");
			} catch {
				list.setErrorForToken(payload.requestToken, "播客加载失败");
			}
			return;
		}
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
