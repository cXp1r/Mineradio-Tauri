import { create } from "zustand";
import type { Track } from "@mineradio/shared";

export type PlaybackMode = "single" | "loop" | "queue" | "shuffle";

export interface PlaybackState {
	currentTrack: Track | null;
	playbackIntentId: number;
	isPlaying: boolean;
	positionMs: number;
	durationMs: number | null;
	volume: number;
	muted: boolean;
	mode: PlaybackMode;
	queue: Track[];
	setCurrentTrack: (track: Track | null) => void;
	setPlaying: (playing: boolean) => void;
	togglePlay: () => void;
	setPosition: (ms: number) => void;
	setDuration: (ms: number | null) => void;
	setVolume: (volume: number) => void;
	toggleMute: () => void;
	setMode: (mode: PlaybackMode) => void;
	setQueue: (tracks: Track[]) => void;
	enqueue: (track: Track) => void;
	insertAt: (index: number, track: Track) => void;
	insertNext: (track: Track) => void;
	playAt: (index: number) => void;
	removeAt: (index: number) => void;
	removeTrack: (track: Track) => void;
	next: () => void;
	previous: () => void;
	ended: () => void;
	clearQueue: () => void;
}

function nextPlaybackIntent(state: Pick<PlaybackState, "playbackIntentId">): number {
	return state.playbackIntentId + 1;
}

export function trackRef(track: Track | null): string {
	return track ? `${track.provider}:${track.id}` : "";
}

function playbackPatchForTrack(track: Track | null) {
	return {
		currentTrack: track,
		isPlaying: track ? true : false,
		positionMs: 0,
		durationMs: track?.durationMs ?? null,
	};
}

function stopPlaybackPatch() {
	return {
		currentTrack: null,
		isPlaying: false,
		positionMs: 0,
		durationMs: null,
	};
}

function findTrackIndex(queue: Track[], track: Track | null): number {
	if (!track) return -1;
	const identityIndex = queue.findIndex((item) => item === track);
	if (identityIndex >= 0) return identityIndex;
	const ref = trackRef(track);
	return ref ? queue.findIndex((item) => trackRef(item) === ref) : -1;
}

export function moveTrackToFront(queue: Track[], track: Track): Track[] {
	const ref = trackRef(track);
	if (!ref) return [track, ...queue];
	const existing = queue.find((item) => trackRef(item) === ref) ?? track;
	return [existing, ...queue.filter((item) => trackRef(item) !== ref)];
}

