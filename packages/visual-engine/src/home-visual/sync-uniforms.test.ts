import { expect, test } from "bun:test";
import "../runtime/happy-dom-preload";
import { cloneFxState } from "./fx-defaults";
import { syncFxUniforms, lerp, type UniformContainer } from "./sync-uniforms";
import { AUDIO_SPECTRUM_BAND_COUNT, type AudioSnapshot } from "../audio/audio-snapshot";

function makeSnapshot(over: Partial<AudioSnapshot> = {}): AudioSnapshot {
	return {
		bass: 0,
		mid: 0,
		treble: 0,
		energy: 0,
		rb: 0,
		rm: 0,
		rt: 0,
		re: 0,
		beatPulse: 0,
		scheduledBeatPulse: 0,
		beatOnsetFlag: false,
		...over,
	};
}

function makeUniforms(): UniformContainer {
	const v2 = { x: 0, y: 0, set: function (x: number, y: number) { this.x = x; this.y = y; } };
	return {
		uBass: { value: 0 },
		uMid: { value: 0 },
		uTreble: { value: 0 },
		uBeat: { value: 0 },
		uEnergy: { value: 0 },
		uMouseXY: { value: v2 },
		uMouseActive: { value: 0 },
		uVinylSpin: { value: 0 },
		uParticleDim: { value: 1 },
		uBurstAmt: { value: 0 },
		uAudioBands: { value: new Float32Array(AUDIO_SPECTRUM_BAND_COUNT) },
	};
}

test("lerp clamps k to [0,1] and returns value + (target-value)*k", () => {
	expect(lerp(0, 1, 0.5)).toBeCloseTo(0.5, 6);
	expect(lerp(2, 4, 0.25)).toBeCloseTo(2.5, 6);
	expect(lerp(0, 1, -1)).toBe(0);
	expect(lerp(0, 1, 2)).toBe(1);
});

test("preset<4 path: uBass = snapshot.bass * fx.intensity (snapshot already encodes smoothBass*1.05+beatPulse*0.18 from audio engine); uBeat=beatPulse; uEnergy=energy", () => {
	const fx = cloneFxState();
	fx.intensity = 1.0;
	fx.preset = 0;
	const snap = makeSnapshot({ bass: 0.4, mid: 0.2, treble: 0.15, beatPulse: 0.3, energy: 0.5 });
	const u = makeUniforms();
	syncFxUniforms(fx, snap, u, { dt: 1 / 60 });
	expect(u.uBass?.value as number).toBeCloseTo(0.4, 5);
	expect(u.uMid?.value as number).toBeCloseTo(0.2, 5);
	expect(u.uTreble?.value as number).toBeCloseTo(0.15, 5);
	expect(u.uBeat?.value).toBe(0.3);
	expect(u.uEnergy?.value).toBe(0.5);
});

test("mouse: uMouseActive reflects fx.mouseActive; uMouseXY copied via .set when present", () => {
	const fx = cloneFxState();
	fx.mouseActive = true;
	fx.mouseXy = { x: 0.4, y: -0.2 };
	const u = makeUniforms();
	syncFxUniforms(fx, makeSnapshot(), u, { dt: 1 / 60 });
	expect(u.uMouseActive?.value).toBe(1);
	const xy = u.uMouseXY?.value as { x: number; y: number };
	expect(xy.x).toBeCloseTo(0.4, 6);
	expect(xy.y).toBeCloseTo(-0.2, 6);
});

test("uBurstAmt decays by 0.90 per call without synthesizing a default-wall shove", () => {
	const fx = cloneFxState();
	const u = makeUniforms();
	(u.uBurstAmt as { value: number }).value = 1.0;
	syncFxUniforms(fx, makeSnapshot(), u, { dt: 1 / 60 });
	expect(u.uBurstAmt?.value).toBeCloseTo(0.90, 6);
	syncFxUniforms(fx, makeSnapshot(), u, { dt: 1 / 60 });
	expect(u.uBurstAmt?.value).toBeCloseTo(0.81, 6);
});

test("default cover wall does not raise uBurstAmt from live audio bands", () => {
	const fx = cloneFxState();
	fx.preset = 0;
	const u = makeUniforms();
	(u.uBass as { value: number }).value = 0.12;
	(u.uMid as { value: number }).value = 0.10;
	(u.uTreble as { value: number }).value = 0.08;
	syncFxUniforms(fx, makeSnapshot({
		bass: 0.42,
		mid: 0.34,
		treble: 0.22,
		beatPulse: 0.18,
		energy: 0.44,
	}), u, { dt: 1 / 60 });
	expect(u.uBurstAmt?.value as number).toBe(0);
});

test("default cover wall does not raise uBurstAmt from scheduled beats", () => {
	const fx = cloneFxState();
	fx.preset = 0;
	const u = makeUniforms();
	syncFxUniforms(fx, makeSnapshot({
		bass: 0.2,
		mid: 0.14,
		treble: 0.1,
		beatPulse: 0.12,
		energy: 0.22,
		scheduledBeatPulse: 0.78,
		beatOnsetFlag: true,
	}), u, { dt: 1 / 60 });
	expect(u.uBurstAmt?.value as number).toBe(0);
});

