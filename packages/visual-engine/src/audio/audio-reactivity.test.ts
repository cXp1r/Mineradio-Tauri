import { expect, test } from "bun:test";
import { createAudioReactivity } from "./audio-reactivity";
import type { AudioFrameBytes } from "./audio-snapshot";

const FS = 44100;
const FFT = 2048;
const BINS = FFT / 2;
const TD_LEN = FFT;
const DT = 1 / 60;

function makeFrame(opts: { playing: boolean; t: number; value: number }): AudioFrameBytes {
	const v = opts.value;
	return {
		mainFreqData: new Uint8Array(BINS).fill(v),
		mainTimeData: new Uint8Array(TD_LEN).fill(v),
		mainSampleRate: FS,
		mainFftSize: FFT,
		beatFreqData: new Uint8Array(BINS).fill(v),
		beatTimeData: new Uint8Array(TD_LEN).fill(v),
		beatSampleRate: FS,
		beatFftSize: FFT,
		playing: opts.playing,
		currentTimeSeconds: opts.t,
	};
}

test("disabled engine returns zeroed snapshot", () => {
	const engine = createAudioReactivity();
	engine.setEnabled(false);
	engine.update(DT);
	const snap = engine.getSnapshot();
	expect(snap.bass).toBe(0);
	expect(snap.mid).toBe(0);
	expect(snap.treble).toBe(0);
	expect(snap.energy).toBe(0);
	expect(snap.rb).toBe(0);
	expect(snap.beatPulse).toBe(0);
	expect(snap.lyricSunEnergy).toBe(0);
	expect(snap.scheduledBeatPulse).toBe(0);
	expect(snap.beatOnsetFlag).toBe(false);
});

test("reduced motion still computes band averages but suppresses beat pulses", () => {
	let t = 0;
	const state = { high: false };
	const engine = createAudioReactivity({
		frameSource: () => makeFrame({ playing: true, t, value: state.high ? 255 : 0 }),
	});
	engine.setPrefersReducedMotion(true);
	for (let i = 0; i < 200; i++) {
		state.high = i % 4 === 0;
		t += DT;
		engine.update(DT);
	}
	const snap = engine.getSnapshot();
	expect(snap.beatPulse).toBeLessThanOrEqual(1e-6);
	expect(snap.scheduledBeatPulse).toBeLessThanOrEqual(1e-6);
	expect(snap.beatOnsetFlag).toBe(false);
});

test("pulsed high-energy frames produce live beat onsets", () => {
	let t = 0;
	const state = { high: false };
	const engine = createAudioReactivity({
		frameSource: () => makeFrame({ playing: true, t, value: state.high ? 255 : 0 }),
	});
	let beatNotifications = 0;
	engine.subscribeBeat(() => beatNotifications++);
	let onsetFrames = 0;
	for (let i = 0; i < 600; i++) {
		state.high = i % 30 === 0;
		t += DT;
		engine.update(DT);
		if (engine.getSnapshot().beatOnsetFlag) onsetFrames++;
	}
	expect(onsetFrames).toBeGreaterThanOrEqual(3);
	expect(beatNotifications).toBeGreaterThanOrEqual(3);
});

test("triggerScheduledBeat raises beat pulse with onset flag on next frame", () => {
	let t = 0;
	let triggered = false;
	const engine = createAudioReactivity({
		frameSource: () => makeFrame({ playing: true, t, value: 0 }),
	});
	engine.subscribeBeat(() => {
		triggered = true;
	});
	for (let i = 0; i < 5; i++) {
		t += DT;
		engine.update(DT);
	}
	engine.triggerScheduledBeat({ strength: 0.8, impact: 0.7, body: 0.3, combo: "downbeat" });
	t += DT;
	engine.update(DT);
	const snap = engine.getSnapshot();
	expect(snap.beatPulse).toBeGreaterThan(0.5);
	expect(snap.beatOnsetFlag).toBe(true);
	expect(triggered).toBe(true);
});

test("subscribeBeat returns an unsubscribe that stops callbacks", () => {
	let t = 0;
	const state = { high: false };
	const engine = createAudioReactivity({
		frameSource: () => makeFrame({ playing: true, t, value: state.high ? 255 : 0 }),
	});
	let calls = 0;
	const unsub = engine.subscribeBeat(() => calls++);
	for (let i = 0; i < 200; i++) {
		state.high = i % 30 === 0;
		t += DT;
		engine.update(DT);
	}
	const baseline = calls;
	unsub();
	for (let i = 0; i < 200; i++) {
		state.high = i % 30 === 0;
		t += DT;
		engine.update(DT);
	}
	expect(calls).toBe(baseline);
});

test("engine exposes ported baseline calibration constants", () => {
	const engine = createAudioReactivity();
	expect(engine.smoothingTimeConstant.main).toBe(0.58);
	expect(engine.smoothingTimeConstant.beat).toBe(0.10);
	expect(engine.binRanges.kickEnd).toBe(7);
	expect(engine.binRanges.vocalEnd).toBe(140);
	expect(engine.binRanges.midEnd).toBe(280);
	expect(engine.beatBandHz.sub).toEqual([38, 74]);
	expect(engine.beatBandHz.kick).toEqual([52, 165]);
	expect(engine.beatBandHz.body).toEqual([165, 420]);
	expect(engine.beatBandHz.vocal).toEqual([420, 2600]);
	expect(engine.beatBandHz.snap).toEqual([1800, 9200]);
	expect(engine.beatEngine.tempoLockMinGapMs).toBe(420);
	expect(engine.beatEngine.tempoLockMaxGapMs).toBe(880);
	expect(engine.beatEngine.onsetSensitivity).toBe(0.16);
});

test("paused frame decays residual bands toward zero", () => {
	let t = 0;
	const state = { high: true, paused: false };
	const engine = createAudioReactivity({
		frameSource: () => makeFrame({ playing: !state.paused, t, value: state.high ? 255 : 0 }),
	});
	for (let i = 0; i < 200; i++) {
		state.high = i % 30 === 0;
		t += DT;
		engine.update(DT);
	}
	const before = engine.getSnapshot();
	expect(before.bass).toBeGreaterThan(0.1);
	state.paused = true;
	for (let i = 0; i < 240; i++) {
		t += DT;
		engine.update(DT);
	}
	const after = engine.getSnapshot();
	expect(after.bass).toBeLessThan(0.02);
});

test("sustained high vocal and spectral energy opens the baseline lyric sun gate", () => {
	let t = 0;
	const engine = createAudioReactivity({
		frameSource: () => makeFrame({ playing: true, t, value: 255 }),
	});
	for (let i = 0; i < 420; i++) {
		t += DT;
		engine.update(DT);
	}
	const snap = engine.getSnapshot();
	expect(snap.lyricSunEnergy ?? 0).toBeGreaterThan(0.02);
	expect(snap.lyricSunEnergy ?? 0).toBeLessThanOrEqual(1);
});

test("paused frames decay lyric sun energy with the original idle branch", () => {
	let t = 0;
	const state = { paused: false };
	const engine = createAudioReactivity({
		frameSource: () => makeFrame({ playing: !state.paused, t, value: 255 }),
	});
	for (let i = 0; i < 420; i++) {
		t += DT;
		engine.update(DT);
	}
	const before = engine.getSnapshot().lyricSunEnergy ?? 0;
	expect(before).toBeGreaterThan(0.02);
	state.paused = true;
	for (let i = 0; i < 120; i++) {
		t += DT;
		engine.update(DT);
	}
	expect(engine.getSnapshot().lyricSunEnergy ?? 0).toBeLessThan(before * 0.5);
});
