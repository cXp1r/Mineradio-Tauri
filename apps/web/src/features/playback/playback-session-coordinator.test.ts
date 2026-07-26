import { expect, test } from "bun:test";
import {
	PlaybackSessionCoordinator,
	type LoadedPlaybackSource,
	type PlaybackLoadHandle,
	type PlaybackReloadReason,
} from "./playback-session-coordinator";

const PLAYBACK_URL_FAR_FUTURE_MS = 1_000 + 20 * 60 * 1_000;

function remoteSource(trackKey = "netease:first"): LoadedPlaybackSource {
	return {
		trackKey,
		quality: "standard",
		resolvedAtMs: 1_000,
		audioUrl: "http://127.0.0.1/audio-proxy",
		rawUrl: "https://media.example/first.mp3",
		local: false,
		trial: false,
	};
}

function load(
	coordinator: PlaybackSessionCoordinator,
	handle: PlaybackLoadHandle,
	source = remoteSource(),
): void {
	expect(coordinator.markLoaded(handle, source)).toBe(true);
}

function play(
	coordinator: PlaybackSessionCoordinator,
	handle: PlaybackLoadHandle,
): void {
	expect(coordinator.markPlaying(handle)).toBe(true);
}

function loadAndPlay(
	coordinator: PlaybackSessionCoordinator,
	handle: PlaybackLoadHandle,
	source = remoteSource(),
): void {
	load(coordinator, handle, source);
	play(coordinator, handle);
}

test("switching tracks invalidates stale playback and lyric work", () => {
	const coordinator = new PlaybackSessionCoordinator();
	const first = coordinator.beginTrack("netease:first")!;
	const second = coordinator.beginTrack("netease:second")!;

	expect(coordinator.isPlaybackCurrent(first)).toBe(false);
	expect(coordinator.isLyricCurrent(first)).toBe(false);
	expect(coordinator.isPlaybackCurrent(second)).toBe(true);
	expect(coordinator.isLyricCurrent(second)).toBe(true);
});

test("a cloned current handle cannot publish a loaded source", () => {
	const coordinator = new PlaybackSessionCoordinator();
	const session = coordinator.beginTrack("netease:first")!;
	const clone = { ...session };
	const resolving = coordinator.snapshot();

	expect(coordinator.markLoaded(clone, remoteSource())).toBe(false);
	expect(coordinator.snapshot()).toBe(resolving);
	expect(coordinator.isPlaybackCurrent(clone)).toBe(false);
	expect(coordinator.isLyricCurrent(clone)).toBe(false);
});

test("a cloned current handle cannot publish playing", () => {
	const coordinator = new PlaybackSessionCoordinator();
	const session = coordinator.beginTrack("netease:first")!;
	load(coordinator, session);
	const clone = { ...session };
	const loading = coordinator.snapshot();

	expect(coordinator.markPlaying(clone)).toBe(false);
	expect(coordinator.snapshot()).toBe(loading);
});

test("a cloned reload handle cannot complete the reload", () => {
	const coordinator = new PlaybackSessionCoordinator();
	const session = coordinator.beginTrack("netease:first")!;
	loadAndPlay(coordinator, session);
	const reload = coordinator.beginReload("url-age")!;
	load(coordinator, reload);
	const clone = { ...reload };
	const loading = coordinator.snapshot();

	expect(coordinator.completeReload(clone)).toBe(false);
	expect(coordinator.snapshot()).toBe(loading);
	expect(coordinator.completeReload(reload)).toBe(true);
});

test("issued playback handles are frozen capabilities", () => {
	const coordinator = new PlaybackSessionCoordinator();
	const session = coordinator.beginTrack("netease:first")!;
	let mutationRejected = false;
	try {
		Object.assign(session, { playbackToken: 99 });
	} catch {
		mutationRejected = true;
	}

	expect(Object.isFrozen(session)).toBe(true);
	expect(mutationRejected).toBe(true);
	expect(session.playbackToken).toBe(1);
});

