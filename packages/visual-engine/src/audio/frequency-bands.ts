export interface MainBinRanges {
	kickEnd: number;
	vocalEnd: number;
	midEnd: number;
}

export const DEFAULT_BIN_RANGES: MainBinRanges = {
	kickEnd: 7,
	vocalEnd: 140,
	midEnd: 280,
};

export interface MainBandAverages {
	kick: number;
	vocal: number;
	mid: number;
	treble: number;
	energy: number;
	rmsRaw: number;
}

export function clamp01(v: number): number {
	return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function analyzeMainFrame(
	freqData: Uint8Array,
	timeData: Uint8Array,
	ranges: MainBinRanges = DEFAULT_BIN_RANGES,
): MainBandAverages {
	const len = freqData.length;
	const kickEnd = Math.min(len, ranges.kickEnd);
	const vocalEnd = Math.min(len, ranges.vocalEnd);
	const midEnd = Math.min(len, ranges.midEnd);

	let bKick = 0;
	let voc = 0;
	let mInst = 0;
	let tHigh = 0;
	let rms = 0;

	for (let i = 0; i < kickEnd; i++) bKick += freqData[i] / 255;
	for (let i = kickEnd; i < vocalEnd; i++) voc += freqData[i] / 255;
	for (let i = vocalEnd; i < midEnd; i++) mInst += freqData[i] / 255;
	for (let i = midEnd; i < len; i++) tHigh += freqData[i] / 255;
	for (let j = 0; j < timeData.length; j++) {
		const tv = (timeData[j] - 128) / 128;
		rms += tv * tv;
	}

	bKick /= Math.max(1, kickEnd);
	voc /= Math.max(1, vocalEnd - kickEnd);
	mInst /= Math.max(1, midEnd - vocalEnd);
	tHigh /= Math.max(1, len - midEnd);
	rms = timeData.length ? Math.sqrt(rms / timeData.length) : 0;

	return {
		kick: bKick,
		vocal: voc,
		mid: mInst,
		treble: tHigh,
		energy: rms,
		rmsRaw: rms,
	};
}

export interface BeatBandHz {
	sub: [number, number];
	kick: [number, number];
	body: [number, number];
	vocal: [number, number];
	snap: [number, number];
}

export const DEFAULT_BEAT_BAND_HZ: BeatBandHz = {
	sub: [38, 74],
	kick: [52, 165],
	body: [165, 420],
	vocal: [420, 2600],
	snap: [1800, 9200],
};

export interface BeatBandSamples {
	sub: number;
	kick: number;
	low: number;
	body: number;
	vocal: number;
	snap: number;
	rms: number;
}

export function beatBandRms(
	data: Uint8Array,
	sampleRate: number,
	fftSize: number,
	hz0: number,
	hz1: number,
): number {
	const binHz = sampleRate / fftSize;
	const a = Math.max(1, Math.floor(hz0 / binHz));
	const b = Math.min(data.length - 1, Math.ceil(hz1 / binHz));
	let sum = 0;
	let count = 0;
	for (let i = a; i <= b; i++) {
		const v = data[i] / 255;
		sum += v * v;
		count++;
	}
	return count ? Math.sqrt(sum / count) : 0;
}

export function analyzeBeatFrame(
	freqData: Uint8Array,
	timeData: Uint8Array,
	sampleRate: number,
	fftSize: number,
	bands: BeatBandHz = DEFAULT_BEAT_BAND_HZ,
): BeatBandSamples {
	const sub = beatBandRms(freqData, sampleRate, fftSize, bands.sub[0], bands.sub[1]);
	const kick = beatBandRms(freqData, sampleRate, fftSize, bands.kick[0], bands.kick[1]);
	const body = beatBandRms(freqData, sampleRate, fftSize, bands.body[0], bands.body[1]);
	const vocal = beatBandRms(freqData, sampleRate, fftSize, bands.vocal[0], bands.vocal[1]);
	const snap = beatBandRms(freqData, sampleRate, fftSize, bands.snap[0], bands.snap[1]);
	const low = Math.min(1, kick * 0.86 + sub * 0.42);
	let rms = 0;
	for (let i = 0; i < timeData.length; i++) {
		const tv = (timeData[i] - 128) / 128;
		rms += tv * tv;
	}
	rms = timeData.length ? Math.sqrt(rms / timeData.length) : 0;
	return { sub, kick, low, body, vocal, snap, rms };
}

export function analyzeLogSpectrumBands(
	freqData: Uint8Array,
	sampleRate: number,
	fftSize: number,
	bandCount: number,
	minHz = 32,
	maxHz = 14_000,
): Float32Array {
	const out = new Float32Array(Math.max(0, Math.floor(bandCount)));
	if (!out.length || !freqData.length || sampleRate <= 0 || fftSize <= 0) return out;
	const nyquist = sampleRate / 2;
	const hiHz = Math.max(minHz + 1, Math.min(maxHz, nyquist));
	const lo = Math.log(Math.max(1, minHz));
	const hi = Math.log(hiHz);
	const binHz = sampleRate / fftSize;
	for (let band = 0; band < out.length; band += 1) {
		const t0 = band / out.length;
		const t1 = (band + 1) / out.length;
		const hz0 = Math.exp(lo + (hi - lo) * t0);
		const hz1 = Math.exp(lo + (hi - lo) * t1);
		const start = Math.max(1, Math.floor(hz0 / binHz));
		const end = Math.min(freqData.length - 1, Math.max(start, Math.ceil(hz1 / binHz)));
		let sum = 0;
		let count = 0;
		for (let i = start; i <= end; i += 1) {
			const v = (freqData[i] ?? 0) / 255;
			sum += v * v;
			count += 1;
		}
		const rms = count ? Math.sqrt(sum / count) : 0;
		out[band] = clamp01(Math.pow(rms, 0.82));
	}
	return out;
}
