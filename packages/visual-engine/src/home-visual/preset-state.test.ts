import { expect, test } from "bun:test";
import "../runtime/happy-dom-preload";
import { cloneFxState } from "./fx-defaults";
import { applyPreset, clampPreset, PRESET_COUNT, SKULL_PRESET_INDEX } from "./preset-state";

test("PRESET_COUNT baseline = 7 presets (0 emily, 1 tunnel, 2 orbit, 3 void, 4 vinyl, 5 wallpaper, 6 skull)", () => {
	expect(PRESET_COUNT).toBe(7);
	expect(SKULL_PRESET_INDEX).toBe(6);
});

test("clampPreset clamps to [0, PRESET_COUNT-1] (baseline Math.max/Math.min, no floor) and coerces NaN to 0", () => {
	expect(clampPreset(0)).toBe(0);
	expect(clampPreset(6)).toBe(6);
	expect(clampPreset(7)).toBe(6);
	expect(clampPreset(-1)).toBe(0);
	expect(clampPreset(NaN)).toBe(0);
});

test("clampPreset(Infinity) clamps to PRESET_COUNT-1 even though baseline does not floor fractional inputs", () => {
	expect(clampPreset(Infinity)).toBe(6);
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

test("applyPreset clamps negative/overflow values baseline Math.max/Math.min style (no floor)", () => {
	const fx = cloneFxState();
	expect(applyPreset(fx, -10).preset).toBe(0);
	expect(applyPreset(fx, 99).preset).toBe(6);
});