import type { FxState } from "./fx-defaults";

export const PRESET_COUNT = 7;
export const SKULL_PRESET_INDEX = 6;

export interface PresetOpts {
	skipTransition?: boolean;
	preserveCamera?: boolean;
	silent?: boolean;
	noSave?: boolean;
	commitPlaybackPreset?: boolean;
}

export function clampPreset(n: number): number {
	return Math.max(0, Math.min(PRESET_COUNT - 1, Number(n) || 0));
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