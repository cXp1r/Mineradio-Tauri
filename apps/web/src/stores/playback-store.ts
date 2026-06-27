import { create } from "zustand";
import type { Track } from "@mineradio/shared";

export type PlaybackMode = "single" | "loop" | "queue" | "shuffle";

export interface PlaybackState {
	currentTrack: Track | null;
	isPlaying: boolean;
	positionMs: number;
	durationMs: number | null;
	mode: PlaybackMode;
	queue: Track[];
	setCurrentTrack: (track: Track | null) => void;
	togglePlay: () => void;
	setPosition: (ms: number) => void;
	setDuration: (ms: number | null) => void;
	setMode: (mode: PlaybackMode) => void;
	setQueue: (tracks: Track[]) => void;
	enqueue: (track: Track) => void;
	insertAt: (index: number, track: Track) => void;
	playAt: (index: number) => void;
	next: () => void;
	previous: () => void;
	clearQueue: () => void;
}

function trackRef(track: Track | null): string {
	return track ? `${track.provider}:${track.id}` : "";
}

export const usePlaybackStore = create<PlaybackState>()((set, get) => ({
	currentTrack: null,
	isPlaying: false,
	positionMs: 0,
	durationMs: null,
	mode: "queue",
	queue: [],
	setCurrentTrack: (track) =>
		set({
			currentTrack: track,
			positionMs: 0,
			durationMs: track?.durationMs ?? null,
		}),
	togglePlay: () => set((s) => ({ isPlaying: !s.isPlaying })),
	setPosition: (ms) => set({ positionMs: ms }),
	setDuration: (ms) => set({ durationMs: ms }),
	setMode: (mode) => set({ mode }),
	setQueue: (tracks) => set({ queue: tracks }),
	enqueue: (track) => set((s) => ({ queue: [...s.queue, track] })),
	insertAt: (index, track) =>
		set((s) => {
			const next = [...s.queue];
			const at = Math.max(0, Math.min(index, next.length));
			next.splice(at, 0, track);
			return { queue: next };
		}),
	playAt: (index) =>
		set((s) => {
			if (index < 0 || index >= s.queue.length) return {};
			const track = s.queue[index] ?? null;
			return {
				currentTrack: track,
				positionMs: 0,
				durationMs: track?.durationMs ?? null,
			};
		}),
	clearQueue: () => set({ queue: [] }),
	previous: () => {
		const { queue, currentTrack, mode } = get();
		if (queue.length === 0) return;
		const currentRef = trackRef(currentTrack);
		const currentIdx = currentTrack ? queue.findIndex((t) => trackRef(t) === currentRef) : -1;
		let prevIdx: number;
		if (mode === "shuffle") {
			const len = queue.length;
			prevIdx = currentIdx >= 0 ? (currentIdx - 1 + len) % len : 0;
		} else if (mode === "single") {
			prevIdx = currentIdx >= 0 ? currentIdx : 0;
		} else {
			const len = queue.length;
			prevIdx = currentIdx >= 0 ? (currentIdx - 1 + len) % len : 0;
		}
		const prevTrack = queue[prevIdx] ?? null;
		set({
			currentTrack: prevTrack,
			positionMs: 0,
			durationMs: prevTrack?.durationMs ?? null,
		});
	},
	next: () => {
		const { queue, currentTrack, mode } = get();
		if (queue.length === 0) return;
		const currentRef = trackRef(currentTrack);
		const currentIdx = currentTrack ? queue.findIndex((t) => trackRef(t) === currentRef) : -1;
		let nextIdx: number;
		if (mode === "shuffle") {
			nextIdx = queue.length === 1 ? 0 : Math.floor(Math.random() * queue.length);
		} else if (mode === "single") {
			nextIdx = currentIdx >= 0 ? currentIdx : 0;
		} else {
			nextIdx = (currentIdx + 1) % queue.length;
		}
		const nextTrack = queue[nextIdx] ?? null;
		set({
			currentTrack: nextTrack,
			positionMs: 0,
			durationMs: nextTrack?.durationMs ?? null,
		});
	},
}));