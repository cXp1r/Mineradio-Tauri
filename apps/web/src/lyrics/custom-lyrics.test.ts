import { beforeEach, expect, test } from "bun:test";
import type { LyricPayload, Track } from "@mineradio/shared";
import {
	CUSTOM_LYRIC_PREF_STORE_KEY,
	CUSTOM_LYRIC_STORE_KEY,
	getCustomLyricTextForTrack,
	readCustomLyricPrefs,
	readCustomLyricStore,
	resolveLyricsForTrack,
	deleteCustomLyricForTrack,
	saveCustomLyricForTrack,
	setCustomLyricPreferenceForTrack,
	trackCustomLyricKey,
} from "./custom-lyrics";

function track(overrides: Partial<Track> = {}): Track {
	return {
		provider: "netease",
		id: "42",
		sourceId: "42",
		title: "Song",
		artists: ["Artist"],
		album: "",
		coverUrl: "",
		qualityHints: [],
		playableState: "unknown",
		...overrides,
	};
}

function original(source = "fallback"): LyricPayload {
	return {
		provider: "netease",
		trackId: "42",
		lines: [{ timeMs: 0, text: "Song - Artist", source }],
		hasTranslation: false,
		isWordByWord: false,
	};
}

beforeEach(async () => {
	await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	(globalThis as unknown as { localStorage: Storage }).localStorage = window.localStorage;
	localStorage.clear();
});

test("trackCustomLyricKey follows baseline songCustomCoverKey-compatible keys", () => {
	expect(trackCustomLyricKey(track())).toBe("id:42");
	expect(trackCustomLyricKey(track({ provider: "qq", id: "abc", sourceId: "mid-1" }))).toBe("qq:mid-1");
	expect(trackCustomLyricKey({ ...track(), customCoverKey: "kept:key" } as Track & { customCoverKey: string })).toBe("kept:key");
});

test("readCustomLyricStore accepts legacy string and object entries", () => {
	localStorage.setItem(CUSTOM_LYRIC_STORE_KEY, JSON.stringify({
		"id:42": "legacy text",
		"qq:abc": { text: "object text", updatedAt: 12 },
		bad: { nope: true },
	}));
	const store = readCustomLyricStore();

	expect(store["id:42"]).toEqual({ text: "legacy text", updatedAt: 0 });
	expect(store["qq:abc"]).toEqual({ text: "object text", updatedAt: 12 });
	expect(store.bad).toBe(undefined);
});

test("getCustomLyricTextForTrack reads matching localStorage entry", () => {
	localStorage.setItem(CUSTOM_LYRIC_STORE_KEY, JSON.stringify({
		"id:42": { text: "自定义歌词", updatedAt: 1 },
	}));

	expect(getCustomLyricTextForTrack(track())).toBe("自定义歌词");
	expect(getCustomLyricTextForTrack(track({ id: "99", sourceId: "99" }))).toBeNull();
});

test("resolveLyricsForTrack applies custom text when original is fallback and respects pinned original preference", () => {
	localStorage.setItem(CUSTOM_LYRIC_STORE_KEY, JSON.stringify({
		"id:42": { text: "自定义第一句\n自定义第二句", updatedAt: 1 },
	}));

	const picked = resolveLyricsForTrack({ track: track(), original: original(), durationMs: 10000 });
	localStorage.setItem(CUSTOM_LYRIC_PREF_STORE_KEY, JSON.stringify({ "id:42": "original" }));
	const pinned = resolveLyricsForTrack({ track: track(), original: original(), durationMs: 10000 });

	expect(picked.source).toBe("custom");
	expect(picked.payload.lines[0].text).toBe("自定义第一句");
	expect(picked.payload.lines[0].durationMs).toBe(5000);
	expect(pinned.source).toBe("original");
	expect(pinned.payload.lines[0].text).toBe("Song - Artist");
});

test("readCustomLyricPrefs ignores invalid preference values", () => {
	localStorage.setItem(CUSTOM_LYRIC_PREF_STORE_KEY, JSON.stringify({
		"id:42": "custom",
		"qq:abc": "original",
		bad: "other",
	}));

	expect(readCustomLyricPrefs()).toEqual({
		"id:42": "custom",
		"qq:abc": "original",
	});
});

test("save and delete custom lyrics persist baseline store and preference entries", () => {
	const saved = saveCustomLyricForTrack(track({ durationMs: 10000 }), "第一句\n第二句", 123);
	expect(saved.lines.length).toBe(2);
	expect(readCustomLyricStore()["id:42"]).toEqual({ text: "第一句\n第二句", updatedAt: 123 });
	expect(readCustomLyricPrefs()["id:42"]).toBe("custom");

	expect(setCustomLyricPreferenceForTrack(track(), "original")).toBe(true);
	expect(readCustomLyricPrefs()["id:42"]).toBe("original");
	expect(deleteCustomLyricForTrack(track())).toBe(true);
	expect(readCustomLyricStore()["id:42"]).toBe(undefined);
	expect(readCustomLyricPrefs()["id:42"]).toBe(undefined);
});
