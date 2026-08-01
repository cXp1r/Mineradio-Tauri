import { expect, test } from "bun:test";
import {
	DEFAULT_STAGE_LYRICS_SETTINGS,
	normalizeStageLyricsSettings,
} from "./stage-lyrics-settings";

test("normalizeStageLyricsSettings uses Electron 2.0.2 defaults for a missing snapshot", () => {
	expect(normalizeStageLyricsSettings()).toEqual(DEFAULT_STAGE_LYRICS_SETTINGS);
});

test("normalizeStageLyricsSettings preserves valid modes and uses Electron fallbacks for invalid modes", () => {
	const valid = normalizeStageLyricsSettings({
		displayMode: "dual",
		translationMode: "current",
		motionStyle: "shine",
	});
	expect(valid.displayMode).toBe("dual");
	expect(valid.translationMode).toBe("current");
	expect(valid.motionStyle).toBe("shine");
	const invalid = normalizeStageLyricsSettings({
		displayMode: "invalid",
		translationMode: "invalid",
		motionStyle: "invalid",
	});
	expect(invalid.displayMode).toBe("single");
	expect(invalid.translationMode).toBe("off");
	expect(invalid.motionStyle).toBe("float");
});

test("normalizeStageLyricsSettings clamps numeric controls and rounds discrete tiers", () => {
	const normalized = normalizeStageLyricsSettings({
		customLineCount: 4.6,
		contextOpacity: -1,
		contextSpread: 99,
		translationGap: Number.NaN,
		translationScale: 2,
		translationOpacity: 0,
		edgeFade: 4,
		motionSoftness: 0,
		glitchIntensity: 9,
		glitchSlice: -2,
		glitchChroma: 9,
		glitchRate: 0,
		glitchJitter: 9,
		textureClarity: 3.6,
	});
	expect({
		customLineCount: normalized.customLineCount,
		contextOpacity: normalized.contextOpacity,
		contextSpread: normalized.contextSpread,
		translationGap: normalized.translationGap,
		translationScale: normalized.translationScale,
		translationOpacity: normalized.translationOpacity,
		edgeFade: normalized.edgeFade,
		motionSoftness: normalized.motionSoftness,
		glitchIntensity: normalized.glitchIntensity,
		glitchSlice: normalized.glitchSlice,
		glitchChroma: normalized.glitchChroma,
		glitchRate: normalized.glitchRate,
		glitchJitter: normalized.glitchJitter,
		textureClarity: normalized.textureClarity,
	}).toEqual({
		customLineCount: 5,
		contextOpacity: 0.25,
		contextSpread: 2.4,
		translationGap: DEFAULT_STAGE_LYRICS_SETTINGS.translationGap,
		translationScale: 1.12,
		translationOpacity: 0.2,
		edgeFade: 1,
		motionSoftness: 0.15,
		glitchIntensity: 1.5,
		glitchSlice: 0,
		glitchChroma: 1.6,
		glitchRate: 0.45,
		glitchJitter: 1.8,
		textureClarity: 4,
	});
});

test("normalizeStageLyricsSettings treats only explicit false as disabling boolean defaults", () => {
	const disabled = normalizeStageLyricsSettings({
		glitchCameraBind: false,
		verticalFloat: false,
		backgroundStarRiver: false,
		pauseHold: false,
	});
	expect([
		disabled.glitchCameraBind,
		disabled.verticalFloat,
		disabled.backgroundStarRiver,
		disabled.pauseHold,
	]).toEqual([false, false, false, false]);
	const defaults = normalizeStageLyricsSettings({
		glitchCameraBind: undefined,
		verticalFloat: undefined,
		backgroundStarRiver: undefined,
		pauseHold: undefined,
	});
	expect([
		defaults.glitchCameraBind,
		defaults.verticalFloat,
		defaults.backgroundStarRiver,
		defaults.pauseHold,
	]).toEqual([true, true, true, true]);
});

test("normalizeStageLyricsSettings migrates the short-lived clarity multipliers", () => {
	expect(normalizeStageLyricsSettings({ textureClarity: 1.25 }).textureClarity).toBe(2);
	expect(normalizeStageLyricsSettings({ textureClarity: 1.5 }).textureClarity).toBe(4);
});
