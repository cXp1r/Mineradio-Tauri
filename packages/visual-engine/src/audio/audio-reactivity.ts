import {
	type AudioSnapshot,
	type AudioReactivityOptions,
	type AudioReactivityEngine,
	type AudioFrameBytes,
	type AudioFrameSource,
	type BeatHandler,
} from "./audio-snapshot";
import {
	createPeakFollower,
	type PeakFollower,
} from "./peak-followers";
import {
	analyzeBeatFrame,
	analyzeMainFrame,
	DEFAULT_BIN_RANGES,
	DEFAULT_BEAT_BAND_HZ,
	type MainBinRanges,
	type BeatBandHz,
	clamp01,
} from "./frequency-bands";
import { createBeatEngine, type BeatSamples } from "./beat-engine";

const PEAK_BASS_RELEASE_MS = -1000 / 60 / Math.log(0.994);
const PEAK_MID_RELEASE_MS = -1000 / 60 / Math.log(0.993);
const PEAK_TREBLE_RELEASE_MS = -1000 / 60 / Math.log(0.992);
const PEAK_ENERGY_RELEASE_MS = -1000 / 60 / Math.log(0.995);

const ENV_ATTACK_PER_FRAME = 60;

function smoothstep01(v: number): number {
	const x = clamp01(v);
	return x * x * (3 - 2 * x);
}

