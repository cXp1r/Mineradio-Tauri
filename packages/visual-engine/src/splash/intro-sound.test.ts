import { expect, test } from "bun:test";
import { createIntroSoundPlayer } from "./intro-sound";

interface FakeAudioParam {
	value: number;
	events: string[];
	setValueAtTime(v: number, t: number): FakeAudioParam;
	exponentialRampToValueAtTime(v: number, t: number): FakeAudioParam;
	linearRampToValueAtTime(v: number, t: number): FakeAudioParam;
}

function makeFakeAudioParam(): FakeAudioParam {
	const p: FakeAudioParam = {
		value: 0,
		events: [],
		setValueAtTime(v, t) {
			p.value = v;
			p.events.push(`set@${t.toFixed(3)}=${v}`);
			return p;
		},
		exponentialRampToValueAtTime(v, t) {
			p.events.push(`exp@${t.toFixed(3)}=${v}`);
			return p;
		},
		linearRampToValueAtTime(v, t) {
			p.events.push(`lin@${t.toFixed(3)}=${v}`);
			return p;
		},
	};
	return p;
}

interface FakeNode {
	connectedTo: Array<FakeNode | { kind: "destination" }>;
	connect(target: FakeNode | { kind: "destination" }): void;
	startTimes: number[];
	stopTimes: number[];
}

interface FakeGain extends FakeNode {
	kind: "gain";
	gain: FakeAudioParam;
}

interface FakeBufferSource extends FakeNode {
	kind: "bufferSource";
	buffer: { numberOfChannels: number; length: number; sampleRate: number };
	start(t: number): void;
	stop(t: number): void;
}

interface FakeOscillator extends FakeNode {
	kind: "oscillator";
	type: string;
	frequency: FakeAudioParam;
	start(t: number): void;
	stop(t: number): void;
}

interface FakeBiquad extends FakeNode {
	kind: "biquad";
	type: string;
	frequency: FakeAudioParam;
	Q: FakeAudioParam;
}

interface Captured {
	gains: FakeGain[];
	sources: FakeBufferSource[];
	oscillators: FakeOscillator[];
	biquads: FakeBiquad[];
	buffers: { numberOfChannels: number; length: number; sampleRate: number }[];
}

interface FakeAudioContext {
	state: "suspended" | "running";
	currentTime: number;
	sampleRate: number;
	destination: { kind: "destination" };
	captured: Captured;
	createGain(): FakeGain;
	createBufferSource(): FakeBufferSource;
	createOscillator(): FakeOscillator;
	createBiquadFilter(): FakeBiquad;
	createBuffer(num: number, length: number, sampleRate: number): { numberOfChannels: number; length: number; sampleRate: number; getChannelData(): Float32Array };
	resume(): Promise<void>;
	closeCalled: boolean;
	close(): Promise<void>;
}

