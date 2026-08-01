import type { VisualLyricLine } from "../../runtime/visual-engine-contract";

export const M4_LYRICS_SEEK_BOUNDARY = Object.freeze([
	Object.freeze({ t: 1, text: "首行" }),
	Object.freeze({ t: 5, text: "重复时间戳 A" }),
	Object.freeze({ t: 5, text: "重复时间戳 B" }),
	Object.freeze({ t: 5.001, text: "紧邻边界" }),
	Object.freeze({ t: 18, text: "末行" }),
]) satisfies readonly VisualLyricLine[];
