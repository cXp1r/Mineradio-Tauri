import { expect, test } from "bun:test";
import type { Track } from "@mineradio/shared";
import {
	buildHomeListenSummary,
	createEmptyHomeListenLedger,
	HOME_LISTEN_DAILY_RETENTION_DAYS,
	HOME_LISTEN_DAILY_TRACK_KEY_LIMIT,
	migrateHomeListenLedger,
	localHomeDateKey,
	recordHomeListenSession,
	type HomeListenLedgerV2,
} from "./home-listen-ledger";

const track: Track = {
	provider: "netease",
	id: "song-1",
	sourceId: "song-1",
	title: "旧版歌曲",
	artists: ["旧版歌手"],
	album: "旧版专辑",
	coverUrl: "https://img.example/song-1.jpg",
	qualityHints: [],
	playableState: "playable",
};

test("v1 listen history migrates lifetime and recent data without inventing daily activity", () => {
	const ledger = migrateHomeListenLedger({
		history: [{
			track,
			plays: 4,
			lastPlayedAt: 1_782_662_400_000,
			listenMs: 245_000,
			completed: 2,
		}],
		updatedAt: 1_782_662_400_000,
	});

	expect(ledger.version).toBe(2);
	expect(ledger.songs.length).toBe(1);
	expect(ledger.songs[0]?.track).toEqual(track);
	expect(ledger.songs[0]?.plays).toBe(4);
	expect(ledger.songs[0]?.listenMs).toBe(245_000);
	expect(ledger.songs[0]?.completed).toBe(2);
	expect(ledger.recent[0]?.track).toEqual(track);
	expect(ledger.recent[0]?.endedAt).toBe(1_782_662_400_000);
	expect(ledger.recent[0]?.migrated).toBe(true);
	expect(ledger.artists[0]?.name).toBe("旧版歌手");
	expect(ledger.artists[0]?.plays).toBe(4);
	expect(ledger.artists[0]?.listenMs).toBe(245_000);
	expect(ledger.daily).toEqual([]);
});

// 编译期守卫：迁移结果始终是 v2，不把旧对象形状泄漏给调用方。
const _ledgerType: HomeListenLedgerV2 = migrateHomeListenLedger(null);
void _ledgerType;

test("new sessions build accurate today totals, unique songs, and a local-day streak", () => {
	const yesterday = new Date(2026, 6, 29, 20).getTime();
	const todayMorning = new Date(2026, 6, 30, 8).getTime();
	const todayEvening = new Date(2026, 6, 30, 19).getTime();
	const otherTrack = { ...track, id: "song-2", sourceId: "song-2", title: "新歌" };
	let ledger = createEmptyHomeListenLedger();
	ledger = recordHomeListenSession(ledger, {
		track,
		startedAt: yesterday - 60_000,
		endedAt: yesterday,
		listenMs: 60_000,
		completed: false,
	});
	ledger = recordHomeListenSession(ledger, {
		track,
		startedAt: todayMorning - 90_000,
		endedAt: todayMorning,
		listenMs: 90_000,
		completed: true,
	});
	ledger = recordHomeListenSession(ledger, {
		track: otherTrack,
		startedAt: todayEvening - 60_000,
		endedAt: todayEvening,
		listenMs: 60_000,
		completed: false,
	});

	const summary = buildHomeListenSummary(
		ledger,
		new Date(2026, 6, 30, 21).getTime(),
	);
	expect(summary?.todayListenMs).toBe(150_000);
	expect(summary?.todayUniqueSongs).toBe(2);
	expect(summary?.streakDays).toBe(2);
	expect(summary?.totalPlays).toBe(3);
	expect(summary?.recent?.track.id).toBe("song-2");
	expect(summary?.topSong?.track.id).toBe("song-1");
});

