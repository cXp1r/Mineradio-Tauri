export const ALBUM_GAPLESS_CROSSFADE_DEFAULT_MS = 720;
export const ALBUM_GAPLESS_CROSSFADE_MIN_MS = 360;
export const ALBUM_GAPLESS_INCOMING_ATTACK_MS = 56;
export const ALBUM_GAPLESS_ADOPT_SLEW_MS = 180;

export interface AlbumGaplessCrossfadeInput {
	readonly elapsedMs: number;
	readonly durationMs?: number;
	readonly outgoingStartGain?: number;
	readonly incomingTargetGain?: number;
}

export interface AlbumGaplessCrossfadeSample {
	readonly progress: number;
	readonly outgoingGain: number;
	readonly incomingGain: number;
}

function clampUnit(value: number): number {
	return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
}

function smoothstep(value: number): number {
	const clamped = clampUnit(value);
	return clamped * clamped * (3 - 2 * clamped);
}

function incomingCurveProgress(elapsedMs: number, durationMs: number): number {
	if (elapsedMs >= durationMs) return 1;
	const attackMs = Math.min(
		ALBUM_GAPLESS_INCOMING_ATTACK_MS,
		Math.max(1, durationMs - 1),
	);
	const entryFloorProgress = Math.asin(0.9) / (Math.PI * 0.5);
	if (elapsedMs <= attackMs) {
		return entryFloorProgress * smoothstep(elapsedMs / attackMs);
	}
	const releaseWindowMs = Math.max(
		ALBUM_GAPLESS_ADOPT_SLEW_MS,
		durationMs - attackMs,
	);
	const release = smoothstep((elapsedMs - attackMs) / releaseWindowMs);
	return entryFloorProgress + (1 - entryFloorProgress) * release;
}

export function sampleAlbumGaplessCrossfade(
	input: AlbumGaplessCrossfadeInput,
): AlbumGaplessCrossfadeSample {
	const durationMs =
		Number.isFinite(input.durationMs) && Number(input.durationMs) > 0
			? Number(input.durationMs)
			: ALBUM_GAPLESS_CROSSFADE_DEFAULT_MS;
	const elapsedMs = Math.min(
		durationMs,
		Math.max(0, Number.isFinite(input.elapsedMs) ? input.elapsedMs : 0),
	);
	const progress = incomingCurveProgress(elapsedMs, durationMs);
	const outgoingStartGain = clampUnit(input.outgoingStartGain ?? 1);
	const incomingTargetGain = clampUnit(input.incomingTargetGain ?? 1);
	if (progress <= 0) {
		return { progress: 0, outgoingGain: outgoingStartGain, incomingGain: 0 };
	}
	if (progress >= 1) {
		return { progress: 1, outgoingGain: 0, incomingGain: incomingTargetGain };
	}
	const theta = progress * Math.PI * 0.5;
	return {
		progress,
		outgoingGain: clampUnit(outgoingStartGain * Math.cos(theta)),
		incomingGain: clampUnit(incomingTargetGain * Math.sin(theta)),
	};
}
