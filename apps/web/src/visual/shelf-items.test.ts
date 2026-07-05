import { expect, test } from "bun:test";
import type { PlaylistSummary, PodcastCollection, Track } from "@mineradio/shared";
import { mapPlaylistsToShelfItems, mapPodcastCollectionsToShelfItems, mapQueueToShelfItems, resolveShelfItems } from "./shelf-items";

function track(
	id: string,
	title: string,
	artists: string[],
	album = "",
	coverUrl = "",
): Track {
	return {
		provider: "netease",
		id,
		sourceId: id,
		title,
		artists,
		album,
		coverUrl,
		durationMs: 180_000,
		qualityHints: [],
		playableState: "playable",
	};
}

test("mapQueueToShelfItems tags the current track as playing and numbers the rest", () => {
	const queue = [
		track("a", "First", ["Ada", "Lin"], "Album A", "cover-a"),
		track("b", "Second", [], "Album B", "cover-b"),
	];

	const items = mapQueueToShelfItems(queue, queue[1]);

	expect(items).toEqual([
		{
			type: "queue",
			title: "First",
			sub: "Ada / Lin",
			cover: "cover-a",
			tag: "#1",
			queueIndex: 0,
			provider: "netease",
		},
		{
			type: "queue",
			title: "Second",
			sub: "Album B",
			cover: "cover-b",
			tag: "正在播放",
			queueIndex: 1,
			provider: "netease",
		},
	]);
});

test("mapQueueToShelfItems returns no hidden Mineradio host fixture when queue is empty", () => {
	const items = mapQueueToShelfItems([], null);

	expect(items).toEqual([]);
	expect(JSON.stringify(items)).not.toContain("Tauri shelf host fixture");
	expect(JSON.stringify(items)).not.toContain("Mineradio");
});

test("resolveShelfItems prefers merged provider playlists over queue fallback for the 3D shelf", () => {
	const playlists: PlaylistSummary[] = [
		{
			provider: "netease",
			id: "101",
			name: "我喜欢的音乐",
			coverUrl: "cover-like",
			trackCount: 12,
			trackIds: [],
			subscribed: false,
		},
		{
			provider: "qq",
			id: "201",
			name: "QQ 收藏",
			coverUrl: "cover-qq",
			trackCount: 3,
			trackIds: [],
			subscribed: true,
		},
	];
	const queue = [track("a", "Queued", ["Ada"], "Album", "cover-q")];

	const items = resolveShelfItems({
		playlists,
		podcastCollections: [],
		queue,
		currentTrack: queue[0],
		settings: { showPodcasts: true, mergeCollections: true },
	});

	expect(items).toEqual([
		{
			type: "playlist",
			title: "我喜欢的音乐",
			sub: "NE · 12 首",
			cover: "cover-like",
			tag: "我的歌单",
			playlistId: "101",
			provider: "netease",
		},
		{
			type: "playlist",
			title: "QQ 收藏",
			sub: "QQ · 3 首",
			cover: "cover-qq",
			tag: "收藏歌单",
			playlistId: "201",
			provider: "qq",
		},
	]);
});

test("mapPlaylistsToShelfItems uses baseline provider abbreviations and mine/favorite tags", () => {
	const playlists: PlaylistSummary[] = [
		{
			provider: "netease",
			id: "mine",
			name: "网易自建",
			coverUrl: "mine-cover",
			trackCount: 21,
			trackIds: [],
			subscribed: false,
		},
		{
			provider: "qq",
			id: "fav",
			name: "QQ 收藏",
			coverUrl: "fav-cover",
			trackCount: 8,
			trackIds: [],
			subscribed: true,
		},
	];

	expect(mapPlaylistsToShelfItems(playlists).map((item) => ({
		title: item.title,
		sub: item.sub,
		tag: item.tag,
	}))).toEqual([
		{ title: "网易自建", sub: "NE · 21 首", tag: "我的歌单" },
		{ title: "QQ 收藏", sub: "QQ · 8 首", tag: "收藏歌单" },
	]);
});

test("mapPlaylistsToShelfItems uses the Soda provider abbreviation", () => {
	const playlists: PlaylistSummary[] = [
		{
			provider: "soda",
			id: "soda",
			name: "Soda List",
			coverUrl: "soda-cover",
			trackCount: 5,
			trackIds: [],
			subscribed: false,
		},
	];

	expect(mapPlaylistsToShelfItems(playlists)[0]?.sub).toContain("SODA");
});

test("mapPodcastCollectionsToShelfItems mirrors baseline podcast collection cards", () => {
	const collections: PodcastCollection[] = [
		{
			key: "collect",
			title: "收藏播客",
			sub: "你收藏的播客",
			itemType: "radio",
			count: 2,
			coverUrl: "pod-cover",
		},
		{
			key: "liked",
			title: "喜欢的声音",
			sub: "收藏或最近喜欢的声音",
			itemType: "voice",
			count: 5,
			coverUrl: "",
		},
	];

	expect(mapPodcastCollectionsToShelfItems(collections)).toEqual([
		{
			type: "podcastCollection",
			title: "收藏播客",
			sub: "2 items",
			cover: "pod-cover",
			tag: "我的播客",
			podcastKey: "collect",
			itemType: "radio",
		},
		{
			type: "podcastCollection",
			title: "喜欢的声音",
			sub: "5 items",
			cover: "",
			tag: "我的播客",
			podcastKey: "liked",
			itemType: "voice",
		},
	]);
});