test("snapshots cannot mutate coordinator machine state", () => {
	const coordinator = new PlaybackSessionCoordinator();
	const session = coordinator.beginTrack("netease:first")!;
	const snapshot = coordinator.snapshot();
	let mutationRejected = false;

	try {
		// @ts-expect-error 快照只允许只读观察
		snapshot.phase = "playing";
	} catch {
		mutationRejected = true;
	}

	expect(Object.isFrozen(snapshot)).toBe(true);
	expect(mutationRejected || snapshot.phase === "resolving").toBe(true);
	expect(coordinator.snapshot().phase).toBe("resolving");
	expect(coordinator.markPlaying(session)).toBe(false);
	expect(coordinator.snapshot().phase).toBe("resolving");
});

test("markMediaFailed is handle-scoped and terminal after source acceptance", () => {
	const coordinator = new PlaybackSessionCoordinator();
	const session = coordinator.beginTrack("netease:first")!;
	const resolving = coordinator.snapshot();

	expect(coordinator.markMediaFailed(session, "too-early")).toBe(false);
	expect(coordinator.snapshot()).toBe(resolving);
	load(coordinator, session);
	const loading = coordinator.snapshot();
	expect(
		coordinator.markMediaFailed({ ...session }, "forged-failure"),
	).toBe(false);
	expect(coordinator.snapshot()).toBe(loading);
	expect(coordinator.markMediaFailed(session, "decoder-failed")).toBe(true);
	expect(coordinator.snapshot().phase).toBe("failed");
	expect(coordinator.snapshot().failureReason).toBe("decoder-failed");
});

test("legacy track changes do not advance the explicit intent watermark", () => {
	const coordinator = new PlaybackSessionCoordinator();
	const legacy = coordinator.beginTrack("netease:first")!;
	const explicit = coordinator.beginTrack("netease:second", 1)!;

	expect(explicit.playbackSessionId).toBeGreaterThan(legacy.playbackSessionId);
});

test("a newer explicit intent creates a fresh session for the same track", () => {
	const coordinator = new PlaybackSessionCoordinator();
	const first = coordinator.beginTrack("netease:first", 1)!;
	const second = coordinator.beginTrack("netease:first", 2)!;

	expect(second.playbackSessionId).toBeGreaterThan(first.playbackSessionId);
	expect(second.playbackToken).toBeGreaterThan(first.playbackToken);
	expect(second.lyricToken).toBeGreaterThan(first.lyricToken);
	expect(coordinator.isPlaybackCurrent(first)).toBe(false);
	expect(coordinator.snapshot().phase).toBe("resolving");
	expect(coordinator.snapshot().loadRequestId).toBe(second.playbackToken);
});

test("the same or an older explicit intent cannot create a session", () => {
	const coordinator = new PlaybackSessionCoordinator();
	const current = coordinator.beginTrack("netease:first", 2)!;

	expect(coordinator.beginTrack("netease:first", 2)).toBeNull();
	expect(coordinator.beginTrack("netease:second", 1)).toBeNull();
	expect(coordinator.snapshot().playbackSessionId).toBe(
		current.playbackSessionId,
	);
});

test("a stale load cannot write the source or advance resolving state", () => {
	const coordinator = new PlaybackSessionCoordinator();
	const first = coordinator.beginTrack("netease:first", 1)!;
	coordinator.beginTrack("netease:first", 2);
	const resolving = coordinator.snapshot();

	expect(coordinator.markLoaded(first, remoteSource())).toBe(false);
	expect(coordinator.snapshot()).toBe(resolving);
	expect(coordinator.refreshReason(PLAYBACK_URL_FAR_FUTURE_MS)).toBeNull();
});

test("the current source advances through loading to playing", () => {
	const coordinator = new PlaybackSessionCoordinator();
	const session = coordinator.beginTrack("netease:first", 1)!;

	load(coordinator, session);
	expect(coordinator.snapshot().phase).toBe("loading");
	play(coordinator, session);
	expect(coordinator.snapshot().phase).toBe("playing");
});

test("accepted source metadata is isolated from caller mutation", () => {
	const coordinator = new PlaybackSessionCoordinator();
	const session = coordinator.beginTrack("netease:first")!;
	const source = remoteSource();
	loadAndPlay(coordinator, session, source);

	source.local = true;
	source.trial = true;
	source.resolvedAtMs = PLAYBACK_URL_FAR_FUTURE_MS;

	const refreshReason = coordinator.refreshReason(PLAYBACK_URL_FAR_FUTURE_MS);
	const recoveryClaimed = coordinator.claimMediaErrorRecovery(
		session,
		"netease:first",
		true,
	);
	expect([refreshReason, recoveryClaimed]).toEqual(["url-age", true]);
});

