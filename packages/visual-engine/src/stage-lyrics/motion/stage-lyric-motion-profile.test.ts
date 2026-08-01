import { expect, test } from "bun:test";
import {
	DEFAULT_STAGE_LYRICS_SETTINGS,
	normalizeStageLyricsSettings,
	type StageLyricMotionStyle,
} from "../model/stage-lyrics-settings";
import {
	createStageLyricMotionProfile,
	type StageLyricMotionProfile,
} from "./stage-lyric-motion-profile";

const MOTION_STYLES: readonly StageLyricMotionStyle[] = [
	"glass",
	"smooth",
	"float",
	"quick",
	"shine",
	"glitch",
];

function round(value: number): number {
	return Number(value.toFixed(4));
}

function signature(profile: StageLyricMotionProfile) {
	return {
		timing: [profile.enter, profile.exit, profile.slide, profile.progressEase].map(round),
		visual: [
			profile.contextDrift,
			profile.edgeBoost,
			profile.sweep,
			profile.shimmer,
			profile.glowLift,
			profile.floatAmp,
		].map(round),
	};
}

test("createStageLyricMotionProfile characterizes all Electron 2.0.2 motion styles", () => {
	const profiles = Object.fromEntries(MOTION_STYLES.map((style) => {
		const settings = normalizeStageLyricsSettings({
			...DEFAULT_STAGE_LYRICS_SETTINGS,
			motionStyle: style,
			motionSoftness: 1,
		});
		return [style, signature(createStageLyricMotionProfile(settings))];
	}));

	expect(profiles).toEqual({
		glass: {
			timing: [0.62, 0.52, 0.437, 0.162],
			visual: [0.066, 1.18, 0.72, 0.22, 1, 1],
		},
		smooth: {
			timing: [0.72, 0.62, 0.276, 0.1296],
			visual: [0.03, 0.62, 0.18, 0.05, 0.74, 0.55],
		},
		float: {
			timing: [0.86, 0.76, 0.621, 0.1188],
			visual: [0.12, 1.04, 0.36, 0.14, 1.16, 1.45],
		},
		quick: {
			timing: [0.36, 0.32, 0.253, 0.2412],
			visual: [0.034, 0.7, 0.28, 0.1, 0.86, 0.62],
		},
		shine: {
			timing: [0.5, 0.44, 0.391, 0.1836],
			visual: [0.052, 1.42, 1.22, 0.34, 1.3, 0.82],
		},
		glitch: {
			timing: [0.4, 0.36, 0.345, 0.2232],
			visual: [0.035, 1.18, 0.54, 0.28, 1.18, 0.7],
		},
	});
});

test("createStageLyricMotionProfile applies softness to transition duration and progress response", () => {
	const profile = createStageLyricMotionProfile(normalizeStageLyricsSettings({
		motionStyle: "glass",
		motionSoftness: 0.72,
	}));

	expect(signature(profile).timing).toEqual([0.4464, 0.3744, 0.3998, 0.225]);
	expect(Object.isFrozen(profile)).toBe(true);
});

test("createStageLyricMotionProfile keeps native karaoke progress more responsive", () => {
	const settings = normalizeStageLyricsSettings({
		motionStyle: "smooth",
		motionSoftness: 1,
	});
	const timed = createStageLyricMotionProfile(settings);
	const native = createStageLyricMotionProfile(settings, { lyricsHasNativeKaraoke: true });

	expect(round(timed.progressEase)).toBe(0.1296);
	expect(round(native.progressEase)).toBe(0.2448);
});

test("createStageLyricMotionProfile exposes glitch controls only for the glitch style", () => {
	const glitch = createStageLyricMotionProfile(normalizeStageLyricsSettings({
		motionStyle: "glitch",
		glitchCameraBind: false,
		glitchIntensity: 1.5,
		glitchSlice: 1.4,
		glitchChroma: 1.6,
		glitchRate: 2.2,
		glitchJitter: 1.8,
	}));
	const float = createStageLyricMotionProfile(normalizeStageLyricsSettings({
		motionStyle: "float",
		glitchCameraBind: true,
		glitchIntensity: 1.5,
		glitchSlice: 1.4,
		glitchChroma: 1.6,
		glitchRate: 2.2,
		glitchJitter: 1.8,
	}));

	expect({
		glitch: glitch.glitch,
		slice: glitch.glitchSlice,
		chroma: glitch.glitchChroma,
		rate: glitch.glitchRate,
		jitter: glitch.glitchJitter,
		cameraBind: glitch.glitchCameraBind,
	}).toEqual({
		glitch: 1.5,
		slice: 1.4,
		chroma: 1.6,
		rate: 2.2,
		jitter: 1.8,
		cameraBind: false,
	});
	expect({
		glitch: float.glitch,
		slice: float.glitchSlice,
		chroma: float.glitchChroma,
		rate: float.glitchRate,
		jitter: float.glitchJitter,
		cameraBind: float.glitchCameraBind,
	}).toEqual({
		glitch: 0,
		slice: 0,
		chroma: 0,
		rate: 1,
		jitter: 0,
		cameraBind: false,
	});
});
