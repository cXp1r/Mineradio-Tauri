import { expect, test } from "bun:test";
import "./happy-dom-preload";
import { createPerformanceCollector } from "./performance-collector";
import { createRenderLoop } from "./render-loop";
import { RenderStepSlot } from "./render-step-slot";
import type { AudioReactivityEngine, AudioSnapshot } from "../audio/audio-snapshot";
import {
	createVisualScheduler,
	type VisualScheduler,
	type VisualSchedulerDriver,
	type VisualSchedulerRuntimeCallbacks,
} from "./visual-scheduler";

const ZERO_RESOURCE_BUDGET = {
	textureBytes: 0,
	geometryBytes: 0,
	meshCount: 0,
	queuedTaskCost: 0,
	cacheBytes: 0,
} as const;

const FOREGROUND_VISIBILITY = {
	documentVisible: true,
	windowVisible: true,
	windowFocused: true,
	windowMinimized: false,
} as const;

const BACKGROUND_VISIBILITY = {
	...FOREGROUND_VISIBILITY,
	windowFocused: false,
} as const;

const DEEP_SLEEP_VISIBILITY = {
	documentVisible: false,
	windowVisible: false,
	windowFocused: false,
	windowMinimized: true,
} as const;

function makePerformanceCollector() {
	return createPerformanceCollector({ resourceBudget: ZERO_RESOURCE_BUDGET });
}

