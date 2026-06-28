import { expect, test } from "bun:test";
import "../runtime/happy-dom-preload";
import type { ThreeFactory } from "../runtime/renderer-setup";
import type { AudioSnapshot } from "../audio/audio-snapshot";
import type { FrameContext } from "../runtime/frame-context";
import { createHomeVisual } from "./home-visual";
import { SKULL_PRESET_INDEX } from "./preset-state";

function makeFakeThree(): ThreeFactory {
	const Points = function (geo: unknown, mat: unknown) {
		return { isPoints: true, geometry: geo, material: mat, frustumCulled: true, renderOrder: 0, visible: true };
	} as never;
	const ShaderMaterial = function (params: Record<string, unknown>) {
		return {
			isShaderMaterial: true,
			uniforms: params.uniforms,
			vertexShader: params.vertexShader,
			fragmentShader: params.fragmentShader,
			transparent: params.transparent,
			depthWrite: params.depthWrite,
			depthTest: params.depthTest,
			blending: params.blending,
			dispose() {},
		};
	} as never;
	const BufferAttribute = function (arr: Float32Array, itemSize: number) {
		return { array: arr, itemSize, count: arr.length / itemSize, needsUpdate: false };
	} as never;
	const BufferGeometry = function () {
		return {
			attributes: {} as Record<string, unknown>,
			setAttribute: function (name: string, attr: unknown) { (this as { attributes: Record<string, unknown> }).attributes[name] = attr; },
			dispose() {},
		};
	} as never;
	const Texture = function () { return { dispose() {} }; } as never;
	const CanvasTexture = function (i: unknown) { return { image: i, dispose() {} }; } as never;
	const Color = function (h: string) { return { hex: h }; } as never;
	const Vector2 = function (x: number, y: number) {
		return { x, y, set(this: { x: number; y: number }, nx: number, ny: number) { this.x = nx; this.y = ny; } };
	} as never;
	const module = {
		Points, ShaderMaterial, BufferAttribute, BufferGeometry,
		Texture, CanvasTexture, Color, Vector2,
		NormalBlending: 1, AdditiveBlending: 2, LinearFilter: 1006, NearestFilter: 1003,
		ClampToEdgeWrapping: 1001, RGBAFormat: 1023, FloatType: 1015,
	};
	return (() => module) as unknown as ThreeFactory;
}

function makeFakeScene() {
	const added: unknown[] = [];
	const removed: unknown[] = [];
	return { add(o: unknown) { added.push(o); }, remove(o: unknown) { removed.push(o); }, added, removed };
}

function makeFakeRuntimeUniforms() {
	const v2 = { x: 0, y: 0, set(this: { x: number; y: number }, x: number, y: number) { this.x = x; this.y = y; } };
	return {
		uTime: { value: 0 },
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
	};
}

function makeFrameCtx(over: Partial<AudioSnapshot> = {}, overUniforms?: Record<string, { value: unknown } | undefined>) {
	const snap: AudioSnapshot = {
		bass: 0, mid: 0, treble: 0, energy: 0,
		rb: 0, rm: 0, rt: 0, re: 0,
		beatPulse: 0, scheduledBeatPulse: 0, beatOnsetFlag: false,
		...over,
	};
	const uniforms = makeFakeRuntimeUniforms();
	for (const k of Object.keys(overUniforms ?? {})) {
		const slot = overUniforms?.[k];
		if (slot) (uniforms as Record<string, { value: unknown }>)[k] = slot;
	}
	return {
		dt: 1 / 60, now: 0, snapshot: snap, uniforms,
		scene: makeFakeScene(), camera: {} as never,
		pointerParallax: { x: 0, y: 0 }, pointerTarget: { x: 0, y: 0 },
	};
}

test("createHomeVisual returns the lifecycle API {update, dispose, getPreset, setPreset, getFx, getField}", async () => {
	const scene = makeFakeScene();
	const hv = await createHomeVisual({ scene: scene as never, threeFactory: makeFakeThree() });
	expect(typeof hv.update).toBe("function");
	expect(typeof hv.dispose).toBe("function");
	expect(typeof hv.getPreset).toBe("function");
	expect(typeof hv.setPreset).toBe("function");
	expect(typeof hv.getFx).toBe("function");
	expect(typeof hv.getField).toBe("function");
	expect(hv.getPreset()).toBe(0);
});

