import { expect, test } from "bun:test";
import "../runtime/happy-dom-preload";
import type { ThreeFactory } from "../runtime/renderer-setup";
import { createConnectorParticles } from "./connector-particles";
import type { FrameContext } from "../runtime/frame-context";
import type { AudioSnapshot } from "../audio/audio-snapshot";
import type { RuntimeUniforms } from "../runtime/uniforms";

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
			disposed: false,
			dispose() { this.disposed = true; },
		};
	} as never;
	const BufferAttribute = function (arr: Float32Array, itemSize: number) {
		return { array: arr, itemSize, count: arr.length / itemSize, needsUpdate: false };
	} as never;
	const BufferGeometry = function () {
		return {
			attributes: {} as Record<string, { array: Float32Array; itemSize: number; count: number }>,
			disposed: false,
			setAttribute(name: string, attr: { array: Float32Array; itemSize: number; count: number }) {
				this.attributes[name] = attr;
			},
			dispose() { this.disposed = true; },
		};
	} as never;
	const module = {
		Points,
		ShaderMaterial,
		BufferAttribute,
		BufferGeometry,
		AdditiveBlending: 2,
	};
	return (() => module) as unknown as ThreeFactory;
}

function makeFakeScene() {
	const added: unknown[] = [];
	const removed: unknown[] = [];
	return {
		add(o: unknown) { added.push(o); },
		remove(o: unknown) { removed.push(o); },
		tracked: added,
		removed,
	};
}

test("createConnectorParticles builds geometry with position(3)*36 / aRand(1)*36 / aT(1)*36", async () => {
	const scene = makeFakeScene();
	const cp = await createConnectorParticles({ scene: scene as never, threeFactory: makeFakeThree() });
	const geo = (cp.object as unknown as {
		geometry: {
			attributes: Record<string, { array: Float32Array; itemSize: number; count: number }>;
		};
	}).geometry;
	const attrs = geo.attributes;
	expect(attrs.position.itemSize).toBe(3);
	expect(attrs.position.count).toBe(36);
	expect(attrs.position.array.length).toBe(3 * 36);
	expect(attrs.aRand.itemSize).toBe(1);
	expect(attrs.aRand.count).toBe(36);
	expect(attrs.aT.itemSize).toBe(1);
	expect(attrs.aT.count).toBe(36);
});

test("createConnectorParticles adds Points to scene; frustumCulled=false; material additive/transparent/depthTest=false", async () => {
	const scene = makeFakeScene();
	const cp = await createConnectorParticles({ scene: scene as never, threeFactory: makeFakeThree() });
	expect((scene.tracked as unknown[]).length).toBe(1);
	expect(scene.tracked[0]).toBe(cp.object);
	const obj = cp.object as unknown as { frustumCulled: boolean };
	expect(obj.frustumCulled).toBe(false);
	const mat = (cp.object as unknown as { material: Record<string, unknown> }).material;
	expect(mat.transparent).toBe(true);
	expect(mat.depthTest).toBe(false);
	expect(mat.blending).toBe(2);
});

test("uniforms match baseline connector/shelf-center names (uTime/uEnergy/uIntensity/uColorMix/uPixel/uTrackScale=1)", async () => {
	const scene = makeFakeScene();
	const cp = await createConnectorParticles({ scene: scene as never, threeFactory: makeFakeThree() });
	const uniforms = (cp.object as unknown as { material: { uniforms: Record<string, { value: unknown }> } }).material.uniforms;
	const expected = ["uTime", "uEnergy", "uIntensity", "uColorMix", "uPixel", "uTrackScale"];
	for (const name of expected) {
		expect(Object.prototype.hasOwnProperty.call(uniforms, name)).toBe(true);
	}
	expect(Object.keys(uniforms).length).toBe(expected.length);
	expect(uniforms.uTrackScale.value).toBe(1);
	expect(uniforms.uPixel.value).toBe(1);
	expect(uniforms.uIntensity.value).toBe(0);
});

test("update(ctx) flows snapshot.energy into uEnergy and reads uTime from ctx.uniforms.uTime.value", async () => {
	const scene = makeFakeScene();
	const cp = await createConnectorParticles({ scene: scene as never, threeFactory: makeFakeThree() });
	const uniforms = (cp.object as unknown as { material: { uniforms: Record<string, { value: number }> } }).material.uniforms;
	const snapshot: AudioSnapshot = {
		bass: 0, mid: 0, treble: 0,
		energy: 0.55,
		rb: 0, rm: 0, rt: 0, re: 0,
		beatPulse: 0, scheduledBeatPulse: 0, beatOnsetFlag: false,
	};
	const ru: RuntimeUniforms = {
		uTime: { value: 7.25 },
		uBass: { value: 0 }, uMid: { value: 0 }, uTreble: { value: 0 },
		uBeat: { value: 0 }, uEnergy: { value: 0 }, uMouseXY: { value: { x: 0, y: 0 } as never },
		uMouseActive: { value: 0 }, uVinylSpin: { value: 0 }, uParticleDim: { value: 0 }, uBurstAmt: { value: 0 },
	};
	const ctx = {
		dt: 0.016, now: 7.25, snapshot, uniforms: ru,
		scene: {} as never, camera: {} as never, pointerParallax: { x: 0, y: 0 }, pointerTarget: { x: 0, y: 0 },
	} as unknown as FrameContext;
	cp.update(ctx);
	expect(uniforms.uTime.value).toBe(7.25);
	expect(uniforms.uEnergy.value).toBe(0.55);
});

test("setIntensity / setTrackScale mutate uniform state holders", async () => {
	const scene = makeFakeScene();
	const cp = await createConnectorParticles({ scene: scene as never, threeFactory: makeFakeThree() });
	const uniforms = (cp.object as unknown as { material: { uniforms: Record<string, { value: number }> } }).material.uniforms;
	cp.setIntensity(0.6);
	expect(uniforms.uIntensity.value).toBe(0.6);
	cp.setTrackScale(1.4);
	expect(uniforms.uTrackScale.value).toBe(1.4);
});

test("reset() rewrites aRand/aT with the given seed", async () => {
	const scene = makeFakeScene();
	const cp = await createConnectorParticles({ scene: scene as never, threeFactory: makeFakeThree() });
	const geo = (cp.object as unknown as {
		geometry: {
			attributes: Record<string, { array: Float32Array; itemSize: number; count: number; needsUpdate: boolean }>;
		};
	}).geometry;
	const aRandBefore = Float32Array.from(geo.attributes.aRand.array);
	cp.reset(123);
	let anyDiff = false;
	for (let i = 0; i < aRandBefore.length; i++) {
		if (aRandBefore[i] !== geo.attributes.aRand.array[i]) { anyDiff = true; break; }
	}
	expect(anyDiff).toBe(true);
	expect(geo.attributes.aRand.needsUpdate).toBe(true);
	expect(geo.attributes.aT.needsUpdate).toBe(true);
});

test("dispose removes Points from scene and disposes geometry/material", async () => {
	const scene = makeFakeScene();
	const cp = await createConnectorParticles({ scene: scene as never, threeFactory: makeFakeThree() });
	const geo = (cp.object as unknown as { geometry: { dispose: () => void; disposed: boolean } }).geometry;
	const mat = (cp.object as unknown as { material: { dispose: () => void; disposed: boolean } }).material;
	cp.dispose();
	expect((scene.removed as unknown[]).length).toBe(1);
	expect(geo.disposed).toBe(true);
	expect(mat.disposed).toBe(true);
	expect(cp.object).toBe(null);
});
