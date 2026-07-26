import { expect, test } from "bun:test";
import {
	createPlaybackState,
	reducePlaybackState,
	type PlaybackMachineState,
} from "./playback-state-machine";

function resolvingState(
	playbackSessionId = 1,
	loadRequestId = 1,
	trackKey = "netease:first",
): PlaybackMachineState {
	return reducePlaybackState(createPlaybackState(), {
		type: "PLAY_TRACK",
		playbackSessionId,
		loadRequestId,
		trackKey,
	});
}

function playingState(): PlaybackMachineState {
	const resolving = resolvingState();
	const loading = reducePlaybackState(resolving, {
		type: "SOURCE_READY",
		playbackSessionId: 1,
		loadRequestId: 1,
	});
	return reducePlaybackState(loading, {
		type: "MEDIA_PLAYING",
		playbackSessionId: 1,
	});
}

test("PLAY_TRACK starts a fresh resolving session", () => {
	const state = reducePlaybackState(createPlaybackState(), {
		type: "PLAY_TRACK",
		playbackSessionId: 7,
		loadRequestId: 11,
		trackKey: "netease:first",
	});

	expect(state).toEqual({
		phase: "resolving",
		playbackSessionId: 7,
		loadRequestId: 11,
		trackKey: "netease:first",
		recoveryAttempts: 0,
		failureReason: null,
	});
});

test("a stale load event is ignored with the same state identity", () => {
	const state = resolvingState(7, 11);
	const result = reducePlaybackState(state, {
		type: "SOURCE_READY",
		playbackSessionId: 7,
		loadRequestId: 10,
	});

	expect(result).toBe(state);
});

test("a resolved source advances through loading to playing", () => {
	const resolving = resolvingState();
	const loading = reducePlaybackState(resolving, {
		type: "SOURCE_READY",
		playbackSessionId: 1,
		loadRequestId: 1,
	});
	const playing = reducePlaybackState(loading, {
		type: "MEDIA_PLAYING",
		playbackSessionId: 1,
	});

	expect(loading.phase).toBe("loading");
	expect(playing.phase).toBe("playing");
});

test("playing media can pause and resume", () => {
	const playing = playingState();
	const paused = reducePlaybackState(playing, {
		type: "PAUSE",
		playbackSessionId: 1,
	});
	const resumed = reducePlaybackState(paused, {
		type: "RESUME",
		playbackSessionId: 1,
	});

	expect(paused.phase).toBe("paused");
	expect(resumed.phase).toBe("playing");
});

test("a recoverable media failure consumes one recovery before exhaustion fails", () => {
	const recovering = reducePlaybackState(playingState(), {
		type: "MEDIA_FAILED",
		playbackSessionId: 1,
		recoverable: true,
		reason: "network",
	});
	const failed = reducePlaybackState(recovering, {
		type: "RECOVERY_EXHAUSTED",
		playbackSessionId: 1,
		reason: "retry-failed",
	});

	expect(recovering.phase).toBe("recovering");
	expect(recovering.recoveryAttempts).toBe(1);
	expect(recovering.failureReason).toBeNull();
	expect(failed.phase).toBe("failed");
	expect(failed.failureReason).toBe("retry-failed");
});

test("switching tracks invalidates events from the old session", () => {
	const first = resolvingState(1, 1, "netease:first");
	const second = reducePlaybackState(first, {
		type: "SWITCH_TRACK",
		playbackSessionId: 2,
		loadRequestId: 2,
		trackKey: "netease:second",
	});
	const staleResult = reducePlaybackState(second, {
		type: "RESOLVE_FAILED",
		playbackSessionId: 1,
		loadRequestId: 1,
		reason: "old-request-failed",
	});

	expect(second.phase).toBe("resolving");
	expect(second.playbackSessionId).toBe(2);
	expect(second.loadRequestId).toBe(2);
	expect(second.trackKey).toBe("netease:second");
	expect(second.recoveryAttempts).toBe(0);
	expect(second.failureReason).toBeNull();
	expect(staleResult).toBe(second);
});

