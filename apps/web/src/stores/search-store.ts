import { create } from "zustand";
import type {
	PodcastProgram,
	PodcastRadio,
	ProviderId,
	Track,
} from "@mineradio/shared";

export type SearchMode = "song" | "netease" | "qq" | "podcast";

export interface SearchRecentQuery {
	keyword: string;
	mode: SearchMode;
}

export interface SearchState {
	results: Track[];
	podcasts: PodcastRadio[];
	programs: PodcastProgram[];
	selectedPodcast: PodcastRadio | null;
	loading: boolean;
	loadingNext: boolean;
	error: string | null;
	exhausted: boolean;
	visibleCount: number;
	generation: number;
	provider: ProviderId;
	keyword: string;
	committedKeyword: string;
	mode: SearchMode;
	detailOpen: boolean;
	recentQueries: SearchRecentQuery[];
	setProvider: (provider: ProviderId) => void;
	setKeyword: (keyword: string) => void;
	setMode: (mode: SearchMode) => void;
	setLoading: (loading: boolean) => void;
	setError: (error: string | null) => void;
	setResults: (results: Track[]) => void;
	openDetail: (keyword: string, mode: SearchMode) => void;
	closeDetail: () => void;
	reset: () => void;
}

export const useSearchStore = create<SearchState>()((set) => ({
	results: [],
	podcasts: [],
	programs: [],
	selectedPodcast: null,
	loading: false,
	loadingNext: false,
	error: null,
	exhausted: true,
	visibleCount: 0,
	generation: 0,
	provider: "netease",
	keyword: "",
	committedKeyword: "",
	mode: "song",
	detailOpen: false,
	recentQueries: [],
	setProvider: (provider) => set({ provider }),
	setKeyword: (keyword) => set({ keyword }),
	setMode: (mode) => set({ mode }),
	setLoading: (loading) => set({ loading }),
	setError: (error) => set({ error, loading: false }),
	setResults: (results) => set({
		results,
		podcasts: [],
		programs: [],
		selectedPodcast: null,
		visibleCount: results.length,
		error: null,
		loading: false,
	}),
	openDetail: (keyword, mode) =>
		set(() => ({
			keyword,
			mode,
			detailOpen: true,
		})),
	closeDetail: () => set({ detailOpen: false }),
	reset: () => set((state) => ({
		results: [],
		podcasts: [],
		programs: [],
		selectedPodcast: null,
		loading: false,
		loadingNext: false,
		error: null,
		exhausted: true,
		visibleCount: 0,
		keyword: "",
		committedKeyword: "",
		detailOpen: false,
		generation: state.generation + 1,
	})),
}));
