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
