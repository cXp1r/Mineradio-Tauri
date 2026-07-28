import { expect, test } from "bun:test";
import { buildStageLyricLayout } from "../layout/stage-lyric-layout";
import { normalizeStageLyricsSettings } from "../model/stage-lyrics-settings";
import { createStageLyricRasterPayload } from "./structured-raster";

const lines = [
	{ t: 0, text: "上一句", translation: "Previous" },
	{ t: 1, text: "当前句", translation: "Current" },
	{ t: 2, text: "下一句", translation: "Next" },
	{ t: 3, text: "更远一句", translation: "Farther" },
];

test("structured raster keeps layout identity while centering the active row", () => {
	const settings = normalizeStageLyricsSettings({
		displayMode: "cinema",
		translationMode: "multi",
		contextSpread: 1.4,
		edgeFade: 0,
	});
	const layout = buildStageLyricLayout(lines, 1, settings, 10);
	const raster = createStageLyricRasterPayload(layout, settings);

	expect(raster.activeRowIndex).toBe(layout.activeEntryIndex);
	const active = raster.rows[raster.activeRowIndex];
	expect(active?.text).toBe("当前句");
	expect(active?.active).toBe(true);
	expect(active?.alpha).toBe(1);
	expect(active?.offset).toBe(0);
	expect(active?.translationLine).toBe(false);
	expect(raster.rows.some((row) => row.translationLine && row.text === "Current")).toBe(true);
	expect(raster.rows[0]?.offset).toBeLessThan(0);
	expect(raster.rows.at(-1)?.offset).toBeGreaterThan(0);
	expect(Object.isFrozen(raster)).toBe(true);
	expect(Object.isFrozen(raster.rows)).toBe(true);
});

test("structured raster applies edge fade only to context rows", () => {
	const baseSettings = normalizeStageLyricsSettings({
		displayMode: "cinema",
		translationMode: "off",
		contextOpacity: 0.9,
		edgeFade: 0,
	});
	const fadedSettings = normalizeStageLyricsSettings({
		...baseSettings,
		edgeFade: 1,
	});
	const layout = buildStageLyricLayout(lines, 1, baseSettings, 10);
	const base = createStageLyricRasterPayload(layout, baseSettings);
	const faded = createStageLyricRasterPayload(layout, fadedSettings);
	const farthestIndex = base.rows.reduce(
		(best, row, index, rows) => Math.abs(row.offset) > Math.abs(rows[best]?.offset ?? 0) ? index : best,
		0,
	);

	expect(faded.rows[faded.activeRowIndex]?.alpha).toBe(1);
	expect(faded.rows[farthestIndex]?.alpha).toBeLessThan(base.rows[farthestIndex]?.alpha ?? 1);
	expect(faded.rows[farthestIndex]?.alpha).toBeGreaterThanOrEqual(0.08);
});

test("structured raster returns an immutable empty payload without an active entry", () => {
	const raster = createStageLyricRasterPayload(
		{ entries: [], activeEntryIndex: -1 },
		{ contextSpread: 1, edgeFade: 1 },
	);
	expect(raster).toEqual({ rows: [], activeRowIndex: -1 });
	expect(Object.isFrozen(raster.rows)).toBe(true);
});
