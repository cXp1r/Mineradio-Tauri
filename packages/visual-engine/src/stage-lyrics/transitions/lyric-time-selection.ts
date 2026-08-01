import type { LyricLine } from "../lyric-line-progress";

/**
 * 在按时间升序的歌词中选择不晚于目标时间的最后一行。
 * 重复时间戳时返回最后一个重复项，避免 seek 后在同一时间点来回跳动。
 */
export function findStageLyricIndexAtTime(
	lines: readonly Pick<LyricLine, "t">[],
	timeSeconds: number,
): number {
	if (lines.length === 0 || !Number.isFinite(timeSeconds)) return -1;
	let low = 0;
	let high = lines.length;
	while (low < high) {
		const middle = low + Math.floor((high - low) / 2);
		if (lines[middle].t <= timeSeconds) low = middle + 1;
		else high = middle;
	}
	return low - 1;
}
