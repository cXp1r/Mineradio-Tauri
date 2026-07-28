import type {
	SonicAudioSnapshot,
	SonicBand,
	SonicBandLevels,
	SonicSpectrumFrame,
} from "../audio/audio-snapshot";

export type {
	SonicAudioSnapshot,
	SonicBand,
	SonicBandLevels,
	SonicSpectrumFrame,
} from "../audio/audio-snapshot";

export const SONIC_SPECTRUM_BIN_COUNT = 512 as const;

export interface SonicSpectrumAnalysis {
	readonly bands: SonicBandLevels;
	readonly kickSub: number;
	readonly kickCore: number;
	readonly kickPunch: number;
	readonly body: number;
	readonly vocal: number;
	readonly snap: number;
	readonly lowDrive: number;
	readonly dominance: number;
	readonly energy: number;
	readonly warmth: number;
	readonly brightness: number;
	readonly sharpness: number;
	readonly smoothness: number;
	readonly density: number;
}

export const SONIC_BAND_HZ: Readonly<Record<SonicBand, readonly [number, number]>> = Object.freeze({
	subBass: Object.freeze([32, 58] as const),
	bass: Object.freeze([58, 118] as const),
	lowMid: Object.freeze([118, 260] as const),
	mid: Object.freeze([260, 720] as const),
	highMid: Object.freeze([720, 1_800] as const),
	presence: Object.freeze([1_800, 4_200] as const),
	brilliance: Object.freeze([4_200, 9_000] as const),
	air: Object.freeze([9_000, 16_000] as const),
});

export interface SonicSpectrumFrameInput {
	readonly bins: Uint8Array;
	readonly sampleRate: number;
	readonly fftSize: number;
	readonly currentTimeSeconds: number;
	readonly playing: boolean;
}

export interface SonicAudioProfileInput {
	readonly spectrum: SonicSpectrumFrame | null;
	readonly dtSeconds: number;
	readonly trackKey: string | null;
	readonly monitorEnabled: boolean;
	readonly reducedMotion: boolean;
	readonly fallback?: {
		readonly bass: number;
		readonly mid: number;
		readonly treble: number;
		readonly energy: number;
		readonly beatPulse: number;
	};
}

export interface SonicAudioProfile {
	update(input: SonicAudioProfileInput): SonicAudioSnapshot;
	getSnapshot(): SonicAudioSnapshot;
	reset(): void;
}

function copySpectrumBins(source: Uint8Array): Uint8Array {
	const output = new Uint8Array(SONIC_SPECTRUM_BIN_COUNT);
	if (source.length === SONIC_SPECTRUM_BIN_COUNT) {
		output.set(source);
		return output;
	}
	if (source.length === 0) return output;

	for (let index = 0; index < output.length; index += 1) {
		const sourceStart = index * source.length / output.length;
		const sourceEnd = (index + 1) * source.length / output.length;
		const first = Math.floor(sourceStart);
		const last = Math.max(first, Math.ceil(sourceEnd) - 1);
		let sumSquares = 0;
		let count = 0;
		for (let sourceIndex = first; sourceIndex <= last && sourceIndex < source.length; sourceIndex += 1) {
			const value = source[sourceIndex] ?? 0;
			sumSquares += value * value;
			count += 1;
		}
		output[index] = count > 0 ? Math.round(Math.sqrt(sumSquares / count)) : 0;
	}
	return output;
}

export function createSonicSpectrumFrame(input: SonicSpectrumFrameInput): SonicSpectrumFrame {
	const bins = copySpectrumBins(input.bins);
	return Object.freeze({
		sampleRate: Number.isFinite(input.sampleRate) ? Math.max(0, input.sampleRate) : 0,
		fftSize: Number.isFinite(input.fftSize) ? Math.max(0, Math.round(input.fftSize)) : 0,
		binCount: SONIC_SPECTRUM_BIN_COUNT,
		currentTimeSeconds: Number.isFinite(input.currentTimeSeconds) ? Math.max(0, input.currentTimeSeconds) : 0,
		playing: input.playing,
		bin(index: number): number {
			if (!Number.isInteger(index) || index < 0 || index >= bins.length) return 0;
			return bins[index] ?? 0;
		},
		mean(startInclusive: number, endExclusive: number): number {
			const start = Math.max(0, Math.min(bins.length, Math.floor(startInclusive)));
			const end = Math.max(start, Math.min(bins.length, Math.ceil(endExclusive)));
			if (end <= start) return 0;
			let sum = 0;
			for (let index = start; index < end; index += 1) sum += bins[index] ?? 0;
			return sum / (end - start);
		},
	});
}