test("markPlaying resumes a paused current load", () => {
	const coordinator = new PlaybackSessionCoordinator();
	const session = coordinator.beginTrack("netease:first", 1)!;
	loadAndPlay(coordinator, session);
	expect(coordinator.markPaused(session, 2_000)).toBe(true);
	expect(coordinator.snapshot().phase).toBe("paused");

	expect(coordinator.markPlaying(session)).toBe(true);
	expect(coordinator.snapshot().phase).toBe("playing");
});

test("claiming current remote media recovery advances the machine", () => {
	const coordinator = new PlaybackSessionCoordinator();
	const session = coordinator.beginTrack("netease:first", 1)!;
	loadAndPlay(coordinator, session);

	expect(
		coordinator.claimMediaErrorRecovery(session, "netease:first", true),
	).toBe(true);
	expect(coordinator.snapshot().phase).toBe("recovering");
	expect(coordinator.snapshot().recoveryAttempts).toBe(1);
	expect(
		coordinator.claimMediaErrorRecovery(session, "netease:first", true),
	).toBe(false);
	expect(coordinator.snapshot().phase).toBe("failed");
});

test("rejecting media recovery while resolving fails the current load", () => {
	const coordinator = new PlaybackSessionCoordinator();
	const session = coordinator.beginTrack("netease:first", 1)!;

	expect(
		coordinator.claimMediaErrorRecovery(session, "netease:first", true),
	).toBe(false);
	expect(coordinator.snapshot().phase).toBe("failed");
});

test("media recovery is claimed only when the current load accepts failure", () => {
	const coordinator = new PlaybackSessionCoordinator();
	const session = coordinator.beginTrack("netease:first", 1)!;
	loadAndPlay(coordinator, session);
	const reload = coordinator.beginReload("url-age")!;
	const resolving = coordinator.snapshot();

	expect(
		coordinator.claimMediaErrorRecovery(reload, "netease:first", true),
	).toBe(false);
	expect(coordinator.snapshot()).toBe(resolving);

	loadAndPlay(coordinator, reload);
	expect(
		coordinator.claimMediaErrorRecovery(reload, "netease:first", true),
	).toBe(true);
});

test("a media-error reload binds its reason and preserves the session", () => {
	const coordinator = new PlaybackSessionCoordinator();
	const session = coordinator.beginTrack("netease:first", 1)!;
	loadAndPlay(coordinator, session);
	coordinator.claimMediaErrorRecovery(session, "netease:first", true);

	const reload = coordinator.beginReload("media-error")!;

	expect(reload.reloadReason).toBe("media-error");
	expect(reload.playbackSessionId).toBe(session.playbackSessionId);
	expect(reload.playbackToken).toBeGreaterThan(session.playbackToken);
	expect(coordinator.snapshot().phase).toBe("recovering");
});

test("beginReload accepts only public reload reasons", () => {
	const reasons: readonly PlaybackReloadReason[] = [
		"long-pause",
		"url-age",
		"media-error",
	];
	for (const reason of reasons) {
		const coordinator = new PlaybackSessionCoordinator();
		const session = coordinator.beginTrack("netease:first")!;
		loadAndPlay(coordinator, session);

		const reload = coordinator.beginReload(reason);
		expect(reload?.reloadReason).toBe(reason);
	}

	const coordinator = new PlaybackSessionCoordinator();
	const session = coordinator.beginTrack("netease:first")!;
	loadAndPlay(coordinator, session);
	const playing = coordinator.snapshot();

	// @ts-expect-error quality 仅允许由音质失效流程内部触发
	expect(coordinator.beginReload("quality")).toBeNull();
	expect(coordinator.beginReload("quality" as any)).toBeNull();
	expect(coordinator.snapshot()).toBe(playing);
});

