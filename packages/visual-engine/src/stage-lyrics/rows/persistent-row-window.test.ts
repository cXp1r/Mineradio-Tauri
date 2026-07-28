import { expect, test } from "bun:test";
import {
	createStagePersistentRowCacheKey,
	planStagePersistentRowWindow,
} from "./persistent-row-window";

test("persistent row cache keys are stable and isolate track/settings generations", () => {
	const baseline = createStagePersistentRowCacheKey({
		trackKey: "netease:19723756",
		trackGeneration: 3,
		settingsGeneration: 7,
		rowIndex: 12,
	});

	expect(createStagePersistentRowCacheKey({
		trackKey: "netease:19723756",
		trackGeneration: 3,
		settingsGeneration: 7,
		rowIndex: 12,
	})).toBe(baseline);
	expect(createStagePersistentRowCacheKey({
		trackKey: "netease:19723756",
		trackGeneration: 4,
		settingsGeneration: 7,
		rowIndex: 12,
	})).not.toBe(baseline);
	expect(createStagePersistentRowCacheKey({
		trackKey: "netease:19723756",
		trackGeneration: 3,
		settingsGeneration: 8,
		rowIndex: 12,
	})).not.toBe(baseline);
});

test("persistent row planning keeps one bounded cache and maps current, adjacent and prewarm priorities", () => {
	const plan = planStagePersistentRowWindow({
		trackKey: "qq:0039MnYb0qxYhV",
		trackGeneration: 2,
		settingsGeneration: 5,
		currentIndex: 5,
		rowCount: 20,
		quality: "balanced",
	});

	expect(plan.rows).toHaveLength(10);
	expect(plan.rows.map(({ rowIndex, kind, priority, resident }) => ({
		rowIndex,
		kind,
		priority,
		resident,
	}))).toEqual([
		{ rowIndex: 5, kind: "current", priority: "essential", resident: true },
		{ rowIndex: 6, kind: "adjacent", priority: "normal", resident: true },
		{ rowIndex: 4, kind: "adjacent", priority: "normal", resident: true },
		{ rowIndex: 7, kind: "adjacent", priority: "normal", resident: true },
		{ rowIndex: 3, kind: "adjacent", priority: "normal", resident: true },
		{ rowIndex: 8, kind: "adjacent", priority: "normal", resident: true },
		{ rowIndex: 2, kind: "prewarm", priority: "background", resident: false },
		{ rowIndex: 9, kind: "prewarm", priority: "background", resident: false },
		{ rowIndex: 1, kind: "prewarm", priority: "background", resident: false },
		{ rowIndex: 10, kind: "prewarm", priority: "background", resident: false },
	]);
	expect(new Set(plan.rows.map((row) => row.cacheKey)).size).toBe(10);
});

test("persistent row planning applies 4/6/8 resident caps and stays bounded at track edges", () => {
	const residentCounts = (["eco", "low", "balanced", "high", "ultra"] as const)
		.map((quality) => [
			quality,
			planStagePersistentRowWindow({
				trackKey: "soda:edge-fixture",
				trackGeneration: 1,
				settingsGeneration: 1,
				currentIndex: 0,
				rowCount: 12,
				quality,
			}).rows.filter((row) => row.resident).length,
		]);

	expect(Object.fromEntries(residentCounts)).toEqual({
		eco: 4,
		low: 4,
		balanced: 6,
		high: 8,
		ultra: 8,
	});

	const finalWindow = planStagePersistentRowWindow({
		trackKey: "soda:edge-fixture",
		trackGeneration: 1,
		settingsGeneration: 1,
		currentIndex: 11,
		rowCount: 12,
		quality: "high",
	});
	expect(finalWindow.rows.map((row) => row.rowIndex)).toEqual([11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
	expect(new Set(finalWindow.rows.map((row) => row.rowIndex)).size).toBe(finalWindow.rows.length);
});
