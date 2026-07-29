import { beforeEach, expect, test } from "bun:test";
import { moveTrackToFront, usePlaybackStore } from "./playback-store";
import type { Track } from "@mineradio/shared";

function makeTrack(id: string): Track {
	return {
		provider: "netease",
		id,
		sourceId: id,
		title: id,
		artists: [],
		album: "",
		coverUrl: "",
		qualityHints: [],
		playableState: "unknown",
	};
}

function resetStore() {
	usePlaybackStore.setState({
		currentTrack: null,
		playbackIntentId: 0,
		isPlaying: false,
		positionMs: 0,
		durationMs: null,
		volume: 0.84,
		muted: false,
		mode: "loop",
		queue: [],
	});
}

beforeEach(() => {
	resetStore();
});

test("setCurrentTrack sets the track and toggles play", () => {
	const store = usePlaybackStore.getState();
	store.setCurrentTrack(makeTrack("a"));
	expect(usePlaybackStore.getState().currentTrack?.id).toBe("a");
	store.setPlaying(true);
	expect(usePlaybackStore.getState().isPlaying).toBe(true);
	store.setPlaying(false);
	expect(usePlaybackStore.getState().isPlaying).toBe(false);
	store.togglePlay();
	expect(usePlaybackStore.getState().isPlaying).toBe(true);
});

test("next in queue mode advances and stops at the end", () => {
	const a = makeTrack("a");
	const b = makeTrack("b");
	usePlaybackStore.getState().setMode("queue");
	usePlaybackStore.getState().enqueue(a);
	usePlaybackStore.getState().enqueue(b);
	usePlaybackStore.getState().setCurrentTrack(a);
	usePlaybackStore.getState().next();
	expect(usePlaybackStore.getState().currentTrack?.id).toBe("b");
	usePlaybackStore.getState().next();
	expect(usePlaybackStore.getState().currentTrack).toBeNull();
	expect(usePlaybackStore.getState().isPlaying).toBe(false);
});

test("default playback mode follows baseline loop mode", () => {
	expect(usePlaybackStore.getState().mode).toBe("loop");
});

test("setQueue replaces the queue and playAt jumps to a specific track", () => {
	const store = usePlaybackStore.getState();
	const a = makeTrack("a");
	const b = makeTrack("b");
	const c = makeTrack("c");
	store.setQueue([a, b, c]);
	expect(usePlaybackStore.getState().queue.length).toBe(3);
	store.playAt(2);
	expect(usePlaybackStore.getState().currentTrack?.id).toBe("c");
	expect(usePlaybackStore.getState().positionMs).toBe(0);
});

test("next cycles a three-track queue in loop mode and previous wraps", () => {
	usePlaybackStore.getState().setMode("loop");
	const store = usePlaybackStore.getState();
	const tracks = [makeTrack("a"), makeTrack("b"), makeTrack("c")];
	store.setQueue(tracks);
	store.playAt(0);
	store.next();
	expect(usePlaybackStore.getState().currentTrack?.id).toBe("b");
	store.next();
	expect(usePlaybackStore.getState().currentTrack?.id).toBe("c");
	store.next();
	expect(usePlaybackStore.getState().currentTrack?.id).toBe("a");
	store.previous();
	expect(usePlaybackStore.getState().currentTrack?.id).toBe("c");
	store.previous();
	expect(usePlaybackStore.getState().currentTrack?.id).toBe("b");
});

test("previous wraps from idx 0 in queue mode like the baseline control", () => {
	const store = usePlaybackStore.getState();
	store.setQueue([makeTrack("a"), makeTrack("b")]);
	store.playAt(0);
	store.previous();
	expect(usePlaybackStore.getState().currentTrack?.id).toBe("b");
});

test("previous in single mode stays on the same track", () => {
	usePlaybackStore.getState().setMode("single");
	const store = usePlaybackStore.getState();
	store.setQueue([makeTrack("a"), makeTrack("b")]);
	store.playAt(1);
	store.previous();
	expect(usePlaybackStore.getState().currentTrack?.id).toBe("b");
});

