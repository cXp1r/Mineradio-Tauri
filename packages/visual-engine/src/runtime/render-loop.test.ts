import { expect, test } from "bun:test";
import "./happy-dom-preload";
import { createRenderLoop } from "./render-loop";
import { RenderStepSlot } from "./render-step-slot";
import type { AudioReactivityEngine, AudioSnapshot } from "../audio/audio-snapshot";

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

function makeFakeAudio(snapshot: AudioSnapshot): Pick<AudioReactivityEngine, "getSnapshot"> {
	return { getSnapshot: () => snapshot };
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
	const loop = createRenderLoop({
		renderer: renderer as never,
		scene: makeFakeScene() as never,
		camera: makeFakeCamera() as never,
		audio: makeFakeAudio(makeAudioSnapshot({ energy: 0.4, rb: 0.3 })),
		uniforms: uniforms as never,
		isMainSceneCoveredBySplash: () => false,
		now: () => 1000,
		raf: () => 0,
		cancelRaf: () => {},
		...over,
	});
	return { loop, renderer, uniforms };
}

test("render loop invokes registered steps in the exact baseline slot order", () => {
	const { loop } = makeLoop();
	const calls: string[] = [];
	for (const slot of [
		RenderStepSlot.ThumbnailPulse,
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
		RenderStepSlot.Ripples,
		RenderStepSlot.FloatLayer,
		RenderStepSlot.CameraCinematic,
		RenderStepSlot.SkullLayer,
		RenderStepSlot.DesktopOverlaySync,
		RenderStepSlot.ThumbnailPulse,
	]);
	loop.dispose();
});

test("render loop clamps dt to 0.05 even when wall gap is large", () => {
	let now = 1000;
	const { loop, uniforms } = makeLoop({ now: () => now });
	let observedDt = Infinity;
	loop.registerStep(RenderStepSlot.Ripples, (ctx: { dt: number }) => { observedDt = ctx.dt; });
	now = 1000;
	loop.stepOnce();
	expect(observedDt).toBeCloseTo(0, 5);
	now = 1000 + 5000;
	loop.stepOnce();
	expect(observedDt).toBeCloseTo(0.05, 5);
	expect(uniforms.uTime.value).toBeCloseTo(0.05, 5);
	loop.dispose();
});

test("adaptive FPS policy skips frames until the configured frame gap elapses", () => {
	let now = 1000;
	const { loop, renderer } = makeLoop({
		now: () => now,
		getAdaptiveFps: () => 24,
	});
	let stepsCalled = 0;
	loop.registerStep(RenderStepSlot.Ripples, () => { stepsCalled += 1; });
	now = 1000;
	loop.stepOnce();
	now = 1000 + 20;
	loop.stepOnce();
	expect(stepsCalled).toBe(0);
	expect(renderer.renderCount).toBe(0);
	expect(loop.getPerfState().skipped).toBe(2);
	now = 1000 + 42;
	loop.stepOnce();
	expect(stepsCalled).toBe(1);
	expect(renderer.renderCount).toBe(1);
	expect(loop.getPerfState().mode).toBe("24fps");
	loop.dispose();
});

test("splash path renders every 520ms and skips step registry", () => {
	let now = 0;
	let splashActive = true;
	const { loop, renderer } = makeLoop({
		isMainSceneCoveredBySplash: () => splashActive,
		now: () => now,
	});
	let stepsCalled = 0;
	loop.registerStep(RenderStepSlot.Ripples, () => { stepsCalled += 1; });
	now = 1000;
	loop.stepOnce();
	expect(stepsCalled).toBe(0);
	expect(renderer.renderCount).toBe(1);
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