test("clear returns to idle and invalidates all old work", () => {
	const coordinator = new PlaybackSessionCoordinator();
	const session = coordinator.beginTrack("netease:first", 1)!;

	coordinator.clear();

	expect(coordinator.snapshot().phase).toBe("idle");
	expect(coordinator.snapshot().trackKey).toBe("");
	expect(coordinator.isPlaybackCurrent(session)).toBe(false);
	expect(coordinator.isLyricCurrent(session)).toBe(false);
});

test("idle reload attempts are rejected without committing fields", () => {
	const coordinator = new PlaybackSessionCoordinator();
	const idle = coordinator.snapshot();

	expect(coordinator.beginReload("url-age")).toBeNull();
	expect(coordinator.invalidateCurrentTrackLoad()).toBeNull();
	expect(coordinator.snapshot()).toBe(idle);
	const first = coordinator.beginTrack("netease:first")!;
	expect(first.playbackSessionId).toBe(1);
	expect(first.playbackToken).toBe(1);
	expect(first.lyricToken).toBe(1);
});

test("ended reload attempts preserve the current source policy", () => {
	const coordinator = new PlaybackSessionCoordinator();
	const session = coordinator.beginTrack("netease:first", 1)!;
	loadAndPlay(coordinator, session);
	expect(coordinator.markEnded(session)).toBe(true);
	const ended = coordinator.snapshot();
	const refreshReason = coordinator.refreshReason(PLAYBACK_URL_FAR_FUTURE_MS);

	expect(coordinator.beginReload("url-age")).toBeNull();
	expect(coordinator.invalidateCurrentTrackLoad()).toBeNull();
	expect(coordinator.snapshot()).toBe(ended);
	expect(coordinator.isPlaybackCurrent(session)).toBe(true);
	expect(coordinator.refreshReason(PLAYBACK_URL_FAR_FUTURE_MS)).toBe(
		refreshReason,
	);
});

test("markLoaded cannot replace a source in an illegal current phase", () => {
	const coordinator = new PlaybackSessionCoordinator();
	const session = coordinator.beginTrack("netease:first", 1)!;
	loadAndPlay(coordinator, session);
	const playing = coordinator.snapshot();

	expect(
		coordinator.markLoaded(session, { ...remoteSource(), local: true }),
	).toBe(false);
	expect(coordinator.snapshot()).toBe(playing);
	expect(coordinator.refreshReason(PLAYBACK_URL_FAR_FUTURE_MS)).toBe("url-age");
});

test("a superseding reload invalidates the pending quality handle", () => {
	const coordinator = new PlaybackSessionCoordinator();
	coordinator.beginTrack("netease:first", 1);
	const quality = coordinator.invalidateCurrentTrackLoad()!;
	const reload = coordinator.beginReload("url-age")!;

	expect(coordinator.isPlaybackCurrent(quality)).toBe(false);
	expect(coordinator.isPlaybackCurrent(reload)).toBe(true);
	expect(coordinator.beginTrack("netease:first", 1)).toBeNull();
});

test("old-session lifecycle events cannot mutate the current load", () => {
	const coordinator = new PlaybackSessionCoordinator();
	const first = coordinator.beginTrack("netease:first", 1)!;
	loadAndPlay(coordinator, first);
	const second = coordinator.beginTrack("netease:second", 2)!;
	load(coordinator, second, remoteSource("netease:second"));
	const loading = coordinator.snapshot();

	expect(coordinator.markPlaying(first)).toBe(false);
	expect(coordinator.snapshot()).toBe(loading);
	play(coordinator, second);
	const playing = coordinator.snapshot();
	expect(coordinator.markPaused(first, 5_000)).toBe(false);
	expect(coordinator.markEnded(first)).toBe(false);
	expect(
		coordinator.claimMediaErrorRecovery(first, "netease:second", true),
	).toBe(false);
	expect(coordinator.markRecoveryExhausted(first, "stale")).toBe(false);
	expect(coordinator.snapshot()).toBe(playing);
	expect(
		coordinator.claimMediaErrorRecovery(second, "netease:second", true),
	).toBe(true);
});

