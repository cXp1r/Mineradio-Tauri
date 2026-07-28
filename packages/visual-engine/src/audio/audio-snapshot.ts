export const AUDIO_SPECTRUM_BAND_COUNT = 32;

export interface SonicSpectrumFrame {
	readonly sampleRate: number;
	readonly fftSize: number;
	readonly binCount: 512;
	readonly currentTimeSeconds: number;
	readonly playing: boolean;
	bin(index: number): number;
	mean(startInclusive: number, endExclusive: number): number;
}

export type SonicBand =
	| "subBass"
	| "bass"
	| "lowMid"
	| "mid"
	| "highMid"
	| "presence"
	| "brilliance"
	| "air";

export type SonicBandLevels = Readonly<Record<SonicBand, number>>;

export interface SonicAudioSnapshot {
	readonly spectrum: SonicSpectrumFrame | null;
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
	readonly onset: number;
	readonly flux: number;
	readonly confidence: number;
	readonly triggerPulse: number;
	readonly kickEnvelope: number;
}

export interface SonicTriggerMonitorSettings {
	readonly monitorEnabled: boolean;
	readonly autoTrack: boolean;
	readonly sensitivity: number;
	readonly bandStart: number;
	readonly bandEnd: number;
	readonly threshold: number;
	readonly pulseStrength: number;
}

export interface AudioSnapshot {
	bass: number;
	mid: number;
	treble: number;
	energy: number;
	rb: number;
	rm: number;
	rt: number;
	re: number;
	beatPulse: number;
	lyricSunEnergy?: number;
	scheduledBeatPulse: number;
	beatOnsetFlag: boolean;
	frequencyBands?: Float32Array;
	sonic?: SonicAudioSnapshot;
}

export interface AudioFrameBytes {
	mainFreqData: Uint8Array;
	mainTimeData: Uint8Array;
	mainSampleRate: number;
	mainFftSize: number;
	beatFreqData: Uint8Array;
	beatTimeData: Uint8Array;
	beatSampleRate: number;
	beatFftSize: number;
	playing: boolean;
	currentTimeSeconds: number;
	trackKey?: string | null;
}

export type AudioFrameSource = () => AudioFrameBytes | null;

export type BeatHandler = (burst: number, isScheduled: boolean) => void;

export interface AudioReactivityOptions {
	frameSource?: AudioFrameSource;
	mainAnalyser?: {
		fftSize: number;
		smoothingTimeConstant: number;
	};
	beatAnalyser?: {
		fftSize: number;
		smoothingTimeConstant: number;
	};
	prefersReducedMotion?: () => boolean;
	sonicMonitorEnabled?: boolean;
	sonicTriggerSettings?: SonicTriggerMonitorSettings;
}

export interface AudioReactivityEngine {
	update(dt: number): void;
	getSnapshot(): AudioSnapshot;
	subscribeBeat(handler: BeatHandler): () => void;
	attachSource(node: AudioNode): void;
	setSource(mediaElement: HTMLAudioElement): void;
	triggerScheduledBeat(beat: {
		strength?: number;
		impact?: number;
		body?: number;
		combo?: string | null;
	}): void;
	setEnabled(enabled: boolean): void;
	setPrefersReducedMotion(reduced: boolean): void;
	setWaitingForBeatMap(waiting: boolean): void;
	setBeatMapReady(ready: boolean): void;
	setSonicMonitorEnabled(enabled: boolean): void;
	setSonicTriggerSettings(settings: SonicTriggerMonitorSettings): void;
	dispose(): void;
	readonly smoothingTimeConstant: { main: number; beat: number };
	readonly binRanges: { kickEnd: number; vocalEnd: number; midEnd: number };
	readonly beatBandHz: {
		sub: [number, number];
		kick: [number, number];
		body: [number, number];
		vocal: [number, number];
		snap: [number, number];
	};
	readonly peakFollowers: {
		bass: { releaseMs: number; initial: number; floor: number };
		mid: { releaseMs: number; initial: number; floor: number };
		treble: { releaseMs: number; initial: number; floor: number };
		energy: { releaseMs: number; initial: number; floor: number };
	};
	readonly beatEngine: {
		tempoLockMinGapMs: number;
		tempoLockMaxGapMs: number;
		onsetSensitivity: number;
	};
}
