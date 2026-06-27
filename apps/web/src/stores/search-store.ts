import { create } from "zustand";
import type { ProviderId, Track } from "@mineradio/shared";

export interface SearchState {
	results: Track[];
	loading: boolean;
	error: string | null;
	provider: ProviderId;
	keyword: string;
	setProvider: (provider: ProviderId) => void;
	setKeyword: (keyword: string) => void;
	setLoading: (loading: boolean) => void;
	setError: (error: string | null) => void;
	setResults: (results: Track[]) => void;
	reset: () => void;
}

export const useSearchStore = create<SearchState>()((set) => ({
	results: [],
	loading: false,
	error: null,
	provider: "netease",
	keyword: "",
	setProvider: (provider) => set({ provider }),
	setKeyword: (keyword) => set({ keyword }),
	setLoading: (loading) => set({ loading }),
	setError: (error) => set({ error, loading: false }),
	setResults: (results) => set({ results, error: null, loading: false }),
	reset: () => set({ results: [], loading: false, error: null, keyword: "" }),
}));