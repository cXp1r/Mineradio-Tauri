import { expect, test } from "bun:test";
import type { DiscoverHomeResponse, Track } from "@mineradio/shared";
import { buildHomeDashboardModel } from "./home-dashboard-policy";

function song(id: string, title = id): Track {
	return {
		provider: "netease",
		id,
		sourceId: id,
		title,
		artists: [`artist-${id}`],
		album: "",
		coverUrl: "",
		qualityHints: [],
		playableState: "playable",
	};
}

function discover(dailySongs: Track[]): DiscoverHomeResponse {
	return {
		loggedIn: true,
		user: null,
		dailySongs,
		playlists: [],
		podcasts: [],
		mode: "member",
		updatedAt: 1,
	};
}

test("dashboard prioritizes the current queue for Continue and exposes the following Next Up track", () => {
	const queue = [song("one"), song("two"), song("three")];
	const model = buildHomeDashboardModel({
		discover: discover([song("daily")]),
		listenSummary: {
			recent: { track: song("recent"), plays: 2 },
		},
		queue,
		currentIndex: 1,
		currentTrack: queue[1],
		isPlaying: false,
		now: new Date(2026, 6, 30, 9, 5).getTime(),
	});

	expect(model.continue.kind).toBe("current");
	expect(model.continue.track?.id).toBe("two");
	expect(model.continue.isPaused).toBe(true);
	expect(model.nextUp?.id).toBe("three");
});

test("For You is date-stable, deduplicated across recent and daily sources, and capped at three tracks", () => {
	const duplicatedRecent = song("shared", "Shared Song");
	const input = {
		discover: discover([
			song("daily-1"),
			duplicatedRecent,
			song("daily-2"),
			song("daily-3"),
		]),
		listenSummary: {
			recent: { track: duplicatedRecent, plays: 2 },
			topSong: { track: song("top"), plays: 5 },
		},
		queue: [],
		currentTrack: null,
		now: new Date(2026, 6, 30, 12).getTime(),
	};
	const first = buildHomeDashboardModel(input);
	const second = buildHomeDashboardModel(input);
	const keys = first.forYou.map((track) => `${track.provider}:${track.id}`);

	expect(first.continue.kind).toBe("recent");
	expect(first.forYou.length).toBe(3);
	expect(new Set(keys).size).toBe(3);
	expect(second.forYou.map((track) => track.id)).toEqual(
		first.forYou.map((track) => track.id),
	);
});

test("For You deduplicates the same title and artist across providers", () => {
	const neteaseTrack = song("netease-shared", "同一首歌");
	const qqTrack: Track = {
		...neteaseTrack,
		provider: "qq",
		id: "qq-shared",
		sourceId: "qq-shared",
	};
	const model = buildHomeDashboardModel({
		discover: discover([qqTrack, song("daily-other")]),
		listenSummary: {
			recent: { track: neteaseTrack, plays: 2 },
		},
		queue: [],
		now: new Date(2026, 6, 30, 12).getTime(),
	});

	expect(model.forYou.length).toBe(2);
	expect(model.forYou.filter((track) => track.title === "同一首歌").length).toBe(1);
});

test("Next Up follows single, loop, queue, and a stable shuffle policy", () => {
	const queue = [song("one"), song("two"), song("three")];
	const base = {
		discover: discover([]),
		listenSummary: null,
		queue,
		currentIndex: 2,
		currentTrack: queue[2],
		now: new Date(2026, 6, 30, 12).getTime(),
	};

	expect(buildHomeDashboardModel({ ...base, playbackMode: "single" }).nextUpIndex).toBe(2);
	expect(buildHomeDashboardModel({ ...base, playbackMode: "loop" }).nextUpIndex).toBe(0);
	expect(buildHomeDashboardModel({ ...base, playbackMode: "queue" }).nextUpIndex).toBe(-1);

	const firstShuffle = buildHomeDashboardModel({ ...base, playbackMode: "shuffle" });
	const secondShuffle = buildHomeDashboardModel({ ...base, playbackMode: "shuffle" });
	expect(firstShuffle.nextUpIndex).not.toBe(2);
	expect(secondShuffle.nextUpIndex).toBe(firstShuffle.nextUpIndex);
	expect(secondShuffle.nextUp?.id).toBe(firstShuffle.nextUp?.id);
});

test("Continue falls back from recent playback to the currently loaded daily songs", () => {
	const model = buildHomeDashboardModel({
		discover: discover([song("daily-1"), song("daily-2")]),
		listenSummary: null,
		queue: [],
		currentTrack: null,
		now: new Date(2026, 6, 30, 12).getTime(),
	});

	expect(model.continue.kind).toBe("daily");
	expect(model.continue.queue.map((track) => track.id)).toEqual([
		"daily-1",
		"daily-2",
	]);
	expect(model.continue.subtitle).toBe("当前已载入 2 首");
});
