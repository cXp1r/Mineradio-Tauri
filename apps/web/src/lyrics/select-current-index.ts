import type { LyricPayload } from "@mineradio/shared";

export function selectCurrentIndex(
	positionMs: number,
	payload: LyricPayload | null,
): number {
	if (!payload || payload.lines.length === 0) return -1;
	const sorted = [...payload.lines]
		.map((line, originalIndex) => ({ line, originalIndex }))
		.sort((a, b) => a.line.timeMs - b.line.timeMs);
	let result = -1;
	let bestTimeMs = -Infinity;
	for (let sortedIndex = 0; sortedIndex < sorted.length; sortedIndex += 1) {
		const entry = sorted[sortedIndex];
		const t = entry.line.timeMs;
		if (t <= positionMs) {
			if (t > bestTimeMs) {
				bestTimeMs = t;
				result = sortedIndex;
			}
		} else {
			break;
		}
	}
	return result;
}