import { expect, test } from "bun:test";
import { PlaybackSessionCoordinator } from "./playback-session-coordinator";

test("switching tracks invalidates stale playback and lyric work", () => {
	const coordinator = new PlaybackSessionCoordinator();
	const first = coordinator.beginTrack("netease:first");
	const second = coordinator.beginTrack("netease:second");

	expect(first).not.toBeNull();
	expect(second).not.toBeNull();
	expect(coordinator.isPlaybackCurrent(first!.playbackToken)).toBe(false);
	expect(coordinator.isLyricCurrent(first!.lyricToken)).toBe(false);
	expect(coordinator.isPlaybackCurrent(second!.playbackToken)).toBe(true);
	expect(coordinator.isLyricCurrent(second!.lyricToken)).toBe(true);
});

test("a remote non-trial track receives only one automatic media recovery", () => {
	const coordinator = new PlaybackSessionCoordinator();
	coordinator.beginTrack("netease:first");
	coordinator.markLoaded({
		trackKey: "netease:first",
		quality: "standard",
		resolvedAtMs: 1_000,
		audioUrl: "http://127.0.0.1/audio-proxy",
		rawUrl: "https://media.example/first.mp3",
		local: false,
		trial: false,
	});

	expect(coordinator.claimMediaErrorRecovery("netease:first", true)).toBe(true);
	expect(coordinator.claimMediaErrorRecovery("netease:first", true)).toBe(false);
});

test("a long pause refreshes the remote source while preserving the long-pause reason", () => {
	const coordinator = new PlaybackSessionCoordinator();
	coordinator.beginTrack("netease:first");
	coordinator.markLoaded({
		trackKey: "netease:first",
		quality: "standard",
		resolvedAtMs: 1_000,
		audioUrl: "http://127.0.0.1/audio-proxy",
		rawUrl: "https://media.example/first.mp3",
		local: false,
		trial: false,
	});
	coordinator.markPaused(5_000);

	expect(coordinator.refreshReason(5_000 + 10 * 60 * 1_000)).toBe("long-pause");
});

test("an old remote URL refreshes even without a recorded pause", () => {
	const coordinator = new PlaybackSessionCoordinator();
	coordinator.beginTrack("netease:first");
	coordinator.markLoaded({
		trackKey: "netease:first",
		quality: "standard",
		resolvedAtMs: 1_000,
		audioUrl: "http://127.0.0.1/audio-proxy",
		rawUrl: "https://media.example/first.mp3",
		local: false,
		trial: false,
	});

	expect(coordinator.refreshReason(1_000 + 20 * 60 * 1_000)).toBe("url-age");
});

test("resuming playback clears the long-pause refresh clock", () => {
	const coordinator = new PlaybackSessionCoordinator();
	coordinator.beginTrack("netease:first");
	coordinator.markLoaded({
		trackKey: "netease:first",
		quality: "standard",
		resolvedAtMs: 1_000,
		audioUrl: "http://127.0.0.1/audio-proxy",
		rawUrl: "https://media.example/first.mp3",
		local: false,
		trial: false,
	});
	coordinator.markPaused(5_000);
	coordinator.markPlaying();

	expect(coordinator.refreshReason(5_000 + 10 * 60 * 1_000)).toBeNull();
});

test("a successful non-error refresh restores the media recovery budget", () => {
	const coordinator = new PlaybackSessionCoordinator();
	coordinator.beginTrack("netease:first");
	coordinator.markLoaded({
		trackKey: "netease:first",
		quality: "standard",
		resolvedAtMs: 1_000,
		audioUrl: "http://127.0.0.1/audio-proxy",
		rawUrl: "https://media.example/first.mp3",
		local: false,
		trial: false,
	});
	expect(coordinator.claimMediaErrorRecovery("netease:first", true)).toBe(true);

	coordinator.completeReload("url-age");

	expect(coordinator.claimMediaErrorRecovery("netease:first", true)).toBe(true);
});

test("quality invalidation allows the same track to start a new load session", () => {
	const coordinator = new PlaybackSessionCoordinator();
	const first = coordinator.beginTrack("netease:first");
	expect(coordinator.beginTrack("netease:first")).toBeNull();

	coordinator.invalidateCurrentTrackLoad();
	const reloaded = coordinator.beginTrack("netease:first");

	expect(reloaded).not.toBeNull();
	expect(coordinator.isPlaybackCurrent(first!.playbackToken)).toBe(false);
});

test("local and trial media never claim automatic media recovery", () => {
	for (const source of [
		{ local: true, trial: false },
		{ local: false, trial: true },
	]) {
		const coordinator = new PlaybackSessionCoordinator();
		coordinator.beginTrack("netease:first");
		coordinator.markLoaded({
			trackKey: "netease:first",
			quality: "standard",
			resolvedAtMs: 1_000,
			audioUrl: "http://127.0.0.1/audio-proxy",
			rawUrl: "https://media.example/first.mp3",
			...source,
		});

		expect(coordinator.claimMediaErrorRecovery("netease:first", true)).toBe(false);
	}
});

test("long-pause takes priority when the pause and URL age thresholds both expire", () => {
	const coordinator = new PlaybackSessionCoordinator();
	coordinator.beginTrack("netease:first");
	coordinator.markLoaded({
		trackKey: "netease:first",
		quality: "standard",
		resolvedAtMs: 1_000,
		audioUrl: "http://127.0.0.1/audio-proxy",
		rawUrl: "https://media.example/first.mp3",
		local: false,
		trial: false,
	});
	coordinator.markPaused(5_000);

	expect(coordinator.refreshReason(1_000 + 20 * 60 * 1_000)).toBe("long-pause");
});

test("a media-error reload keeps the one-shot recovery budget consumed", () => {
	const coordinator = new PlaybackSessionCoordinator();
	coordinator.beginTrack("netease:first");
	coordinator.markLoaded({
		trackKey: "netease:first",
		quality: "standard",
		resolvedAtMs: 1_000,
		audioUrl: "http://127.0.0.1/audio-proxy",
		rawUrl: "https://media.example/first.mp3",
		local: false,
		trial: false,
	});
	expect(coordinator.claimMediaErrorRecovery("netease:first", true)).toBe(true);

	coordinator.completeReload("media-error");

	expect(coordinator.claimMediaErrorRecovery("netease:first", true)).toBe(false);
});
