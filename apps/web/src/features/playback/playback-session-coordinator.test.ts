import { expect, test } from "bun:test";
import { PlaybackSessionCoordinator } from "./playback-session-coordinator";

const PLAYBACK_URL_FAR_FUTURE_MS = 1_000 + 20 * 60 * 1_000;

function remoteSource(trackKey = "netease:first") {
	return {
		trackKey,
		quality: "standard" as const,
		resolvedAtMs: 1_000,
		audioUrl: "http://127.0.0.1/audio-proxy",
		rawUrl: "https://media.example/first.mp3",
		local: false,
		trial: false,
	};
}

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

test("legacy track changes do not advance the explicit intent watermark", () => {
	const coordinator = new PlaybackSessionCoordinator();
	const legacy = coordinator.beginTrack("netease:first");
	const explicit = coordinator.beginTrack("netease:second", 1);

	expect(legacy).not.toBeNull();
	expect(explicit).not.toBeNull();
	expect(explicit!.playbackSessionId).toBeGreaterThan(
		legacy!.playbackSessionId,
	);
});

test("a newer explicit intent creates a fresh session even for the same track", () => {
	const coordinator = new PlaybackSessionCoordinator();
	const first = coordinator.beginTrack("netease:first", 1);
	const second = coordinator.beginTrack("netease:first", 2);

	expect(first).not.toBeNull();
	expect(second).not.toBeNull();
	expect(second!.playbackSessionId).toBeGreaterThan(first!.playbackSessionId);
	expect(second!.playbackToken).toBeGreaterThan(first!.playbackToken);
	expect(second!.lyricToken).toBeGreaterThan(first!.lyricToken);
	expect(coordinator.isPlaybackCurrent(first!.playbackToken)).toBe(false);
	expect(coordinator.snapshot().phase).toBe("resolving");
	expect(coordinator.snapshot().playbackSessionId).toBe(
		second!.playbackSessionId,
	);
	expect(coordinator.snapshot().loadRequestId).toBe(second!.playbackToken);
	expect(coordinator.snapshot().trackKey).toBe("netease:first");
});

test("the same or an older explicit intent cannot create a session", () => {
	const coordinator = new PlaybackSessionCoordinator();
	const current = coordinator.beginTrack("netease:first", 2);

	expect(current).not.toBeNull();
	expect(coordinator.beginTrack("netease:first", 2)).toBeNull();
	expect(coordinator.beginTrack("netease:second", 1)).toBeNull();
	expect(coordinator.snapshot().playbackSessionId).toBe(
		current!.playbackSessionId,
	);
});

test("a stale load cannot write the source or advance the resolving state", () => {
	const coordinator = new PlaybackSessionCoordinator();
	const first = coordinator.beginTrack("netease:first", 1)!;
	coordinator.beginTrack("netease:first", 2);
	const resolving = coordinator.snapshot();

	coordinator.markLoaded(remoteSource(), first.playbackToken);

	expect(coordinator.snapshot()).toBe(resolving);
	expect(coordinator.snapshot().phase).toBe("resolving");
	expect(coordinator.refreshReason(PLAYBACK_URL_FAR_FUTURE_MS)).toBeNull();
});

test("the current source advances through loading to playing", () => {
	const coordinator = new PlaybackSessionCoordinator();
	const session = coordinator.beginTrack("netease:first", 1)!;

	coordinator.markLoaded(remoteSource(), session.playbackToken);
	expect(coordinator.snapshot().phase).toBe("loading");

	coordinator.markPlaying();
	expect(coordinator.snapshot().phase).toBe("playing");
});

test("markPlaying resumes a paused current session", () => {
	const coordinator = new PlaybackSessionCoordinator();
	const session = coordinator.beginTrack("netease:first", 1)!;
	coordinator.markLoaded(remoteSource(), session.playbackToken);
	coordinator.markPlaying();
	coordinator.markPaused(2_000);
	expect(coordinator.snapshot().phase).toBe("paused");

	coordinator.markPlaying();

	expect(coordinator.snapshot().phase).toBe("playing");
});

test("claiming current remote media recovery advances the machine", () => {
	const coordinator = new PlaybackSessionCoordinator();
	const session = coordinator.beginTrack("netease:first", 1)!;
	coordinator.markLoaded(remoteSource(), session.playbackToken);
	coordinator.markPlaying();

	expect(coordinator.claimMediaErrorRecovery("netease:first", true)).toBe(true);
	expect(coordinator.snapshot().phase).toBe("recovering");
	expect(coordinator.snapshot().recoveryAttempts).toBe(1);
	expect(coordinator.claimMediaErrorRecovery("netease:first", true)).toBe(false);
	expect(coordinator.snapshot().phase).toBe("failed");
});

