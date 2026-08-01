import {
	DEFAULT_STAGE_LYRICS_SETTINGS,
	type StageLyricMotionStyle,
	type StageLyricsSettings,
} from "../model/stage-lyrics-settings";

export type StageLyricMotionProfileSettings = Pick<
	StageLyricsSettings,
	| "motionStyle"
	| "motionSoftness"
	| "glitchCameraBind"
	| "glitchIntensity"
	| "glitchSlice"
	| "glitchChroma"
	| "glitchRate"
	| "glitchJitter"
>;

export interface StageLyricMotionProfileOptions {
	readonly lyricsHasNativeKaraoke?: boolean;
}

export interface StageLyricMotionProfile {
	readonly style: StageLyricMotionStyle;
	readonly enter: number;
	readonly exit: number;
	readonly slide: number;
	readonly progressEase: number;
	readonly contextDrift: number;
	readonly edgeBoost: number;
	readonly sweep: number;
	readonly shimmer: number;
	readonly glitch: number;
	readonly glitchSlice: number;
	readonly glitchChroma: number;
	readonly glitchRate: number;
	readonly glitchJitter: number;
	readonly glitchCameraBind: boolean;
	readonly glowLift: number;
	readonly floatAmp: number;
}

interface StageLyricMotionStyleProfile {
	readonly enter: number;
	readonly exit: number;
	readonly slide: number;
	readonly progressEaseMultiplier: number;
	readonly contextDrift: number;
	readonly edgeBoost: number;
	readonly sweep: number;
	readonly shimmer: number;
	readonly glowLift: number;
	readonly floatAmp: number;
}

const STYLE_PROFILES = Object.freeze({
	glass: Object.freeze({
		enter: 0.62,
		exit: 0.52,
		slide: 0.38,
		progressEaseMultiplier: 0.9,
		contextDrift: 0.066,
		edgeBoost: 1.18,
		sweep: 0.72,
		shimmer: 0.22,
		glowLift: 1,
		floatAmp: 1,
	}),
	smooth: Object.freeze({
		enter: 0.72,
		exit: 0.62,
		slide: 0.24,
		progressEaseMultiplier: 0.72,
		contextDrift: 0.03,
		edgeBoost: 0.62,
		sweep: 0.18,
		shimmer: 0.05,
		glowLift: 0.74,
		floatAmp: 0.55,
	}),
	float: Object.freeze({
		enter: 0.86,
		exit: 0.76,
		slide: 0.54,
		progressEaseMultiplier: 0.66,
		contextDrift: 0.12,
		edgeBoost: 1.04,
		sweep: 0.36,
		shimmer: 0.14,
		glowLift: 1.16,
		floatAmp: 1.45,
	}),
	quick: Object.freeze({
		enter: 0.36,
		exit: 0.32,
		slide: 0.22,
		progressEaseMultiplier: 1.34,
		contextDrift: 0.034,
		edgeBoost: 0.7,
		sweep: 0.28,
		shimmer: 0.1,
		glowLift: 0.86,
		floatAmp: 0.62,
	}),
	shine: Object.freeze({
		enter: 0.5,
		exit: 0.44,
		slide: 0.34,
		progressEaseMultiplier: 1.02,
		contextDrift: 0.052,
		edgeBoost: 1.42,
		sweep: 1.22,
		shimmer: 0.34,
		glowLift: 1.3,
		floatAmp: 0.82,
	}),
	glitch: Object.freeze({
		enter: 0.4,
		exit: 0.36,
		slide: 0.3,
		progressEaseMultiplier: 1.24,
		contextDrift: 0.035,
		edgeBoost: 1.18,
		sweep: 0.54,
		shimmer: 0.28,
		glowLift: 1.08,
		floatAmp: 0.7,
	}),
} satisfies Readonly<Record<StageLyricMotionStyle, StageLyricMotionStyleProfile>>);

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
}

export function createStageLyricMotionProfile(
	settings: Readonly<StageLyricMotionProfileSettings> = DEFAULT_STAGE_LYRICS_SETTINGS,
	options: StageLyricMotionProfileOptions = {},
): Readonly<StageLyricMotionProfile> {
	const style = settings.motionStyle in STYLE_PROFILES ? settings.motionStyle : "float";
	const source = STYLE_PROFILES[style];
	const softness = clamp(settings.motionSoftness, 0.15, 1.2);
	const slideScale = clamp(0.8 + softness * 0.35, 0.75, 1.28);
	const progressBase = options.lyricsHasNativeKaraoke ? 0.34 : 0.18;
	const glitch = style === "glitch" ? clamp(settings.glitchIntensity, 0, 1.5) : 0;

	return Object.freeze({
		style,
		enter: source.enter * softness,
		exit: source.exit * softness,
		slide: source.slide * slideScale,
		progressEase: clamp(
			(progressBase * source.progressEaseMultiplier) / clamp(softness, 0.35, 1.2),
			0.08,
			0.72,
		),
		contextDrift: source.contextDrift,
		edgeBoost: source.edgeBoost,
		sweep: source.sweep,
		shimmer: source.shimmer,
		glitch,
		glitchSlice: style === "glitch" ? clamp(settings.glitchSlice, 0, 1.4) : 0,
		glitchChroma: style === "glitch" ? clamp(settings.glitchChroma, 0, 1.6) : 0,
		glitchRate: style === "glitch" ? clamp(settings.glitchRate, 0.45, 2.2) : 1,
		glitchJitter: style === "glitch" ? clamp(settings.glitchJitter, 0, 1.8) : 0,
		glitchCameraBind: style === "glitch" && settings.glitchCameraBind,
		glowLift: source.glowLift + glitch * 0.1,
		floatAmp: source.floatAmp,
	});
}
