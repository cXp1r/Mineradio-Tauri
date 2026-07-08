import { create } from "zustand";
import type { ProviderId, Track } from "@mineradio/shared";

export type SearchMode = "song" | "netease" | "qq" | "podcast";

export interface SearchRecentQuery {
	keyword: string;
	mode: SearchMode;
}

export interface SearchState {
	results: Track[];
	loading: boolean;
	error: string | null;
	provider: ProviderId;
	keyword: string;
	mode: SearchMode;
	detailOpen: boolean;
	recentQueries: SearchRecentQuery[];
	setProvider: (provider: ProviderId) => void;
	setKeyword: (keyword: string) => void;
	setMode: (mode: SearchMode) => void;
	setLoading: (loading: boolean) => void;
	setError: (error: string | null) => void;
	setResults: (results: Track[]) => void;
	addRecentQuery: (keyword: string, mode: SearchMode) => void;
	openDetail: (keyword: string, mode: SearchMode) => void;
	closeDetail: () => void;
	reset: () => void;
}

function normalizeRecentKeyword(keyword: string): string {
	return keyword.trim();
}

function nextRecentQueries(
	previous: SearchRecentQuery[],
	keyword: string,
	mode: SearchMode,
): SearchRecentQuery[] {
	const trimmed = normalizeRecentKeyword(keyword);
	if (!trimmed && mode !== "podcast") return previous;
	const query = { keyword: trimmed, mode };
	const key = `${mode}:${trimmed}`;
	return [
		query,
		...previous.filter((item) => `${item.mode}:${item.keyword}` !== key),
	].slice(0, 8);
}

export const useSearchStore = create<SearchState>()((set) => ({
	results: [],
	loading: false,
	error: null,
	provider: "netease",
	keyword: "",
	mode: "song",
	detailOpen: false,
	recentQueries: [],
	setProvider: (provider) => set({ provider }),
	setKeyword: (keyword) => set({ keyword }),
	setMode: (mode) => set({ mode }),
	setLoading: (loading) => set({ loading }),
	setError: (error) => set({ error, loading: false }),
	setResults: (results) => set({ results, error: null, loading: false }),
	addRecentQuery: (keyword, mode) =>
		set((state) => ({
			recentQueries: nextRecentQueries(state.recentQueries, keyword, mode),
		})),
	openDetail: (keyword, mode) =>
		set((state) => ({
			keyword,
			mode,
			detailOpen: true,
			recentQueries: nextRecentQueries(state.recentQueries, keyword, mode),
		})),
	closeDetail: () => set({ detailOpen: false }),
	reset: () => set({ results: [], loading: false, error: null, keyword: "", detailOpen: false }),
}));
