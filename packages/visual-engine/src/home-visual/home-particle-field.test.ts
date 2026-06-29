import { expect, test } from "bun:test";
import "../runtime/happy-dom-preload";
import type { ThreeFactory } from "../runtime/renderer-setup";
import { createHomeParticleField, coverParticleGridForResolution, normalizeCoverResolution } from "./home-particle-field";
import { cloneFxState } from "./fx-defaults";

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
	const Texture = function () { return { minFilter: 0, magFilter: 0, disposed: false, dispose() { this.disposed = true; } }; } as never;
	const CanvasTexture = function (image: unknown) { return { image, minFilter: 0, magFilter: 0, disposed: false, dispose() { this.disposed = true; } }; } as never;
	const Color = function (h: string) {
		return {
			hex: h,
			set(this: { hex: string }, next: string) { this.hex = next; return this; },
		};
	} as never;
	const Vector2 = function (x: number, y: number) {
		return { x, y, set(this: { x: number; y: number }, nx: number, ny: number) { this.x = nx; this.y = ny; } };
	} as never;
	const DataTexture = function (data: Float32Array, width: number, height: number) {
		return { image: { data, width, height }, magFilter: 0, minFilter: 0, disposed: false, dispose() { this.disposed = true; } };
	} as never;
	const module = {
		Points,
		ShaderMaterial,
		BufferAttribute,
		BufferGeometry,
		Texture,
		CanvasTexture,
		DataTexture,
		Color,
		Vector2,
		NormalBlending: 1,
		AdditiveBlending: 2,
		LinearFilter: 1006,
		NearestFilter: 1003,
		ClampToEdgeWrapping: 1001,
		RGBAFormat: 1023,
		FloatType: 1015,
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

test("coverParticleGridForResolution(normalize(1.55)) = 183 (odd grid, baseline 118*1.55 clamped)", () => {
	expect(normalizeCoverResolution(1.55)).toBe(1.55);
	expect(coverParticleGridForResolution(1.55)).toBe(183);
});

test("createHomeParticleField builds geometry with position(3)/aUv(2)/aRand(1) attributes sized grid*grid", async () => {
	const scene = makeFakeScene();
	const field = await createHomeParticleField(scene as never, { threeFactory: makeFakeThree(), coverResolution: 1.55 });
	const geo = field.geometry as unknown as {
		attributes: Record<string, { array: Float32Array; itemSize: number; count: number }>;
		disposed: boolean;
	};
	expect(geo.attributes.position.itemSize).toBe(3);
	expect(geo.attributes.aUv.itemSize).toBe(2);
	expect(geo.attributes.aRand.itemSize).toBe(1);
	expect(geo.attributes.position.count).toBe(183 * 183);
	expect(geo.attributes.aUv.count).toBe(183 * 183);
	expect(geo.attributes.aRand.count).toBe(183 * 183);
	expect(geo.attributes.position.array.length).toBe(183 * 183 * 3);
	expect(geo.attributes.aUv.array.length).toBe(183 * 183 * 2);
	expect(geo.attributes.aRand.array.length).toBe(183 * 183);
});

test("createHomeParticleField adds bloomPoints(renderOrder=0) then points(renderOrder=1) to scene; frustumCulled=false for both", async () => {
	const scene = makeFakeScene();
	const field = await createHomeParticleField(scene as never, { threeFactory: makeFakeThree() });
	expect((scene.tracked as unknown[]).length).toBe(2);
	expect(scene.tracked[0]).toBe(field.bloomPoints);
	expect(scene.tracked[1]).toBe(field.points);
	expect((field.bloomPoints as { renderOrder: number }).renderOrder).toBe(0);
	expect((field.points as { renderOrder: number }).renderOrder).toBe(1);
	expect((field.bloomPoints as { frustumCulled: boolean }).frustumCulled).toBe(false);
	expect((field.points as { frustumCulled: boolean }).frustumCulled).toBe(false);
});

test("material setup matches baseline: main transparent/depthWrite=false/NormalBlending; bloom transparent/depthWrite=false/depthTest=false/AdditiveBlending; shared uniforms record with all baseline uniform names", async () => {
	const scene = makeFakeScene();
	const field = await createHomeParticleField(scene as never, { threeFactory: makeFakeThree() });
	const main = field.material as unknown as Record<string, unknown>;
	const bloom = field.bloomMaterial as unknown as Record<string, unknown>;
	expect(main.transparent).toBe(true);
	expect(main.depthWrite).toBe(false);
	expect(main.blending).toBe(1);
	expect(bloom.transparent).toBe(true);
	expect(bloom.depthWrite).toBe(false);
	expect(bloom.depthTest).toBe(false);
	expect(bloom.blending).toBe(2);
	const uniforms = field.materialUniforms;
	const baselineUniformNames = [
		"uTime", "uBass", "uMid", "uTreble", "uBeat", "uEnergy", "uBurstAmt", "uVinylSpin",
		"uPreset", "uIntensity", "uDepth", "uPointScale", "uSpeed", "uTwist",
		"uColorBoost", "uScatter", "uCoverRes", "uBgFade", "uBloomStrength", "uBloomSize",
		"uTintColor", "uTintStrength", "uCoverTex", "uPrevCoverTex", "uColorMixT",
		"uEdgeTex", "uRippleTex", "uRippleCount", "uDotTex",
		"uHasCover", "uHasDepth", "uEdgeEnabled", "uAiBoost",
		"uMouseXY", "uMouseActive", "uHandXY", "uHandActive", "uGestureGrip",
		"uPixel", "uAlpha", "uParticleDim", "uFloatAlpha", "uLoading",
	];
	for (const name of baselineUniformNames) {
		expect(Object.prototype.hasOwnProperty.call(uniforms, name)).toBe(true);
	}
	expect(Object.keys(uniforms).length).toBe(baselineUniformNames.length);
});

test("ripple uniform is the baseline 1x12 RGBA Float DataTexture with nearest filtering", async () => {
	const scene = makeFakeScene();
	const field = await createHomeParticleField(scene as never, { threeFactory: makeFakeThree() });
	const ripple = field.materialUniforms.uRippleTex.value as {
		image: { data: Float32Array; width: number; height: number };
		magFilter: number;
		minFilter: number;
	};
	expect(ripple.image.data).toBeInstanceOf(Float32Array);
	expect(ripple.image.data.length).toBe(12 * 4);
	expect(ripple.image.width).toBe(1);
	expect(ripple.image.height).toBe(12);
	expect(ripple.magFilter).toBe(1003);
	expect(ripple.minFilter).toBe(1003);
});

test("bloomMaterial vertexShader is the main vs with uBloomSize uniform decl + gl_PointSize multiplied by uBloomSize", async () => {
	const scene = makeFakeScene();
	const field = await createHomeParticleField(scene as never, { threeFactory: makeFakeThree() });
	const bloomVs = (field.bloomMaterial as unknown as { vertexShader: string }).vertexShader;
	expect(bloomVs).toContain("uBloomSize");
	expect(bloomVs).toContain("gl_PointSize = sz * uPixel * uPointScale * uBloomSize;");
});

test("dispose removes both Points from scene, calls geometry/material/bloomMaterial.dispose, disposes shader textures", async () => {
	const scene = makeFakeScene();
	const field = await createHomeParticleField(scene as never, { threeFactory: makeFakeThree() });
	const geo = field.geometry as unknown as { dispose: () => void; disposed: boolean };
	const mat = field.material as unknown as { dispose: () => void; disposed: boolean };
	const bloomMat = field.bloomMaterial as unknown as { dispose: () => void; disposed: boolean };
	field.dispose();
	expect((scene.removed as unknown[]).length).toBe(2);
	expect(geo.disposed).toBe(true);
	expect(mat.disposed).toBe(true);
	expect(bloomMat.disposed).toBe(true);
});

test("applyFxState maps baseline visual tint mode/color into shader uniforms", async () => {
	const scene = makeFakeScene();
	const field = await createHomeParticleField(scene as never, { threeFactory: makeFakeThree() });
	const fx = cloneFxState();
	fx.visualTintMode = "custom";
	fx.visualTintColor = "#223344";

	field.applyFxState(fx);

	expect((field.materialUniforms.uTintColor.value as { hex: string }).hex).toBe("#223344");
	expect(field.materialUniforms.uTintStrength.value).toBe(0.42);

	fx.visualTintMode = "auto";
	field.applyFxState(fx);
	expect(field.materialUniforms.uTintStrength.value).toBe(0);
});
