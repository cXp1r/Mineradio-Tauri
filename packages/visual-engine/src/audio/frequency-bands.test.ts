import { expect, test } from "bun:test";
import {
	analyzeMainFrame,
	analyzeBeatFrame,
	analyzeLogSpectrumBands,
	DEFAULT_BIN_RANGES,
	DEFAULT_BEAT_BAND_HZ,
	beatBandRms,
} from "./frequency-bands";

const FFT_SIZE = 2048;
const BIN_SIZE = FFT_SIZE / 2;

function makeFreqData(value: number, len: number = BIN_SIZE): Uint8Array {
	const arr = new Uint8Array(len);
	arr.fill(value);
	return arr;
}

function makeTimeData(value: number, len: number = FFT_SIZE): Uint8Array {
	const arr = new Uint8Array(len);
	arr.fill(value);
	return arr;
}

test("silent frequency data yields zero kick/vocal/mid/treble averages", () => {
	const freq = makeFreqData(0);
	const time = makeTimeData(128);
	const out = analyzeMainFrame(freq, time, DEFAULT_BIN_RANGES);
	expect(out.kick).toBe(0);
	expect(out.vocal).toBe(0);
	expect(out.mid).toBe(0);
	expect(out.treble).toBe(0);
	expect(out.energy).toBe(0);
});

test("full-scale frequency data yields unit kick/vocal/mid/treble averages", () => {
	const freq = makeFreqData(255);
	const time = makeTimeData(255);
	const out = analyzeMainFrame(freq, time, DEFAULT_BIN_RANGES);
	expect(Math.abs(out.kick - 1) < 1e-9).toBe(true);
	expect(Math.abs(out.vocal - 1) < 1e-9).toBe(true);
	expect(Math.abs(out.mid - 1) < 1e-9).toBe(true);
	expect(Math.abs(out.treble - 1) < 1e-9).toBe(true);
	expect(out.energy).toBeCloseTo(127 / 128, 5);
});

test("kick bin range 0..7 from spec holds only first 7 bins", () => {
	const freq = new Uint8Array(BIN_SIZE);
	for (let i = 0; i < 7; i++) freq[i] = 255;
	const time = makeTimeData(128);
	const out = analyzeMainFrame(freq, time, DEFAULT_BIN_RANGES);
	expect(Math.abs(out.kick - 1) < 1e-9).toBe(true);
	expect(out.vocal).toBe(0);
	expect(out.mid).toBe(0);
	expect(out.treble).toBe(0);
});

test("mid bin range 140..280 sums mInst only in 140..280", () => {
	const freq = new Uint8Array(BIN_SIZE);
	for (let i = DEFAULT_BIN_RANGES.vocalEnd; i < DEFAULT_BIN_RANGES.midEnd; i++) freq[i] = 255;
	const time = makeTimeData(128);
	const out = analyzeMainFrame(freq, time, DEFAULT_BIN_RANGES);
	expect(out.kick).toBe(0);
	expect(out.vocal).toBe(0);
	expect(Math.abs(out.mid - 1) < 1e-9).toBe(true);
	expect(out.treble).toBe(0);
});

test("treble bin range 280+ sums tHigh only above 280", () => {
	const freq = new Uint8Array(BIN_SIZE);
	for (let i = DEFAULT_BIN_RANGES.midEnd; i < BIN_SIZE; i++) freq[i] = 255;
	const time = makeTimeData(128);
	const out = analyzeMainFrame(freq, time, DEFAULT_BIN_RANGES);
	expect(out.kick).toBe(0);
	expect(out.vocal).toBe(0);
	expect(out.mid).toBe(0);
	expect(Math.abs(out.treble - 1) < 1e-9).toBe(true);
});

test("rms aggregates squared deviation from 128 midpoint", () => {
	const time = new Uint8Array(FFT_SIZE);
	for (let i = 0; i < time.length; i++) {
		time[i] = i % 2 === 0 ? 128 + 127 : 128 - 127;
	}
	const freq = makeFreqData(0);
	const out = analyzeMainFrame(freq, time, DEFAULT_BIN_RANGES);
	expect(out.energy).toBeCloseTo(127 / 128, 5);
	expect(out.rmsRaw).toBeCloseTo(127 / 128, 5);
});

test("beatBandRms masks bins outside hz range using fftSize-linked bin width", () => {
	const sr = 44100;
	const fft = 2048;
	const binHz = sr / fft;
	const data = new Uint8Array(fft / 2);
	const target = Math.floor(38 / binHz);
	for (let i = target; i <= Math.ceil(74 / binHz); i++) data[i] = 255;
	const rms = beatBandRms(data, sr, fft, 38, 74);
	expect(Math.abs(rms - 1) < 1e-9).toBe(true);
});

test("analyzeBeatFrame returns low = kick * 0.86 + sub * 0.42 clamped to 1", () => {
	const sr = 44100;
	const fft = 2048;
	const freq = makeFreqData(0, fft / 2);
	const time = makeTimeData(128, fft);
	const out = analyzeBeatFrame(freq, time, sr, fft, DEFAULT_BEAT_BAND_HZ);
	expect(out.low).toBe(0);
});

test("analyzeBeatFrame full-scale data sub=1 low clamped to 1", () => {
	const sr = 44100;
	const fft = 2048;
	const freq = makeFreqData(255, fft / 2);
	const time = makeTimeData(255, fft);
	const out = analyzeBeatFrame(freq, time, sr, fft, DEFAULT_BEAT_BAND_HZ);
	expect(out.low).toBe(1);
});

test("analyzeLogSpectrumBands preserves frequency terrain across low and high bands", () => {
	const sr = 44100;
	const fft = 2048;
	const binHz = sr / fft;
	const freq = makeFreqData(0, fft / 2);
	for (let hz = 80; hz <= 160; hz += binHz) {
		freq[Math.floor(hz / binHz)] = 255;
	}
	for (let hz = 6_000; hz <= 7_200; hz += binHz) {
		freq[Math.floor(hz / binHz)] = 96;
	}
	const bands = analyzeLogSpectrumBands(freq, sr, fft, 32);
	expect(bands.length).toBe(32);
	expect(Math.max(...bands.slice(2, 8))).toBeGreaterThan(0.8);
	expect(Math.max(...bands.slice(22, 30))).toBeGreaterThan(0.25);
	expect(Math.max(...bands.slice(12, 18))).toBeLessThan(0.05);
});