test("rejecting media recovery while resolving fails the current load", () => {
	const coordinator = new PlaybackSessionCoordinator();
	coordinator.beginTrack("netease:first", 1);

	expect(coordinator.claimMediaErrorRecovery("netease:first", true)).toBe(false);
	expect(coordinator.snapshot().phase).toBe("failed");
});

test("media recovery is claimed only when the current load accepts failure", () => {
	const coordinator = new PlaybackSessionCoordinator();
	const session = coordinator.beginTrack("netease:first", 1)!;
	coordinator.markLoaded(remoteSource(), session.playbackToken);
	coordinator.markPlaying();
	const reloadToken = coordinator.beginReload("url-age");
	const resolving = coordinator.snapshot();

	expect(coordinator.claimMediaErrorRecovery("netease:first", true)).toBe(false);
	expect(coordinator.snapshot()).toBe(resolving);

	coordinator.markLoaded(remoteSource(), reloadToken);
	coordinator.markPlaying();
	expect(coordinator.claimMediaErrorRecovery("netease:first", true)).toBe(true);
});

test("a media-error reload keeps the session while starting a new load", () => {
	const coordinator = new PlaybackSessionCoordinator();
	const session = coordinator.beginTrack("netease:first", 1)!;
	coordinator.markLoaded(remoteSource(), session.playbackToken);
	coordinator.markPlaying();
	coordinator.claimMediaErrorRecovery("netease:first", true);

	const playbackToken = coordinator.beginReload("media-error");

	expect(playbackToken).toBeGreaterThan(session.playbackToken);
	expect(coordinator.snapshot().phase).toBe("recovering");
	expect(coordinator.snapshot().playbackSessionId).toBe(
		session.playbackSessionId,
	);
	expect(coordinator.snapshot().loadRequestId).toBe(playbackToken);
	expect(coordinator.snapshot().recoveryAttempts).toBe(1);
});

test("clear returns to idle and invalidates all work from the old session", () => {
	const coordinator = new PlaybackSessionCoordinator();
	const session = coordinator.beginTrack("netease:first", 1)!;

	coordinator.clear();

	expect(coordinator.snapshot().phase).toBe("idle");
	expect(coordinator.snapshot().trackKey).toBe("");
	expect(coordinator.snapshot().playbackSessionId).toBeGreaterThan(
		session.playbackSessionId,
	);
	expect(coordinator.isPlaybackCurrent(session.playbackToken)).toBe(false);
	expect(coordinator.isLyricCurrent(session.lyricToken)).toBe(false);
});

test("stale reload completion cannot restore the recovery budget", () => {
	const coordinator = new PlaybackSessionCoordinator();
	const session = coordinator.beginTrack("netease:first", 1)!;
	coordinator.markLoaded(remoteSource(), session.playbackToken);
	coordinator.markPlaying();
	coordinator.claimMediaErrorRecovery("netease:first", true);
	const reloadToken = coordinator.beginReload("url-age");
	coordinator.markLoaded(remoteSource(), reloadToken);
	const loading = coordinator.snapshot();

	coordinator.completeReload("url-age", session.playbackToken);

	expect(coordinator.snapshot()).toBe(loading);
	expect(coordinator.snapshot().recoveryAttempts).toBe(1);
	expect(coordinator.claimMediaErrorRecovery("netease:first", true)).toBe(false);
});