test("previous in shuffle mode stays within bounds", () => {
	usePlaybackStore.getState().setMode("shuffle");
	const store = usePlaybackStore.getState();
	store.setQueue([makeTrack("a"), makeTrack("b"), makeTrack("c")]);
	store.playAt(2);
	const before = 2;
	store.previous();
	const idx = usePlaybackStore.getState().queue.findIndex(
		(t) => t.id === usePlaybackStore.getState().currentTrack?.id,
	);
	expect(idx).toBeGreaterThanOrEqual(0);
	expect(idx).toBeLessThan(3);
	void before;
});

test("insertAt inserts a track at the given index", () => {
	const store = usePlaybackStore.getState();
	store.setQueue([makeTrack("a"), makeTrack("c")]);
	store.insertAt(1, makeTrack("b"));
	expect(usePlaybackStore.getState().queue.map((t) => t.id).join(",")).toBe("a,b,c");
});

test("insertNext dedupes and moves an existing later track after the current track", () => {
	const store = usePlaybackStore.getState();
	const tracks = [makeTrack("a"), makeTrack("b"), makeTrack("c"), makeTrack("d")];
	store.setQueue(tracks);
	store.playAt(0);
	store.insertNext(tracks[2]);
	expect(usePlaybackStore.getState().queue.map((t) => t.id).join(",")).toBe("a,c,b,d");
	expect(usePlaybackStore.getState().currentTrack?.id).toBe("a");
});

test("insertNext dedupes and preserves current track when moving an earlier item", () => {
	const store = usePlaybackStore.getState();
	const tracks = [makeTrack("a"), makeTrack("b"), makeTrack("c")];
	store.setQueue(tracks);
	store.playAt(2);
	store.insertNext(tracks[0]);
	expect(usePlaybackStore.getState().queue.map((t) => t.id).join(",")).toBe("b,c,a");
	expect(usePlaybackStore.getState().currentTrack?.id).toBe("c");
});

test("insertNext appends without auto-start when there is no current track", () => {
	const store = usePlaybackStore.getState();
	store.insertNext(makeTrack("a"));
	expect(usePlaybackStore.getState().queue.map((t) => t.id)).toEqual(["a"]);
	expect(usePlaybackStore.getState().currentTrack).toBeNull();
	expect(usePlaybackStore.getState().isPlaying).toBe(false);
});

test("removeAt removes tracks and advances current track identity safely", () => {
	const store = usePlaybackStore.getState();
	const tracks = [makeTrack("a"), makeTrack("b"), makeTrack("c")];
	store.setQueue(tracks);
	store.playAt(1);
	store.removeAt(0);
	expect(usePlaybackStore.getState().queue.map((t) => t.id).join(",")).toBe("b,c");
	expect(usePlaybackStore.getState().currentTrack?.id).toBe("b");
	store.removeAt(0);
	expect(usePlaybackStore.getState().queue.map((t) => t.id)).toEqual(["c"]);
	expect(usePlaybackStore.getState().currentTrack?.id).toBe("c");
});

test("removeTrack removes every matching track reference", () => {
	const store = usePlaybackStore.getState();
	const a = makeTrack("a");
	const b = makeTrack("b");
	store.setQueue([a, b, makeTrack("a")]);
	store.playAt(0);
	store.removeTrack(a);
	expect(usePlaybackStore.getState().queue.map((t) => t.id)).toEqual(["b"]);
	expect(usePlaybackStore.getState().currentTrack?.id).toBe("b");
});

test("clearQueue clears current playback timing state", () => {
	const store = usePlaybackStore.getState();
	store.setQueue([makeTrack("a")]);
	store.playAt(0);
	store.togglePlay();
	store.setPosition(1200);
	store.setDuration(5000);
	store.clearQueue();
	expect(usePlaybackStore.getState().queue).toEqual([]);
	expect(usePlaybackStore.getState().currentTrack).toBeNull();
	expect(usePlaybackStore.getState().positionMs).toBe(0);
	expect(usePlaybackStore.getState().durationMs).toBeNull();
	expect(usePlaybackStore.getState().isPlaying).toBe(false);
});

