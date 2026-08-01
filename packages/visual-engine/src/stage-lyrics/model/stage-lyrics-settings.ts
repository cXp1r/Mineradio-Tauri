export type StageLyricDisplayMode =
	| "single"
	| "dual"
	| "triple"
	| "cinema"
	| "custom";

export type StageLyricTranslationMode = "off" | "current" | "dual" | "multi";

export type StageLyricMotionStyle =
	| "glass"
	| "smooth"
	| "float"
	| "quick"
	| "shine"
	| "glitch";

export interface StageLyricsSettings {
	readonly displayMode: StageLyricDisplayMode;
	readonly customLineCount: number;
	readonly translationMode: StageLyricTranslationMode;
	readonly motionStyle: StageLyricMotionStyle;
	readonly contextOpacity: number;
	readonly contextSpread: number;
	readonly translationGap: number;
	readonly translationScale: number;
	readonly translationOpacity: number;
	readonly edgeFade: number;
	readonly motionSoftness: number;
	readonly glitchCameraBind: boolean;
	readonly glitchIntensity: number;
	readonly glitchSlice: number;
	readonly glitchChroma: number;
	readonly glitchRate: number;
	readonly glitchJitter: number;
	readonly textureClarity: 1 | 2 | 3 | 4;
	readonly verticalFloat: boolean;
	readonly backgroundStarRiver: boolean;
	readonly pauseHold: boolean;
}

export const DEFAULT_STAGE_LYRICS_SETTINGS: Readonly<StageLyricsSettings> = Object.freeze({
	displayMode: "cinema",
	customLineCount: 10,
	translationMode: "multi",
	motionStyle: "float",
	contextOpacity: 0.54,
	contextSpread: 1.96,
	translationGap: 0.92,
	translationScale: 0.65,
	translationOpacity: 0.86,
	edgeFade: 0.32,
	motionSoftness: 0.72,
	glitchCameraBind: true,
	glitchIntensity: 1,
	glitchSlice: 0.72,
	glitchChroma: 0.86,
	glitchRate: 1,
	glitchJitter: 0.72,
	textureClarity: 1,
	verticalFloat: true,
	backgroundStarRiver: true,
	pauseHold: true,
});

const DISPLAY_MODES = new Set<StageLyricDisplayMode>([
	"single",
	"dual",
	"triple",
	"cinema",
	"custom",
]);
const TRANSLATION_MODES = new Set<StageLyricTranslationMode>([
	"off",
	"current",
	"dual",
	"multi",
]);
const MOTION_STYLES = new Set<StageLyricMotionStyle>([
	"glass",
	"smooth",
	"float",
	"quick",
	"shine",
	"glitch",
]);

type StageLyricsSettingsInput = Partial<{
	[K in keyof StageLyricsSettings]: unknown;
}>;

function finiteNumber(value: unknown, fallback: number): number {
	const numberValue = Number(value);
	return Number.isFinite(numberValue) ? numberValue : fallback;
}

function clamp(value: unknown, fallback: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, finiteNumber(value, fallback)));
}

function booleanValue(value: unknown, fallback: boolean): boolean {
	return value === undefined || value === null ? fallback : value !== false;
}

function displayMode(value: unknown): StageLyricDisplayMode {
	if (value === undefined || value === null || value === "") {
		return DEFAULT_STAGE_LYRICS_SETTINGS.displayMode;
	}
	const normalized = String(value) as StageLyricDisplayMode;
	return DISPLAY_MODES.has(normalized) ? normalized : "single";
}

function translationMode(value: unknown): StageLyricTranslationMode {
	if (value === undefined || value === null || value === "") {
		return DEFAULT_STAGE_LYRICS_SETTINGS.translationMode;
	}
	const normalized = String(value) as StageLyricTranslationMode;
	return TRANSLATION_MODES.has(normalized) ? normalized : "off";
}

function motionStyle(value: unknown): StageLyricMotionStyle {
	if (value === undefined || value === null || value === "") {
		return DEFAULT_STAGE_LYRICS_SETTINGS.motionStyle;
	}
	const normalized = String(value) as StageLyricMotionStyle;
	return MOTION_STYLES.has(normalized) ? normalized : "float";
}

function textureClarity(value: unknown): 1 | 2 | 3 | 4 {
	const normalized = finiteNumber(value, DEFAULT_STAGE_LYRICS_SETTINGS.textureClarity);
	if (Math.abs(normalized - 1.25) < 0.001) return 2;
	if (Math.abs(normalized - 1.5) < 0.001) return 4;
	return Math.round(Math.max(1, Math.min(4, normalized))) as 1 | 2 | 3 | 4;
}

export function normalizeStageLyricsSettings(
	input: StageLyricsSettingsInput = {},
): Readonly<StageLyricsSettings> {
	const defaults = DEFAULT_STAGE_LYRICS_SETTINGS;
	return Object.freeze({
		displayMode: displayMode(input.displayMode),
		customLineCount: Math.round(clamp(input.customLineCount, defaults.customLineCount, 1, 10)),
		translationMode: translationMode(input.translationMode),
		motionStyle: motionStyle(input.motionStyle),
		contextOpacity: clamp(input.contextOpacity, defaults.contextOpacity, 0.25, 1),
		contextSpread: clamp(input.contextSpread, defaults.contextSpread, 0.6, 2.4),
		translationGap: clamp(input.translationGap, defaults.translationGap, 0.28, 2.2),
		translationScale: clamp(input.translationScale, defaults.translationScale, 0.46, 1.12),
		translationOpacity: clamp(input.translationOpacity, defaults.translationOpacity, 0.2, 1),
		edgeFade: clamp(input.edgeFade, defaults.edgeFade, 0, 1),
		motionSoftness: clamp(input.motionSoftness, defaults.motionSoftness, 0.15, 1.2),
		glitchCameraBind: booleanValue(input.glitchCameraBind, defaults.glitchCameraBind),
		glitchIntensity: clamp(input.glitchIntensity, defaults.glitchIntensity, 0, 1.5),
		glitchSlice: clamp(input.glitchSlice, defaults.glitchSlice, 0, 1.4),
		glitchChroma: clamp(input.glitchChroma, defaults.glitchChroma, 0, 1.6),
		glitchRate: clamp(input.glitchRate, defaults.glitchRate, 0.45, 2.2),
		glitchJitter: clamp(input.glitchJitter, defaults.glitchJitter, 0, 1.8),
		textureClarity: textureClarity(input.textureClarity),
		verticalFloat: booleanValue(input.verticalFloat, defaults.verticalFloat),
		backgroundStarRiver: booleanValue(input.backgroundStarRiver, defaults.backgroundStarRiver),
		pauseHold: booleanValue(input.pauseHold, defaults.pauseHold),
	});
}
