import type { VisualShelfItem } from "../../runtime/visual-engine-contract";

export const M4_SHELF_600 = Object.freeze(
	Array.from({ length: 600 }, (_, index) => Object.freeze({
		type: "playlist",
		title: `测试歌单 ${index + 1}`,
		sub: `${20 + (index % 80)} 首歌曲`,
		cover: `fixture://cover/${index + 1}`,
		playlistId: `fixture-${index + 1}`,
		provider: index % 2 === 0 ? "netease" : "qq",
	})),
) satisfies readonly VisualShelfItem[];
