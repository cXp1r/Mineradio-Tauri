import { expect, test } from "bun:test";
import type { ThreeFactory } from "../runtime/renderer-setup";
import { BACK_COVER_COUNT, createBackCoverLayer } from "./back-cover-layer";

function makeFakeThree(): ThreeFactory {
	const Points = function (geo: unknown, mat: unknown) {
		return {
			isPoints: true,
			geometry: geo,
			material: mat,
			frustumCulled: true,
			renderOrder: 0,
			visible: true,
			disposed: false,
		};
	} as never;
	const ShaderMaterial = function (params: Record<string, unknown>) {
		return {
			isShaderMaterial: true,
			uniforms: params.uniforms,
			vertexShader: params.vertexShader,
			fragmentShader: params.fragmentShader,
			transparent: params.transparent,
			depthWrite: params.depthWrite,
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
			attributes: {} as Record<string, unknown>,
			disposed: false,
			setAttribute: function (name: string, attr: unknown) { (this as { attributes: Record<string, unknown> }).attributes[name] = attr; },
			dispose() { this.disposed = true; },
		};
	} as never;
	const module = {
		Points,
		ShaderMaterial,
		BufferAttribute,
		BufferGeometry,
		NormalBlending: 1,
	};
	return (() => module) as unknown as ThreeFactory;
}

function makeScene() {
	const added: unknown[] = [];
	const removed: unknown[] = [];
	return {
		add(o: unknown) { added.push(o); },
		remove(o: unknown) { removed.push(o); },
		added,
		removed,
	};
}

function makeUniforms() {
	return {
		uTime: { value: 0 },
		uBass: { value: 0 },
		uMid: { value: 0 },
		uTreble: { value: 0 },
		uBeat: { value: 0 },
		uEnergy: { value: 0 },
		uPixel: { value: 1 },
		uDotTex: { value: { label: "dot" } },
		uAlpha: { value: 0.96 },
	};
}

function makeCanvas(width: number, height: number, data: Uint8ClampedArray) {
	return {
		width,
		height,
		getContext(type: string) {
			expect(type).toBe("2d");
			return {
				getImageData() {
					return { data };
				},
			};
		},
	};
}

function rgba(width: number, height: number, fill: (x: number, y: number) => [number, number, number, number]): Uint8ClampedArray {
	const data = new Uint8ClampedArray(width * height * 4);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const [r, g, b, a] = fill(x, y);
			const off = (y * width + x) * 4;
			data[off] = r;
			data[off + 1] = g;
			data[off + 2] = b;
			data[off + 3] = a;
		}
	}
	return data;
}

test("createBackCoverLayer builds the baseline 3000 point layer behind the cover plane", async () => {
	const scene = makeScene();
	const layer = await createBackCoverLayer({
		scene: scene as never,
		threeFactory: makeFakeThree(),
		uniforms: makeUniforms() as never,
		random: () => 0.25,
	});
	const points = layer.getPoints() as unknown as { frustumCulled: boolean; geometry: { attributes: Record<string, { array: Float32Array; itemSize: number; count: number }> }; material: Record<string, unknown> };
	expect(scene.added).toEqual([points]);
	expect(points.frustumCulled).toBe(false);
	expect(points.geometry.attributes.position.count).toBe(BACK_COVER_COUNT);
	expect(points.geometry.attributes.aColor.count).toBe(BACK_COVER_COUNT);
	expect(points.geometry.attributes.aRand.count).toBe(BACK_COVER_COUNT);
	expect(points.geometry.attributes.aUv.count).toBe(BACK_COVER_COUNT);
	expect(points.geometry.attributes.position.array[0]).toBeCloseTo(-1.2, 6);
	expect(points.geometry.attributes.position.array[1]).toBeCloseTo(-1.2, 6);
	expect(points.geometry.attributes.position.array[2]).toBeCloseTo(-1.6, 6);
	expect(points.geometry.attributes.aUv.array[0]).toBeCloseTo(0.75, 6);
	expect(points.geometry.attributes.aUv.array[1]).toBeCloseTo(0.25, 6);
	expect(points.geometry.attributes.aColor.array[0]).toBeCloseTo(0.7, 6);
	expect(points.geometry.attributes.aColor.array[1]).toBeCloseTo(0.6, 6);
	expect(points.geometry.attributes.aColor.array[2]).toBeCloseTo(0.8, 6);
});

test("createBackCoverLayer shares audio band and beat uniforms for audio-following rhythm", async () => {
	const scene = makeScene();
	const uniforms = makeUniforms();
	const layer = await createBackCoverLayer({
		scene: scene as never,
		threeFactory: makeFakeThree(),
		uniforms: uniforms as never,
	});
	const material = (layer.getPoints() as unknown as { material: { uniforms: Record<string, unknown>; vertexShader: string } }).material;
	expect(material.uniforms.uBass).toBe(uniforms.uBass);
	expect(material.uniforms.uMid).toBe(uniforms.uMid);
	expect(material.uniforms.uTreble).toBe(uniforms.uTreble);
	expect(material.uniforms.uBeat).toBe(uniforms.uBeat);
	expect(material.uniforms.uEnergy).toBe(uniforms.uEnergy);
	expect(material.vertexShader).toContain("uBeat");
	expect(material.vertexShader).toContain("uEnergy");
});

test("refreshColorsFromCover mirrors baseline UV sampling, scales by 0.85, and marks aColor dirty", async () => {
	const scene = makeScene();
	const layer = await createBackCoverLayer({
		scene: scene as never,
		threeFactory: makeFakeThree(),
		uniforms: makeUniforms() as never,
		random: () => 0,
	});
	const data = rgba(4, 4, (x, y) => [x * 40, y * 50, 200, 255]);
	expect(layer.refreshColorsFromCover(makeCanvas(4, 4, data) as never)).toBe(true);
	const color = layer.getColorArray();
	const attr = (layer.getPoints() as { geometry: { attributes: Record<string, { needsUpdate: boolean }> } }).geometry.attributes.aColor;
	expect(color[0]).toBeCloseTo(120 / 255 * 0.85, 6);
	expect(color[1]).toBe(0);
	expect(color[2]).toBeCloseTo(200 / 255 * 0.85, 6);
	expect(attr.needsUpdate).toBe(true);
});

test("dispose removes the layer and disposes geometry/material once", async () => {
	const scene = makeScene();
	const layer = await createBackCoverLayer({
		scene: scene as never,
		threeFactory: makeFakeThree(),
		uniforms: makeUniforms() as never,
	});
	const points = layer.getPoints() as unknown as { geometry: { disposed: boolean }; material: { disposed: boolean } };
	layer.dispose();
	layer.dispose();
	expect(scene.removed).toEqual([points]);
	expect(points.geometry.disposed).toBe(true);
	expect(points.material.disposed).toBe(true);
});