test("resolveShelfItems appends podcast collections after provider playlists before queue fallback", () => {
	const playlists: PlaylistSummary[] = [{
		provider: "netease",
		id: "101",
		name: "我喜欢的音乐",
		coverUrl: "cover-like",
		trackCount: 12,
		trackIds: [],
		subscribed: false,
	}];
	const podcastCollections: PodcastCollection[] = [{
		key: "liked",
		title: "喜欢的声音",
		sub: "收藏或最近喜欢的声音",
		itemType: "voice",
		count: 5,
		coverUrl: "voice-cover",
	}];
	const queue = [track("a", "Queued", ["Ada"], "Album", "cover-q")];

	expect(resolveShelfItems({ playlists, podcastCollections, queue, currentTrack: queue[0] })).toEqual([
		{
			type: "playlist",
			title: "我喜欢的音乐",
			sub: "NE · 12 首",
			cover: "cover-like",
			tag: "我的歌单",
			playlistId: "101",
			provider: "netease",
		},
		{
			type: "podcastCollection",
			title: "喜欢的声音",
			sub: "5 items",
			cover: "voice-cover",
			tag: "我的播客",
			podcastKey: "liked",
			itemType: "voice",
		},
	]);
});

test("resolveShelfItems hides podcast collections when the baseline content switch is off", () => {
	const playlists: PlaylistSummary[] = [{
		provider: "netease",
		id: "101",
		name: "我的歌单",
		coverUrl: "cover-like",
		trackCount: 12,
		trackIds: [],
		subscribed: false,
	}];
	const podcastCollections: PodcastCollection[] = [{
		key: "liked",
		title: "喜欢的声音",
		sub: "收藏或最近喜欢的声音",
		itemType: "voice",
		count: 5,
		coverUrl: "voice-cover",
	}];

	expect(resolveShelfItems({
		playlists,
		podcastCollections,
		queue: [],
		currentTrack: null,
		settings: { showPodcasts: false, mergeCollections: false },
	})).toEqual([{
		type: "playlist",
		title: "我的歌单",
		sub: "NE · 12 首",
		cover: "cover-like",
		tag: "我的歌单",
		playlistId: "101",
		provider: "netease",
	}]);
});

test("resolveShelfItems keeps favorite playlists out of the default mine pane until merge is enabled", () => {
	const playlists: PlaylistSummary[] = [
		{
			provider: "netease",
			id: "mine",
			name: "我的歌单",
			coverUrl: "mine-cover",
			trackCount: 12,
			trackIds: [],
			subscribed: false,
		},
		{
			provider: "netease",
			id: "fav",
			name: "收藏歌单",
			coverUrl: "fav-cover",
			trackCount: 7,
			trackIds: [],
			subscribed: true,
		},
	];

	expect(resolveShelfItems({
		playlists,
		podcastCollections: [],
		queue: [],
		currentTrack: null,
		settings: { showPodcasts: true, mergeCollections: false },
	}).map((item) => item.title)).toEqual(["我的歌单"]);

	expect(resolveShelfItems({
		playlists,
		podcastCollections: [],
		queue: [],
		currentTrack: null,
		settings: { showPodcasts: true, mergeCollections: false, pane: "fav" },
	}).map((item) => item.title)).toEqual(["收藏歌单"]);

	expect(resolveShelfItems({
		playlists,
		podcastCollections: [],
		queue: [],
		currentTrack: null,
		settings: { showPodcasts: true, mergeCollections: true },
	}).map((item) => item.title)).toEqual(["我的歌单", "收藏歌单"]);
});

test("resolveShelfItems only appends podcast collections on mine pane unless collections are merged", () => {
	const playlists: PlaylistSummary[] = [
		{
			provider: "netease",
			id: "mine",
			name: "我的歌单",
			coverUrl: "",
			trackCount: 1,
			trackIds: [],
			subscribed: false,
		},
		{
			provider: "netease",
			id: "fav",
			name: "收藏歌单",
			coverUrl: "",
			trackCount: 1,
			trackIds: [],
			subscribed: true,
		},
	];
	const podcastCollections: PodcastCollection[] = [{
		key: "liked",
		title: "喜欢的声音",
		sub: "",
		itemType: "voice",
		count: 2,
		coverUrl: "",
	}];

	expect(resolveShelfItems({
		playlists,
		podcastCollections,
		queue: [],
		currentTrack: null,
		settings: { showPodcasts: true, mergeCollections: false, pane: "fav" },
	}).map((item) => item.title)).toEqual(["收藏歌单"]);

	expect(resolveShelfItems({
		playlists,
		podcastCollections,
		queue: [],
		currentTrack: null,
		settings: { showPodcasts: true, mergeCollections: true, pane: "fav" },
	}).map((item) => item.title)).toEqual(["我的歌单", "收藏歌单", "喜欢的声音"]);
});

test("resolveShelfItems falls back to queue when no provider playlist is available", () => {
	const queue = [track("a", "Queued", ["Ada"], "Album", "cover-q")];
	const items = resolveShelfItems({ playlists: [], podcastCollections: [], queue, currentTrack: queue[0] });

	expect(items[0]).toEqual({
		type: "queue",
		title: "Queued",
		sub: "Ada",
		cover: "cover-q",
		tag: "正在播放",
		queueIndex: 0,
		provider: "netease",
	});
});