test("HomeVisual.setPreset clamps p to [0,6] and mutates fx.preset; field sees fx.preset through applyFxState", async () => {
	const scene = makeFakeScene();
	const hv = await createHomeVisual({ scene: scene as never, threeFactory: makeFakeThree() });
	hv.setPreset(99);
	expect(hv.getPreset()).toBe(6);
	expect(hv.getFx().preset).toBe(6);
	const uniforms = hv.getField().materialUniforms;
	expect(uniforms.uPreset.value).toBe(6);
	hv.setPreset(2);
	expect(uniforms.uPreset.value).toBe(2);
});

test("HomeVisual.update threads snapshot into runtime uniforms (uBass/uMid/uTreble/uBeat/uEnergy) and material uniforms", async () => {
	const scene = makeFakeScene();
	const hv = await createHomeVisual({ scene: scene as never, threeFactory: makeFakeThree(), coverResolution: 1.55 });
	const ctx = makeFrameCtx({ bass: 0.5, mid: 0.3, treble: 0.2, beatPulse: 0.4, energy: 0.6 });
	hv.update(ctx as unknown as FrameContext);
	const fx = hv.getFx();
	expect((ctx.uniforms as unknown as { uBass: { value: number } }).uBass.value).toBeCloseTo(0.5 * fx.intensity, 5);
	expect((ctx.uniforms as unknown as { uBass: { value: number } }).uBass.value).toBeCloseTo(hv.getField().materialUniforms.uBass.value as number, 5);
	expect((ctx.uniforms as unknown as { uEnergy: { value: number } }).uEnergy.value).toBeCloseTo(0.6, 5);
});

test("HomeVisual.update syncs materialUniforms.uTime to ctx.uniforms.uTime.value (render loop advances uTime)", async () => {
	const scene = makeFakeScene();
	const hv = await createHomeVisual({ scene: scene as never, threeFactory: makeFakeThree() });
	const ctx = makeFrameCtx();
	(ctx.uniforms as unknown as { uTime: { value: number } }).uTime.value = 1.234;
	hv.update(ctx as unknown as FrameContext);
	expect(hv.getField().materialUniforms.uTime.value as number).toBeCloseTo(1.234, 5);
});

test("HomeVisual.update fades particle alpha toward the visible baseline target", async () => {
	const scene = makeFakeScene();
	const hv = await createHomeVisual({ scene: scene as never, threeFactory: makeFakeThree() });
	expect(hv.getField().materialUniforms.uAlpha.value as number).toBe(0);
	hv.update(makeFrameCtx() as unknown as FrameContext);
	expect(hv.getField().materialUniforms.uAlpha.value as number).toBeGreaterThan(0);
	expect(hv.getField().materialUniforms.uAlpha.value as number).toBeLessThanOrEqual(0.96);
});

test("HomeVisual.setCoverUrl updates cover uniforms and update advances the baseline color mix tween", async () => {
	const scene = makeFakeScene();
	const hv = await createHomeVisual({
		scene: scene as never,
		threeFactory: makeFakeThree(),
		loadCoverImage: async (url) => ({ width: 128, height: 128, src: url }),
	});
	hv.setCoverUrl("https://img.example/a.jpg");
	await hv.getCoverController().whenIdle();
	expect(hv.getField().materialUniforms.uHasCover.value).toBe(1);
	expect(hv.getField().materialUniforms.uColorMixT.value).toBe(0);
	hv.update(makeFrameCtx({}, { uTime: { value: 0.25 } }) as unknown as FrameContext);
	expect(hv.getField().materialUniforms.uColorMixT.value as number).toBeGreaterThan(0);
});

