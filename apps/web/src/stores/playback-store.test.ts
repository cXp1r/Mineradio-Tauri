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
