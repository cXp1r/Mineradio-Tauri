export type SonicColorMode = "cover" | "custom";

export type SonicPerformanceQuality = "eco" | "balanced" | "high" | "ultra";

export interface SonicTerrainSettings {
	readonly amplitude: number;
	readonly motionSpeed: number;
	readonly density: number;
	readonly range: number;
	readonly lower: number;
	readonly depth: number;
	readonly autoRotate: number;
}

export interface SonicEqSettings {
	readonly subBass: number;
	readonly bass: number;
	readonly lowMid: number;
	readonly mid: number;
	readonly highMid: number;
	readonly presence: number;
	readonly brilliance: number;
	readonly air: number;
}

export interface SonicColorSettings {
	readonly mode: SonicColorMode;
	readonly base: string;
	readonly cool: string;
	readonly warm: string;
	readonly accent: string;
	readonly glow: number;
}

export interface SonicFloatingSettings {
	readonly enabled: boolean;
	readonly count: number;
	readonly intensity: number;
	readonly minSize: number;
	readonly maxSize: number;
	readonly speed: number;
}

export interface SonicTriggerSettings {
	readonly monitorEnabled: boolean;
	readonly autoTrack: boolean;
	readonly sensitivity: number;
	readonly bandStart: number;
	readonly bandEnd: number;
	readonly threshold: number;
	readonly pulseStrength: number;
}

export interface SonicTopographySettings {
	readonly terrain: SonicTerrainSettings;
	readonly eq: SonicEqSettings;
	readonly colors: SonicColorSettings;
	readonly floating: SonicFloatingSettings;
	readonly trigger: SonicTriggerSettings;
}

export const SONIC_TOPOGRAPHY_DEFAULTS: SonicTopographySettings = Object.freeze({
	terrain: Object.freeze({
		amplitude: 50,
		motionSpeed: 50,
		density: 46,
		range: 82,
		lower: 68,
		depth: 62,
		autoRotate: 50,
	}),
	eq: Object.freeze({
		subBass: 90,
		bass: 92,
		lowMid: 50,
		mid: 50,
		highMid: 50,
		presence: 25,
		brilliance: 50,
		air: 48,
	}),
	colors: Object.freeze({
		mode: "cover",
		base: "#05070c",
		cool: "#0066ff",
		warm: "#ff3c19",
		accent: "#33e6ff",
		glow: 20,
	}),
	floating: Object.freeze({
		enabled: true,
		count: 80,
		intensity: 36,
		minSize: 9,
		maxSize: 12,
		speed: 59,
	}),
	trigger: Object.freeze({
		monitorEnabled: true,
		autoTrack: true,
		sensitivity: 100,
		bandStart: 1,
		bandEnd: 4,
		threshold: 32,
		pulseStrength: 62,
	}),
});

export const SONIC_TERRAIN_GRID_CAP: Readonly<Record<SonicPerformanceQuality, number>> = Object.freeze({
	eco: 112,
	balanced: 160,
	high: 192,
	ultra: 224,
});

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
	return value !== null && typeof value === "object"
		? value as Readonly<Record<string, unknown>>
		: {};
}

function integerControl(value: unknown, fallback: number, minimum = 0, maximum = 100): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(maximum, Math.max(minimum, Math.round(value)));
}

