import { expect, test } from "bun:test";
import { findStageLyricIndexAtTime } from "./lyric-time-selection";

test("findStageLyricIndexAtTime uses rightmost binary selection at seek boundaries", () => {
	const lines = [
		{ t: 1, text: "a" },
		{ t: 2, text: "b" },
		{ t: 2, text: "c" },
		{ t: 4, text: "d" },
	];
	expect(findStageLyricIndexAtTime(lines, 0.99)).toBe(-1);
	expect(findStageLyricIndexAtTime(lines, 1)).toBe(0);
	expect(findStageLyricIndexAtTime(lines, 2)).toBe(2);
	expect(findStageLyricIndexAtTime(lines, 3.99)).toBe(2);
	expect(findStageLyricIndexAtTime(lines, 99)).toBe(3);
});
