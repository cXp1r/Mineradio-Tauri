import { create } from "zustand";
import type { LyricPayload } from "@mineradio/shared";

export interface LyricsState {
	payload: LyricPayload | null;
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
	loading: false,
	error: null,
	currentIndex: -1,
	setPayload: (payload) =>
		set({
			payload,
			loading: false,
			error: null,
			currentIndex: -1,
		}),
	setLoading: (loading) => set({ loading }),
	setError: (error) => set({ error, loading: false }),
	setCurrentIndex: (index) => set({ currentIndex: index }),
	reset: () => set({ payload: null, loading: false, error: null, currentIndex: -1 }),
}));