test("volume and mute controls clamp values like the baseline console", () => {
	const store = usePlaybackStore.getState();
	store.setVolume(1.8);
	expect(usePlaybackStore.getState().volume).toBe(1);
	expect(usePlaybackStore.getState().muted).toBe(false);
	store.setVolume(0);
	expect(usePlaybackStore.getState().volume).toBe(0);
	expect(usePlaybackStore.getState().muted).toBe(true);
	store.toggleMute();
	expect(usePlaybackStore.getState().muted).toBe(false);
});

test("next in single mode restarts the current track", () => {
	const store = usePlaybackStore.getState();
	store.setMode("single");
	store.setQueue([makeTrack("a"), makeTrack("b")]);
	store.playAt(1);
	store.setPosition(1200);
	store.next();
	expect(usePlaybackStore.getState().currentTrack?.id).toBe("b");
	expect(usePlaybackStore.getState().positionMs).toBe(0);
});

test("shuffle next keeps selection in bounds and avoids the same track when possible", () => {
	const originalRandom = Math.random;
	Math.random = () => 0;
	try {
		const store = usePlaybackStore.getState();
		store.setMode("shuffle");
		store.setQueue([makeTrack("a"), makeTrack("b"), makeTrack("c")]);
		store.playAt(0);
		store.next();
		expect(usePlaybackStore.getState().currentTrack?.id).toBe("b");
	} finally {
		Math.random = originalRandom;
	}
});

test("moveTrackToFront dedupes by provider and id", () => {
	const tracks = [makeTrack("a"), makeTrack("b"), makeTrack("a")];
	const result = moveTrackToFront(tracks, makeTrack("a"));
	expect(result.map((t) => t.id)).toEqual(["a", "b"]);
});

test("playback intent starts at zero and advances for every setCurrentTrack call", () => {
	const track = makeTrack("a");
	const store = usePlaybackStore.getState();
	expect(store.playbackIntentId).toBe(0);
	store.setCurrentTrack(track);
	expect(usePlaybackStore.getState().playbackIntentId).toBe(1);
	store.setCurrentTrack(track);
	expect(usePlaybackStore.getState().playbackIntentId).toBe(2);
	store.setCurrentTrack(null);
	expect(usePlaybackStore.getState().playbackIntentId).toBe(3);
});

test("valid playAt and queue navigation advance playback intent", () => {
	const tracks = [makeTrack("a"), makeTrack("b")];
	const store = usePlaybackStore.getState();
	store.setQueue(tracks);
	store.playAt(0);
	expect(usePlaybackStore.getState().playbackIntentId).toBe(1);
	store.next();
	expect(usePlaybackStore.getState().playbackIntentId).toBe(2);
	store.previous();
	expect(usePlaybackStore.getState().playbackIntentId).toBe(3);
});

test("single ended restarts playback with a new intent", () => {
	const track = makeTrack("a");
	const store = usePlaybackStore.getState();
	store.setMode("single");
	store.setQueue([track]);
	store.playAt(0);
	store.setPosition(1200);
	store.ended();
	expect(usePlaybackStore.getState().currentTrack).toBe(track);
	expect(usePlaybackStore.getState().positionMs).toBe(0);
	expect(usePlaybackStore.getState().playbackIntentId).toBe(2);
});

test("non-single ended delegates to next with exactly one new intent", () => {
	const tracks = [makeTrack("a"), makeTrack("b")];
	const store = usePlaybackStore.getState();
	store.setQueue(tracks);
	store.playAt(0);
	store.ended();
	expect(usePlaybackStore.getState().currentTrack).toBe(tracks[1]);
	expect(usePlaybackStore.getState().playbackIntentId).toBe(2);
});

test("clearQueue emits a stop intent even when the queue is already empty", () => {
	const store = usePlaybackStore.getState();
	store.clearQueue();
	expect(usePlaybackStore.getState().playbackIntentId).toBe(1);
	store.clearQueue();
	expect(usePlaybackStore.getState().playbackIntentId).toBe(2);
});

test("next emits stop intents for an empty queue and the end of queue mode", () => {
	const store = usePlaybackStore.getState();
	store.next();
	expect(usePlaybackStore.getState().currentTrack).toBeNull();
	expect(usePlaybackStore.getState().playbackIntentId).toBe(1);

	const track = makeTrack("a");
	store.setMode("queue");
	store.setQueue([track]);
	store.playAt(0);
	store.next();
	expect(usePlaybackStore.getState().currentTrack).toBeNull();
	expect(usePlaybackStore.getState().playbackIntentId).toBe(3);
});