export const usePlaybackStore = create<PlaybackState>()((set, get) => ({
	currentTrack: null,
	playbackIntentId: 0,
	isPlaying: false,
	positionMs: 0,
	durationMs: null,
	volume: 0.84,
	muted: false,
	mode: "loop",
	queue: [],
	setCurrentTrack: (track) =>
		set((s) => ({
			...playbackPatchForTrack(track),
			playbackIntentId: nextPlaybackIntent(s),
		})),
	setPlaying: (playing) => set({ isPlaying: playing }),
	togglePlay: () => set((s) => ({ isPlaying: !s.isPlaying })),
	setPosition: (ms) => set({ positionMs: ms }),
	setDuration: (ms) => set({ durationMs: ms }),
	setVolume: (volume) => set({ volume: Math.max(0, Math.min(1, volume)), muted: volume <= 0 }),
	toggleMute: () => set((s) => ({ muted: !s.muted })),
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
	insertNext: (track) =>
		set((s) => {
			const targetRef = trackRef(track);
			const currentIdx = findTrackIndex(s.queue, s.currentTrack);
			const existingIdx = targetRef ? s.queue.findIndex((item) => trackRef(item) === targetRef) : -1;
			if (existingIdx === currentIdx && currentIdx >= 0) return {};

			const next = [...s.queue];
			const moved = existingIdx >= 0 ? next.splice(existingIdx, 1)[0] : track;
			let adjustedCurrentIdx = currentIdx;
			if (existingIdx >= 0 && existingIdx < currentIdx) adjustedCurrentIdx -= 1;

			if (adjustedCurrentIdx < 0) {
				next.push(moved);
				return { queue: next };
			}

			const insertAt = Math.min(next.length, adjustedCurrentIdx + 1);
			next.splice(insertAt, 0, moved);
			return { queue: next };
		}),
	playAt: (index) =>
		set((s) => {
			if (index < 0 || index >= s.queue.length) return {};
			const track = s.queue[index] ?? null;
			return {
				...playbackPatchForTrack(track),
				playbackIntentId: nextPlaybackIntent(s),
			};
		}),
	removeAt: (index) =>
		set((s) => {
			if (index < 0 || index >= s.queue.length) return {};
			const currentIdx = findTrackIndex(s.queue, s.currentTrack);
			const next = s.queue.filter((_, itemIdx) => itemIdx !== index);
			if (index !== currentIdx) return { queue: next };

			const nextCurrent = next[Math.min(index, next.length - 1)] ?? null;
			return {
				queue: next,
				...playbackPatchForTrack(nextCurrent),
				...(nextCurrent ? {} : { isPlaying: false }),
				playbackIntentId: nextPlaybackIntent(s),
			};
		}),
	removeTrack: (track) =>
		set((s) => {
			const ref = trackRef(track);
			if (!ref) return {};
			const firstRemovedIdx = s.queue.findIndex((item) => trackRef(item) === ref);
			if (firstRemovedIdx < 0) return {};
			const currentRemoved = trackRef(s.currentTrack) === ref;
			const next = s.queue.filter((item) => trackRef(item) !== ref);
			if (!currentRemoved) return { queue: next };

			const nextCurrent = next[Math.min(firstRemovedIdx, next.length - 1)] ?? null;
			return {
				queue: next,
				...playbackPatchForTrack(nextCurrent),
				...(nextCurrent ? {} : { isPlaying: false }),
				playbackIntentId: nextPlaybackIntent(s),
			};
		}),
	clearQueue: () =>
		set((s) => ({
			queue: [],
			...stopPlaybackPatch(),
			playbackIntentId: nextPlaybackIntent(s),
		})),
	previous: () =>
		set((s) => {
			if (s.queue.length === 0) return s;
			const currentIdx = findTrackIndex(s.queue, s.currentTrack);
			let prevIdx: number;
			if (s.mode === "shuffle") {
				const len = s.queue.length;
				prevIdx = currentIdx >= 0 ? (currentIdx - 1 + len) % len : 0;
			} else if (s.mode === "single") {
				prevIdx = currentIdx >= 0 ? currentIdx : 0;
			} else {
				const len = s.queue.length;
				prevIdx = currentIdx >= 0 ? (currentIdx - 1 + len) % len : 0;
			}
			const prevTrack = s.queue[prevIdx] ?? null;
			return {
				...playbackPatchForTrack(prevTrack),
				playbackIntentId: nextPlaybackIntent(s),
			};
		}),
	next: () =>
		set((s) => {
			if (s.queue.length === 0) {
				return {
					...stopPlaybackPatch(),
					playbackIntentId: nextPlaybackIntent(s),
				};
			}
			const currentIdx = findTrackIndex(s.queue, s.currentTrack);
			let nextIdx: number;
			if (s.mode === "shuffle") {
				if (s.queue.length === 1) {
					nextIdx = 0;
				} else {
					const randomIdx = Math.floor(Math.random() * (s.queue.length - 1));
					nextIdx = currentIdx >= 0 && randomIdx >= currentIdx ? randomIdx + 1 : randomIdx;
				}
			} else if (s.mode === "single") {
				nextIdx = currentIdx >= 0 ? currentIdx : 0;
			} else if (s.mode === "loop") {
				nextIdx = (currentIdx + 1) % s.queue.length;
			} else {
				const candidate = currentIdx + 1;
				if (candidate >= s.queue.length) {
					return {
						...stopPlaybackPatch(),
						playbackIntentId: nextPlaybackIntent(s),
					};
				}
				nextIdx = candidate;
			}
			const nextTrack = s.queue[nextIdx] ?? null;
			return {
				...playbackPatchForTrack(nextTrack),
				playbackIntentId: nextPlaybackIntent(s),
			};
		}),
	ended: () => {
		if (get().mode === "single") {
			set((s) => {
				const currentIdx = findTrackIndex(s.queue, s.currentTrack);
				const track = currentIdx >= 0 ? s.queue[currentIdx] : s.currentTrack;
				return {
					...playbackPatchForTrack(track),
					playbackIntentId: nextPlaybackIntent(s),
				};
			});
			return;
		}
		get().next();
	},
}));