test("today unique songs stay exact after the legacy 48-key threshold", () => {
	const today = new Date(2026, 6, 30, 12).getTime();
	let ledger = createEmptyHomeListenLedger();
	for (let index = 0; index < 96; index += 1) {
		ledger = recordHomeListenSession(ledger, {
			track: {
				...track,
				id: `song-${index}`,
				sourceId: `song-${index}`,
				title: `歌曲 ${index}`,
			},
			startedAt: today + index * 1_000,
			endedAt: today + index * 1_000 + 500,
			listenMs: 500,
			completed: true,
		});
	}
	const beforeReplay = buildHomeListenSummary(ledger, today + 120_000);
	ledger = recordHomeListenSession(ledger, {
		track: { ...track, id: "song-0", sourceId: "song-0", title: "歌曲 0" },
		startedAt: today + 121_000,
		endedAt: today + 121_500,
		listenMs: 500,
		completed: true,
	});
	const afterReplay = buildHomeListenSummary(ledger, today + 122_000);

	expect(beforeReplay?.todayUniqueSongs).toBe(96);
	expect(afterReplay?.todayUniqueSongs).toBe(96);
	expect(ledger.daily[0]?.trackKeys.length).toBe(96);
});

test("an incomplete legacy key set saturates instead of overcounting an unknown replay", () => {
	const today = new Date(2026, 6, 30, 12).getTime();
	let ledger = migrateHomeListenLedger({
		version: 2,
		recent: [],
		songs: [],
		artists: [],
		daily: [{
			date: localHomeDateKey(today),
			listenMs: 49_000,
			trackKeys: Array.from(
				{ length: 48 },
				(_, index) => `netease:song-${index + 1}`,
			),
			uniqueTracks: 49,
			sessions: 49,
			completed: 49,
		}],
		streakCarry: null,
		updatedAt: today,
	});
	ledger = recordHomeListenSession(ledger, {
		track: { ...track, id: "song-0", sourceId: "song-0", title: "歌曲 0" },
		startedAt: today + 60_000,
		endedAt: today + 60_500,
		listenMs: 500,
		completed: true,
	});

	expect(buildHomeListenSummary(ledger, today + 61_000)?.todayUniqueSongs).toBe(
		49,
	);
});

test("long-term heavy ledger stays bounded without understating today or streak", () => {
	const dayCount = 1_200;
	const tracksPerDay = 96;
	const timestamps = Array.from({ length: dayCount }, (_, index) =>
		new Date(2022, 0, index + 1, 12).getTime(),
	);
	const ledger = migrateHomeListenLedger({
		version: 2,
		recent: [],
		songs: [],
		artists: [],
		daily: timestamps.map((timestamp, dayIndex) => ({
			date: localHomeDateKey(timestamp),
			listenMs: 86_400_000,
			trackKeys: Array.from(
				{ length: tracksPerDay },
				(_, trackIndex) =>
					`netease:long-provider-track-${dayIndex}-${trackIndex}-${"x".repeat(80)}`,
			),
			sessions: tracksPerDay,
			completed: tracksPerDay,
		})),
		updatedAt: timestamps.at(-1),
	});

	expect(ledger.daily.length).toBe(HOME_LISTEN_DAILY_RETENTION_DAYS);
	expect(ledger.daily[0]?.trackKeys.length).toBe(tracksPerDay);
	expect(ledger.daily.slice(1).every((day) => day.trackKeys.length === 0)).toBe(
		true,
	);
	expect(
		ledger.daily.every(
			(day) => day.trackKeys.length <= HOME_LISTEN_DAILY_TRACK_KEY_LIMIT,
		),
	).toBe(true);
	expect(ledger.daily[0]?.uniqueTracks).toBe(tracksPerDay);
	expect(
		new TextEncoder().encode(JSON.stringify(ledger)).byteLength < 192 * 1024,
	).toBe(true);
	const summary = buildHomeListenSummary(
		ledger,
		(timestamps.at(-1) ?? 0) + 60_000,
	);
	expect(summary?.todayUniqueSongs).toBe(tracksPerDay);
	expect(summary?.streakDays).toBe(dayCount);

	const latestTimestamp = timestamps.at(-1) ?? 0;
	const latestSourceId = `long-provider-track-${dayCount - 1}-0-${"x".repeat(80)}`;
	const afterReplay = recordHomeListenSession(ledger, {
		track: {
			...track,
			id: latestSourceId,
			sourceId: latestSourceId,
			title: "最新日已听歌曲",
		},
		startedAt: latestTimestamp + 61_000,
		endedAt: latestTimestamp + 61_500,
		listenMs: 500,
		completed: true,
	});
	expect(
		buildHomeListenSummary(afterReplay, latestTimestamp + 62_000)
			?.todayUniqueSongs,
	).toBe(tracksPerDay);
	const afterNewSong = recordHomeListenSession(afterReplay, {
		track: {
			...track,
			id: "latest-day-new-song",
			sourceId: "latest-day-new-song",
			title: "最新日新歌曲",
		},
		startedAt: latestTimestamp + 63_000,
		endedAt: latestTimestamp + 63_500,
		listenMs: 500,
		completed: true,
	});
	const afterNewSummary = buildHomeListenSummary(
		afterNewSong,
		latestTimestamp + 64_000,
	);
	expect(afterNewSummary?.todayUniqueSongs).toBe(tracksPerDay + 1);
	expect(afterNewSummary?.streakDays).toBe(dayCount);
});

