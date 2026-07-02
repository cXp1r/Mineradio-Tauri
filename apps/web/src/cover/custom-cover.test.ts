import { beforeEach, expect, test } from "bun:test";
import type { Track } from "@mineradio/shared";
import {
	CUSTOM_COVER_STORE_KEY,
	saveCustomCoverForTrack,
	withStoredCustomCover,
} from "./custom-cover";

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

function dataImage(chars: number): string {
	return `data:image/png;base64,${"a".repeat(chars)}`;
}

beforeEach(async () => {
	await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	(globalThis as unknown as { localStorage: Storage }).localStorage = window.localStorage;
	localStorage.clear();
});

test("saveCustomCoverForTrack keeps oversized covers in memory but skips localStorage persistence", () => {
	const largeCover = dataImage(1_100_000);
	const result = saveCustomCoverForTrack(track(), largeCover);

	expect(result.saved).toBe(false);
	expect(result.track.coverUrl).toBe(largeCover);
	expect((result.track as Track & { customCover?: string }).customCover).toBe(largeCover);
	expect(localStorage.getItem(CUSTOM_COVER_STORE_KEY)).toBeNull();
});

test("saveCustomCoverForTrack prunes old custom covers to keep localStorage bounded", () => {
	for (let i = 0; i < 6; i += 1) {
		const cover = dataImage(420_000);
		const result = saveCustomCoverForTrack(track({ id: String(i), sourceId: String(i) }), cover);
		expect(result.track.coverUrl).toBe(cover);
	}

	const raw = localStorage.getItem(CUSTOM_COVER_STORE_KEY) ?? "{}";
	const stored = JSON.parse(raw) as Record<string, string>;
	expect(raw.length).toBeLessThanOrEqual(2_000_000);
	expect(stored["id:0"]).toBe(undefined);
	expect(stored["id:5"]).toBe(dataImage(420_000));
	expect(withStoredCustomCover(track({ id: "0", sourceId: "0" })).coverUrl).toBe("");
	expect(withStoredCustomCover(track({ id: "5", sourceId: "5" })).coverUrl).toBe(dataImage(420_000));
});
