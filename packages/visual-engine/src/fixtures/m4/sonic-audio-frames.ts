export interface M4SonicAudioFrameFixture {
	readonly sampleRate: number;
	readonly fftSize: number;
	readonly currentTimeSeconds: number;
	readonly playing: boolean;
	createBins(): Uint8Array;
}

function createPeakedBins(peaks: readonly [number, number][]): Uint8Array {
	const bins = new Uint8Array(512);
	for (const [index, value] of peaks) bins[index] = value;
	return bins;
}

export const M4_SONIC_AUDIO_FRAMES = Object.freeze({
	silence: Object.freeze({
		sampleRate: 48_000,
		fftSize: 1024,
		currentTimeSeconds: 0,
		playing: true,
		createBins: () => new Uint8Array(512),
	}),
	kick: Object.freeze({
		sampleRate: 48_000,
		fftSize: 1024,
		currentTimeSeconds: 1,
		playing: true,
		createBins: () => createPeakedBins([[1, 240], [2, 255], [3, 220], [4, 180]]),
	}),
	bright: Object.freeze({
		sampleRate: 48_000,
		fftSize: 1024,
		currentTimeSeconds: 2,
		playing: true,
		createBins: () => createPeakedBins([[96, 180], [160, 210], [240, 245], [320, 220]]),
	}),
}) satisfies Readonly<Record<string, M4SonicAudioFrameFixture>>;