test("oversized song and artist metadata is bounded before persistence", () => {
	const oversizedText = "超长元数据".repeat(1_000);
	const oversizedUrl = `https://img.example/${"cover".repeat(1_000)}`;
	const songs = Array.from({ length: 24 }, (_, index) => ({
		track: {
			...track,
			id: `song-${index}-${oversizedText}`,
			sourceId: `source-${index}-${oversizedText}`,
			mediaMid: `mid-${index}-${oversizedText}`,
			title: `歌曲 ${index} ${oversizedText}`,
			artists: Array.from(
				{ length: 64 },
				(_, artistIndex) => `歌手 ${artistIndex} ${oversizedText}`,
			),
			album: `专辑 ${index} ${oversizedText}`,
			coverUrl: oversizedUrl,
			qualityHints: Array.from(
				{ length: 64 },
				(_, qualityIndex) => `音质 ${qualityIndex} ${oversizedText}`,
			),
		},
		plays: 1,
		lastPlayedAt: 1_782_662_400_000 + index,
		listenMs: 60_000,
		completed: 1,
	}));
	const ledger = migrateHomeListenLedger({
		version: 2,
		recent: songs.map((song, index) => ({
			id: `session-${index}-${oversizedText}`,
			track: song.track,
			startedAt: song.lastPlayedAt - 60_000,
			endedAt: song.lastPlayedAt,
			listenMs: song.listenMs,
			completed: true,
		})),
		songs,
		artists: Array.from({ length: 300 }, (_, index) => ({
			name: `聚合歌手 ${index} ${oversizedText}`,
			plays: 1,
			listenMs: 60_000,
			lastPlayedAt: 1_782_662_400_000 + index,
			coverUrl: oversizedUrl,
		})),
		daily: [{
			date: localHomeDateKey(1_782_662_400_000),
			listenMs: 86_400_000,
			trackKeys: Array.from(
				{ length: HOME_LISTEN_DAILY_TRACK_KEY_LIMIT },
				(_, index) => `netease:active-track-${index}`,
			),
			uniqueTracks: HOME_LISTEN_DAILY_TRACK_KEY_LIMIT,
			sessions: HOME_LISTEN_DAILY_TRACK_KEY_LIMIT,
			completed: HOME_LISTEN_DAILY_TRACK_KEY_LIMIT,
		}],
		updatedAt: 1_782_662_400_000,
	});

	expect(ledger.songs.length).toBe(24);
	expect(ledger.recent.length).toBe(24);
	expect(ledger.artists.length).toBeLessThanOrEqual(48);
	expect(ledger.artists.every((artist) => artist.name.length <= 128)).toBe(true);
	expect(
		[...ledger.songs, ...ledger.recent].every(({ track: storedTrack }) =>
			storedTrack.id.length <= 256 &&
			storedTrack.sourceId.length <= 256 &&
			storedTrack.title.length <= 256 &&
			storedTrack.album.length <= 256 &&
			storedTrack.coverUrl.length <= 2_048 &&
			storedTrack.artists.length <= 8 &&
			storedTrack.artists.every((artist) => artist.length <= 128) &&
			storedTrack.qualityHints.length <= 8 &&
			storedTrack.qualityHints.every((hint) => hint.length <= 128),
		),
	).toBe(true);
	expect(
		new TextEncoder().encode(JSON.stringify(ledger)).byteLength < 192 * 1024,
	).toBe(true);
	expect(migrateHomeListenLedger(ledger)).toEqual(ledger);
});
