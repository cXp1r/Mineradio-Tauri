import { expect, test } from "bun:test";
import type { ProviderId, Track } from "@mineradio/shared";
import { clearSearchAfterPlayback, searchTracksForMode } from "./SearchShell";
import { useSearchStore } from "../../stores/search-store";

function makeTrack(id: string, provider: ProviderId = "netease"): Track {
	return {
		provider,
		id,
		sourceId: id,
		title: id,
		artists: ["Artist"],
		album: "Album",
		coverUrl: "",
		qualityHints: [],
		playableState: "playable",
	};
}

test("searchTracksForMode routes All through cross-source search", async () => {
	const calls: string[] = [];
	const client = {
		search: async (provider: ProviderId, keyword: string, limit: number) => {
			calls.push(`provider:${provider}:${keyword}:${limit}`);
			return [makeTrack(`${provider}-1`, provider)];
		},
		searchAll: async (keyword: string, limit: number) => {
			calls.push(`all:${keyword}:${limit}`);
			return [makeTrack("all-1")];
		},
	};

	await searchTracksForMode(client, "song", "遇见", 30);

	expect(calls).toEqual(["all:遇见:30"]);
});

test("searchTracksForMode keeps explicit provider modes provider-specific", async () => {
	const calls: string[] = [];
	const client = {
		search: async (provider: ProviderId, keyword: string, limit: number) => {
			calls.push(`provider:${provider}:${keyword}:${limit}`);
			return [makeTrack(`${provider}-1`, provider)];
		},
		searchAll: async (keyword: string, limit: number) => {
			calls.push(`all:${keyword}:${limit}`);
			return [makeTrack("all-1")];
		},
	};

	await searchTracksForMode(client, "netease", "晴天", 30);
	await searchTracksForMode(client, "qq", "夜航星", 30);

	expect(calls).toEqual(["provider:netease:晴天:30", "provider:qq:夜航星:30"]);
});

test("clearSearchAfterPlayback invalidates in-flight search before clearing UI state", () => {
	const calls: string[] = [];
	clearSearchAfterPlayback({
		nextSearchSeq: () => calls.push("nextSearchSeq"),
		setLoading: (loading) => calls.push(`loading:${loading}`),
		setKeyword: (keyword) => calls.push(`keyword:${keyword}`),
		setResults: (results) => calls.push(`results:${results.length}`),
		setError: (error) => calls.push(`error:${error ?? ""}`),
	});

	expect(calls).toEqual(["nextSearchSeq", "loading:false", "keyword:", "results:0", "error:"]);
});

test("search store opens full-screen detail with committed keyword and mode", () => {
	const store = useSearchStore.getState() as typeof useSearchStore extends { getState: () => infer S } ? S & {
		openDetail: (keyword: string, mode: "song" | "netease" | "qq" | "podcast") => void;
		detailOpen: boolean;
		mode: "song" | "netease" | "qq" | "podcast";
		recentQueries: Array<{ keyword: string; mode: "song" | "netease" | "qq" | "podcast" }>;
	} : never;

	store.openDetail("晴天", "song");
	const next = useSearchStore.getState() as typeof store;

	expect(next.detailOpen).toBe(true);
	expect(next.keyword).toBe("晴天");
	expect(next.mode).toBe("song");
	expect(next.recentQueries[0]).toEqual({ keyword: "晴天", mode: "song" });
});
