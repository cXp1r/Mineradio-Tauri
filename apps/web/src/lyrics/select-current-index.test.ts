import { expect, test } from "bun:test";
import { selectCurrentIndex } from "./select-current-index";
import type { LyricPayload } from "@mineradio/shared";

function payload(lines: Array<{ timeMs: number; text: string }>): LyricPayload {
	return {
		provider: "netease",
		trackId: "t1",
		lines: lines.map((l) => ({ timeMs: l.timeMs, text: l.text })),
		hasTranslation: false,
		isWordByWord: false,
	};
}

test("selectCurrentIndex returns -1 for null payload", () => {
	expect(selectCurrentIndex(0, null)).toBe(-1);
});

test("selectCurrentIndex on sorted lines picks the line whose timeMs <= position", () => {
	const p = payload([
		{ timeMs: 0, text: "a" },
		{ timeMs: 1000, text: "b" },
		{ timeMs: 2000, text: "c" },
	]);
	expect(selectCurrentIndex(0, p)).toBe(0);
	expect(selectCurrentIndex(500, p)).toBe(0);
	expect(selectCurrentIndex(1000, p)).toBe(1);
	expect(selectCurrentIndex(1999, p)).toBe(1);
	expect(selectCurrentIndex(2000, p)).toBe(2);
	expect(selectCurrentIndex(9999, p)).toBe(2);
});

test("selectCurrentIndex defensively sorts interleaved lines by timeMs", () => {
	const p = payload([
		{ timeMs: 2000, text: "c" },
		{ timeMs: 0, text: "a" },
		{ timeMs: 1000, text: "b" },
		{ timeMs: 500, text: "a2" },
	]);
	expect(selectCurrentIndex(0, p)).toBe(0);
	expect(selectCurrentIndex(500, p)).toBe(1);
	expect(selectCurrentIndex(1000, p)).toBe(2);
	expect(selectCurrentIndex(2000, p)).toBe(3);
});

test("selectCurrentIndex keeps stable order for equal timeMs (interleaved lrc)", () => {
	const p = payload([
		{ timeMs: 0, text: "simplified" },
		{ timeMs: 0, text: "traditional" },
		{ timeMs: 1000, text: "next" },
	]);
	expect(selectCurrentIndex(0, p)).toBe(0);
	expect(selectCurrentIndex(0, p)).not.toBe(1);
});