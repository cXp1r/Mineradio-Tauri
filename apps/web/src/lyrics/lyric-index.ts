import type { LyricLine, LyricPayload } from "@mineradio/shared";

export interface NormalizedLyricLine {
	line: LyricLine;
	originalIndex: number;
	index: number;
}

export interface NormalizedLyricIndex {
	payload: LyricPayload | null;
	lines: NormalizedLyricLine[];
	timeMs: number[];
}

const EMPTY_INDEX: NormalizedLyricIndex = {
	payload: null,
	lines: [],
	timeMs: [],
};

const indexCache = new WeakMap<LyricPayload, NormalizedLyricIndex>();

export function getLyricIndex(payload: LyricPayload | null): NormalizedLyricIndex {
	if (!payload || !Array.isArray(payload.lines) || payload.lines.length === 0) {
		return EMPTY_INDEX;
	}
	const cached = indexCache.get(payload);
	if (cached) return cached;

	const lines = payload.lines
		.map((line, originalIndex) => ({ line, originalIndex }))
		.filter(({ line }) => Number.isFinite(line.timeMs))
		.sort((a, b) => a.line.timeMs - b.line.timeMs || a.originalIndex - b.originalIndex)
		.map((entry, index) => ({ ...entry, index }));
	const normalized: NormalizedLyricIndex = {
		payload,
		lines,
		timeMs: lines.map((entry) => entry.line.timeMs),
	};
	indexCache.set(payload, normalized);
	return normalized;
}

export function selectLyricIndexAtPosition(
	index: NormalizedLyricIndex,
	positionMs: number,
	opts: { leadMs?: number } = {},
): number {
	const times = index.timeMs;
	if (times.length === 0) return -1;
	const now = (Number.isFinite(positionMs) ? positionMs : 0) + (opts.leadMs ?? 0);
	let lo = 0;
	let hi = times.length;
	while (lo < hi) {
		const mid = lo + Math.floor((hi - lo) / 2);
		if ((times[mid] ?? Infinity) <= now) lo = mid + 1;
		else hi = mid;
	}
	let selected = lo - 1;
	if (selected < 0) return -1;
	const selectedTime = times[selected];
	while (selected > 0 && times[selected - 1] === selectedTime) {
		selected -= 1;
	}
	return selected;
}

export function selectLyricLineAtPosition(
	index: NormalizedLyricIndex,
	positionMs: number,
	opts: { leadMs?: number } = {},
): NormalizedLyricLine | null {
	const selected = selectLyricIndexAtPosition(index, positionMs, opts);
	return selected >= 0 ? index.lines[selected] ?? null : null;
}