export function createAudioReactivity(opts: AudioReactivityOptions = {}): AudioReactivityEngine {
	const mainAnalyserConfig = opts.mainAnalyser ?? { fftSize: 2048, smoothingTimeConstant: 0.58 };
	const beatAnalyserConfig = opts.beatAnalyser ?? { fftSize: 2048, smoothingTimeConstant: 0.10 };
	const staticFrameSource: AudioFrameSource | null = opts.frameSource ?? null;
	const externalReducedMotion = opts.prefersReducedMotion;

	let frameSource: AudioFrameSource | null = staticFrameSource;
	let enabled = true;
	let prefersReducedMotionValue = false;
	let waitingForBeatMap = true;
	let beatMapReadyForCamera = false;

	const bassPeak = createPeakFollower(0.12, 0, PEAK_BASS_RELEASE_MS, 0.030);
	const midPeak = createPeakFollower(0.10, 0, PEAK_MID_RELEASE_MS, 0.026);
	const treblePeak = createPeakFollower(0.08, 0, PEAK_TREBLE_RELEASE_MS, 0.018);
	const energyPeak = createPeakFollower(0.10, 0, PEAK_ENERGY_RELEASE_MS, 0.030);
	const peakFollowers = { bass: bassPeak, mid: midPeak, treble: treblePeak, energy: energyPeak };

	const beatEngine = createBeatEngine();

	let smoothBass = 0;
	let smoothMid = 0;
	let smoothTreb = 0;
	let smoothEnergy = 0;
	let prevEnergy = 0;
	let beatPulse = 0;
	let lyricSunEnergy = 0;
	let lyricSunTarget = 0;
	let lyricSunHold = 0;
	let lyricSunAvg = 0;
	let lyricSunPeak = 0.55;
	let scheduledBeatPulse = 0;
	let scheduledBeatFlag = false;
	let beatOnsetFlag = false;
	let bass = 0;
	let mid = 0;
	let treble = 0;
	let audioEnergy = 0;
	let rb = 0;
	let rm = 0;
	let rt = 0;
	let re = 0;

	const beatSubscribers = new Set<BeatHandler>();

	function env(prev: number, next: number, attack: number, release: number, dt: number): number {
		const per = next > prev ? attack : release;
		const k = 1 - Math.pow(1 - per, dt * ENV_ATTACK_PER_FRAME);
		return prev + (next - prev) * k;
	}

	function notifyBeat(burst: number, isScheduled: boolean) {
		for (const cb of beatSubscribers) {
			try {
				cb(burst, isScheduled);
			} catch {
				// ignore consumer failures
			}
		}
	}

	function decayIdle(dt: number) {
		void dt;
		smoothBass *= 0.91;
		smoothMid *= 0.91;
		smoothTreb *= 0.91;
		smoothEnergy *= 0.91;
		beatPulse *= 0.82;
		lyricSunTarget = 0;
		lyricSunHold *= 0.90;
		lyricSunEnergy *= 0.92;
		lyricSunAvg *= 0.995;
		lyricSunPeak = Math.max(0.48, lyricSunPeak * 0.997);
	}

	function resetLyricSunEnergy(): void {
		lyricSunEnergy = 0;
		lyricSunTarget = 0;
		lyricSunHold = 0;
		lyricSunAvg = 0;
		lyricSunPeak = 0.55;
	}

	function updateLyricSunEnergy(vocal: number): void {
		const sunEnergy = clamp01((smoothEnergy - 0.18) / 0.38);
		const sunVoice = clamp01((vocal - 0.11) / 0.34);
		const sunMelody = clamp01((smoothMid - 0.16) / 0.27);
		const sunAir = clamp01((smoothTreb - 0.105) / 0.17);
		let sunRaw = clamp01(sunEnergy * 0.36 + sunVoice * 0.18 + sunMelody * 0.26 + sunAir * 0.20);
		sunRaw = smoothstep01(sunRaw);
		lyricSunAvg += (sunRaw - lyricSunAvg) * 0.006;
		lyricSunPeak = Math.max(0.48, lyricSunPeak * 0.9985, sunRaw);
		const sunThreshold = Math.max(0.78, lyricSunAvg + 0.20, lyricSunPeak * 0.74);
		let sunGate = clamp01((sunRaw - sunThreshold) / Math.max(0.08, 1.0 - sunThreshold));
		sunGate = smoothstep01(sunGate);
		lyricSunHold += (sunGate - lyricSunHold) * (sunGate > lyricSunHold ? 0.035 : 0.014);
		lyricSunTarget = lyricSunHold > 0.16 ? clamp01((lyricSunHold - 0.16) / 0.84) : 0;
		lyricSunEnergy += (lyricSunTarget - lyricSunEnergy) * (lyricSunTarget > lyricSunEnergy ? 0.075 : 0.030);
	}

	function applySnapshotPostBlock(dt: number) {
		void dt;
		audioEnergy = Math.max(smoothEnergy, beatPulse * 0.30);
		bass = Math.min(0.90, smoothBass * 1.05 + beatPulse * 0.18);
		mid = Math.min(0.72, smoothMid * 1.12);
		treble = Math.min(0.62, smoothTreb * 1.20);
	}

	function update(dt: number) {
		const dtSec = Math.max(0.001, Math.min(0.05, dt));
		beatOnsetFlag = false;

		if (!enabled) {
			smoothBass = 0;
			smoothMid = 0;
			smoothTreb = 0;
			smoothEnergy = 0;
			beatPulse = 0;
			resetLyricSunEnergy();
			scheduledBeatPulse = 0;
			scheduledBeatFlag = false;
			prevEnergy = 0;
			audioEnergy = 0;
			bass = 0;
			mid = 0;
			treble = 0;
			rb = 0;
			rm = 0;
			rt = 0;
			re = 0;
			return;
		}

		const frame: AudioFrameBytes | null = frameSource ? frameSource() : null;
		const playing = !!(frame && frame.playing);

		if (!frame || !playing) {
			decayIdle(dtSec);
			applySnapshotPostBlock(dtSec);
			return;
		}

		const main = analyzeMainFrame(
			frame.mainFreqData,
			frame.mainTimeData,
			DEFAULT_BIN_RANGES,
		);
		const beat = analyzeBeatFrame(
			frame.beatFreqData,
			frame.beatTimeData,
			frame.beatSampleRate,
			frame.beatFftSize,
			DEFAULT_BEAT_BAND_HZ,
		);

		bassPeak.update(main.kick, dtSec * 1000);
		midPeak.update(main.mid, dtSec * 1000);
		treblePeak.update(main.treble, dtSec * 1000);
		energyPeak.update(main.energy, dtSec * 1000);

		const bassPeakVal = bassPeak.get();
		const midPeakVal = midPeak.get();
		const treblePeakVal = treblePeak.get();
		const energyPeakVal = energyPeak.get();

		rb = Math.min(1, Math.pow(main.kick / Math.max(0.038, bassPeakVal * 0.66), 0.78));
		rm = Math.min(1, Math.pow(main.mid / Math.max(0.025, midPeakVal * 0.70), 0.86));
		rt = Math.min(1, Math.pow(main.treble / Math.max(0.020, treblePeakVal * 0.74), 0.92));
		re = Math.min(1, Math.pow(main.energy / Math.max(0.034, energyPeakVal * 0.68), 0.82));

		const bassOnset = Math.max(0, rb - smoothBass);
		const energyOnset = Math.max(0, re - prevEnergy);
		prevEnergy = prevEnergy * 0.88 + re * 0.12;

		if (!prefersReducedMotionValue) {
			const samples: BeatSamples = {
				sub: beat.sub,
				kick: beat.kick,
				body: beat.body,
				vocal: beat.vocal,
				snap: beat.snap,
				rms: beat.rms,
				currentTimeSec: frame.currentTimeSeconds,
			};
			const rtBeat = beatEngine.update(samples, dtSec * 1000);
			if (rtBeat.hit) {
				const liveKickFrame = rtBeat.lowPresence > 0.50 && rb > 0.42 && bassOnset > 0.070 && energyOnset > 0.016;
				const liveStrongHit = rtBeat.confidence > 0.76 && rtBeat.strength > 0.70 && rtBeat.score > 0.56 && liveKickFrame;
				const liveTempoHit = rtBeat.tempoAssist && rtBeat.confidence > 0.80 && rtBeat.strength > 0.66 && rtBeat.lowPresence > 0.50 && bassOnset > 0.052;
				let liveFallbackOk: boolean;
				if (waitingForBeatMap) {
					liveFallbackOk = liveStrongHit || liveTempoHit;
				} else {
					liveFallbackOk = rtBeat.confidence > 0.84 && rtBeat.strength > 0.80 && rtBeat.lowPresence > 0.54 && (liveKickFrame || rtBeat.score > 0.68);
				}
				if (!beatMapReadyForCamera && liveFallbackOk) {
					const previewPulseScale = waitingForBeatMap ? 0.68 : 1;
					const rtPulse = Math.min(
						waitingForBeatMap ? 0.46 : 0.62,
						rtBeat.strength * (rtBeat.tempoAssist ? 0.62 : 0.68) * previewPulseScale,
					);
					if (rtPulse > beatPulse + 0.09) {
						beatOnsetFlag = true;
						notifyBeat(rtPulse, false);
					}
					beatPulse = Math.max(beatPulse, rtPulse);
				}
			} else if (bassOnset > 0.075 && rb > 0.32 && energyOnset > 0.020) {
				beatPulse = Math.max(beatPulse, Math.min(0.12, bassOnset * 0.18));
			}
			beatPulse *= Math.pow(0.36, dtSec);
			if (scheduledBeatFlag) {
				beatOnsetFlag = true;
				scheduledBeatFlag = false;
				notifyBeat(scheduledBeatPulse, true);
			}
			if (scheduledBeatPulse > beatPulse) beatPulse = scheduledBeatPulse;
			scheduledBeatPulse *= Math.pow(0.32, dtSec);
		} else {
			beatPulse *= Math.pow(0.36, dtSec);
			scheduledBeatPulse *= Math.pow(0.32, dtSec);
			scheduledBeatFlag = false;
		}

		smoothBass = env(smoothBass, Math.min(0.82, rb * 0.78 + re * 0.025), 0.28, 0.075, dtSec);
		smoothMid = env(smoothMid, Math.min(0.68, rm * 0.64 + re * 0.025), 0.18, 0.060, dtSec);
		smoothTreb = env(smoothTreb, Math.min(0.56, rt * 0.54), 0.18, 0.055, dtSec);
		smoothEnergy = env(smoothEnergy, Math.min(0.72, re), 0.16, 0.055, dtSec);
		updateLyricSunEnergy(main.vocal);

		applySnapshotPostBlock(dtSec);
	}

	function getSnapshot(): AudioSnapshot {
		return {
			bass,
			mid,
			treble,
			energy: audioEnergy,
			rb,
			rm,
			rt,
			re,
			beatPulse,
			lyricSunEnergy,
			scheduledBeatPulse,
			beatOnsetFlag,
		};
	}

	function subscribeBeat(handler: BeatHandler): () => void {
		beatSubscribers.add(handler);
		return () => {
			beatSubscribers.delete(handler);
		};
	}

	function attachSource(_node: AudioNode): void {
		// DI seam: in real usage the host wires AnalyserNodes through opts.frameSource;
		// this method is a no-op stub kept for interface parity with downstream hosts.
	}

	function setSource(_mediaElement: HTMLAudioElement): void {
		// DI seam: in production the host wires AnalyserNodes through opts.frameSource;
		// this method is a no-op stub kept for interface parity with downstream hosts.
	}

	function triggerScheduledBeat(beat: { strength?: number; impact?: number; body?: number; combo?: string | null }): void {
		if (prefersReducedMotionValue || !enabled) return;
		const strength = typeof beat?.strength === "number" ? clamp01(beat.strength) : 0.42;
		const impact = typeof beat?.impact === "number" ? clamp01(beat.impact) : strength;
		if (impact < 0.18 && strength < 0.52) return;
		const body = typeof beat?.body === "number" ? clamp01(beat.body) : 0;
		const combo = beat?.combo ?? null;
		const comboLift = combo === "downbeat" ? 0.08 : combo === "drop" ? 0.04 : 0;
		const dynScale = 0.88 + impact * 0.16;
		const pulse = Math.min(0.78, (0.14 + strength * 0.46 + impact * 0.18 + body * 0.08 + comboLift) * dynScale);
		if (pulse > scheduledBeatPulse) scheduledBeatPulse = pulse;
		scheduledBeatFlag = true;
	}

	function setEnabled(value: boolean) {
		enabled = !!value;
		if (!enabled) {
			beatEngine.reset(0);
		}
	}

	function setPrefersReducedMotion(value: boolean) {
		prefersReducedMotionValue = !!value;
	}

	function setWaitingForBeatMap(value: boolean) {
		waitingForBeatMap = !!value;
	}

	function setBeatMapReady(value: boolean) {
		beatMapReadyForCamera = !!value;
	}

	function dispose() {
		beatSubscribers.clear();
		scheduledBeatFlag = false;
		smoothBass = smoothMid = smoothTreb = smoothEnergy = 0;
		prevEnergy = 0;
		beatPulse = 0;
		resetLyricSunEnergy();
		scheduledBeatPulse = 0;
		bassPeak.reset();
		midPeak.reset();
		treblePeak.reset();
		energyPeak.reset();
	}

	const engine: AudioReactivityEngine = {
		update,
		getSnapshot,
		subscribeBeat,
		attachSource,
		setSource,
		triggerScheduledBeat,
		setEnabled,
		setPrefersReducedMotion,
		setWaitingForBeatMap,
		setBeatMapReady,
		dispose,
		smoothingTimeConstant: {
			main: mainAnalyserConfig.smoothingTimeConstant,
			beat: beatAnalyserConfig.smoothingTimeConstant,
		},
		binRanges: {
			kickEnd: DEFAULT_BIN_RANGES.kickEnd,
			vocalEnd: DEFAULT_BIN_RANGES.vocalEnd,
			midEnd: DEFAULT_BIN_RANGES.midEnd,
		},
		beatBandHz: {
			sub: DEFAULT_BEAT_BAND_HZ.sub,
			kick: DEFAULT_BEAT_BAND_HZ.kick,
			body: DEFAULT_BEAT_BAND_HZ.body,
			vocal: DEFAULT_BEAT_BAND_HZ.vocal,
			snap: DEFAULT_BEAT_BAND_HZ.snap,
		},
		peakFollowers: {
			bass: { releaseMs: PEAK_BASS_RELEASE_MS, initial: 0.12, floor: 0.030 },
			mid: { releaseMs: PEAK_MID_RELEASE_MS, initial: 0.10, floor: 0.026 },
			treble: { releaseMs: PEAK_TREBLE_RELEASE_MS, initial: 0.08, floor: 0.018 },
			energy: { releaseMs: PEAK_ENERGY_RELEASE_MS, initial: 0.10, floor: 0.030 },
		},
		beatEngine: {
			tempoLockMinGapMs: 420,
			tempoLockMaxGapMs: 880,
			onsetSensitivity: 0.16,
		},
	};

	void externalReducedMotion;
	void peakFollowers;

	return engine;
}
