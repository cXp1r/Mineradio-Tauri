import { expect, test } from "bun:test";
import { usePlaybackStore } from "./playback-store";
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

test("setCurrentTrack sets the track and toggles play", () => {
	const store = usePlaybackStore.getState();
	usePlaybackStore.setState({
		currentTrack: null,
		isPlaying: false,
		queue: [],
		positionMs: 0,
		durationMs: null,
		mode: "queue",
	});
	store.setCurrentTrack(makeTrack("a"));
	expect(usePlaybackStore.getState().currentTrack?.id).toBe("a");
	store.togglePlay();
	expect(usePlaybackStore.getState().isPlaying).toBe(true);
});

test("next cycles a two-track queue in queue mode", () => {
	usePlaybackStore.setState({
		currentTrack: null,
		isPlaying: false,
		positionMs: 0,
		durationMs: null,
		mode: "queue",
		queue: [],
	});
	const a = makeTrack("a");
	const b = makeTrack("b");
	usePlaybackStore.getState().enqueue(a);
	usePlaybackStore.getState().enqueue(b);
	usePlaybackStore.getState().setCurrentTrack(a);
	usePlaybackStore.getState().next();
	expect(usePlaybackStore.getState().currentTrack?.id).toBe("b");
	usePlaybackStore.getState().next();
	expect(usePlaybackStore.getState().currentTrack?.id).toBe("a");
});

test("setQueue replaces the queue and playAt jumps to a specific track", () => {
	usePlaybackStore.setState({
		currentTrack: null,
		isPlaying: false,
		positionMs: 0,
		durationMs: null,
		mode: "queue",
		queue: [],
	});
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

test("next cycles a three-track queue and previous wraps", () => {
	usePlaybackStore.setState({
		currentTrack: null,
		isPlaying: false,
		positionMs: 0,
		durationMs: null,
		mode: "queue",
		queue: [],
	});
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

test("previous wraps from idx 0 in queue mode", () => {
	usePlaybackStore.setState({
		currentTrack: null,
		isPlaying: false,
		positionMs: 0,
		durationMs: null,
		mode: "queue",
		queue: [],
	});
	const store = usePlaybackStore.getState();
	store.setQueue([makeTrack("a"), makeTrack("b")]);
	store.playAt(0);
	store.previous();
	expect(usePlaybackStore.getState().currentTrack?.id).toBe("b");
});

test("previous in single mode stays on the same track", () => {
	usePlaybackStore.setState({
		currentTrack: null,
		isPlaying: false,
		positionMs: 0,
		durationMs: null,
		mode: "single",
		queue: [],
	});
	const store = usePlaybackStore.getState();
	store.setQueue([makeTrack("a"), makeTrack("b")]);
	store.playAt(1);
	store.previous();
	expect(usePlaybackStore.getState().currentTrack?.id).toBe("b");
});

test("previous in shuffle mode stays within bounds", () => {
	usePlaybackStore.setState({
		currentTrack: null,
		isPlaying: false,
		positionMs: 0,
		durationMs: null,
		mode: "shuffle",
		queue: [],
	});
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
	usePlaybackStore.setState({
		currentTrack: null,
		isPlaying: false,
		positionMs: 0,
		durationMs: null,
		mode: "queue",
		queue: [],
	});
	const store = usePlaybackStore.getState();
	store.setQueue([makeTrack("a"), makeTrack("c")]);
	store.insertAt(1, makeTrack("b"));
	expect(usePlaybackStore.getState().queue.map((t) => t.id).join(",")).toBe("a,b,c");
});