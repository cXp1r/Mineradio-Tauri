export interface LyricWord {
	t: number;
	d?: number;
	c0: number;
	c1: number;
	text?: string;
}

export interface LyricLine {
	t: number;
	text: string;
	translation?: string;
	duration?: number;
	charCount?: number;
	fallback?: boolean;
	words?: LyricWord[];
}

export function getLyricLineProgress(
	line: LyricLine | null | undefined,
	nextLine: LyricLine | null | undefined,
	nowSeconds: number,
	audioDurationSeconds?: number,
): number {
	if (!line) return 0;
	const now = nowSeconds + (line.words && line.words.length ? 0.030 : 0.020);
	if (line.words && line.words.length && (line.charCount ?? 0) > 0) {
		let lastP = 0;
		for (let i = 0; i < line.words.length; i++) {
			const w = line.words[i];
			const ws = w.t;
			const we = w.t + Math.max(0.08, w.d ?? 0.24);
			if (now < ws) return lastP;
			const span = Math.max(0.08, we - ws);
			const localRaw = now >= we ? 1 : (now - ws) / span;
			const local = Math.max(0, Math.min(1, localRaw));
			const p = (w.c0 + (w.c1 - w.c0) * local) / (line.charCount as number);
			lastP = Math.max(lastP, p);
			if (now < we) return lastP;
		}
		return 1;
	}
	const nextT =
		nextLine && nextLine.t > line.t
			? nextLine.t
			: Math.min(audioDurationSeconds ?? now + 4, line.t + (line.duration ?? 4.8));
	const span = Math.max(0.75, nextT - line.t);
	const prog = Math.max(0, Math.min(1, (now - line.t) / span));
	return prog * prog * (3 - 2 * prog);
}
