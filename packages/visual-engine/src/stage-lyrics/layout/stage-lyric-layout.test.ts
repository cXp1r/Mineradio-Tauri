import { expect, test } from "bun:test";
import { DEFAULT_STAGE_LYRICS_SETTINGS } from "../model/stage-lyrics-settings";
import {
	buildStageLyricLayout,
	stageLyricDisplayOffsets,
} from "./stage-lyric-layout";

test("stageLyricDisplayOffsets matches Electron display windows", () => {
	expect(stageLyricDisplayOffsets("single", 10)).toEqual([0]);
	expect(stageLyricDisplayOffsets("dual", 10)).toEqual([0, 1]);
	expect(stageLyricDisplayOffsets("triple", 10)).toEqual([-1, 0, 1]);
	expect(stageLyricDisplayOffsets("cinema", 10)).toEqual([-2, -1, 0, 1, 2]);
	expect(stageLyricDisplayOffsets("custom", 4)).toEqual([-2, -1, 0, 1]);
});

test("buildStageLyricLayout keeps a compact primary window when the current line has no translation", () => {
	const lines = [
		{ t: 0, text: "甲", translation: "A" },
		{ t: 1, text: "乙" },
		{ t: 2, text: "丙", translation: "C" },
	];
	const layout = buildStageLyricLayout(lines, 1, {
		...DEFAULT_STAGE_LYRICS_SETTINGS,
		displayMode: "triple",
		translationMode: "multi",
	});
	expect(layout.entries.map((entry) => [entry.role, entry.lineIndex, entry.text])).toEqual([
		["prev", 0, "甲"],
		["current", 1, "乙"],
		["next", 2, "丙"],
	]);
	expect(layout.activeEntryIndex).toBe(1);
	expect(layout.entries.every((entry, index, entries) => index === 0 || entry.virtualIndex > entries[index - 1].virtualIndex)).toBe(true);
});

test("buildStageLyricLayout applies current, dual, multi and off translation modes", () => {
	const lines = [
		{ t: 0, text: "甲", translation: "A" },
		{ t: 1, text: "乙", translation: "B" },
		{ t: 2, text: "丙", translation: "C" },
	];
	const settings = {
		...DEFAULT_STAGE_LYRICS_SETTINGS,
		displayMode: "triple" as const,
	};
	const translations = (mode: "off" | "current" | "dual" | "multi") =>
		buildStageLyricLayout(lines, 1, { ...settings, translationMode: mode })
			.entries.filter((entry) => entry.translationLine)
			.map((entry) => entry.lineIndex);
	expect(translations("off")).toEqual([]);
	expect(translations("current")).toEqual([1]);
	expect(translations("dual")).toEqual([1, 2]);
	expect(translations("multi")).toEqual([0, 1, 2]);
});

test("dual mode backfills the previous line when current is the final line", () => {
	const layout = buildStageLyricLayout([
		{ t: 0, text: "A" },
		{ t: 1, text: "B" },
	], 1, {
		...DEFAULT_STAGE_LYRICS_SETTINGS,
		displayMode: "dual",
		translationMode: "off",
	});
	expect(layout.entries.map((entry) => entry.lineIndex)).toEqual([0, 1]);
	expect(layout.activeEntryIndex).toBe(1);
});
