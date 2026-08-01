import { expect, test } from "bun:test";
import "../runtime/happy-dom-preload";
import { cloneFxState } from "./fx-defaults";
import {
	applyPreset,
	clampCurrentPreset,
	isDedicatedVisualPreset,
	migrateLegacyPreset,
	PRESET_COUNT,
	SKULL_PRESET_INDEX,
} from "./preset-state";

test("PRESET_COUNT exposes Workshop as preset 8 while preserving Sonic 7 and skull 6", () => {
	expect(PRESET_COUNT).toBe(9);
	expect(SKULL_PRESET_INDEX).toBe(6);
});

test("clampCurrentPreset accepts current preset 8 and rejects invalid values", () => {
	expect(clampCurrentPreset(0)).toBe(0);
	expect(clampCurrentPreset(6)).toBe(6);
	expect(clampCurrentPreset(7)).toBe(7);
	expect(clampCurrentPreset(8)).toBe(8);
	expect(clampCurrentPreset(5.6)).toBe(6);
	expect(clampCurrentPreset(7.6)).toBe(8);
	expect(clampCurrentPreset(-1)).toBe(0);
	expect(clampCurrentPreset(99)).toBe(8);
	expect(clampCurrentPreset(NaN)).toBe(0);
	expect(clampCurrentPreset(Infinity)).toBe(0);
	expect(clampCurrentPreset(-Infinity)).toBe(0);
});

test("migrateLegacyPreset maps legacy numeric 8 to Sonic 7 without changing current clamp semantics", () => {
	expect(migrateLegacyPreset(8)).toBe(7);
	expect(migrateLegacyPreset(7)).toBe(7);
	expect(migrateLegacyPreset(99)).toBe(7);
});

test("dedicated presets are exactly skull, Sonic Topography, and Sonic Workshop", () => {
	expect([0, 1, 2, 3, 4, 5, 6, 7, 8].filter(isDedicatedVisualPreset)).toEqual([
		6,
		7,
		8,
	]);
});

test("applyPreset is pure: input fx is not mutated and result has the clamped preset", () => {
	const fx = cloneFxState();
	fx.preset = 2;
	const before = { ...fx };
	const next = applyPreset(fx, 5, { silent: true });
	expect(fx.preset).toBe(before.preset);
	expect(next.preset).toBe(5);
	expect(next).not.toBe(fx);
	expect(next.mouseXy).not.toBe(fx.mouseXy);
});

test("applyPreset clamps negative and overflow values to the public preset range", () => {
	const fx = cloneFxState();
	expect(applyPreset(fx, -10).preset).toBe(0);
	expect(applyPreset(fx, 99).preset).toBe(8);
});