test("old-load lifecycle events cannot mutate a newer load in the same session", () => {
	const coordinator = new PlaybackSessionCoordinator();
	const first = coordinator.beginTrack("netease:first", 1)!;
	loadAndPlay(coordinator, first);
	const reload = coordinator.beginReload("url-age")!;
	load(coordinator, reload);
	const loading = coordinator.snapshot();

	expect(coordinator.markPlaying(first)).toBe(false);
	expect(coordinator.snapshot()).toBe(loading);
	play(coordinator, reload);
	const playing = coordinator.snapshot();
	expect(coordinator.markPaused(first, 5_000)).toBe(false);
	expect(coordinator.markEnded(first)).toBe(false);
	expect(
		coordinator.claimMediaErrorRecovery(first, "netease:first", true),
	).toBe(false);
	expect(coordinator.markRecoveryExhausted(first, "stale")).toBe(false);
	expect(coordinator.snapshot()).toBe(playing);
});

test("stale reload completion cannot restore the recovery budget", () => {
	const coordinator = new PlaybackSessionCoordinator();
	const session = coordinator.beginTrack("netease:first", 1)!;
	loadAndPlay(coordinator, session);
	coordinator.claimMediaErrorRecovery(session, "netease:first", true);
	const firstReload = coordinator.beginReload("url-age")!;
	const currentReload = coordinator.beginReload("url-age")!;
	load(coordinator, currentReload);
	const loading = coordinator.snapshot();

	expect(coordinator.completeReload(firstReload)).toBe(false);
	expect(coordinator.snapshot()).toBe(loading);
	expect(coordinator.snapshot().recoveryAttempts).toBe(1);
});

test("reload completion rejects forged metadata without internal authority", () => {
	const coordinator = new PlaybackSessionCoordinator();
	const session = coordinator.beginTrack("netease:first", 1)!;
	loadAndPlay(coordinator, session);
	expect(
		coordinator.claimMediaErrorRecovery(session, "netease:first", true),
	).toBe(true);
	const forged: PlaybackLoadHandle = {
		...session,
		reloadReason: "url-age",
	};

	expect(coordinator.completeReload(forged)).toBe(false);
	expect(coordinator.snapshot().recoveryAttempts).toBe(1);
});

test("reload completion uses the coordinator-bound reason", () => {
	const coordinator = new PlaybackSessionCoordinator();
	const session = coordinator.beginTrack("netease:first", 1)!;
	loadAndPlay(coordinator, session);
	coordinator.claimMediaErrorRecovery(session, "netease:first", true);
	const reload = coordinator.beginReload("media-error")!;
	load(coordinator, reload);
	let mutationRejected = false;
	try {
		Object.assign(reload, { reloadReason: "url-age" });
	} catch {
		mutationRejected = true;
	}
	expect(mutationRejected).toBe(true);
	expect(reload.reloadReason).toBe("media-error");

	expect(coordinator.completeReload(reload)).toBe(true);
	expect(coordinator.snapshot().recoveryAttempts).toBe(1);
});

test("reload completion authority is consumed once", () => {
	const coordinator = new PlaybackSessionCoordinator();
	const session = coordinator.beginTrack("netease:first", 1)!;
	loadAndPlay(coordinator, session);
	coordinator.claimMediaErrorRecovery(session, "netease:first", true);
	const reload = coordinator.beginReload("url-age")!;
	load(coordinator, reload);
	expect(coordinator.completeReload(reload)).toBe(true);
	play(coordinator, reload);
	expect(
		coordinator.claimMediaErrorRecovery(reload, "netease:first", true),
	).toBe(true);

	expect(coordinator.completeReload(reload)).toBe(false);
	expect(coordinator.snapshot().recoveryAttempts).toBe(1);
});

