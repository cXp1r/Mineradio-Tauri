import { expect, test } from "bun:test";
import "../runtime/happy-dom-preload";
import type { ThreeFactory } from "../runtime/renderer-setup";
import { createLyricParticles } from "./lyric-particles";
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

test("createLyricParticles builds geometry with position(3)*132 / aRand(1)*132 / aOffset(1)*132", async () => {
	const scene = makeFakeScene();
	const lp = await createLyricParticles({ scene: scene as never, threeFactory: makeFakeThree() });
	const geo = lp.object as unknown as {
		geometry: {
			attributes: Record<string, { array: Float32Array; itemSize: number; count: number }>;
		};
	};
	const attrs = geo.geometry.attributes;
	expect(attrs.position.itemSize).toBe(3);
	expect(attrs.position.count).toBe(132);
	expect(attrs.position.array.length).toBe(3 * 132);
	expect(attrs.aRand.itemSize).toBe(1);
	expect(attrs.aRand.count).toBe(132);
	expect(attrs.aOffset.itemSize).toBe(1);
	expect(attrs.aOffset.count).toBe(132);
});

test("createLyricParticles adds Points to scene; frustumCulled=false; material is additive/transparent/depthWrite=false", async () => {
	const scene = makeFakeScene();
	const lp = await createLyricParticles({ scene: scene as never, threeFactory: makeFakeThree() });
	expect((scene.tracked as unknown[]).length).toBe(1);
	expect(scene.tracked[0]).toBe(lp.object);
	const obj = lp.object as unknown as { frustumCulled: boolean };
	expect(obj.frustumCulled).toBe(false);
	const mat = (lp.object as unknown as { material: Record<string, unknown> }).material;
	expect(mat.transparent).toBe(true);
	expect(mat.depthWrite).toBe(false);
	expect(mat.blending).toBe(2);
});

test("uniforms match baseline lyric-particle state holder names (uTime/uBass/uEnergy/uBurstAmt/uPixel/uLyricLineTransition/uGlowStrength=0.28)", async () => {
	const scene = makeFakeScene();
	const lp = await createLyricParticles({ scene: scene as never, threeFactory: makeFakeThree() });
	const mat = lp.object as unknown as { material: { uniforms: Record<string, { value: unknown }> } };
	const uniforms = mat.material.uniforms;
	const expected = ["uTime", "uBass", "uEnergy", "uBurstAmt", "uPixel", "uLyricLineTransition", "uGlowStrength"];
	for (const name of expected) {
		expect(Object.prototype.hasOwnProperty.call(uniforms, name)).toBe(true);
	}
	expect(Object.keys(uniforms).length).toBe(expected.length);
	expect(uniforms.uGlowStrength.value).toBe(0.28);
	expect(uniforms.uPixel.value).toBe(1);
	expect(uniforms.uLyricLineTransition.value).toBe(0);
});

test("update(ctx) flows snapshot.bass/energy/beatPulse into uBass/uEnergy/uBurstAmt and reads uTime from ctx.uniforms.uTime.value", async () => {
	const scene = makeFakeScene();
	const lp = await createLyricParticles({ scene: scene as never, threeFactory: makeFakeThree() });
	const uniforms = (lp.object as unknown as { material: { uniforms: Record<string, { value: number }> } }).material.uniforms;
	const snapshot: AudioSnapshot = {
		bass: 0.31,
		mid: 0,
		treble: 0,
		energy: 0.42,
		rb: 0, rm: 0, rt: 0, re: 0,
		beatPulse: 0.77,
		scheduledBeatPulse: 0,
		beatOnsetFlag: false,
	};
	const ru: RuntimeUniforms = {
		uTime: { value: 12.5 },
		uBass: { value: 0 }, uMid: { value: 0 }, uTreble: { value: 0 },
		uBeat: { value: 0 }, uEnergy: { value: 0 }, uMouseXY: { value: { x: 0, y: 0 } as never },
		uMouseActive: { value: 0 }, uVinylSpin: { value: 0 }, uParticleDim: { value: 0 }, uBurstAmt: { value: 0 },
	};
	const ctx = {
		dt: 0.016, now: 12.5, snapshot, uniforms: ru,
		scene: {} as never, camera: {} as never, pointerParallax: { x: 0, y: 0 }, pointerTarget: { x: 0, y: 0 },
	} as unknown as FrameContext;
	lp.update(ctx);
	expect(uniforms.uTime.value).toBe(12.5);
	expect(uniforms.uBass.value).toBe(0.31);
	expect(uniforms.uEnergy.value).toBe(0.42);
	expect(uniforms.uBurstAmt.value).toBe(0.77);
});

test("setGlowStrength / setBurst mutate uniform state holders", async () => {
	const scene = makeFakeScene();
	const lp = await createLyricParticles({ scene: scene as never, threeFactory: makeFakeThree() });
	const uniforms = (lp.object as unknown as { material: { uniforms: Record<string, { value: number }> } }).material.uniforms;
	lp.setGlowStrength(0.5);
	expect(uniforms.uGlowStrength.value).toBe(0.5);
	lp.setBurst(0.9);
	expect(uniforms.uBurstAmt.value).toBe(0.9);
});

test("reset() rewrites aRand/aOffset with the given seed; updates attribute needsUpdate flag", async () => {
	const scene = makeFakeScene();
	const lp = await createLyricParticles({ scene: scene as never, threeFactory: makeFakeThree() });
	const geo = (lp.object as unknown as {
		geometry: {
			attributes: Record<string, { array: Float32Array; itemSize: number; count: number; needsUpdate: boolean }>;
		};
	}).geometry;
	const aRandBefore = Float32Array.from(geo.attributes.aRand.array);
	lp.reset(42);
	const aRandAfter = geo.attributes.aRand.array;
	expect(geo.attributes.aRand.needsUpdate).toBe(true);
	expect(geo.attributes.aOffset.needsUpdate).toBe(true);
	let anyDiff = false;
	for (let i = 0; i < aRandBefore.length; i++) {
		if (aRandBefore[i] !== aRandAfter[i]) { anyDiff = true; break; }
	}
	expect(anyDiff).toBe(true);
});

test("dispose removes Points from scene and disposes geometry/material", async () => {
	const scene = makeFakeScene();
	const lp = await createLyricParticles({ scene: scene as never, threeFactory: makeFakeThree() });
	const geo = (lp.object as unknown as { geometry: { dispose: () => void; disposed: boolean } }).geometry;
	const mat = (lp.object as unknown as { material: { dispose: () => void; disposed: boolean } }).material;
	lp.dispose();
	expect((scene.removed as unknown[]).length).toBe(1);
	expect(geo.disposed).toBe(true);
	expect(mat.disposed).toBe(true);
	expect(lp.object).toBe(null);
});
