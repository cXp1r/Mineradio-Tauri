import type { VisualLyricLine } from "../../runtime/visual-engine-contract";

export const M4_LYRICS_LONG = Object.freeze(
	Array.from({ length: 240 }, (_, index) => Object.freeze({
		t: index * 3.25,
		text: index % 17 === 0
			? `超长歌词 ${index + 1}：用于验证纹理预算、预热窗口与快速切换时的资源收口。`
			: `长歌词 ${index + 1}`,
	})),
) satisfies readonly VisualLyricLine[];