test("terminal helpers reject stale loads and advance current work", () => {
	const resolvingCoordinator = new PlaybackSessionCoordinator();
	const resolvingSession = resolvingCoordinator.beginTrack("netease:first", 1)!;
	const resolving = resolvingCoordinator.snapshot();
	resolvingCoordinator.markResolveFailed(
		resolvingSession.playbackToken - 1,
		"stale",
	);
	expect(resolvingCoordinator.snapshot()).toBe(resolving);
	resolvingCoordinator.markResolveFailed(
		resolvingSession.playbackToken,
		"no-source",
	);
	expect(resolvingCoordinator.snapshot().phase).toBe("failed");
	expect(resolvingCoordinator.snapshot().failureReason).toBe("no-source");

	const playingCoordinator = new PlaybackSessionCoordinator();
	const playingSession = playingCoordinator.beginTrack("netease:first", 1)!;
	playingCoordinator.markLoaded(remoteSource(), playingSession.playbackToken);
	playingCoordinator.markPlaying();
	playingCoordinator.markEnded();
	expect(playingCoordinator.snapshot().phase).toBe("ended");

	const recoveringCoordinator = new PlaybackSessionCoordinator();
	const recoveringSession = recoveringCoordinator.beginTrack("netease:first", 1)!;
	recoveringCoordinator.markLoaded(remoteSource(), recoveringSession.playbackToken);
	recoveringCoordinator.markPlaying();
	recoveringCoordinator.claimMediaErrorRecovery("netease:first", true);
	recoveringCoordinator.markRecoveryExhausted("retry-failed");
	expect(recoveringCoordinator.snapshot().phase).toBe("failed");
	expect(recoveringCoordinator.snapshot().failureReason).toBe("retry-failed");
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
	expect(reloaded!.playbackSessionId).toBe(first!.playbackSessionId);
	expect(coordinator.isPlaybackCurrent(first!.playbackToken)).toBe(false);
	expect(coordinator.isLyricCurrent(first!.lyricToken)).toBe(false);
});

test("explicit quality invalidation reuses one current-intent load handle", () => {
	const coordinator = new PlaybackSessionCoordinator();
	const first = coordinator.beginTrack("netease:first", 1)!;

	coordinator.invalidateCurrentTrackLoad();
	const invalidatedLoadRequestId = coordinator.snapshot().loadRequestId;
	const invalidatedLyricToken = first.lyricToken + 1;
	expect(coordinator.isPlaybackCurrent(first.playbackToken)).toBe(false);
	expect(coordinator.isLyricCurrent(first.lyricToken)).toBe(false);
	expect(coordinator.isLyricCurrent(invalidatedLyricToken)).toBe(true);
	expect(coordinator.beginTrack("netease:first", 0)).toBeNull();
	const reloaded = coordinator.beginTrack("netease:first", 1);

	expect(reloaded).not.toBeNull();
	expect(reloaded!.playbackSessionId).toBe(first.playbackSessionId);
	expect(reloaded!.playbackToken).toBeGreaterThan(first.playbackToken);
	expect(reloaded!.playbackToken).toBe(invalidatedLoadRequestId);
	expect(reloaded!.lyricToken).toBeGreaterThan(first.lyricToken);
	expect(reloaded!.lyricToken).toBe(invalidatedLyricToken);
	expect(coordinator.isPlaybackCurrent(first.playbackToken)).toBe(false);
	expect(coordinator.isLyricCurrent(first.lyricToken)).toBe(false);
	expect(coordinator.snapshot().playbackSessionId).toBe(first.playbackSessionId);
	expect(coordinator.snapshot().loadRequestId).toBe(reloaded!.playbackToken);
	expect(coordinator.beginTrack("netease:first", 1)).toBeNull();
});

test("a successful quality reload restores media recovery for the current load", () => {
	const coordinator = new PlaybackSessionCoordinator();
	const first = coordinator.beginTrack("netease:first", 1)!;
	coordinator.markLoaded(remoteSource(), first.playbackToken);
	coordinator.markPlaying();
	expect(coordinator.claimMediaErrorRecovery("netease:first", true)).toBe(true);

	const mediaReloadToken = coordinator.beginReload("media-error");
	coordinator.markLoaded(remoteSource(), mediaReloadToken);
	coordinator.markPlaying();
	expect(coordinator.snapshot().recoveryAttempts).toBe(1);

	coordinator.invalidateCurrentTrackLoad();
	const qualityReload = coordinator.beginTrack("netease:first", 1)!;
	expect(qualityReload.playbackSessionId).toBe(first.playbackSessionId);
	coordinator.markLoaded(remoteSource(), mediaReloadToken);
	expect(coordinator.snapshot().phase).toBe("resolving");
	expect(coordinator.snapshot().recoveryAttempts).toBe(1);

	coordinator.markLoaded(remoteSource(), qualityReload.playbackToken);
	expect(coordinator.snapshot().recoveryAttempts).toBe(0);
	coordinator.markPlaying();
	expect(coordinator.claimMediaErrorRecovery("netease:first", true)).toBe(true);
	expect(coordinator.snapshot().phase).toBe("recovering");
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
