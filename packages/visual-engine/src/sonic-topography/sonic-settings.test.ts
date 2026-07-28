import { expect, test } from "bun:test";
import {
	mapSonicTerrainAmplitude,
	normalizeSonicTopographySettings,
	resolveSonicTerrainGrid,
	SONIC_TOPOGRAPHY_DEFAULTS,
} from "./sonic-settings";

test("Sonic clean-room settings expose the frozen Electron 2.0.2 effective defaults", () => {
	expect(SONIC_TOPOGRAPHY_DEFAULTS).toEqual({
		terrain: {
			amplitude: 50,
			motionSpeed: 50,
			density: 46,
			range: 82,
			lower: 68,
			depth: 62,
			autoRotate: 50,
		},
		eq: {
			subBass: 90,
			bass: 92,
			lowMid: 50,
			mid: 50,
			highMid: 50,
			presence: 25,
			brilliance: 50,
			air: 48,
		},
		colors: {
			mode: "cover",
			base: "#05070c",
			cool: "#0066ff",
			warm: "#ff3c19",
			accent: "#33e6ff",
			glow: 20,
		},
		floating: {
			enabled: true,
			count: 80,
			intensity: 36,
			minSize: 9,
			maxSize: 12,
			speed: 59,
		},
		trigger: {
			monitorEnabled: true,
			autoTrack: true,
			sensitivity: 100,
			bandStart: 1,
			bandEnd: 4,
			threshold: 32,
			pulseStrength: 62,
		},
	});
	expect(Object.isFrozen(SONIC_TOPOGRAPHY_DEFAULTS)).toBe(true);
	expect(Object.isFrozen(SONIC_TOPOGRAPHY_DEFAULTS.terrain)).toBe(true);
});

test("Sonic settings normalization fills missing values and clamps persisted controls", () => {
	const normalized = normalizeSonicTopographySettings({
		terrain: { amplitude: -10.4, density: 130.8, motionSpeed: 42.6 },
		eq: { subBass: Number.NaN, bass: 91.6, presence: -2 },
		colors: { mode: "invalid", base: "#ABC", cool: "not-a-color", glow: 101.2 },
		floating: { enabled: false, count: 120.1, minSize: -5, maxSize: 101 },
		trigger: {
			monitorEnabled: false,
			autoTrack: false,
			sensitivity: 61.7,
			bandStart: 511,
			bandEnd: 2,
			threshold: -1,
		},
	});

	expect({
		terrain: {
			amplitude: normalized.terrain.amplitude,
			density: normalized.terrain.density,
			motionSpeed: normalized.terrain.motionSpeed,
			range: normalized.terrain.range,
		},
		eq: {
			subBass: normalized.eq.subBass,
			bass: normalized.eq.bass,
			presence: normalized.eq.presence,
			air: normalized.eq.air,
		},
		colors: {
			mode: normalized.colors.mode,
			base: normalized.colors.base,
			cool: normalized.colors.cool,
			glow: normalized.colors.glow,
		},
		floating: {
			enabled: normalized.floating.enabled,
			count: normalized.floating.count,
			minSize: normalized.floating.minSize,
			maxSize: normalized.floating.maxSize,
			speed: normalized.floating.speed,
		},
		trigger: normalized.trigger,
	}).toEqual({
		terrain: { amplitude: 0, density: 100, motionSpeed: 43, range: 82 },
		eq: { subBass: 90, bass: 92, presence: 0, air: 48 },
		colors: { mode: "cover", base: "#aabbcc", cool: "#0066ff", glow: 100 },
		floating: { enabled: false, count: 100, minSize: 0, maxSize: 100, speed: 59 },
		trigger: {
			monitorEnabled: false,
			autoTrack: false,
			sensitivity: 62,
			bandStart: 510,
			bandEnd: 512,
			threshold: 0,
			pulseStrength: 62,
		},
	});
	expect(Object.isFrozen(normalized)).toBe(true);
	expect(Object.isFrozen(normalized.trigger)).toBe(true);
});

test("Sonic terrain derivation honors quality caps and the clean-room amplitude curve", () => {
	expect({
		density46: {
			eco: resolveSonicTerrainGrid(46, "eco"),
			balanced: resolveSonicTerrainGrid(46, "balanced"),
			high: resolveSonicTerrainGrid(46, "high"),
			ultra: resolveSonicTerrainGrid(46, "ultra"),
		},
		density100: {
			eco: resolveSonicTerrainGrid(100, "eco"),
			balanced: resolveSonicTerrainGrid(100, "balanced"),
			high: resolveSonicTerrainGrid(100, "high"),
			ultra: resolveSonicTerrainGrid(100, "ultra"),
		},
		amplitude: [0, 50, 100].map(mapSonicTerrainAmplitude),
	}).toEqual({
		density46: { eco: 112, balanced: 156, high: 156, ultra: 156 },
		density100: { eco: 112, balanced: 160, high: 192, ultra: 224 },
		amplitude: [0, 1, 15],
	});
});
