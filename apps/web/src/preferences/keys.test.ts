import { expect, test } from "bun:test";
import {
	M8_PREFERENCE_KEYS,
	SEARCH_HISTORY_PREFERENCE,
	normalizeSearchHistory,
} from "./keys";
import { createJsonPreferenceKey } from "../ports/preferences-repository";

test("search history accepts legacy shapes and keeps ten unique recent queries", () => {
	expect(
		normalizeSearchHistory({
			song: ["  周杰伦  ", "Taylor Swift", "周杰伦"],
			qq: ["林俊杰", "陈奕迅", "五月天", "孙燕姿", "王菲", "张学友"],
			podcast: ["科技", "历史", "音乐", "多余"],
		}),
	).toEqual([
		"周杰伦",
		"Taylor Swift",
		"林俊杰",
		"陈奕迅",
		"五月天",
		"孙燕姿",
		"王菲",
		"张学友",
		"科技",
		"历史",
	]);
	expect(SEARCH_HISTORY_PREFERENCE.parse({ items: ["A", "a", "B"] })).toEqual([
		"A",
		"B",
	]);
	expect(
		SEARCH_HISTORY_PREFERENCE.parse({
			modes: { song: ["嵌套歌曲"], qq: ["嵌套 QQ"] },
		}),
	).toEqual(["嵌套歌曲", "嵌套 QQ"]);
});

test("M8 preference catalog contains only unique typed keys", () => {
	const names = M8_PREFERENCE_KEYS.map((key) => key.name);
	expect(new Set(names).size).toBe(names.length);
	expect(names).toContain("search.history");
	expect(names).toContain("home.listenLedger.v2");
});

test("typed preference rejects a default that does not satisfy its schema", () => {
	let message = "";
	try {
		createJsonPreferenceKey<number>({
			name: "invalid.default",
			schemaVersion: 1,
			defaultValue: "not-a-number" as unknown as number,
			parse: (value) => (typeof value === "number" ? value : undefined),
		});
	} catch (error) {
		message = error instanceof Error ? error.message : String(error);
	}
	expect(message).toContain("PREFERENCE_DEFAULT_INVALID");
});