test("terminal helpers reject stale loads and advance current work", () => {
	const resolvingCoordinator = new PlaybackSessionCoordinator();
	const first = resolvingCoordinator.beginTrack("netease:first", 1)!;
	const current = resolvingCoordinator.beginReload("url-age")!;
	const resolving = resolvingCoordinator.snapshot();
	expect(resolvingCoordinator.markResolveFailed(first, "stale")).toBe(false);
	expect(resolvingCoordinator.snapshot()).toBe(resolving);
	expect(
		resolvingCoordinator.markResolveFailed(current, "no-source"),
	).toBe(true);
	expect(resolvingCoordinator.snapshot().failureReason).toBe("no-source");

	const playingCoordinator = new PlaybackSessionCoordinator();
	const playing = playingCoordinator.beginTrack("netease:first", 1)!;
	loadAndPlay(playingCoordinator, playing);
	expect(playingCoordinator.markEnded(playing)).toBe(true);
	expect(playingCoordinator.snapshot().phase).toBe("ended");

	const recoveringCoordinator = new PlaybackSessionCoordinator();
	const recovering = recoveringCoordinator.beginTrack("netease:first", 1)!;
	loadAndPlay(recoveringCoordinator, recovering);
	recoveringCoordinator.claimMediaErrorRecovery(
		recovering,
		"netease:first",
		true,
	);
	expect(
		recoveringCoordinator.markRecoveryExhausted(recovering, "retry-failed"),
	).toBe(true);
	expect(recoveringCoordinator.snapshot().failureReason).toBe("retry-failed");
});

test("a remote non-trial track receives only one automatic media recovery", () => {
	const coordinator = new PlaybackSessionCoordinator();
	const session = coordinator.beginTrack("netease:first")!;
	loadAndPlay(coordinator, session);

	expect(
		coordinator.claimMediaErrorRecovery(session, "netease:first", true),
	).toBe(true);
	expect(
		coordinator.claimMediaErrorRecovery(session, "netease:first", true),
	).toBe(false);
});

test("a long pause refreshes the remote source", () => {
	const coordinator = new PlaybackSessionCoordinator();
	const session = coordinator.beginTrack("netease:first")!;
	loadAndPlay(coordinator, session);
	expect(coordinator.markPaused(session, 5_000)).toBe(true);

	expect(coordinator.refreshReason(5_000 + 10 * 60 * 1_000)).toBe("long-pause");
});

test("an old remote URL refreshes without a recorded pause", () => {
	const coordinator = new PlaybackSessionCoordinator();
	const session = coordinator.beginTrack("netease:first")!;
	load(coordinator, session);

	expect(coordinator.refreshReason(PLAYBACK_URL_FAR_FUTURE_MS)).toBe("url-age");
});

test("resuming playback clears the long-pause refresh clock", () => {
	const coordinator = new PlaybackSessionCoordinator();
	const session = coordinator.beginTrack("netease:first")!;
	loadAndPlay(coordinator, session);
	coordinator.markPaused(session, 5_000);
	coordinator.markPlaying(session);

	expect(coordinator.refreshReason(5_000 + 10 * 60 * 1_000)).toBeNull();
});

test("a successful non-error refresh restores media recovery", () => {
	const coordinator = new PlaybackSessionCoordinator();
	const session = coordinator.beginTrack("netease:first")!;
	loadAndPlay(coordinator, session);
	coordinator.claimMediaErrorRecovery(session, "netease:first", true);
	const reload = coordinator.beginReload("url-age")!;
	load(coordinator, reload);
	expect(coordinator.completeReload(reload)).toBe(true);
	play(coordinator, reload);

	expect(
		coordinator.claimMediaErrorRecovery(reload, "netease:first", true),
	).toBe(true);
});

test("quality invalidation reuses the same session with fresh tokens", () => {
	const coordinator = new PlaybackSessionCoordinator();
	const first = coordinator.beginTrack("netease:first")!;
	const invalidated = coordinator.invalidateCurrentTrackLoad()!;
	const reloaded = coordinator.beginTrack(
		"netease:first",
		undefined,
		invalidated,
	)!;

	expect(reloaded).toBe(invalidated);
	expect(reloaded.playbackSessionId).toBe(first.playbackSessionId);
	expect(coordinator.isPlaybackCurrent(first)).toBe(false);
	expect(coordinator.isLyricCurrent(first)).toBe(false);
});