function bandRms(frame: SonicSpectrumFrame, hzStart: number, hzEnd: number): number {
	if (frame.sampleRate <= 0 || hzEnd <= hzStart) return 0;
	const binHz = frame.sampleRate / 2 / frame.binCount;
	const start = Math.max(1, Math.ceil(hzStart / binHz));
	const end = Math.min(frame.binCount, Math.max(start + 1, Math.ceil(hzEnd / binHz)));
	let sumSquares = 0;
	let count = 0;
	for (let index = start; index < end; index += 1) {
		const value = frame.bin(index) / 255;
		sumSquares += value * value;
		count += 1;
	}
	return count > 0 ? Math.sqrt(sumSquares / count) : 0;
}

export function analyzeSonicBands(frame: SonicSpectrumFrame): SonicBandLevels {
	return Object.freeze({
		subBass: bandRms(frame, ...SONIC_BAND_HZ.subBass),
		bass: bandRms(frame, ...SONIC_BAND_HZ.bass),
		lowMid: bandRms(frame, ...SONIC_BAND_HZ.lowMid),
		mid: bandRms(frame, ...SONIC_BAND_HZ.mid),
		highMid: bandRms(frame, ...SONIC_BAND_HZ.highMid),
		presence: bandRms(frame, ...SONIC_BAND_HZ.presence),
		brilliance: bandRms(frame, ...SONIC_BAND_HZ.brilliance),
		air: bandRms(frame, ...SONIC_BAND_HZ.air),
	});
}

function clamp01(value: number): number {
	return value < 0 ? 0 : value > 1 ? 1 : value;
}

function analyzeSonicBandLevels(bands: SonicBandLevels): SonicSpectrumAnalysis {
	const orderedBands = [
		bands.subBass,
		bands.bass,
		bands.lowMid,
		bands.mid,
		bands.highMid,
		bands.presence,
		bands.brilliance,
		bands.air,
	] as const;
	const kickSub = bands.subBass;
	const kickCore = bands.bass;
	const kickPunch = clamp01(bands.lowMid * 0.82 + bands.mid * 0.18);
	const body = clamp01(bands.lowMid * 0.45 + bands.mid * 0.45 + bands.highMid * 0.10);
	const vocal = clamp01(bands.mid * 0.25 + bands.highMid * 0.45 + bands.presence * 0.30);
	const snap = clamp01(bands.brilliance * 0.65 + bands.air * 0.35);
	const lowDrive = clamp01(kickSub * 0.35 + kickCore * 0.45 + kickPunch * 0.20);
	const lowMass = bands.subBass + bands.bass + bands.lowMid;
	const remainingMass = bands.mid + bands.highMid + bands.presence + bands.brilliance + bands.air;
	const dominance = clamp01(lowMass / Math.max(0.000_001, lowMass + remainingMass));
	const energy = Math.sqrt(orderedBands.reduce((sum, value) => sum + value * value, 0) / orderedBands.length);
	const warmth = clamp01(bands.subBass * 0.25 + bands.bass * 0.45 + bands.lowMid * 0.30);
	const brightness = clamp01(bands.presence * 0.20 + bands.brilliance * 0.45 + bands.air * 0.35);
	const sharpness = clamp01(bands.brilliance * 0.45 + bands.air * 0.55);
	let adjacentDelta = 0;
	for (let index = 1; index < orderedBands.length; index += 1) {
		adjacentDelta += Math.abs(orderedBands[index] - orderedBands[index - 1]);
	}
	const smoothness = clamp01((1 - adjacentDelta / (orderedBands.length - 1)) * energy);
	const activeBandRatio = orderedBands.filter((value) => value >= 0.08).length / orderedBands.length;
	const density = clamp01(activeBandRatio * 0.65 + energy * 0.35);

	return Object.freeze({
		bands,
		kickSub,
		kickCore,
		kickPunch,
		body,
		vocal,
		snap,
		lowDrive,
		dominance,
		energy,
		warmth,
		brightness,
		sharpness,
		smoothness,
		density,
	});
}

