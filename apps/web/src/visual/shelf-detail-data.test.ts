import { expect, test } from "bun:test";
import type { PlaylistDetail, ProviderId } from "@mineradio/shared";
import { usePlaybackStore } from "../stores/playback-store";
import {
	createShelfDetailContentLoader,
	mapPlaylistDetailToShelfRows,
	mapShelfDetailRowToTrack,
	playShelfDetailRow,
} from "./shelf-detail-data";

function makeDetail(): PlaylistDetail {
	return {
		provider: "netease",
		id: "daily",
		name: "Daily Mix",
		coverUrl: "cover.jpg",
		trackIds: [],
		tracks: [
			{
				provider: "netease",
				id: "song-1",
				sourceId: "song-1",
				title: "First Song",
				artists: ["Alice", "Bob"],
				album: "First Album",
				coverUrl: "first.jpg",
				durationMs: 201_000,
				qualityHints: ["lossless"],
				playableState: "playable",
			},
			{
				provider: "netease",
				id: "song-2",
				sourceId: "song-2",
				title: "Second Song",
				artists: [],
				album: "Second Album",
				coverUrl: "",
				qualityHints: [],
				playableState: "vip_required",
			},
		],
	};
}

function resetPlaybackStore(): void {
	usePlaybackStore.setState({
		currentTrack: null,
		isPlaying: false,
		positionMs: 0,
		durationMs: null,
		mode: "queue",
		queue: [],
	});
}

test("mapPlaylistDetailToShelfRows maps shared tracks into visual shelf detail rows and preserves playback metadata", () => {
	expect(mapPlaylistDetailToShelfRows(makeDetail(), "netease")).toEqual([
		{
			id: "song-1",
			name: "First Song",
			artist: "Alice / Bob",
			cover: "first.jpg",
			provider: "netease",
			type: "playable",
			sourceId: "song-1",
			title: "First Song",
			artists: ["Alice", "Bob"],
			album: "First Album",
			coverUrl: "first.jpg",
			durationMs: 201_000,
			playableState: "playable",
			qualityHints: ["lossless"],
		},
		{
			id: "song-2",
			name: "Second Song",
			artist: "Second Album",
			cover: "",
			provider: "netease",
			type: "vip_required",
			sourceId: "song-2",
			title: "Second Song",
			artists: [],
			album: "Second Album",
			coverUrl: "",
			playableState: "vip_required",
			qualityHints: [],
		},
	]);
});

test("mapShelfDetailRowToTrack returns a valid shared track for a loaded playable row", () => {
	const row = mapPlaylistDetailToShelfRows(makeDetail(), "netease")[0]!;
	expect(mapShelfDetailRowToTrack(row)).toEqual({
		provider: "netease",
		id: "song-1",
		sourceId: "song-1",
		title: "First Song",
		artists: ["Alice", "Bob"],
		album: "First Album",
		coverUrl: "first.jpg",
		durationMs: 201_000,
		qualityHints: ["lossless"],
		playableState: "playable",
	});
});

test("mapShelfDetailRowToTrack returns null for invalid provider, id, and title metadata", () => {
	expect(mapShelfDetailRowToTrack({ id: "song-1", name: "Song", provider: "unknown" })).toBeNull();
	expect(mapShelfDetailRowToTrack({ id: "", name: "Song", provider: "netease" })).toBeNull();
	expect(mapShelfDetailRowToTrack({ id: "song-1", name: "", provider: "netease" })).toBeNull();
});

test("playShelfDetailRow enqueues and plays valid rows while ignoring hard non-playable rows", () => {
	resetPlaybackStore();
	const rows = mapPlaylistDetailToShelfRows(makeDetail(), "netease");
	expect(playShelfDetailRow({ row: rows[0]!, index: 0 })).toBe(true);
	expect(usePlaybackStore.getState().queue.length).toBe(1);
	expect(usePlaybackStore.getState().currentTrack?.id).toBe("song-1");

	expect(playShelfDetailRow({ row: rows[1]!, index: 1 })).toBe(false);
	expect(usePlaybackStore.getState().queue.length).toBe(1);
	expect(usePlaybackStore.getState().currentTrack?.id).toBe("song-1");
});

test("createShelfDetailContentLoader fetches playlist detail and writes rows through the request token", async () => {
	const calls: Array<{ provider: ProviderId; id: string }> = [];
	const writes: unknown[] = [];
	const loader = createShelfDetailContentLoader({
		client: {
			async playlistDetail(provider: ProviderId, id: string) {
				calls.push({ provider, id });
				return makeDetail();
			},
		},
		getContentList: () => ({
			setRowsForToken(token: number, rows: unknown[], kind?: string) {
				writes.push({ token, rows, kind });
			},
			setErrorForToken() {
				throw new Error("should not set error on success");
			},
		}),
	});

	await loader({
		provider: "netease",
		playlistId: "daily",
		title: "Daily Mix",
		contentKind: "playlist",
		requestToken: 7,
		sourceCard: null,
	});

	expect(calls).toEqual([{ provider: "netease", id: "daily" }]);
	expect(writes).toEqual([{
		token: 7,
		kind: "playlist",
		rows: mapPlaylistDetailToShelfRows(makeDetail(), "netease"),
	}]);
});

test("createShelfDetailContentLoader writes deterministic token-guarded errors when metadata is missing", async () => {
	const errors: unknown[] = [];
	const loader = createShelfDetailContentLoader({
		client: {
			async playlistDetail() {
				throw new Error("should not fetch without provider and playlist id");
			},
		},
		getContentList: () => ({
			setRowsForToken() {
				throw new Error("should not set rows without metadata");
			},
			setErrorForToken(token: number, label: string) {
				errors.push({ token, label });
			},
		}),
	});

	await loader({
		playlistId: "",
		title: "Missing",
		contentKind: "playlist",
		requestToken: 3,
		sourceCard: null,
	});

	expect(errors).toEqual([{ token: 3, label: "歌单信息不完整" }]);
});

test("createShelfDetailContentLoader rejects unknown provider ids before sidecar fetch", async () => {
	const errors: unknown[] = [];
	const loader = createShelfDetailContentLoader({
		client: {
			async playlistDetail() {
				throw new Error("should not fetch invalid provider ids");
			},
		},
		getContentList: () => ({
			setRowsForToken() {
				throw new Error("should not set rows without a valid provider");
			},
			setErrorForToken(token: number, label: string) {
				errors.push({ token, label });
			},
		}),
	});

	await loader({
		provider: "unknown",
		playlistId: "daily",
		title: "Invalid",
		contentKind: "playlist",
		requestToken: 4,
		sourceCard: null,
	});

	expect(errors).toEqual([{ token: 4, label: "歌单信息不完整" }]);
});

test("createShelfDetailContentLoader writes a safe token-guarded error label on fetch failure", async () => {
	const errors: unknown[] = [];
	const loader = createShelfDetailContentLoader({
		client: {
			async playlistDetail() {
				throw new Error("cookie=secret failed");
			},
		},
		getContentList: () => ({
			setRowsForToken() {
				throw new Error("should not set rows on failure");
			},
			setErrorForToken(token: number, label: string) {
				errors.push({ token, label });
			},
		}),
	});

	await loader({
		provider: "netease",
		playlistId: "daily",
		title: "Daily Mix",
		contentKind: "playlist",
		requestToken: 9,
		sourceCard: null,
	});

	expect(errors).toEqual([{ token: 9, label: "歌单加载失败" }]);
});
