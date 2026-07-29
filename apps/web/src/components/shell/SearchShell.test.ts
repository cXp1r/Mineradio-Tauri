import { expect, test } from "bun:test";
import { useSearchStore } from "../../stores/search-store";

test("search store opens full-screen detail without writing history before a successful result", () => {
	useSearchStore.setState({ recentQueries: [] });
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
	expect(next.recentQueries).toEqual([]);
});
