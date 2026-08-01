import type { VisualLyricLine } from "../../runtime/visual-engine-contract";

export const M4_LYRICS_DENSE = Object.freeze(
	Array.from({ length: 64 }, (_, index) => Object.freeze({
		t: index * 0.075,
		text: `密集歌词 ${index + 1}`,
		...(index % 3 === 0 ? { translation: `Dense line ${index + 1}` } : {}),
	})),
) satisfies readonly VisualLyricLine[];