function makeAudioSnapshot(over: Partial<AudioSnapshot> = {}): AudioSnapshot {
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

function makeFakeAudio(snapshot: AudioSnapshot): Pick<AudioReactivityEngine, "update" | "getSnapshot"> {
	return { update() {}, getSnapshot: () => snapshot };
}

class ManualVisualScheduler implements VisualScheduler {
	private callbacks: VisualSchedulerRuntimeCallbacks | null = null;
	private lastNowMs: number | undefined;

	constructor(private readonly now: () => number) {}

	registerRuntimeCallbacks(callbacks: VisualSchedulerRuntimeCallbacks): () => void {
		if (this.callbacks) throw new Error("callbacks already registered");
		this.callbacks = callbacks;
		return () => {
			if (this.callbacks === callbacks) this.callbacks = null;
		};
	}

	start(): void {}
	stop(): void {}
	stepOnce(): void {
		const nowMs = this.now();
		const deltaSec = this.lastNowMs === undefined ? 0 : (nowMs - this.lastNowMs) / 1_000;
		const dtSec = deltaSec < 0 || deltaSec > 1 ? 0 : Math.min(deltaSec, 0.05);
		this.lastNowMs = nowMs;
		this.callbacks?.onAnimation(nowMs, { run: true, dtSec, pendingDtSec: 0 });
	}
	setVisibility(): void {}
	setBackgroundPolicy(): void {}
	setForegroundFramePolicy(): void {}
	getMode = () => "foreground" as const;
	getGeneration = () => 0;
	dispose(): void {}
}

class FakeVisualSchedulerDriver implements VisualSchedulerDriver {
	private nextHandle = 1;
	private nowMs = 0;
	readonly frameCallbacks = new Map<number, (nowMs: number) => void>();
	readonly activeFrames = new Set<number>();
	readonly timerCallbacks = new Map<number, () => void>();
	readonly activeTimers = new Map<number, number>();

	now(): number {
		return this.nowMs;
	}

	requestFrame(callback: (nowMs: number) => void): number {
		const handle = this.nextHandle++;
		this.frameCallbacks.set(handle, callback);
		this.activeFrames.add(handle);
		return handle;
	}

	cancelFrame(handle: number): void {
		this.activeFrames.delete(handle);
	}

	setTimer(callback: () => void, delayMs: number): number {
		const handle = this.nextHandle++;
		this.timerCallbacks.set(handle, callback);
		this.activeTimers.set(handle, delayMs);
		return handle;
	}

	clearTimer(handle: number): void {
		this.activeTimers.delete(handle);
	}

	triggerNextFrame(nowMs: number): void {
		this.nowMs = nowMs;
		const handles = [...this.activeFrames];
		if (handles.length !== 1) throw new Error(`expected one frame, received ${handles.length}`);
		const handle = handles[0] as number;
		this.activeFrames.delete(handle);
		this.frameCallbacks.get(handle)?.(nowMs);
	}

	triggerNextTimer(nowMs: number): void {
		this.nowMs = nowMs;
		const handles = [...this.activeTimers.keys()];
		if (handles.length !== 1) throw new Error(`expected one timer, received ${handles.length}`);
		const handle = handles[0] as number;
		this.activeTimers.delete(handle);
		this.timerCallbacks.get(handle)?.();
	}
}

function driveFrames(driver: FakeVisualSchedulerDriver, hz: number, count: number): void {
	for (let frame = 0; frame < count; frame += 1) {
		driver.triggerNextFrame((frame * 1_000) / hz);
	}
}

function makeFakeRenderer() {
	let renderCount = 0;
	const renderer = {
		domElement: document.createElement("canvas"),
		render: () => { renderCount += 1; },
		setPixelRatio: () => {},
		setSize: () => {},
		setClearColor: () => {},
		dispose: () => {},
		get renderCount() { return renderCount; },
	};
	return renderer;
}

function makeFakeScene() {
	return { add: () => {}, background: undefined };
}

function makeFakeCamera() {
	return {
		fov: 45,
		aspect: 1,
		near: 0.1,
		far: 100,
		position: { x: 0, y: 0, z: 0 },
		rotation: { x: 0, y: 0, z: 0, order: "YXZ" },
		lookAt: () => {},
		updateProjectionMatrix: () => {},
	};
}

function makeFakeUniforms() {
	return {
		uTime: { value: 0 },
		uBass: { value: 0 },
		uMid: { value: 0 },
		uTreble: { value: 0 },
		uBeat: { value: 0 },
		uEnergy: { value: 0 },
		uMouseXY: { value: { x: 0, y: 0, set: () => {} } },
		uMouseActive: { value: 0 },
		uVinylSpin: { value: 0 },
		uParticleDim: { value: 0 },
		uBurstAmt: { value: 0 },
	};
}

function makeLoop(over: Record<string, unknown> = {}) {
	const renderer = makeFakeRenderer();
	const uniforms = makeFakeUniforms();
	const now = typeof over.now === "function" ? over.now as () => number : () => 1000;
	const scheduler = over.scheduler as VisualScheduler | undefined ?? new ManualVisualScheduler(now);
	const performance = makePerformanceCollector();
	const loop = createRenderLoop({
		renderer: renderer as never,
		scene: makeFakeScene() as never,
		camera: makeFakeCamera() as never,
		audio: makeFakeAudio(makeAudioSnapshot({ energy: 0.4, rb: 0.3 })),
		scheduler,
		performance,
		uniforms: uniforms as never,
		isMainSceneCoveredBySplash: () => false,
		now,
		...over,
	} as never);
	loop.start();
	return { loop, renderer, uniforms, performance };
}

function makeScheduledLoop(options: {
	readonly scheduler?: Record<string, unknown>;
	readonly loop?: Record<string, unknown>;
} = {}) {
	const driver = new FakeVisualSchedulerDriver();
	const scheduler = createVisualScheduler({
		driver,
		...options.scheduler,
	} as never);
	const performance = makePerformanceCollector();
	const renderer = makeFakeRenderer();
	const uniforms = makeFakeUniforms();
	const loop = createRenderLoop({
		renderer: renderer as never,
		scene: makeFakeScene() as never,
		camera: makeFakeCamera() as never,
		audio: makeFakeAudio(makeAudioSnapshot()),
		scheduler,
		performance,
		uniforms: uniforms as never,
		now: () => 0,
		...options.loop,
	} as never);
	return { driver, scheduler, performance, renderer, uniforms, loop };
}

test("Beatmap runs first while all legacy slots retain their relative order", () => {
	const { loop } = makeLoop();
	const calls: string[] = [];
	for (const slot of [
		RenderStepSlot.ThumbnailPulse,
		RenderStepSlot.Beatmap,
		RenderStepSlot.Ripples,
		RenderStepSlot.CameraCinematic,
		RenderStepSlot.SkullLayer,
		RenderStepSlot.FloatLayer,
		RenderStepSlot.DesktopOverlaySync,
	] as const) {
		loop.registerStep(slot, () => { calls.push(slot); });
	}
	loop.stepOnce();
	expect(calls).toEqual([
		RenderStepSlot.Beatmap,
		RenderStepSlot.Ripples,
		RenderStepSlot.FloatLayer,
		RenderStepSlot.CameraCinematic,
		RenderStepSlot.SkullLayer,
		RenderStepSlot.DesktopOverlaySync,
		RenderStepSlot.ThumbnailPulse,
	]);
	loop.dispose();
});

test("render loop caps a valid lane dt and resets after a multi-second stall", () => {
	let now = 1000;
	const { loop, uniforms } = makeLoop({ now: () => now });
	let observedDt = Infinity;
	loop.registerStep(RenderStepSlot.Ripples, (ctx: { dt: number }) => { observedDt = ctx.dt; });
	now = 1000;
	loop.stepOnce();
	expect(observedDt).toBeCloseTo(0, 5);
	now = 1000 + 500;
	loop.stepOnce();
	expect(observedDt).toBeCloseTo(0.05, 5);
	now = 1000 + 5000;
	loop.stepOnce();
	expect(observedDt).toBeCloseTo(0, 5);
	expect(uniforms.uTime.value).toBeCloseTo(0.05, 5);
	loop.dispose();
});

test("compatibility perf APIs project collector counters with render-loop timestamps", () => {
	const { loop, performance } = makeLoop();
	performance.recordFrame({ source: "raf", rendered: true, costMs: 51 });
	performance.recordFrame({ source: "raf", rendered: false, costMs: 1 });
	performance.recordGate("presentation", {
		run: true,
		effectiveFps: 24,
		pendingDtSec: 0,
		costMs: 1,
	});
	performance.recordGate("presentation", {
		run: false,
		effectiveFps: 24,
		pendingDtSec: 0.01,
	});

	expect(loop.getFps()).toBe(24);
	expect(loop.getPerfState()).toEqual({
		mode: "24fps",
		frames: 1,
		fps: 24,
		longFrames: 1,
		skipped: 1,
		lastRenderAt: 1000,
		lastSampleAt: 1000,
	});
	loop.dispose();
});

test("compatibility perf mode follows the current presentation policy instead of cumulative skips", () => {
	const { driver, scheduler, loop } = makeScheduledLoop({
		scheduler: { initialForegroundFramePolicy: { mode: "fixed", fps: 30 } },
	});
	loop.start();
	scheduler.start();
	driveFrames(driver, 60, 3);

	expect(loop.getPerfState().mode).toBe("30fps");
	scheduler.setForegroundFramePolicy({ mode: "vsync" });
	driver.triggerNextFrame(50);
	driver.triggerNextFrame(1_000 / 15);

	expect(loop.getPerfState().mode).toBe("vsync");
	loop.dispose();
	scheduler.dispose();
});

test("compatibility perf state uses collector renders and real render and sample timestamps", () => {
	const { driver, scheduler, renderer, loop } = makeScheduledLoop({
		scheduler: { initialForegroundFramePolicy: { mode: "fixed", fps: 30 } },
	});
	loop.start();
	scheduler.start();
	driver.triggerNextFrame(100);
	driver.triggerNextFrame(100 + 1_000 / 60);

	const state = loop.getPerfState();
	expect(renderer.renderCount).toBe(1);
	expect(state.frames).toBe(1);
	expect(state.lastRenderAt).toBe(100);
	expect(state.lastSampleAt).toBeCloseTo(100 + 1_000 / 60, 6);
	loop.dispose();
	scheduler.dispose();
});

test("splash path renders every 520ms and skips step registry", () => {
	let now = 0;
	let splashActive = true;
	const { loop, renderer, performance } = makeLoop({
		isMainSceneCoveredBySplash: () => splashActive,
		now: () => now,
	});
	let stepsCalled = 0;
	loop.registerStep(RenderStepSlot.Ripples, () => { stepsCalled += 1; });
	now = 1000;
	loop.stepOnce();
	expect(stepsCalled).toBe(0);
	expect(renderer.renderCount).toBe(1);
	expect(performance.getSnapshot().gates[RenderStepSlot.Ripples]?.skips).toBe(1);
	now = 1000 + 400;
	loop.stepOnce();
	expect(renderer.renderCount).toBe(1);
	now = 1000 + 540;
	loop.stepOnce();
	expect(renderer.renderCount).toBe(2);
	splashActive = false;
	now = 1000 + 600;
	loop.stepOnce();
	expect(stepsCalled).toBe(1);
	const rippleGate = performance.getSnapshot().gates[RenderStepSlot.Ripples];
	expect(rippleGate?.runs).toBe(1);
	expect(rippleGate?.skips).toBe(3);
	loop.dispose();
});

test("stop then start inside the splash predicate cannot revive the old tick", () => {
	const calls: string[] = [];
	let restartPipeline = () => {};
	let restarted = false;
	const { loop, renderer } = makeLoop({
		isMainSceneCoveredBySplash() {
			calls.push("splash");
			if (restarted) return true;
			restarted = true;
			restartPipeline();
			return true;
		},
	});
	restartPipeline = () => {
		loop.stop();
		loop.start();
	};

	loop.stepOnce();

	expect(calls).toEqual(["splash"]);
	expect(renderer.renderCount).toBe(0);

	loop.stepOnce();
	expect(calls).toEqual(["splash", "splash"]);
	expect(renderer.renderCount).toBe(1);
	loop.dispose();
});

test("uniforms.uTime advances by dt each frame", () => {
	let now = 1000;
	const { loop, uniforms } = makeLoop({ now: () => now });
	now = 1000;
	loop.stepOnce();
	expect(uniforms.uTime.value).toBeCloseTo(0, 5);
	now = 1000 + 33;
	loop.stepOnce();
	expect(uniforms.uTime.value).toBeCloseTo(0.033, 4);
	loop.dispose();
});

test("pointerParallax lerps toward pointerTarget with 0.040 factor per frame", () => {
	let now = 1000;
	const pointerTarget = { x: 1, y: 1 };
	const { loop } = makeLoop({ pointerTarget, now: () => now });
	now = 1000;
	loop.stepOnce();
	const parallax = loop.getPointerParallax();
	expect(parallax.x).toBeCloseTo(0.040, 5);
	expect(parallax.y).toBeCloseTo(0.040, 5);
	now = 1000 + 16;
	loop.stepOnce();
	const parallax2 = loop.getPointerParallax();
	expect(parallax2.x).toBeCloseTo(0.040 + (1 - 0.040) * 0.040, 5);
	loop.dispose();
});

test("registerStep returns an unsubscribe that removes the callback", () => {
	const { loop } = makeLoop();
	let called = 0;
	const off = loop.registerStep(RenderStepSlot.Ripples, () => { called += 1; });
	loop.stepOnce();
	expect(called).toBe(1);
	off();
	loop.stepOnce();
	expect(called).toBe(1);
	loop.dispose();
});

test("render loop registers one scheduler consumer without taking scheduler handle ownership", () => {
	let callbacks: VisualSchedulerRuntimeCallbacks | null = null;
	let registrations = 0;
	let unregisters = 0;
	let schedulerStarts = 0;
	let schedulerStops = 0;
	let schedulerDisposals = 0;
	let schedulerSteps = 0;
	let legacyRafRequests = 0;
	const scheduler: VisualScheduler = {
		registerRuntimeCallbacks(nextCallbacks) {
			registrations += 1;
			callbacks = nextCallbacks;
			return () => {
				unregisters += 1;
				callbacks = null;
			};
		},
		start() { schedulerStarts += 1; },
		stop() { schedulerStops += 1; },
		stepOnce() {
			schedulerSteps += 1;
			callbacks?.onAnimation(1_000, { run: true, dtSec: 0, pendingDtSec: 0 });
		},
		setVisibility() {},
		setBackgroundPolicy() {},
		setForegroundFramePolicy() {},
		getMode: () => "foreground",
		getGeneration: () => 0,
		dispose() { schedulerDisposals += 1; },
	};
	const performance = makePerformanceCollector();
	const renderer = makeFakeRenderer();
	const loop = createRenderLoop({
		renderer: renderer as never,
		scene: makeFakeScene() as never,
		camera: makeFakeCamera() as never,
		audio: {
			update() {},
			getSnapshot: () => makeAudioSnapshot(),
		},
		scheduler,
		performance,
		now: () => 1_000,
		raf: () => {
			legacyRafRequests += 1;
			return 1;
		},
	} as never);

	expect(registrations).toBe(1);
	loop.start();
	loop.stepOnce();
	loop.stop();
	loop.dispose();
	loop.dispose();

	expect(schedulerSteps).toBe(1);
	expect(unregisters).toBe(1);
	expect(schedulerStarts).toBe(0);
	expect(schedulerStops).toBe(0);
	expect(schedulerDisposals).toBe(0);
	expect(legacyRafRequests).toBe(0);
});

test("audio analysis updates before snapshot and Beatmap leads visual steps with one shared snapshot", () => {
	const calls: string[] = [];
	const snapshot = makeAudioSnapshot({ bass: 0.8 });
	const snapshots: AudioSnapshot[] = [];
	const { loop } = makeLoop({
		audio: {
			update() { calls.push("audio.update"); },
			getSnapshot() {
				calls.push("audio.getSnapshot");
				return snapshot;
			},
		},
	});
	loop.registerStep(RenderStepSlot.FloatLayer, (ctx) => {
		calls.push("float-layer");
		snapshots.push(ctx.snapshot);
	});
	loop.registerStep(RenderStepSlot.Ripples, (ctx) => {
		calls.push("ripples");
		snapshots.push(ctx.snapshot);
	});
	loop.registerStep(RenderStepSlot.Beatmap, (ctx) => {
		calls.push("beatmap");
		snapshots.push(ctx.snapshot);
	});

	loop.stepOnce();

	expect(calls).toEqual([
		"audio.update",
		"audio.getSnapshot",
		"beatmap",
		"ripples",
		"float-layer",
	]);
	expect(snapshots).toHaveLength(3);
	expect(snapshots[0]).not.toBe(snapshot);
	expect(snapshots[0]).toEqual(snapshot);
	expect(Object.isFrozen(snapshots[0])).toBe(true);
	expect(snapshots[1]).toBe(snapshots[0]);
	expect(snapshots[2]).toBe(snapshots[0]);
	loop.dispose();
});

test("frequency bands reject writes without leaking mutable backing storage across a scheduler tick", () => {
	const rawBands = new Float32Array([0.25, 0.5]);
	const snapshots: AudioSnapshot[] = [];
	let directWriteRejected = false;
	let definePropertyRejected = false;
	let mutatorRejected = false;
	let laterBand = Number.NaN;
	const { loop } = makeLoop({
		audio: makeFakeAudio(makeAudioSnapshot({ frequencyBands: rawBands })),
	});
	loop.registerStep(RenderStepSlot.Beatmap, (ctx) => {
		snapshots.push(ctx.snapshot);
		const bands = ctx.snapshot.frequencyBands as Float32Array;
		try {
			bands[0] = 0.9;
		} catch {
			directWriteRejected = true;
		}
		try {
			Object.defineProperty(bands, "0", { value: 0.8 });
		} catch {
			definePropertyRejected = true;
		}
		try {
			bands.fill(0.7);
		} catch {
			mutatorRejected = true;
		}
		new Float32Array(bands.buffer)[0] = 0.6;
		bands.subarray(0, 1)[0] = 0.55;
	});
	loop.registerStep(RenderStepSlot.Ripples, (ctx) => {
		snapshots.push(ctx.snapshot);
		laterBand = ctx.snapshot.frequencyBands?.[0] ?? Number.NaN;
	});

	loop.stepOnce();

	expect(directWriteRejected).toBe(true);
	expect(definePropertyRejected).toBe(true);
	expect(mutatorRejected).toBe(true);
	expect(laterBand).toBeCloseTo(0.25, 6);
	expect(rawBands[0]).toBeCloseTo(0.25, 6);
	expect(snapshots[1]).toBe(snapshots[0]);
	expect(snapshots[0]?.frequencyBands).not.toBe(rawBands);
	expect(snapshots[0]?.frequencyBands instanceof Float32Array).toBe(true);
	loop.dispose();
});

test("frequency band cloning ignores an overridden source slice and keeps its backing isolated", () => {
	let sliceCalls = 0;
	class SharedSliceFloat32Array extends Float32Array {
		override slice(_start?: number, _end?: number): Float32Array<ArrayBuffer> {
			sliceCalls += 1;
			return this;
		}
	}
	const rawBands = new SharedSliceFloat32Array([0.25, 0.5]);
	let directWriteRejected = false;
	let mutatorRejected = false;
	let laterBand = Number.NaN;
	const { loop } = makeLoop({
		audio: makeFakeAudio(makeAudioSnapshot({ frequencyBands: rawBands })),
	});
	loop.registerStep(RenderStepSlot.Beatmap, (ctx) => {
		const bands = ctx.snapshot.frequencyBands as Float32Array;
		try {
			bands[0] = 0.9;
		} catch {
			directWriteRejected = true;
		}
		try {
			bands.set([0.8]);
		} catch {
			mutatorRejected = true;
		}
		new Float32Array(bands.buffer)[0] = 0.7;
		bands.subarray(0, 1)[0] = 0.6;
	});
	loop.registerStep(RenderStepSlot.Ripples, (ctx) => {
		laterBand = ctx.snapshot.frequencyBands?.[0] ?? Number.NaN;
	});

	loop.stepOnce();

	expect(sliceCalls).toBe(0);
	expect(directWriteRejected).toBe(true);
	expect(mutatorRejected).toBe(true);
	expect(laterBand).toBeCloseTo(0.25, 6);
	expect(rawBands[0]).toBeCloseTo(0.25, 6);
	loop.dispose();
});

test("numeric lanes advance independently while fixed presentation cadence only gates presentation work", () => {
	let audioUpdates = 0;
	let snapshotReads = 0;
	const counts = {
		beatmap: 0,
		ripples: 0,
		shelf: 0,
		lyricParticles: 0,
		stageLyrics: 0,
		desktopOverlay: 0,
		homeVisual: 0,
	};
	const { driver, scheduler, performance, renderer, loop } = makeScheduledLoop({
		scheduler: { initialForegroundFramePolicy: { mode: "fixed", fps: 24 } },
		loop: { audio: {
			update() { audioUpdates += 1; },
			getSnapshot() {
				snapshotReads += 1;
				return makeAudioSnapshot();
			},
		} },
	});
	loop.registerStep(RenderStepSlot.Beatmap, () => { counts.beatmap += 1; });
	loop.registerStep(RenderStepSlot.Ripples, () => { counts.ripples += 1; });
	loop.registerStep(RenderStepSlot.Shelf, () => { counts.shelf += 1; });
	loop.registerStep(RenderStepSlot.LyricParticles, () => { counts.lyricParticles += 1; });
	loop.registerStep(RenderStepSlot.StageLyrics, () => { counts.stageLyrics += 1; });
	loop.registerStep(RenderStepSlot.DesktopOverlaySync, () => { counts.desktopOverlay += 1; });
	loop.registerStep(RenderStepSlot.HomeVisual, () => { counts.homeVisual += 1; });
	loop.start();
	scheduler.start();

	driveFrames(driver, 120, 120);

	expect(audioUpdates).toBe(60);
	expect(snapshotReads).toBe(audioUpdates);
	expect(counts).toEqual({
		beatmap: 60,
		ripples: 60,
		shelf: 30,
		lyricParticles: 45,
		stageLyrics: 45,
		desktopOverlay: 12,
		homeVisual: 24,
	});
	expect(renderer.renderCount).toBe(24);
	expect(audioUpdates).toBeGreaterThan(renderer.renderCount);
	const perf = performance.getSnapshot();
	expect(perf.frames).toEqual({
		rafTicks: 120,
		timerTicks: 0,
		renders: 24,
		skippedRenders: 96,
		frameCostP50Ms: 0,
		frameCostP95Ms: 0,
		longFrames: 0,
	});
	expect(perf.gates["audio-analysis"]?.runs).toBe(60);
	expect(perf.gates["audio-analysis"]?.skips).toBe(60);
	expect(perf.gates[RenderStepSlot.Shelf]?.runs).toBe(30);
	expect(perf.gates[RenderStepSlot.Shelf]?.skips).toBe(90);
	loop.dispose();
	scheduler.dispose();
});

test("deep sleep runs maintenance only and waking resets lane phase with bounded dt", () => {
	const audioDts: number[] = [];
	let steps = 0;
	let cacheTrims = 0;
	const { driver, scheduler, performance, renderer, loop } = makeScheduledLoop({
		scheduler: { maintenanceIntervalMs: 250 },
		loop: { audio: {
			update(dt: number) { audioDts.push(dt); },
			getSnapshot: () => makeAudioSnapshot(),
		},
		onCacheTrim() { cacheTrims += 1; } },
	});
	loop.registerStep(RenderStepSlot.Ripples, () => { steps += 1; });
	loop.start();
	scheduler.start();
	driver.triggerNextFrame(0);

	scheduler.setVisibility(DEEP_SLEEP_VISIBILITY);
	driver.triggerNextTimer(500);

	expect(audioDts).toEqual([0]);
	expect(steps).toBe(1);
	expect(renderer.renderCount).toBe(1);
	expect(cacheTrims).toBe(1);
	expect(performance.getSnapshot().frames.timerTicks).toBe(1);

	scheduler.setVisibility(FOREGROUND_VISIBILITY);
	driver.triggerNextFrame(600);
	driver.triggerNextFrame(1_100);

	expect(audioDts).toEqual([0, 0, 0.05]);
	expect(steps).toBe(3);
	expect(renderer.renderCount).toBe(3);
	expect(cacheTrims).toBe(1);
	loop.dispose();
	scheduler.dispose();
});

test("maintenance is a metrics-free no-op while the render pipeline is stopped or disposed", () => {
	let callbacks: VisualSchedulerRuntimeCallbacks | null = null;
	const scheduler: VisualScheduler = {
		registerRuntimeCallbacks(next) {
			callbacks = next;
			return () => {};
		},
		start() {},
		stop() {},
		stepOnce() {},
		setVisibility() {},
		setBackgroundPolicy() {},
		setForegroundFramePolicy() {},
		getMode: () => "deep-sleep",
		getGeneration: () => 0,
		dispose() {},
	};
	const performance = makePerformanceCollector();
	let cacheTrims = 0;
	const loop = createRenderLoop({
		renderer: makeFakeRenderer() as never,
		scene: makeFakeScene() as never,
		camera: makeFakeCamera() as never,
		audio: makeFakeAudio(makeAudioSnapshot()),
		scheduler,
		performance,
		onCacheTrim() { cacheTrims += 1; },
		now: () => 0,
	});
	const maintenanceCallbacks = callbacks as unknown as VisualSchedulerRuntimeCallbacks;
	loop.start();
	maintenanceCallbacks.onMaintenance?.(100);

	expect(cacheTrims).toBe(1);
	expect(performance.getSnapshot().frames.timerTicks).toBe(1);
	expect(performance.getSnapshot().gates.maintenance?.runs).toBe(1);

	loop.stop();
	maintenanceCallbacks.onMaintenance?.(200);
	loop.start();
	loop.dispose();
	maintenanceCallbacks.onMaintenance?.(300);

	expect(cacheTrims).toBe(1);
	expect(performance.getSnapshot().frames.timerTicks).toBe(1);
	expect(performance.getSnapshot().gates.maintenance?.runs).toBe(1);
	expect(performance.getSnapshot().gates.maintenance?.skips).toBe(0);
});

test("a failing visual step records diagnostics while later steps and render continue", () => {
	const performance = makePerformanceCollector();
	const renderer = makeFakeRenderer();
	const scheduler = new ManualVisualScheduler(() => 1_000);
	const calls: string[] = [];
	let measurementNow = 0;
	const loop = createRenderLoop({
		renderer: renderer as never,
		scene: makeFakeScene() as never,
		camera: makeFakeCamera() as never,
		audio: makeFakeAudio(makeAudioSnapshot()),
		scheduler,
		performance,
		now: () => measurementNow++,
	});
	loop.registerStep(RenderStepSlot.Beatmap, () => {
		calls.push("beatmap");
		throw new Error("beatmap failed");
	});
	loop.registerStep(RenderStepSlot.Ripples, () => { calls.push("ripples"); });
	loop.start();
	loop.stepOnce();

	expect(calls).toEqual(["beatmap", "ripples"]);
	expect(renderer.renderCount).toBe(1);
	const snapshot = performance.getSnapshot();
	expect(snapshot.frames.rafTicks).toBe(0);
	expect(snapshot.frames.renders).toBe(0);
	expect(snapshot.gates[RenderStepSlot.Beatmap]?.errors).toBe(1);
	expect(snapshot.gates[RenderStepSlot.Ripples]?.runs).toBe(1);
	expect(snapshot.gates["audio-analysis"]?.runs).toBe(1);
	expect(snapshot.gates[RenderStepSlot.Beatmap]?.costP50Ms).toBeGreaterThan(0);
	loop.dispose();
});

test("a failing audio update records diagnostics while snapshot, later steps, and render continue", () => {
	const calls: string[] = [];
	const { loop, renderer, performance } = makeLoop({
		audio: {
			update() {
				calls.push("audio.update");
				throw new Error("audio update failed");
			},
			getSnapshot() {
				calls.push("audio.getSnapshot");
				return makeAudioSnapshot({ energy: 0.6 });
			},
		},
	});
	loop.registerStep(RenderStepSlot.Ripples, () => { calls.push("ripples"); });

	loop.stepOnce();

	expect(calls).toEqual(["audio.update", "audio.getSnapshot", "ripples"]);
	expect(renderer.renderCount).toBe(1);
	const snapshot = performance.getSnapshot();
	expect(snapshot.gates["audio-analysis"]?.runs).toBe(1);
	expect(snapshot.gates["audio-analysis"]?.errors).toBe(1);
	expect(snapshot.gates[RenderStepSlot.Ripples]?.runs).toBe(1);
	expect(snapshot.frames.renders).toBe(0);
	loop.dispose();
});

test("stop then start inside audio update cannot revive the old tick but the next tick runs", () => {
	const calls: string[] = [];
	let restartPipeline = () => {};
	let restarted = false;
	let laneRuns = 0;
	const { loop, renderer } = makeLoop({
		audio: {
			update() {
				calls.push("audio.update");
				if (restarted) return;
				restarted = true;
				restartPipeline();
			},
			getSnapshot() {
				calls.push("audio.getSnapshot");
				return makeAudioSnapshot({ beatPulse: 0.8 });
			},
		},
	});
	restartPipeline = () => {
		loop.stop();
		loop.start();
	};
	loop.registerStep(RenderStepSlot.Ripples, () => { laneRuns += 1; });

	loop.stepOnce();

	expect(calls).toEqual(["audio.update"]);
	expect(laneRuns).toBe(0);
	expect(renderer.renderCount).toBe(0);

	loop.stepOnce();
	expect(calls).toEqual(["audio.update", "audio.update", "audio.getSnapshot"]);
	expect(laneRuns).toBe(1);
	expect(renderer.renderCount).toBe(1);
	loop.dispose();
});

test("a failing audio snapshot uses a frozen neutral snapshot without blocking later steps or render", () => {
	const calls: string[] = [];
	let visualSnapshot: AudioSnapshot | undefined;
	const { loop, renderer, performance } = makeLoop({
		audio: {
			update() { calls.push("audio.update"); },
			getSnapshot() {
				calls.push("audio.getSnapshot");
				throw new Error("audio snapshot failed");
			},
		},
	});
	loop.registerStep(RenderStepSlot.Ripples, (ctx) => {
		calls.push("ripples");
		visualSnapshot = ctx.snapshot;
	});

	loop.stepOnce();

	expect(calls).toEqual(["audio.update", "audio.getSnapshot", "ripples"]);
	expect(visualSnapshot).toEqual(makeAudioSnapshot());
	expect(Object.isFrozen(visualSnapshot)).toBe(true);
	expect(renderer.renderCount).toBe(1);
	expect(performance.getSnapshot().gates["audio-analysis"]?.errors).toBe(1);
	loop.dispose();
});

test("a failed later audio snapshot replaces cached reactive data with a frozen neutral snapshot", () => {
	let now = 1_000;
	let snapshotReads = 0;
	const visualSnapshots: AudioSnapshot[] = [];
	const { loop, renderer, performance } = makeLoop({
		now: () => now,
		audio: {
			update() {},
			getSnapshot() {
				snapshotReads += 1;
				if (snapshotReads === 1) {
					return makeAudioSnapshot({
						beatPulse: 0.8,
						frequencyBands: new Float32Array([0.75, 0.25]),
					});
				}
				throw new Error("later audio snapshot failed");
			},
		},
	});
	loop.registerStep(RenderStepSlot.Ripples, (ctx) => { visualSnapshots.push(ctx.snapshot); });

	loop.stepOnce();
	now += 17;
	loop.stepOnce();

	expect(visualSnapshots).toHaveLength(2);
	expect(visualSnapshots[0]?.beatPulse).toBe(0.8);
	expect(visualSnapshots[0]?.frequencyBands?.[0]).toBeCloseTo(0.75, 6);
	expect(visualSnapshots[1]).toEqual(makeAudioSnapshot());
	expect(visualSnapshots[1]).not.toBe(visualSnapshots[0]);
	expect(visualSnapshots[1]?.frequencyBands).toBeUndefined();
	expect(Object.isFrozen(visualSnapshots[1])).toBe(true);
	expect(renderer.renderCount).toBe(2);
	expect(performance.getSnapshot().gates["audio-analysis"]?.errors).toBe(1);
	loop.dispose();
});

test("a failing isActive predicate is isolated and recorded before later steps render", () => {
	const performance = makePerformanceCollector();
	const renderer = makeFakeRenderer();
	const scheduler = new ManualVisualScheduler(() => 1_000);
	let ripples = 0;
	const loop = createRenderLoop({
		renderer: renderer as never,
		scene: makeFakeScene() as never,
		camera: makeFakeCamera() as never,
		audio: makeFakeAudio(makeAudioSnapshot()),
		scheduler,
		performance,
		now: () => 0,
	});
	loop.registerStep(RenderStepSlot.Beatmap, () => {
		throw new Error("inactive callback must not run");
	}, {
		isActive() { throw new Error("activation failed"); },
	});
	loop.registerStep(RenderStepSlot.Ripples, () => { ripples += 1; });
	loop.start();

	expect(() => loop.stepOnce()).not.toThrow();
	expect(ripples).toBe(1);
	expect(renderer.renderCount).toBe(1);
	const beatmapGate = performance.getSnapshot().gates[RenderStepSlot.Beatmap];
	expect(beatmapGate?.runs).toBe(0);
	expect(beatmapGate?.skips).toBe(1);
	expect(beatmapGate?.errors).toBe(1);
	loop.dispose();
});

test("stop then start inside an isActive predicate cannot revive the old tick", () => {
	const calls: string[] = [];
	let restarted = false;
	const { loop, renderer } = makeLoop();
	loop.registerStep(RenderStepSlot.Beatmap, () => { calls.push("beatmap"); }, {
		isActive() {
			if (restarted) {
				calls.push("predicate-next");
				return true;
			}
			restarted = true;
			calls.push("predicate-restart");
			loop.stop();
			loop.start();
			return true;
		},
	});
	loop.registerStep(RenderStepSlot.Ripples, () => { calls.push("later-slot"); });

	loop.stepOnce();
	expect(calls).toEqual(["predicate-restart"]);
	expect(renderer.renderCount).toBe(0);

	loop.stepOnce();
	expect(calls).toEqual(["predicate-restart", "predicate-next", "beatmap", "later-slot"]);
	expect(renderer.renderCount).toBe(1);
	loop.dispose();
});

test("reduced-motion snapshot is constructed once per audio gate run and reused between audio ticks", () => {
	let snapshotReads = 0;
	const rawSnapshot = makeAudioSnapshot({
		bass: 0.9,
		mid: 0.8,
		treble: 0.7,
		beatPulse: 0.6,
		scheduledBeatPulse: 0.5,
	});
	const snapshots: AudioSnapshot[] = [];
	const { driver, scheduler, loop } = makeScheduledLoop({
		loop: { audio: {
			update() {},
			getSnapshot() {
				snapshotReads += 1;
				return rawSnapshot;
			},
		},
		prefersReducedMotion: () => true,
		},
	});
	loop.registerStep(RenderStepSlot.HomeVisual, (ctx) => { snapshots.push(ctx.snapshot); });
	loop.registerStep(RenderStepSlot.CameraCinematic, (ctx) => { snapshots.push(ctx.snapshot); });
	loop.start();
	scheduler.start();
	driver.triggerNextFrame(0);
	driver.triggerNextFrame(1_000 / 120);

	expect(snapshotReads).toBe(1);
	expect(snapshots).toHaveLength(4);
	expect(snapshots[0]).not.toBe(rawSnapshot);
	expect(snapshots[0]).toBe(snapshots[1]);
	expect(snapshots[1]).toBe(snapshots[2]);
	expect(snapshots[2]).toBe(snapshots[3]);
	expect(snapshots[0]).toEqual({
		...rawSnapshot,
		bass: 0,
		mid: 0,
		treble: 0,
		beatPulse: 0,
		scheduledBeatPulse: 0,
	});
	expect(Object.isFrozen(snapshots[0])).toBe(true);
	loop.dispose();
	scheduler.dispose();
});

test("registrations added during a tick wait until the next tick even in a later slot", () => {
	let now = 1_000;
	let lateRuns = 0;
	let registered = false;
	const { loop } = makeLoop({ now: () => now });
	loop.registerStep(RenderStepSlot.Beatmap, () => {
		if (registered) return;
		registered = true;
		loop.registerStep(RenderStepSlot.Ripples, () => { lateRuns += 1; });
	});

	loop.stepOnce();
	expect(lateRuns).toBe(0);
	now += 17;
	loop.stepOnce();
	expect(lateRuns).toBe(1);
	loop.dispose();
});

test("a callback that keeps registering its own slot cannot grow one tick without bound", () => {
	let runs = 0;
	const { loop } = makeLoop();
	const registerAgain = () => {
		runs += 1;
		if (runs < 8) loop.registerStep(RenderStepSlot.HomeVisual, registerAgain);
	};
	loop.registerStep(RenderStepSlot.HomeVisual, registerAgain);

	loop.stepOnce();

	expect(runs).toBe(1);
	loop.dispose();
});

test("an entry unsubscribed after the tick snapshot is skipped before its turn", () => {
	const calls: string[] = [];
	const { loop } = makeLoop();
	let unsubscribeLater = () => {};
	loop.registerStep(RenderStepSlot.Beatmap, () => {
		calls.push("beatmap");
		unsubscribeLater();
	});
	unsubscribeLater = loop.registerStep(RenderStepSlot.Ripples, () => { calls.push("ripples"); });

	loop.stepOnce();

	expect(calls).toEqual(["beatmap"]);
	loop.dispose();
});

test("stopping inside a step aborts later registrations, later slots, and presentation", () => {
	const calls: string[] = [];
	const { loop, renderer } = makeLoop();
	loop.registerStep(RenderStepSlot.Beatmap, () => {
		calls.push("stop");
		loop.stop();
	});
	loop.registerStep(RenderStepSlot.Beatmap, () => { calls.push("same-slot"); });
	loop.registerStep(RenderStepSlot.Ripples, () => { calls.push("later-slot"); });

	loop.stepOnce();

	expect(calls).toEqual(["stop"]);
	expect(renderer.renderCount).toBe(0);
	loop.dispose();
});

test("stop then start inside a step cannot revive the old tick but the next tick runs", () => {
	const calls: string[] = [];
	let restarted = false;
	const { loop, renderer } = makeLoop();
	loop.registerStep(RenderStepSlot.Beatmap, () => {
		if (restarted) {
			calls.push("beatmap-next");
			return;
		}
		restarted = true;
		calls.push("restart");
		loop.stop();
		loop.start();
	});
	loop.registerStep(RenderStepSlot.Beatmap, () => { calls.push("same-slot"); });
	loop.registerStep(RenderStepSlot.Ripples, () => { calls.push("later-slot"); });

	loop.stepOnce();
	expect(calls).toEqual(["restart"]);
	expect(renderer.renderCount).toBe(0);

	loop.stepOnce();
	expect(calls).toEqual(["restart", "beatmap-next", "same-slot", "later-slot"]);
	expect(renderer.renderCount).toBe(1);
	loop.dispose();
});

test("stop then start inside renderer does not credit the old tick but the next tick renders", () => {
	let restartPipeline = () => {};
	let restarted = false;
	let renderCalls = 0;
	const renderer = {
		render() {
			renderCalls += 1;
			if (restarted) return;
			restarted = true;
			restartPipeline();
		},
	};
	const { driver, scheduler, performance, loop } = makeScheduledLoop({
		loop: { renderer },
	});
	restartPipeline = () => {
		loop.stop();
		loop.start();
	};
	loop.start();
	scheduler.start();

	driver.triggerNextFrame(100);
	expect(renderCalls).toBe(1);
	expect(performance.getSnapshot().frames.renders).toBe(0);
	expect(performance.getSnapshot().frames.skippedRenders).toBe(1);
	expect(loop.getPerfState().lastRenderAt).toBe(0);

	driver.triggerNextFrame(116);
	expect(renderCalls).toBe(2);
	expect(performance.getSnapshot().frames.renders).toBe(1);
	expect(performance.getSnapshot().frames.skippedRenders).toBe(1);
	expect(loop.getPerfState().lastRenderAt).toBe(116);
	loop.dispose();
	scheduler.dispose();
});

test("disposing inside a step aborts the rest of the tick before presentation", () => {
	const calls: string[] = [];
	const { loop, renderer } = makeLoop();
	loop.registerStep(RenderStepSlot.Beatmap, () => {
		calls.push("dispose");
		loop.dispose();
	});
	loop.registerStep(RenderStepSlot.Beatmap, () => { calls.push("same-slot"); });
	loop.registerStep(RenderStepSlot.Ripples, () => { calls.push("later-slot"); });

	loop.stepOnce();

	expect(calls).toEqual(["dispose"]);
	expect(renderer.renderCount).toBe(0);
});

test("same-slot registrations keep independent cadence and inactive lanes resume without backlog", () => {
	let thirtyRuns = 0;
	let twelveRuns = 0;
	const resumedDts: number[] = [];
	const { driver, scheduler, performance, loop } = makeScheduledLoop();
	loop.registerStep(RenderStepSlot.FloatLayer, (ctx) => {
		thirtyRuns += 1;
		resumedDts.push(ctx.dt);
	}, {
		cadence: 30,
		isActive: (mode) => mode === "foreground",
	});
	loop.registerStep(RenderStepSlot.FloatLayer, () => { twelveRuns += 1; }, { cadence: 12 });
	loop.start();
	scheduler.start();
	driveFrames(driver, 120, 120);

	expect(thirtyRuns).toBe(30);
	expect(twelveRuns).toBe(12);
	const gates = performance.getSnapshot().gates;
	expect(gates[RenderStepSlot.FloatLayer]?.runs).toBe(30);
	expect(gates[RenderStepSlot.FloatLayer]?.skips).toBe(90);
	expect(gates[RenderStepSlot.FloatLayer]?.effectiveFps).toBe(30);
	expect(gates[`${RenderStepSlot.FloatLayer}#2`]?.runs).toBe(12);
	expect(gates[`${RenderStepSlot.FloatLayer}#2`]?.skips).toBe(108);
	expect(gates[`${RenderStepSlot.FloatLayer}#2`]?.effectiveFps).toBe(12);

	scheduler.setVisibility(BACKGROUND_VISIBILITY);
	driver.triggerNextFrame(1_050);
	driver.triggerNextFrame(1_100);
	const runsBeforeWake = thirtyRuns;
	scheduler.setVisibility(FOREGROUND_VISIBILITY);
	driver.triggerNextFrame(1_200);

	expect(thirtyRuns).toBe(runsBeforeWake + 1);
	expect(resumedDts.at(-1)).toBe(0);
	loop.dispose();
	scheduler.dispose();
});

test("pipeline start and stop do not create or cancel scheduler handles and stepOnce stays handle-free", () => {
	let steps = 0;
	const { driver, scheduler, loop } = makeScheduledLoop();
	loop.registerStep(RenderStepSlot.Ripples, () => { steps += 1; });

	loop.stepOnce();
	expect(steps).toBe(0);
	expect(driver.activeFrames.size).toBe(0);
	loop.start();
	loop.stepOnce();
	expect(steps).toBe(1);
	expect(driver.activeFrames.size).toBe(0);
	loop.stop();
	loop.stepOnce();
	expect(steps).toBe(1);
	expect(driver.activeFrames.size).toBe(0);

	scheduler.start();
	expect(driver.activeFrames.size).toBe(1);
	loop.start();
	loop.stop();
	expect(driver.activeFrames.size).toBe(1);
	loop.dispose();
	expect(driver.activeFrames.size).toBe(0);
	scheduler.dispose();
});

test("scheduler ticks after pipeline stop leave collector state unchanged while the scheduler stays live", () => {
	const { driver, scheduler, performance, renderer, loop } = makeScheduledLoop();
	loop.registerStep(RenderStepSlot.Ripples, () => {});
	loop.start();
	scheduler.start();
	driver.triggerNextFrame(0);
	const beforeStop = performance.getSnapshot();

	loop.stop();
	driver.triggerNextFrame(16);
	driver.triggerNextFrame(32);

	expect(performance.getSnapshot()).toEqual(beforeStop);
	expect(renderer.renderCount).toBe(1);
	expect(driver.activeFrames.size).toBe(1);
	loop.dispose();
	scheduler.dispose();
});

test("manual stepOnce keeps gate diagnostics without fabricating RAF frame metrics", () => {
	const { loop, renderer, performance } = makeLoop();
	loop.registerStep(RenderStepSlot.Ripples, () => {});

	loop.stepOnce();

	expect(renderer.renderCount).toBe(1);
	expect(performance.getSnapshot().gates[RenderStepSlot.Ripples]?.runs).toBe(1);
	expect(performance.getSnapshot().gates.presentation?.runs).toBe(1);
	expect(performance.getSnapshot().frames).toEqual({
		rafTicks: 0,
		timerTicks: 0,
		renders: 0,
		skippedRenders: 0,
		frameCostP50Ms: 0,
		frameCostP95Ms: 0,
		longFrames: 0,
	});
	loop.dispose();
});

test("唯一 presentation render seam 负责 GPU timer capture 与释放", () => {
	let captures = 0;
	let disposals = 0;
	const gpuFrameTimer = {
		capture<T>(render: () => T): T {
			captures += 1;
			return render();
		},
		getSnapshot: () => ({
			extensionSupported: true,
			sampleCount: captures,
			pendingQueryCount: 0,
			p50Ms: 1,
			p95Ms: 1,
			disjointQueryCount: 0,
			droppedQueryCount: 0,
			errorCount: 0,
			contextLost: false,
		}),
		dispose() { disposals += 1; },
	};
	const { loop, renderer } = makeLoop({ gpuFrameTimer });

	loop.stepOnce();
	expect(captures).toBe(1);
	expect(renderer.renderCount).toBe(1);
	expect(loop.getGpuTimingSnapshot()?.sampleCount).toBe(1);
	loop.stop();
	loop.stepOnce();
	expect(captures).toBe(1);

	loop.dispose();
	loop.dispose();
	expect(disposals).toBe(1);
});

test("duplicate scheduler registration fails without fallback and dispose unregisters idempotently", () => {
	const driver = new FakeVisualSchedulerDriver();
	const scheduler = createVisualScheduler({ driver });
	const performance = makePerformanceCollector();
	const options = {
		renderer: makeFakeRenderer() as never,
		scene: makeFakeScene() as never,
		camera: makeFakeCamera() as never,
		audio: makeFakeAudio(makeAudioSnapshot()),
		scheduler,
		performance,
		now: () => 0,
	};
	const first = createRenderLoop(options);

	expect(() => createRenderLoop(options)).toThrow("already registered");
	first.dispose();
	first.dispose();
	const replacement = createRenderLoop(options);
	replacement.dispose();
	scheduler.dispose();
});

test("an inactive registration discards elapsed time and runs immediately with zero dt when reactivated", () => {
	let enabled = false;
	const dts: number[] = [];
	const { driver, scheduler, loop } = makeScheduledLoop();
	loop.registerStep(RenderStepSlot.Shelf, (ctx) => { dts.push(ctx.dt); }, {
		isActive: () => enabled,
	});
	loop.start();
	scheduler.start();
	driver.triggerNextFrame(0);
	driver.triggerNextFrame(20);
	driver.triggerNextFrame(40);
	enabled = true;
	driver.triggerNextFrame(50);

	expect(dts).toEqual([0]);
	loop.dispose();
	scheduler.dispose();
});

test("uTime and pointer parallax advance only on presentation decisions", () => {
	const pointerParallax = { x: 0, y: 0 };
	const { driver, scheduler, renderer, uniforms, loop } = makeScheduledLoop({
		scheduler: { initialForegroundFramePolicy: { mode: "fixed", fps: 24 } },
		loop: {
			pointerParallax,
			pointerTarget: { x: 1, y: 1 },
		},
	});
	loop.start();
	scheduler.start();
	driver.triggerNextFrame(0);
	const afterFirstPresentation = { ...pointerParallax };
	driver.triggerNextFrame(10);

	expect(uniforms.uTime.value).toBe(0);
	expect(pointerParallax).toEqual(afterFirstPresentation);
	expect(renderer.renderCount).toBe(1);
	driver.triggerNextFrame(42);

	expect(uniforms.uTime.value).toBeCloseTo(0.042, 5);
	expect(pointerParallax.x).toBeCloseTo(0.04 + (1 - 0.04) * 0.04, 5);
	expect(pointerParallax.y).toBeCloseTo(pointerParallax.x, 5);
	expect(renderer.renderCount).toBe(2);
	loop.dispose();
	scheduler.dispose();
});

test("a short deep-sleep transition resets lane phase even before maintenance fires", () => {
	const audioDts: number[] = [];
	const { driver, scheduler, loop } = makeScheduledLoop({
		scheduler: { maintenanceIntervalMs: 1_000 },
		loop: { audio: {
			update(dt: number) { audioDts.push(dt); },
			getSnapshot: () => makeAudioSnapshot(),
		} },
	});
	loop.start();
	scheduler.start();
	driver.triggerNextFrame(0);
	scheduler.setVisibility(DEEP_SLEEP_VISIBILITY);
	scheduler.setVisibility(FOREGROUND_VISIBILITY);
	driver.triggerNextFrame(500);

	expect(audioDts).toEqual([0, 0]);
	loop.dispose();
	scheduler.dispose();
});
