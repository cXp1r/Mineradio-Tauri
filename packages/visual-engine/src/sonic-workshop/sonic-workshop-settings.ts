export const SONIC_WORKSHOP_ACTIVATION_ID = "sonic-workshop-v1" as const;

export const SONIC_WORKSHOP_THEMES = [
	"coral-mirage",
	"ocean-deep",
	"arctic-aurora",
	"cyber-forest",
	"minimal-monochrome",
	"neon-tokyo",
	"golden-hour",
	"ember-fire",
	"crimson-sunset",
] as const;

export type SonicWorkshopTheme = typeof SONIC_WORKSHOP_THEMES[number];
export type SonicWorkshopColorMode = "cover" | "theme" | "custom";

export interface SonicWorkshopColors {
	readonly mode: SonicWorkshopColorMode;
	readonly primary: string;
	readonly base: string;
	readonly warm: string;
	readonly cool: string;
	readonly ripple: string;
	readonly peak: string;
}

export interface SonicWorkshopSettings {
	readonly active: boolean;
	readonly inputGain: number;
	readonly audioIntensity: number;
	readonly responseRange: number;
	readonly peakIntensity: number;
	readonly theme: SonicWorkshopTheme;
	readonly colors: SonicWorkshopColors;
	readonly showCover: boolean;
	readonly autoRotate: boolean;
	readonly rotationSpeed: number;
}

export interface SonicWorkshopThemeColors {
	readonly primary: string;
	readonly base: string;
	readonly warm: string;
	readonly cool: string;
	readonly ripple: string;
	readonly peak: string;
}

export const SONIC_WORKSHOP_THEME_COLORS: Readonly<
	Record<SonicWorkshopTheme, SonicWorkshopThemeColors>
> = Object.freeze({
	"coral-mirage": Object.freeze({
		primary: "#cb6c89",
		base: "#16060f",
		warm: "#cb6c89",
		cool: "#99c4ff",
		ripple: "#f8d8ff",
		peak: "#99c4ff",
	}),
	"ocean-deep": Object.freeze({
		primary: "#1b6fb8",
		base: "#031025",
		warm: "#2e8ed4",
		cool: "#7fdcff",
		ripple: "#b7f5ff",
		peak: "#80b8ff",
	}),
	"arctic-aurora": Object.freeze({
		primary: "#79e1c4",
		base: "#05161d",
		warm: "#79e1c4",
		cool: "#99c4ff",
		ripple: "#e6fbff",
		peak: "#b7e6ff",
	}),
	"cyber-forest": Object.freeze({
		primary: "#3fc78a",
		base: "#04150d",
		warm: "#3fc78a",
		cool: "#74f5ff",
		ripple: "#b9ffd8",
		peak: "#d1ffe9",
	}),
	"minimal-monochrome": Object.freeze({
		primary: "#d9dde3",
		base: "#0b0c0e",
		warm: "#d9dde3",
		cool: "#ffffff",
		ripple: "#ffffff",
		peak: "#f2f5f8",
	}),
	"neon-tokyo": Object.freeze({
		primary: "#ff4fb8",
		base: "#100018",
		warm: "#ff4fb8",
		cool: "#39d7ff",
		ripple: "#ffd6f2",
		peak: "#e8ff6e",
	}),
	"golden-hour": Object.freeze({
		primary: "#e8b44c",
		base: "#160d02",
		warm: "#e8b44c",
		cool: "#89c8ff",
		ripple: "#fff0b8",
		peak: "#ffffff",
	}),
	"ember-fire": Object.freeze({
		primary: "#f27a28",
		base: "#180603",
		warm: "#f27a28",
		cool: "#76c8ff",
		ripple: "#ffd2a1",
		peak: "#fff2cf",
	}),
	"crimson-sunset": Object.freeze({
		primary: "#d84252",
		base: "#180307",
		warm: "#d84252",
		cool: "#8ec7ff",
		ripple: "#ffd5df",
		peak: "#fff1f4",
	}),
});

const DEFAULT_THEME = SONIC_WORKSHOP_THEME_COLORS["coral-mirage"];

export const SONIC_WORKSHOP_DEFAULTS: SonicWorkshopSettings = Object.freeze({
	active: false,
	inputGain: 82,
	audioIntensity: 1.15,
	responseRange: 1.3,
	peakIntensity: 0.62,
	theme: "coral-mirage",
	colors: Object.freeze({
		mode: "cover",
		...DEFAULT_THEME,
	}),
	showCover: true,
	autoRotate: true,
	rotationSpeed: 7,
});

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
	return value !== null && typeof value === "object"
		? value as Readonly<Record<string, unknown>>
		: {};
}