function booleanControl(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function colorControl(value: unknown, fallback: string): string {
	if (typeof value !== "string") return fallback;
	const color = value.trim().toLowerCase();
	if (/^#[0-9a-f]{6}$/.test(color)) return color;
	const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(color);
	return short
		? `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`
		: fallback;
}

export function normalizeSonicTopographySettings(value: unknown): SonicTopographySettings {
	const source = asRecord(value);
	const terrain = asRecord(source.terrain);
	const eq = asRecord(source.eq);
	const colors = asRecord(source.colors);
	const floating = asRecord(source.floating);
	const trigger = asRecord(source.trigger);
	const bandStart = integerControl(trigger.bandStart, SONIC_TOPOGRAPHY_DEFAULTS.trigger.bandStart, 0, 510);
	const requestedBandEnd = integerControl(trigger.bandEnd, SONIC_TOPOGRAPHY_DEFAULTS.trigger.bandEnd, 2, 512);
	const bandEnd = Math.min(512, Math.max(bandStart + 2, requestedBandEnd));

	return Object.freeze({
		terrain: Object.freeze({
			amplitude: integerControl(terrain.amplitude, SONIC_TOPOGRAPHY_DEFAULTS.terrain.amplitude),
			motionSpeed: integerControl(terrain.motionSpeed, SONIC_TOPOGRAPHY_DEFAULTS.terrain.motionSpeed),
			density: integerControl(terrain.density, SONIC_TOPOGRAPHY_DEFAULTS.terrain.density),
			range: integerControl(terrain.range, SONIC_TOPOGRAPHY_DEFAULTS.terrain.range),
			lower: integerControl(terrain.lower, SONIC_TOPOGRAPHY_DEFAULTS.terrain.lower),
			depth: integerControl(terrain.depth, SONIC_TOPOGRAPHY_DEFAULTS.terrain.depth),
			autoRotate: integerControl(terrain.autoRotate, SONIC_TOPOGRAPHY_DEFAULTS.terrain.autoRotate),
		}),
		eq: Object.freeze({
			subBass: integerControl(eq.subBass, SONIC_TOPOGRAPHY_DEFAULTS.eq.subBass),
			bass: integerControl(eq.bass, SONIC_TOPOGRAPHY_DEFAULTS.eq.bass),
			lowMid: integerControl(eq.lowMid, SONIC_TOPOGRAPHY_DEFAULTS.eq.lowMid),
			mid: integerControl(eq.mid, SONIC_TOPOGRAPHY_DEFAULTS.eq.mid),
			highMid: integerControl(eq.highMid, SONIC_TOPOGRAPHY_DEFAULTS.eq.highMid),
			presence: integerControl(eq.presence, SONIC_TOPOGRAPHY_DEFAULTS.eq.presence),
			brilliance: integerControl(eq.brilliance, SONIC_TOPOGRAPHY_DEFAULTS.eq.brilliance),
			air: integerControl(eq.air, SONIC_TOPOGRAPHY_DEFAULTS.eq.air),
		}),
		colors: Object.freeze({
			mode: colors.mode === "custom" || colors.mode === "cover"
				? colors.mode
				: SONIC_TOPOGRAPHY_DEFAULTS.colors.mode,
			base: colorControl(colors.base, SONIC_TOPOGRAPHY_DEFAULTS.colors.base),
			cool: colorControl(colors.cool, SONIC_TOPOGRAPHY_DEFAULTS.colors.cool),
			warm: colorControl(colors.warm, SONIC_TOPOGRAPHY_DEFAULTS.colors.warm),
			accent: colorControl(colors.accent, SONIC_TOPOGRAPHY_DEFAULTS.colors.accent),
			glow: integerControl(colors.glow, SONIC_TOPOGRAPHY_DEFAULTS.colors.glow),
		}),
		floating: Object.freeze({
			enabled: booleanControl(floating.enabled, SONIC_TOPOGRAPHY_DEFAULTS.floating.enabled),
			count: integerControl(floating.count, SONIC_TOPOGRAPHY_DEFAULTS.floating.count),
			intensity: integerControl(floating.intensity, SONIC_TOPOGRAPHY_DEFAULTS.floating.intensity),
			minSize: integerControl(floating.minSize, SONIC_TOPOGRAPHY_DEFAULTS.floating.minSize),
			maxSize: integerControl(floating.maxSize, SONIC_TOPOGRAPHY_DEFAULTS.floating.maxSize),
			speed: integerControl(floating.speed, SONIC_TOPOGRAPHY_DEFAULTS.floating.speed),
		}),
		trigger: Object.freeze({
			monitorEnabled: booleanControl(trigger.monitorEnabled, SONIC_TOPOGRAPHY_DEFAULTS.trigger.monitorEnabled),
			autoTrack: booleanControl(trigger.autoTrack, SONIC_TOPOGRAPHY_DEFAULTS.trigger.autoTrack),
			sensitivity: integerControl(trigger.sensitivity, SONIC_TOPOGRAPHY_DEFAULTS.trigger.sensitivity),
			bandStart,
			bandEnd,
			threshold: integerControl(trigger.threshold, SONIC_TOPOGRAPHY_DEFAULTS.trigger.threshold),
			pulseStrength: integerControl(trigger.pulseStrength, SONIC_TOPOGRAPHY_DEFAULTS.trigger.pulseStrength),
		}),
	});
}

export function resolveSonicTerrainGrid(density: number, quality: SonicPerformanceQuality): number {
	const normalizedDensity = integerControl(density, SONIC_TOPOGRAPHY_DEFAULTS.terrain.density);
	const uncapped = Math.round((96 + (224 - 96) * (normalizedDensity / 100)) / 4) * 4;
	return Math.min(SONIC_TERRAIN_GRID_CAP[quality], uncapped);
}

export function mapSonicTerrainAmplitude(value: number): number {
	const normalized = integerControl(value, SONIC_TOPOGRAPHY_DEFAULTS.terrain.amplitude);
	if (normalized <= 50) return normalized / 50;
	const upper = (normalized - 50) / 50;
	return 1 + upper * upper * 14;
}
