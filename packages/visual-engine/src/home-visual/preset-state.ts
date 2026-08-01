import type { FxState } from "./fx-defaults";

export const PRESET_COUNT = 9;
export const SKULL_PRESET_INDEX = 6;
export const SONIC_PRESET_INDEX = 7;
export const SONIC_WORKSHOP_PRESET_INDEX = 8;

export function isDedicatedVisualPreset(preset: number): boolean {
	return (
		preset === SKULL_PRESET_INDEX ||
		preset === SONIC_PRESET_INDEX ||
		preset === SONIC_WORKSHOP_PRESET_INDEX
	);
}

export interface PresetOpts {
	skipTransition?: boolean;
	preserveCamera?: boolean;
	silent?: boolean;
	noSave?: boolean;
	commitPlaybackPreset?: boolean;
}

export function clampCurrentPreset(n: number): number {
	const value = Number(n);
	if (!Number.isFinite(value)) return 0;
	const rounded = Math.round(value);
	return Math.max(0, Math.min(PRESET_COUNT - 1, rounded));
}

/** 只用于读取旧版 visual.fx；旧数值 8 在历史上表示并迁移为 Sonic 7。 */
export function migrateLegacyPreset(n: number): number {
	const value = Number(n);
	if (!Number.isFinite(value)) return 0;
	return Math.max(0, Math.min(SONIC_PRESET_INDEX, Math.round(value)));
}

/** 兼容既有调用方；语义始终是当前 0..8 preset。 */
export const clampPreset = clampCurrentPreset;

export function applyPreset(fx: FxState, next: number, _opts?: PresetOpts): FxState {
	const p = clampCurrentPreset(next);
	const next0: FxState = {
		...fx,
		preset: p,
		mouseXy: { ...fx.mouseXy },
	};
	return next0;
}