test("STOP returns to idle and invalidates the stopped session", () => {
	const playing = playingState();
	const stopped = reducePlaybackState(playing, {
		type: "STOP",
		playbackSessionId: 2,
	});
	const staleResult = reducePlaybackState(stopped, {
		type: "MEDIA_ENDED",
		playbackSessionId: 1,
	});

	expect(stopped).toEqual({
		phase: "idle",
		playbackSessionId: 2,
		loadRequestId: 0,
		trackKey: "",
		recoveryAttempts: 0,
		failureReason: null,
	});
	expect(staleResult).toBe(stopped);
});

test("an event that is illegal in the current phase preserves state identity", () => {
	const resolving = resolvingState();
	const result = reducePlaybackState(resolving, {
		type: "PAUSE",
		playbackSessionId: 1,
	});

	expect(result).toBe(resolving);
});

test("BEGIN_RELOAD keeps the session and consumed recovery budget", () => {
	const recovering = reducePlaybackState(playingState(), {
		type: "MEDIA_FAILED",
		playbackSessionId: 1,
		recoverable: true,
		reason: "network",
	});
	const mediaReload = reducePlaybackState(recovering, {
		type: "BEGIN_RELOAD",
		playbackSessionId: 1,
		loadRequestId: 2,
		reason: "media-error",
	});
	const ageReload = reducePlaybackState(mediaReload, {
		type: "BEGIN_RELOAD",
		playbackSessionId: 1,
		loadRequestId: 3,
		reason: "url-age",
	});

	expect(mediaReload.phase).toBe("recovering");
	expect(mediaReload.playbackSessionId).toBe(1);
	expect(mediaReload.loadRequestId).toBe(2);
	expect(mediaReload.recoveryAttempts).toBe(1);
	expect(ageReload.phase).toBe("resolving");
	expect(ageReload.playbackSessionId).toBe(1);
	expect(ageReload.loadRequestId).toBe(3);
	expect(ageReload.recoveryAttempts).toBe(1);
});

test("a non-recoverable or already recovered media failure records its reason", () => {
	const failedImmediately = reducePlaybackState(playingState(), {
		type: "MEDIA_FAILED",
		playbackSessionId: 1,
		recoverable: false,
		reason: "unsupported-codec",
	});
	const recovering = reducePlaybackState(playingState(), {
		type: "MEDIA_FAILED",
		playbackSessionId: 1,
		recoverable: true,
		reason: "network",
	});
	const reload = reducePlaybackState(recovering, {
		type: "BEGIN_RELOAD",
		playbackSessionId: 1,
		loadRequestId: 2,
		reason: "media-error",
	});
	const loading = reducePlaybackState(reload, {
		type: "SOURCE_READY",
		playbackSessionId: 1,
		loadRequestId: 2,
	});
	const failedAfterRecovery = reducePlaybackState(loading, {
		type: "MEDIA_FAILED",
		playbackSessionId: 1,
		recoverable: true,
		reason: "network-again",
	});

	expect(failedImmediately.phase).toBe("failed");
	expect(failedImmediately.failureReason).toBe("unsupported-codec");
	expect(failedAfterRecovery.phase).toBe("failed");
	expect(failedAfterRecovery.recoveryAttempts).toBe(1);
	expect(failedAfterRecovery.failureReason).toBe("network-again");
});

test("resolve failure is load-scoped and records the reason", () => {
	const resolving = resolvingState();
	const failed = reducePlaybackState(resolving, {
		type: "RESOLVE_FAILED",
		playbackSessionId: 1,
		loadRequestId: 1,
		reason: "no-source",
	});

	expect(failed.phase).toBe("failed");
	expect(failed.failureReason).toBe("no-source");
});

test("current playback can end", () => {
	const ended = reducePlaybackState(playingState(), {
		type: "MEDIA_ENDED",
		playbackSessionId: 1,
	});

	expect(ended.phase).toBe("ended");
});