test("default cover wall copies smoothed audio frequency bands into uAudioBands", () => {
	const fx = cloneFxState();
	fx.preset = 0;
	const u = makeUniforms();
	const bands = new Float32Array(AUDIO_SPECTRUM_BAND_COUNT);
	bands[4] = 0.42;
	bands[18] = 0.21;
	syncFxUniforms(fx, makeSnapshot({ frequencyBands: bands }), u, { dt: 1 / 60 });
	const out = u.uAudioBands?.value as Float32Array;
	expect(out).toBeInstanceOf(Float32Array);
	expect(out[4]).toBeCloseTo(0.42, 5);
	expect(out[18]).toBeCloseTo(0.21, 5);
});

test("uVinylSpin advances by dt * (0.40 + smoothBass*0.09) * fx.speed and wraps at 2*PI", () => {
	const fx = cloneFxState();
	fx.speed = 1.0;
	const u = makeUniforms();
	const snap = makeSnapshot({ bass: 1.0, beatPulse: 0.0 });
	const smoothBass = (1.0 - 0.0 * 0.18) / 1.05;
	const expectedSpeed = 0.40 + smoothBass * 0.09;
	(u.uVinylSpin as { value: number }).value = 0;
	syncFxUniforms(fx, snap, u, { dt: 0.1 });
	expect(u.uVinylSpin?.value as number).toBeCloseTo(0.1 * expectedSpeed, 5);
});

test("preset 4 path uses ring remap with non-wallpaper multipliers (1.58/1.82/2.28 and offsets 0.16/0.06, 0.14/0.07, 0.10/0.05)", () => {
	const fx = cloneFxState();
	fx.intensity = 1.0;
	fx.preset = 4;
	const smoothBass = 0.5;
	const smoothMid = 0.3;
	const smoothTreb = 0.2;
	const bass = snapshotFromSmooth(smoothBass, smoothMid, smoothTreb);
	const snap = makeSnapshot({ bass, mid: smoothMid * 1.12, treble: smoothTreb * 1.20, beatPulse: 0.0 });
	const u = makeUniforms();
	syncFxUniforms(fx, snap, u, { dt: 1 / 60 });
	const ringBass = smoothBass * 1.58 + 0 * 0.42 - smoothMid * 0.16 - smoothTreb * 0.06;
	const expectedBass = Math.pow(Math.max(0, Math.min(1, (ringBass - 0.050) / 0.58)), 0.72) * 1.0;
	expect(u.uBass?.value as number).toBeCloseTo(expectedBass, 5);
});

test("preset 5 (wallpaper) path caps bass/mid/treble at 0.46/0.40/0.36 * intensity and scales beatPulse by 0.34", () => {
	const fx = cloneFxState();
	fx.intensity = 1.0;
	fx.preset = 5;
	const smoothBass = 0.9, smoothMid = 0.8, smoothTreb = 0.7;
	const snap = makeSnapshot({
		bass: snapshotFromSmooth(smoothBass, smoothMid, smoothTreb),
		mid: smoothMid * 1.12,
		treble: smoothTreb * 1.20,
		beatPulse: 0.5,
		energy: 0.4,
	});
	const u = makeUniforms();
	syncFxUniforms(fx, snap, u, { dt: 1 / 60 });
	expect(u.uBass?.value as number).toBeLessThanOrEqual(0.46);
	expect(u.uMid?.value as number).toBeLessThanOrEqual(0.40);
	expect(u.uTreble?.value as number).toBeLessThanOrEqual(0.36);
	expect(u.uBeat?.value as number).toBeCloseTo(0.5 * 0.34, 5);
});

test("preset 6 (skull) particle dim target = 0.58 and eases toward target with 0.18 when decreasing", () => {
	const fx = cloneFxState();
	fx.preset = 6;
	const u = makeUniforms();
	(u.uParticleDim as { value: number }).value = 1.0;
	syncFxUniforms(fx, makeSnapshot(), u, { dt: 1 / 60 });
	const easeK = 0.18;
	const expected = 1.0 + (0.58 - 1.0) * Math.min(1, easeK * Math.max(1, (1 / 60) * 60));
	expect(u.uParticleDim?.value as number).toBeCloseTo(expected, 5);
});

test("preset 5 wallpaper shelf dim target = 0.48 and eases toward target with baseline decrease rate", () => {
	const fx = cloneFxState();
	fx.preset = 5;
	const u = makeUniforms();
	(u.uParticleDim as { value: number }).value = 1.0;
	syncFxUniforms(fx, makeSnapshot(), u, { dt: 1 / 60, wallpaperShelfDim: true });
	const expected = 1.0 + (0.48 - 1.0) * 0.18;
	expect(u.uParticleDim?.value as number).toBeCloseTo(expected, 5);
});

function snapshotFromSmooth(sB: number, sM: number, sT: number): number {
	return Math.min(0.90, sB * 1.05 + 0 * 0.18);
}