function makeFakeAudioContext(suspended = false): FakeAudioContext {
	const captured: Captured = {
		gains: [],
		sources: [],
		oscillators: [],
		biquads: [],
		buffers: [],
	};
	const ctx: FakeAudioContext = {
		state: suspended ? "suspended" : "running",
		currentTime: 100.0,
		sampleRate: 44100,
		destination: { kind: "destination" },
		captured,
		createGain() {
			const g: FakeGain = {
				kind: "gain",
				connectedTo: [],
				gain: makeFakeAudioParam(),
				connect(t) {
					g.connectedTo.push(t);
				},
				startTimes: [],
				stopTimes: [],
			};
			captured.gains.push(g);
			return g;
		},
		createBufferSource() {
			const s: FakeBufferSource = {
				kind: "bufferSource",
				connectedTo: [],
				buffer: { numberOfChannels: 0, length: 0, sampleRate: 0 },
				connect(t) {
					s.connectedTo.push(t);
				},
				start(t) {
					s.startTimes.push(t);
				},
				stop(t) {
					s.stopTimes.push(t);
				},
				startTimes: [],
				stopTimes: [],
			};
			captured.sources.push(s);
			return s;
		},
		createOscillator() {
			const o: FakeOscillator = {
				kind: "oscillator",
				connectedTo: [],
				type: "sine",
				frequency: makeFakeAudioParam(),
				connect(t) {
					o.connectedTo.push(t);
				},
				start(t) {
					o.startTimes.push(t);
				},
				stop(t) {
					o.stopTimes.push(t);
				},
				startTimes: [],
				stopTimes: [],
			};
			captured.oscillators.push(o);
			return o;
		},
		createBiquadFilter() {
			const b: FakeBiquad = {
				kind: "biquad",
				connectedTo: [],
				type: "",
				frequency: makeFakeAudioParam(),
				Q: makeFakeAudioParam(),
				connect(t) {
					b.connectedTo.push(t);
				},
				startTimes: [],
				stopTimes: [],
			};
			captured.biquads.push(b);
			return b;
		},
		createBuffer(num, length, sampleRate) {
			const b = {
				numberOfChannels: num,
				length,
				sampleRate,
				getChannelData() {
					return new Float32Array(length);
				},
			};
			captured.buffers.push(b);
			return b;
		},
		resume() {
			return Promise.resolve();
		},
		closeCalled: false,
		close() {
			ctx.closeCalled = true;
			return Promise.resolve();
		},
	};
	return ctx;
}

function makeWinWithCtx(fakeCtx: FakeAudioContext): { AudioContext: new () => AudioContext } {
	// Use a regular function (not arrow) so it has [[Construct]] and `new` returns the object.
	function Ctor(this: unknown): FakeAudioContext {
		return fakeCtx;
	}
	return { AudioContext: Ctor as unknown as new () => AudioContext };
}

test(".play() is a no-op when AudioContext is unavailable (SSR / non-browser)", () => {
	const player = createIntroSoundPlayer({ document: null, window: null });
	expect(player.play()).toBe(false);
	expect(player.hasPlayed()).toBe(false);
});

test("play() schedules the byte-equal baseline master gain ramp: 0.0001→0.062→0.040→0.0001", () => {
	const fakeCtx = makeFakeAudioContext(false);
	const win = makeWinWithCtx(fakeCtx);
	const player = createIntroSoundPlayer({ window: win as never, document: null });
	expect(player.play()).toBe(true);
	const master = fakeCtx.captured.gains[0];
	if (!master) throw new Error("master gain missing");
	expect(master.gain.events).toContain("set@100.020=0.0001");
	expect(master.gain.events).toContain("exp@100.180=0.062");
	expect(master.gain.events).toContain("exp@103.370=0.04");
	expect(master.gain.events).toContain("exp@105.300=0.0001");
	expect(master.connectedTo).toEqual([{ kind: "destination" }]);
});

test("play() wires the noise branch: buffer len floor(sampleRate*2.45), bandpass 720→2400, Q 0.72, stop @+2.46", () => {
	const fakeCtx = makeFakeAudioContext(false);
	const win = makeWinWithCtx(fakeCtx);
	const player = createIntroSoundPlayer({ window: win as never, document: null });
	player.play();
	expect(fakeCtx.captured.buffers.length).toBeGreaterThanOrEqual(1);
	const noiseBuf = fakeCtx.captured.buffers[0];
	expect(noiseBuf.numberOfChannels).toBe(1);
	expect(noiseBuf.length).toBe(Math.floor(44100 * 2.45));
	expect(noiseBuf.sampleRate).toBe(44100);

	const bandpass = fakeCtx.captured.biquads.find((b) => b.type === "bandpass");
	if (!bandpass) throw new Error("bandpass missing");
	expect(bandpass.frequency.events).toContain("set@100.020=720");
	expect(bandpass.frequency.events).toContain("exp@102.220=2400");
	expect(bandpass.Q.events).toContain("set@100.020=0.72");

	const noiseSource = fakeCtx.captured.sources.find((s) => s.buffer === noiseBuf);
	if (!noiseSource) throw new Error("noise source missing");
	expect(noiseSource.startTimes.some((t) => Math.abs(t - 100.02) < 1e-6)).toBe(true);
	expect(noiseSource.stopTimes.some((t) => Math.abs(t - 102.48) < 1e-6)).toBe(true);
});