test("explicit quality invalidation returns its original one-shot handle", () => {
	const coordinator = new PlaybackSessionCoordinator();
	const first = coordinator.beginTrack("netease:first", 1)!;
	const invalidated = coordinator.invalidateCurrentTrackLoad()!;

	expect(coordinator.beginTrack("netease:first", 0)).toBeNull();
	const reloaded = coordinator.beginTrack("netease:first", 1, invalidated)!;

	expect(reloaded).toBe(invalidated);
	expect(reloaded.playbackSessionId).toBe(first.playbackSessionId);
	expect(reloaded.playbackToken).toBeGreaterThan(first.playbackToken);
	expect(reloaded.lyricToken).toBeGreaterThan(first.lyricToken);
	expect(coordinator.beginTrack("netease:first", 1)).toBeNull();
});

test("quality invalidation can only be claimed with its exact handle", () => {
	const coordinator = new PlaybackSessionCoordinator();
	coordinator.beginTrack("netease:first", 1);
	const stale = coordinator.invalidateCurrentTrackLoad()!;
	const current = coordinator.invalidateCurrentTrackLoad()!;

	expect(coordinator.beginTrack("netease:first", 1, stale)).toBeNull();
	expect(coordinator.beginTrack("netease:first", 1, current)).toBe(current);
});

test("a successful quality reload restores recovery for its current load", () => {
	const coordinator = new PlaybackSessionCoordinator();
	const first = coordinator.beginTrack("netease:first", 1)!;
	loadAndPlay(coordinator, first);
	coordinator.claimMediaErrorRecovery(first, "netease:first", true);
	const mediaReload = coordinator.beginReload("media-error")!;
	loadAndPlay(coordinator, mediaReload);
	expect(coordinator.snapshot().recoveryAttempts).toBe(1);

	const quality = coordinator.invalidateCurrentTrackLoad()!;
	const claimed = coordinator.beginTrack("netease:first", 1, quality)!;
	expect(claimed).toBe(quality);
	expect(coordinator.markLoaded(mediaReload, remoteSource())).toBe(false);
	expect(coordinator.snapshot().recoveryAttempts).toBe(1);
	load(coordinator, quality);
	expect(coordinator.snapshot().recoveryAttempts).toBe(0);
	play(coordinator, quality);

	expect(
		coordinator.claimMediaErrorRecovery(quality, "netease:first", true),
	).toBe(true);
});

test("a failed quality source does not reset recovery", () => {
	const coordinator = new PlaybackSessionCoordinator();
	const first = coordinator.beginTrack("netease:first", 1)!;
	loadAndPlay(coordinator, first);
	coordinator.claimMediaErrorRecovery(first, "netease:first", true);
	const mediaReload = coordinator.beginReload("media-error")!;
	loadAndPlay(coordinator, mediaReload);
	const quality = coordinator.invalidateCurrentTrackLoad()!;

	expect(coordinator.markResolveFailed(quality, "quality-failed")).toBe(true);
	expect(coordinator.snapshot().phase).toBe("failed");
	expect(coordinator.snapshot().recoveryAttempts).toBe(1);
});

test("local and trial media never claim automatic recovery", () => {
	for (const source of [
		{ local: true, trial: false },
		{ local: false, trial: true },
	]) {
		const coordinator = new PlaybackSessionCoordinator();
		const session = coordinator.beginTrack("netease:first")!;
		loadAndPlay(coordinator, session, { ...remoteSource(), ...source });

		expect(
			coordinator.claimMediaErrorRecovery(session, "netease:first", true),
		).toBe(false);
	}
});

test("long-pause takes priority when pause and URL age both expire", () => {
	const coordinator = new PlaybackSessionCoordinator();
	const session = coordinator.beginTrack("netease:first")!;
	loadAndPlay(coordinator, session);
	coordinator.markPaused(session, 5_000);

	expect(coordinator.refreshReason(PLAYBACK_URL_FAR_FUTURE_MS)).toBe("long-pause");
});

test("a media-error reload keeps the one-shot budget consumed", () => {
	const coordinator = new PlaybackSessionCoordinator();
	const session = coordinator.beginTrack("netease:first")!;
	loadAndPlay(coordinator, session);
	coordinator.claimMediaErrorRecovery(session, "netease:first", true);
	const reload = coordinator.beginReload("media-error")!;
	load(coordinator, reload);
	expect(coordinator.completeReload(reload)).toBe(true);
	play(coordinator, reload);

	expect(
		coordinator.claimMediaErrorRecovery(reload, "netease:first", true),
	).toBe(false);
});