export function analyzeSonicSpectrum(frame: SonicSpectrumFrame): SonicSpectrumAnalysis {
	return analyzeSonicBandLevels(analyzeSonicBands(frame));
}

const EMPTY_SONIC_BANDS: SonicBandLevels = Object.freeze({
	subBass: 0,
	bass: 0,
	lowMid: 0,
	mid: 0,
	highMid: 0,
	presence: 0,
	brilliance: 0,
	air: 0,
});

function createEmptySonicSnapshot(): SonicAudioSnapshot {
	return Object.freeze({
		spectrum: null,
		bands: EMPTY_SONIC_BANDS,
		kickSub: 0,
		kickCore: 0,
		kickPunch: 0,
		body: 0,
		vocal: 0,
		snap: 0,
		lowDrive: 0,
		dominance: 0,
		energy: 0,
		warmth: 0,
		brightness: 0,
		sharpness: 0,
		smoothness: 0,
		density: 0,
		onset: 0,
		flux: 0,
		confidence: 0,
		triggerPulse: 0,
	});
}

function calculatePositiveFlux(current: SonicBandLevels, previous: SonicBandLevels): number {
	const keys = Object.keys(SONIC_BAND_HZ) as SonicBand[];
	let sumSquares = 0;
	for (const key of keys) {
		const delta = Math.max(0, current[key] - previous[key]);
		sumSquares += delta * delta;
	}
	return Math.sqrt(sumSquares / keys.length);
}

function smoothBandLevels(
	previous: SonicBandLevels,
	target: SonicBandLevels,
	dtSeconds: number,
): SonicBandLevels {
	const smooth = (from: number, to: number) => {
		const timeConstant = to > from ? 0.015 : 0.18;
		return from + (to - from) * (1 - Math.exp(-dtSeconds / timeConstant));
	};
	return Object.freeze({
		subBass: smooth(previous.subBass, target.subBass),
		bass: smooth(previous.bass, target.bass),
		lowMid: smooth(previous.lowMid, target.lowMid),
		mid: smooth(previous.mid, target.mid),
		highMid: smooth(previous.highMid, target.highMid),
		presence: smooth(previous.presence, target.presence),
		brilliance: smooth(previous.brilliance, target.brilliance),
		air: smooth(previous.air, target.air),
	});
}