test("play() wires the low sine oscillator: 86→43 Hz, start @+0.12 stop @+1.40", () => {
	const fakeCtx = makeFakeAudioContext(false);
	const win = makeWinWithCtx(fakeCtx);
	const player = createIntroSoundPlayer({ window: win as never, document: null });
	player.play();
	const low = fakeCtx.captured.oscillators.find((o) => o.type === "sine" && o.frequency.events.some((e) => e.includes("=86")));
	if (!low) throw new Error("low sine missing");
	expect(low.frequency.events).toContain("set@100.200=86");
	expect(low.frequency.events).toContain("exp@101.200=43");
	expect(low.startTimes.some((t) => Math.abs(t - 100.14) < 1e-6)).toBe(true);
	expect(low.stopTimes.some((t) => Math.abs(t - 101.42) < 1e-6)).toBe(true);
});

test("play() wires the 5 softTones (3 triangle + 2 sine) with lowpass biquad at 3400 Hz", () => {
	const fakeCtx = makeFakeAudioContext(false);
	const win = makeWinWithCtx(fakeCtx);
	const player = createIntroSoundPlayer({ window: win as never, document: null });
	player.play();
	const lowpassCount = fakeCtx.captured.biquads.filter((b) => b.type === "lowpass").length;
	expect(lowpassCount).toBe(5);
	const triangleCount = fakeCtx.captured.oscillators.filter((o) => o.type === "triangle").length;
	const sineCount = fakeCtx.captured.oscillators.filter((o) => o.type === "sine" && !o.frequency.events.some((e) => e.includes("=86"))).length;
	expect(triangleCount).toBe(3);
	expect(sineCount).toBe(2);
});

test("play() is idempotent — second call is a no-op (no new nodes scheduled)", () => {
	const fakeCtx = makeFakeAudioContext(false);
	const win = makeWinWithCtx(fakeCtx);
	const player = createIntroSoundPlayer({ window: win as never, document: null });
	expect(player.play()).toBe(true);
	const nodesAfterFirst = {
		gains: fakeCtx.captured.gains.length,
		sources: fakeCtx.captured.sources.length,
		oscillators: fakeCtx.captured.oscillators.length,
		biquads: fakeCtx.captured.biquads.length,
	};
	expect(player.play()).toBe(true);
	expect(fakeCtx.captured.gains.length).toBe(nodesAfterFirst.gains);
	expect(fakeCtx.captured.sources.length).toBe(nodesAfterFirst.sources);
	expect(fakeCtx.captured.oscillators.length).toBe(nodesAfterFirst.oscillators);
	expect(fakeCtx.captured.biquads.length).toBe(nodesAfterFirst.biquads);
});

test("play() returns false when AudioContext is suspended (autoplay policy) and schedules async resume", async () => {
	const fakeCtx = makeFakeAudioContext(true);
	const win = makeWinWithCtx(fakeCtx);
	const player = createIntroSoundPlayer({ window: win as never, document: null });
	const result = player.play();
	expect(result).toBe(false);
	expect(player.hasPlayed()).toBe(false);
	await fakeCtx.resume();
	// After the resume promise resolves, real AudioContext transitions to "running".
	fakeCtx.state = "running";
	expect(player.play()).toBe(true);
	expect(player.hasPlayed()).toBe(true);
});

