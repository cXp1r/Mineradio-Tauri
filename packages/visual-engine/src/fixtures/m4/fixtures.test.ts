import { expect, test } from "bun:test";
import {
	M4_LYRICS_DENSE,
	M4_LYRICS_LONG,
	M4_LYRICS_SEEK_BOUNDARY,
	M4_LYRICS_TRANSLATED,
	M4_SHELF_600,
	M4_SONIC_AUDIO_FRAMES,
} from "./index";

test("M4 fixtures are deterministic, bounded, and free of external input", () => {
	expect(M4_LYRICS_DENSE).toHaveLength(64);
	expect(M4_LYRICS_LONG).toHaveLength(240);
	expect(M4_LYRICS_SEEK_BOUNDARY.map((line) => line.t)).toEqual([1, 5, 5, 5.001, 18]);
	const firstTranslatedLine = M4_LYRICS_TRANSLATED[0];
	expect(firstTranslatedLine && "translation" in firstTranslatedLine ? firstTranslatedLine.translation : undefined).toBe("Hello");
	expect(M4_SHELF_600).toHaveLength(600);
	expect(M4_SONIC_AUDIO_FRAMES.kick?.createBins()).toHaveLength(512);
	expect(M4_SONIC_AUDIO_FRAMES.kick?.createBins()).not.toBe(M4_SONIC_AUDIO_FRAMES.kick?.createBins());
});