test("HomeVisual.setCoverUrl prepares cover canvas with the same baseline coverResolution as the field", async () => {
	const scene = makeFakeScene();
	const hv = await createHomeVisual({
		scene: scene as never,
		threeFactory: makeFakeThree(),
		coverResolution: 1.1,
		loadCoverImage: async (url) => ({ naturalWidth: 640, naturalHeight: 480, src: url }),
		createCoverCanvas: (width, height) => ({
			width,
			height,
			getContext: () => ({
				drawImage() {},
			} as never),
		}) as never,
	});
	hv.setCoverUrl("https://img.example/a.jpg");
	await hv.getCoverController().whenIdle();
	const image = hv.getField().materialUniforms.uCoverTex.value.image as { width: number; height: number };
	expect(image.width).toBe(384);
	expect(image.height).toBe(384);
});

test("HomeVisual.update advances cover depth uniforms after edge texture generation", async () => {
	const scene = makeFakeScene();
	const edgeCanvas = { width: 256, height: 256, label: "edge" };
	const hv = await createHomeVisual({
		scene: scene as never,
		threeFactory: makeFakeThree(),
		loadCoverImage: async (url) => ({ width: 128, height: 128, src: url }),
		buildCoverEdgeDepth: () => edgeCanvas,
	});
	hv.setCoverUrl("https://img.example/a.jpg");
	await hv.getCoverController().whenIdle();
	expect(hv.getField().materialUniforms.uEdgeTex.value.image).toBe(edgeCanvas);
	expect(hv.getField().materialUniforms.uHasDepth.value).toBe(0);
	hv.update(makeFrameCtx({}, { uTime: { value: 0.25 } }) as unknown as FrameContext);
	expect(hv.getField().materialUniforms.uHasDepth.value as number).toBeGreaterThan(0);
	expect(hv.getField().materialUniforms.uAiBoost.value as number).toBeGreaterThan(0);
});

test("HomeVisual.update drives baseline ripple texture from bass rising edges", async () => {
	const scene = makeFakeScene();
	const hv = await createHomeVisual({ scene: scene as never, threeFactory: makeFakeThree() });
	const uniforms = hv.getField().materialUniforms;
	const data = (uniforms.uRippleTex.value as { image: { data: Float32Array } }).image.data;
	const ctx = makeFrameCtx({ bass: 0.4 }, { uTime: { value: 0.4 } });
	hv.update(ctx as unknown as FrameContext);
	expect(uniforms.uRippleCount.value as number).toBeGreaterThanOrEqual(2);
	expect(uniforms.uRippleCount.value as number).toBeLessThanOrEqual(3);
	expect((uniforms.uRippleTex.value as { needsUpdate: boolean }).needsUpdate).toBe(true);
	expect(data[2]).toBeCloseTo(1 / 60, 5);
	expect(data[3]).toBeGreaterThan(1);
});

test("preset 6 (skull) suppresses points visibility; non-skull leaves points visible", async () => {
	const scene = makeFakeScene();
	const hv = await createHomeVisual({ scene: scene as never, threeFactory: makeFakeThree() });
	hv.setPreset(5);
	hv.update(makeFrameCtx() as unknown as FrameContext);
	expect((hv.getField().points as { visible: boolean }).visible).toBe(true);
	hv.setPreset(SKULL_PRESET_INDEX);
	hv.update(makeFrameCtx() as unknown as FrameContext);
	expect((hv.getField().points as { visible: boolean }).visible).toBe(false);
});

test("bloom gate: when fx.bloom=false, bloomPoints.visible=false; when fx.bloom=true && bloomStrength>0.01, bloomPoints.visible=true (unless skull)", async () => {
	const scene = makeFakeScene();
	const hv = await createHomeVisual({ scene: scene as never, threeFactory: makeFakeThree() });
	hv.getFx().bloom = false;
	hv.update(makeFrameCtx() as unknown as FrameContext);
	expect((hv.getField().bloomPoints as { visible: boolean }).visible).toBe(false);
	hv.getFx().bloom = true;
	hv.getFx().bloomStrength = 0.65;
	hv.update(makeFrameCtx() as unknown as FrameContext);
	expect((hv.getField().bloomPoints as { visible: boolean }).visible).toBe(true);
});

test("HomeVisual.dispose disposes the underlying particle field (Points removed)", async () => {
	const scene = makeFakeScene();
	const hv = await createHomeVisual({ scene: scene as never, threeFactory: makeFakeThree() });
	hv.dispose();
	expect((scene.removed as unknown[]).length).toBe(2);
});