test("armFallback() registers pointerdown + keydown capture listeners and unlocks on first pointer down", () => {
	const listeners: { type: string; handler: (event: Event) => void; useCapture: boolean }[] = [];
	const doc = {
		addEventListener(type: string, handler: (event: Event) => void, useCapture?: boolean) {
			listeners.push({ type, handler, useCapture: Boolean(useCapture) });
		},
		removeEventListener(type: string, handler: (event: Event) => void, useCapture?: boolean) {
			const i = listeners.findIndex((l) => l.type === type && l.handler === handler && l.useCapture === Boolean(useCapture));
			if (i >= 0) listeners.splice(i, 1);
		},
	};
	const fakeCtx = makeFakeAudioContext(false);
	const win = makeWinWithCtx(fakeCtx);
	const player = createIntroSoundPlayer({ window: win as never, document: doc as never });
	player.armFallback();
	expect(listeners.filter((l) => l.type === "pointerdown" && l.useCapture).length).toBe(1);
	expect(listeners.filter((l) => l.type === "keydown" && l.useCapture).length).toBe(1);
	const pd = listeners.find((l) => l.type === "pointerdown");
	if (!pd) throw new Error("pointerdown missing");
	pd.handler(new Event("pointerdown"));
	expect(player.hasPlayed()).toBe(true);
	const remaining = listeners.filter((l) => l.type === "pointerdown" || l.type === "keydown");
	expect(remaining.length).toBe(0);
});

test("armFallback() is idempotent — calling twice registers only one pair", () => {
	const listeners: { type: string; handler: (event: Event) => void; useCapture: boolean }[] = [];
	const doc = {
		addEventListener(type: string, handler: (event: Event) => void, useCapture?: boolean) {
			listeners.push({ type, handler, useCapture: Boolean(useCapture) });
		},
		removeEventListener() {},
	};
	const player = createIntroSoundPlayer({ document: doc as never, window: null });
	player.armFallback();
	player.armFallback();
	expect(listeners.filter((l) => l.type === "pointerdown").length).toBe(1);
	expect(listeners.filter((l) => l.type === "keydown").length).toBe(1);
});

test("dispose() keeps a player-created AudioContext alive by default, matching baseline splashAudioCtx lifetime", () => {
	const fakeCtx = makeFakeAudioContext(false);
	const win = makeWinWithCtx(fakeCtx);
	const player = createIntroSoundPlayer({ window: win as never, document: null });
	player.play();
	player.dispose();
	expect(fakeCtx.closeCalled).toBe(false);
});

test("dispose() can opt into closing the AudioContext the player created", () => {
	const fakeCtx = makeFakeAudioContext(false);
	const win = makeWinWithCtx(fakeCtx);
	const player = createIntroSoundPlayer({
		window: win as never,
		document: null,
		closeOwnedAudioContextOnDispose: true,
	});
	player.play();
	player.dispose();
	expect(fakeCtx.closeCalled).toBe(true);
});

test("dispose() does NOT close an externally-injected shared AudioContext", () => {
	const fakeCtx = makeFakeAudioContext(false);
	const player = createIntroSoundPlayer({
		audioContext: fakeCtx as unknown as AudioContext,
		document: null,
	});
	player.play();
	player.dispose();
	expect(fakeCtx.closeCalled).toBe(false);
});

test("play() uses an externally-injected AudioContext even when no AudioContext constructor exists on window", () => {
	const fakeCtx = makeFakeAudioContext(false);
	const player = createIntroSoundPlayer({
		audioContext: fakeCtx as unknown as AudioContext,
		document: null,
		window: {},
	});
	expect(player.play()).toBe(true);
	expect(player.hasPlayed()).toBe(true);
	expect(fakeCtx.captured.gains.length).toBeGreaterThan(0);
});

test("dispose() removes armed fallback listeners before first unlock", () => {
	const listeners: { type: string; handler: (event: Event) => void; useCapture: boolean }[] = [];
	const doc = {
		addEventListener(type: string, handler: (event: Event) => void, useCapture?: boolean) {
			listeners.push({ type, handler, useCapture: Boolean(useCapture) });
		},
		removeEventListener(type: string, handler: (event: Event) => void, useCapture?: boolean) {
			const i = listeners.findIndex((l) => l.type === type && l.handler === handler && l.useCapture === Boolean(useCapture));
			if (i >= 0) listeners.splice(i, 1);
		},
	};
	const player = createIntroSoundPlayer({ document: doc as never, window: null });
	player.armFallback();
	expect(listeners.length).toBe(2);
	player.dispose();
	expect(listeners.length).toBe(0);
});
