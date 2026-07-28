import { expect, test } from "bun:test";
import "../runtime/happy-dom-preload";
import { cloneFxState } from "./fx-defaults";
import { applyPreset, clampPreset, PRESET_COUNT, SKULL_PRESET_INDEX } from "./preset-state";

test("PRESET_COUNT exposes Sonic as preset 7 while preserving preset 6 skull", () => {
	expect(PRESET_COUNT).toBe(8);
	expect(SKULL_PRESET_INDEX).toBe(6);
});

test("clampPreset rounds finite inputs, migrates legacy 8 to 7, and rejects non-finite values", () => {
	expect(clampPreset(0)).toBe(0);
	expect(clampPreset(6)).toBe(6);
	expect(clampPreset(7)).toBe(7);
	expect(clampPreset(8)).toBe(7);
	expect(clampPreset(5.6)).toBe(6);
	expect(clampPreset(6.6)).toBe(7);
	expect(clampPreset(-1)).toBe(0);
	expect(clampPreset(NaN)).toBe(0);
	expect(clampPreset(Infinity)).toBe(0);
	expect(clampPreset(-Infinity)).toBe(0);
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
	expect(applyPreset(fx, 99).preset).toBe(7);
});
