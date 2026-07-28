import type { FxState } from "./fx-defaults";

export const PRESET_COUNT = 8;
export const SKULL_PRESET_INDEX = 6;
export const SONIC_PRESET_INDEX = 7;

export interface PresetOpts {
	skipTransition?: boolean;
	preserveCamera?: boolean;
	silent?: boolean;
	noSave?: boolean;
	commitPlaybackPreset?: boolean;
}

export function clampPreset(n: number): number {
	const value = Number(n);
	if (!Number.isFinite(value)) return 0;
	const rounded = Math.round(value);
	if (rounded === 8) return SONIC_PRESET_INDEX;
	return Math.max(0, Math.min(PRESET_COUNT - 1, rounded));
}

export function applyPreset(fx: FxState, next: number, _opts?: PresetOpts): FxState {
	const p = clampPreset(next);
	const next0: FxState = {
		...fx,
		preset: p,
		mouseXy: { ...fx.mouseXy },
	};
	return next0;
}