function boundedNumber(
	value: unknown,
	fallback: number,
	minimum: number,
	maximum: number,
): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.max(minimum, Math.min(maximum, value));
}

function boundedInteger(
	value: unknown,
	fallback: number,
	minimum: number,
	maximum: number,
): number {
	return Math.round(boundedNumber(value, fallback, minimum, maximum));
}

function booleanSetting(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function colorSetting(value: unknown, fallback: string): string {
	if (typeof value !== "string") return fallback;
	const color = value.trim().toLowerCase();
	if (/^#[0-9a-f]{6}$/.test(color)) return color;
	const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(color);
	return short
		? `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`
		: fallback;
}

function themeSetting(value: unknown): SonicWorkshopTheme {
	return typeof value === "string" && (SONIC_WORKSHOP_THEMES as readonly string[]).includes(value)
		? value as SonicWorkshopTheme
		: SONIC_WORKSHOP_DEFAULTS.theme;
}

function colorModeSetting(value: unknown): SonicWorkshopColorMode {
	return value === "cover" || value === "theme" || value === "custom"
		? value
		: SONIC_WORKSHOP_DEFAULTS.colors.mode;
}

export function normalizeSonicWorkshopSettings(value: unknown): SonicWorkshopSettings {
	const source = asRecord(value);
	const colors = asRecord(source.colors);
	return Object.freeze({
		active: booleanSetting(source.active, SONIC_WORKSHOP_DEFAULTS.active),
		inputGain: boundedInteger(source.inputGain, SONIC_WORKSHOP_DEFAULTS.inputGain, 40, 100),
		audioIntensity: boundedNumber(
			source.audioIntensity,
			SONIC_WORKSHOP_DEFAULTS.audioIntensity,
			0.3,
			2.5,
		),
		responseRange: boundedNumber(
			source.responseRange,
			SONIC_WORKSHOP_DEFAULTS.responseRange,
			0.3,
			2,
		),
		peakIntensity: boundedNumber(
			source.peakIntensity,
			SONIC_WORKSHOP_DEFAULTS.peakIntensity,
			0,
			1.4,
		),
		theme: themeSetting(source.theme),
		colors: Object.freeze({
			mode: colorModeSetting(colors.mode),
			primary: colorSetting(colors.primary, SONIC_WORKSHOP_DEFAULTS.colors.primary),
			base: colorSetting(colors.base, SONIC_WORKSHOP_DEFAULTS.colors.base),
			warm: colorSetting(colors.warm, SONIC_WORKSHOP_DEFAULTS.colors.warm),
			cool: colorSetting(colors.cool, SONIC_WORKSHOP_DEFAULTS.colors.cool),
			ripple: colorSetting(colors.ripple, SONIC_WORKSHOP_DEFAULTS.colors.ripple),
			peak: colorSetting(colors.peak, SONIC_WORKSHOP_DEFAULTS.colors.peak),
		}),
		showCover: booleanSetting(source.showCover, SONIC_WORKSHOP_DEFAULTS.showCover),
		autoRotate: booleanSetting(source.autoRotate, SONIC_WORKSHOP_DEFAULTS.autoRotate),
		rotationSpeed: boundedNumber(
			source.rotationSpeed,
			SONIC_WORKSHOP_DEFAULTS.rotationSpeed,
			0,
			20,
		),
	});
}

export function areSonicWorkshopSettingsEqual(
	left: SonicWorkshopSettings,
	right: SonicWorkshopSettings,
): boolean {
	return left === right || (
		left.active === right.active
		&& left.inputGain === right.inputGain
		&& left.audioIntensity === right.audioIntensity
		&& left.responseRange === right.responseRange
		&& left.peakIntensity === right.peakIntensity
		&& left.theme === right.theme
		&& left.showCover === right.showCover
		&& left.autoRotate === right.autoRotate
		&& left.rotationSpeed === right.rotationSpeed
		&& left.colors.mode === right.colors.mode
		&& left.colors.primary === right.colors.primary
		&& left.colors.base === right.colors.base
		&& left.colors.warm === right.colors.warm
		&& left.colors.cool === right.colors.cool
		&& left.colors.ripple === right.colors.ripple
		&& left.colors.peak === right.colors.peak
	);
}
