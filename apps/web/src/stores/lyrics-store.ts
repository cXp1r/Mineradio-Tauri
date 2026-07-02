import { create } from "zustand";
import type { LyricPayload } from "@mineradio/shared";
import { getLyricIndex, type NormalizedLyricIndex } from "../lyrics/lyric-index";

export interface LyricsState {
	payload: LyricPayload | null;
	index: NormalizedLyricIndex;
	loading: boolean;
	error: string | null;
	currentIndex: number;
	setPayload: (payload: LyricPayload | null) => void;
	setLoading: (loading: boolean) => void;
	setError: (error: string | null) => void;
	setCurrentIndex: (index: number) => void;
	reset: () => void;
}

export const useLyricsStore = create<LyricsState>()((set) => ({
	payload: null,
	index: getLyricIndex(null),
	loading: false,
	error: null,
	currentIndex: -1,
	setPayload: (payload) =>
		set({
			payload,
			index: getLyricIndex(payload),
			loading: false,
			error: null,
			currentIndex: -1,
		}),
	setLoading: (loading) => set({ loading }),
	setError: (error) => set({ error, loading: false }),
	setCurrentIndex: (index) => set({ currentIndex: index }),
	reset: () =>
		set({
			payload: null,
			index: getLyricIndex(null),
			loading: false,
			error: null,
			currentIndex: -1,
		}),
}));