test("removing the current item advances intent while removing another item does not", () => {
	const tracks = [makeTrack("a"), makeTrack("b"), makeTrack("c")];
	const store = usePlaybackStore.getState();
	store.setQueue(tracks);
	store.playAt(1);
	store.removeAt(0);
	expect(usePlaybackStore.getState().playbackIntentId).toBe(1);
	store.removeAt(0);
	expect(usePlaybackStore.getState().currentTrack).toBe(tracks[2]);
	expect(usePlaybackStore.getState().playbackIntentId).toBe(2);
});

test("removeTrack only advances intent when it removes the current track", () => {
	const tracks = [makeTrack("a"), makeTrack("b")];
	const store = usePlaybackStore.getState();
	store.setQueue(tracks);
	store.playAt(0);
	store.removeTrack(tracks[1]);
	expect(usePlaybackStore.getState().playbackIntentId).toBe(1);
	store.removeTrack(tracks[0]);
	expect(usePlaybackStore.getState().currentTrack).toBeNull();
	expect(usePlaybackStore.getState().playbackIntentId).toBe(2);
});

test("invalid playAt and previous without a queue do not advance intent", () => {
	const store = usePlaybackStore.getState();
	store.playAt(-1);
	store.playAt(0);
	store.previous();
	expect(usePlaybackStore.getState().playbackIntentId).toBe(0);
});

test("previous without a queue does not notify subscribers", () => {
	let notifications = 0;
	const unsubscribe = usePlaybackStore.subscribe(() => {
		notifications += 1;
	});
	try {
		usePlaybackStore.getState().previous();
		expect(notifications).toBe(0);
	} finally {
		unsubscribe();
	}
});

test("non-playback state and queue edits do not advance intent", () => {
	const store = usePlaybackStore.getState();
	const a = makeTrack("a");
	const b = makeTrack("b");
	store.setPlaying(true);
	store.togglePlay();
	store.setPosition(100);
	store.setDuration(200);
	store.setVolume(0.5);
	store.toggleMute();
	store.setMode("queue");
	store.setQueue([a]);
	store.enqueue(b);
	store.insertAt(1, makeTrack("c"));
	store.insertNext(makeTrack("d"));
	expect(usePlaybackStore.getState().playbackIntentId).toBe(0);
});

test("replaceCurrentSource 原子替换当前队列项并保留位置", () => {
	const original = makeTrack("original");
	const next = makeTrack("next");
	const candidate = { ...original, provider: "qq" as const, id: "qq-source" };
	const store = usePlaybackStore.getState();
	store.setQueue([original, next]);
	store.playAt(0);
	store.setPosition(54_321);
	const expectedIntent = usePlaybackStore.getState().playbackIntentId;

	const committed = usePlaybackStore.getState().replaceCurrentSource({
		candidate,
		expectedPlaybackIntentId: expectedIntent,
		preservePositionMs: 54_321,
	});

	expect(committed).toBe(true);
	const state = usePlaybackStore.getState();
	expect(state.queue[0]).toBe(candidate);
	expect(state.queue[1]).toBe(next);
	expect(state.currentTrack).toBe(candidate);
	expect(state.positionMs).toBe(54_321);
	expect(state.playbackIntentId).toBe(expectedIntent + 1);
});

test("replaceCurrentSource 拒绝过期 intent 且不改变队列", () => {
	const original = makeTrack("original");
	const candidate = { ...original, provider: "qq" as const, id: "qq-source" };
	const store = usePlaybackStore.getState();
	store.setQueue([original]);
	store.playAt(0);
	const before = usePlaybackStore.getState();

	const committed = store.replaceCurrentSource({
		candidate,
		expectedPlaybackIntentId: before.playbackIntentId - 1,
		preservePositionMs: 5_000,
	});

	expect(committed).toBe(false);
	expect(usePlaybackStore.getState().queue).toEqual(before.queue);
	expect(usePlaybackStore.getState().currentTrack).toBe(before.currentTrack);
	expect(usePlaybackStore.getState().playbackIntentId).toBe(before.playbackIntentId);
});