export function createSonicAudioProfile(): SonicAudioProfile {
	let snapshot = createEmptySonicSnapshot();
	let previousBands = EMPTY_SONIC_BANDS;
	let previousTrackKey: string | null = null;
	let previousTimeSeconds = 0;
	let previousSampleRate = 0;
	let previousFftSize = 0;
	let hasTimeline = false;
	let triggerArmed = true;
	let triggerPulse = 0;

	function reset(): void {
		snapshot = createEmptySonicSnapshot();
		previousBands = EMPTY_SONIC_BANDS;
		previousTrackKey = null;
		previousTimeSeconds = 0;
		previousSampleRate = 0;
		previousFftSize = 0;
		hasTimeline = false;
		triggerArmed = true;
		triggerPulse = 0;
	}

	function update(input: SonicAudioProfileInput): SonicAudioSnapshot {
		if (!input.monitorEnabled) {
			reset();
			const fallback = input.fallback;
			if (!fallback) return snapshot;
			const bands = Object.freeze({
				subBass: clamp01(fallback.bass * 0.92),
				bass: clamp01(fallback.bass),
				lowMid: clamp01(fallback.bass * 0.65 + fallback.mid * 0.35),
				mid: clamp01(fallback.mid),
				highMid: clamp01(fallback.mid * 0.84),
				presence: clamp01(fallback.mid * 0.48 + fallback.treble * 0.52),
				brilliance: clamp01(fallback.treble),
				air: clamp01(fallback.treble * 0.80),
			});
			const analysis = analyzeSonicBandLevels(bands);
			snapshot = Object.freeze({
				spectrum: null,
				...analysis,
				energy: clamp01(fallback.energy),
				onset: 0,
				flux: 0,
				confidence: clamp01(fallback.energy * 0.55 + fallback.bass * 0.45),
				triggerPulse: input.reducedMotion ? 0 : clamp01(fallback.beatPulse),
			});
			return snapshot;
		}
		if (!input.spectrum) {
			reset();
			return snapshot;
		}

		const spectrum = input.spectrum;
		const timelineChanged = !hasTimeline
			|| input.trackKey !== previousTrackKey
			|| spectrum.currentTimeSeconds + 0.075 < previousTimeSeconds
			|| spectrum.sampleRate !== previousSampleRate
			|| spectrum.fftSize !== previousFftSize;
		const dt = Math.max(0, Math.min(0.25, input.dtSeconds));
		if (!spectrum.playing) {
			if (timelineChanged) {
				snapshot = createEmptySonicSnapshot();
				previousBands = EMPTY_SONIC_BANDS;
				triggerPulse = 0;
				triggerArmed = true;
			}
			const decay = Math.exp(-dt / 0.18);
			const bands: SonicBandLevels = Object.freeze({
				subBass: snapshot.bands.subBass * decay,
				bass: snapshot.bands.bass * decay,
				lowMid: snapshot.bands.lowMid * decay,
				mid: snapshot.bands.mid * decay,
				highMid: snapshot.bands.highMid * decay,
				presence: snapshot.bands.presence * decay,
				brilliance: snapshot.bands.brilliance * decay,
				air: snapshot.bands.air * decay,
			});
			const analysis = analyzeSonicBandLevels(bands);
			triggerPulse *= decay;
			if (analysis.lowDrive < 0.32) triggerArmed = true;
			snapshot = Object.freeze({
				spectrum,
				...analysis,
				onset: 0,
				flux: 0,
				confidence: snapshot.confidence * decay,
				triggerPulse: input.reducedMotion ? 0 : triggerPulse,
			});
			previousBands = bands;
			previousTrackKey = input.trackKey;
			previousTimeSeconds = spectrum.currentTimeSeconds;
			previousSampleRate = spectrum.sampleRate;
			previousFftSize = spectrum.fftSize;
			hasTimeline = true;
			return snapshot;
		}

		const rawAnalysis = analyzeSonicSpectrum(spectrum);
		const flux = timelineChanged ? 0 : calculatePositiveFlux(rawAnalysis.bands, previousBands);
		let onset = 0;
		if (timelineChanged) {
			triggerArmed = rawAnalysis.lowDrive < 0.58;
		} else if (rawAnalysis.lowDrive < 0.32) {
			triggerArmed = true;
		} else if (triggerArmed && rawAnalysis.lowDrive >= 0.58) {
			onset = clamp01((rawAnalysis.lowDrive - 0.58) / 0.42 + flux * 0.45);
			triggerArmed = false;
		}

		triggerPulse *= Math.exp(-dt / 0.18);
		if (!input.reducedMotion) triggerPulse = Math.max(triggerPulse, onset);
		const smoothedBands = smoothBandLevels(
			timelineChanged ? EMPTY_SONIC_BANDS : snapshot.bands,
			rawAnalysis.bands,
			dt,
		);
		const analysis = analyzeSonicBandLevels(smoothedBands);
		const confidence = clamp01(rawAnalysis.lowDrive * 0.52 + rawAnalysis.dominance * 0.28 + flux * 0.55);
		snapshot = Object.freeze({
			spectrum,
			...analysis,
			onset,
			flux,
			confidence,
			triggerPulse: input.reducedMotion ? 0 : triggerPulse,
		});

		previousBands = rawAnalysis.bands;
		previousTrackKey = input.trackKey;
		previousTimeSeconds = spectrum.currentTimeSeconds;
		previousSampleRate = spectrum.sampleRate;
		previousFftSize = spectrum.fftSize;
		hasTimeline = true;
		return snapshot;
	}

	return {
		update,
		getSnapshot: () => snapshot,
		reset,
	};
}
