import { expect, test } from "bun:test";
import "../runtime/happy-dom-preload";
import type { ThreeFactory, ThreeModule } from "../runtime/renderer-setup";
import { buildLyricGroup, disposeLyricGroup, updateLyricGroupProgress } from "./lyric-builder";
import { DEFAULT_LYRIC_PALETTE } from "./palette";

function makeFakeThree(): ThreeFactory {
	function Group() {
		return {
			isGroup: true,
			renderOrder: 0,
			children: [] as unknown[],
			userData: {} as Record<string, unknown>,
			position: { x: 0, y: 0, z: 0, set(this: { x: number; y: number; z: number }, x: number, y: number, z: number) { this.x = x; this.y = y; this.z = z; } },
			scale: { x: 1, y: 1, z: 1, setScalar(this: { x: number; y: number; z: number }, s: number) { this.x = s; this.y = s; this.z = s; } },
			add(child: unknown) { (this as { children: unknown[] }).children.push(child); },
			remove(child: unknown) {
				const arr = (this as { children: unknown[] }).children;
				const idx = arr.indexOf(child);
				if (idx >= 0) arr.splice(idx, 1);
			},
		};
	}
	function PlaneGeometry() {
		return { isBufferGeometry: true, isPlaneGeometry: true, disposed: false, dispose() { this.disposed = true; } };
	}
	function BufferGeometry() {
		return {
			isBufferGeometry: true,
			attributes: {} as Record<string, { array: Float32Array; itemSize: number; count: number }>,
			disposed: false,
			setAttribute(name: string, attr: { array: Float32Array; itemSize: number; count: number }) {
				this.attributes[name] = attr;
			},
			dispose() { (this as { disposed: boolean }).disposed = true; },
		};
	}
	function BufferAttribute(arr: Float32Array, itemSize: number) {
		return { array: arr, itemSize, count: arr.length / itemSize, needsUpdate: false };
	}
	function MeshBasicMaterial(params: Record<string, unknown>) {
		return {
			isMaterial: true,
			transparent: params.transparent,
			opacity: params.opacity,
			depthWrite: params.depthWrite,
			depthTest: params.depthTest,
			side: params.side,
			blending: params.blending,
			map: params.map,
			color: params.color,
			disposed: false,
			dispose() { this.disposed = true; },
		};
	}
	function ShaderMaterial(params: Record<string, unknown>) {
		return {
			isMaterial: true,
			isShaderMaterial: true,
			uniforms: params.uniforms,
			vertexShader: params.vertexShader,
			fragmentShader: params.fragmentShader,
			transparent: params.transparent,
			depthWrite: params.depthWrite,
			depthTest: params.depthTest,
			side: params.side,
			blending: params.blending,
			disposed: false,
			dispose() { this.disposed = true; },
		};
	}
	function Mesh(geometry: unknown, material: unknown) {
		return {
			isMesh: true,
			geometry,
			material,
			renderOrder: 0,
			visible: true,
			userData: {} as Record<string, unknown>,
			position: { x: 0, y: 0, z: 0, set(this: { x: number; y: number; z: number }, x: number, y: number, z: number) { this.x = x; this.y = y; this.z = z; } },
			scale: { x: 1, y: 1, z: 1, set(this: { x: number; y: number; z: number }, x: number, y: number, z: number) { this.x = x; this.y = y; this.z = z; } },
		};
	}
	function Points(geometry: unknown, material: unknown) {
		return {
			isPoints: true,
			geometry,
			material,
			renderOrder: 0,
			visible: true,
			frustumCulled: true,
		};
	}
	function Color(r: number, g: number, b: number) {
		return { r, g, b, isColor: true };
	}
	function CanvasTexture(image: HTMLCanvasElement) {
		return {
			image,
			isTexture: true,
			minFilter: 0,
			magFilter: 0,
			generateMipmaps: false,
			anisotropy: 1,
			disposed: false,
			dispose() { this.disposed = true; },
		};
	}
	function Texture() {
		return { isTexture: true, minFilter: 0, magFilter: 0, disposed: false, dispose() { this.disposed = true; } };
	}
	const module = {
		Group,
		PlaneGeometry,
		BufferGeometry,
		BufferAttribute,
		MeshBasicMaterial,
		ShaderMaterial,
		Mesh,
		Points,
		Color,
		CanvasTexture,
		Texture,
		LinearFilter: 1006,
		NearestFilter: 1003,
		DoubleSide: 2,
		AdditiveBlending: 2,
		NormalBlending: 1,
	};
	return (() => module) as unknown as ThreeFactory;
}

function makeFakeDotTexture() {
	return {
		isTexture: true,
		disposed: false,
		dispose() {
			(this as { disposed: boolean }).disposed = true;
		},
	} as never;
}

test("buildLyricGroup builds a 5-child group with sun/glow/readability/textMesh/sparks", async () => {
	const lyric = await buildLyricGroup("hello", DEFAULT_LYRIC_PALETTE, {
		threeFactory: makeFakeThree(),
		lyricGlowParticles: false,
		dotTexture: makeFakeDotTexture(),
		rand: () => 0.35,
	});
	const g = lyric.group as unknown as {
		renderOrder: number;
		children: unknown[];
		position: { x: number; y: number; z: number };
		scale: { x: number; y: number; z: number };
		userData: Record<string, unknown>;
	};
	expect(g.renderOrder).toBe(42);
	expect(g.position.y).toBeCloseTo(0.2, 6);
	expect(g.position.z).toBeCloseTo(1.46, 6);
	expect(g.position.x).toBeGreaterThanOrEqual(-0.04);
	expect(g.position.x).toBeLessThanOrEqual(0.04);
	expect(g.scale.x).toBeCloseTo(0.96, 6);
	expect(g.scale.y).toBeCloseTo(0.96, 6);
	expect(g.scale.z).toBeCloseTo(0.96, 6);
	expect(g.children.length).toBe(5);
	expect(g.userData.state).toBe("in");
	expect(g.userData.age).toBe(0);
	expect(typeof g.userData.floatSeed).toBe("number");
	expect(g.userData.lastLyricProgress).toBe(0);
});

test("buildLyricGroup assigns baseline renderOrders 40/41/42/43/44 across sun/glow/readability/text/sparks", async () => {
	const lyric = await buildLyricGroup("test", DEFAULT_LYRIC_PALETTE, {
		threeFactory: makeFakeThree(),
		dotTexture: makeFakeDotTexture(),
	});
	expect((lyric.sun as unknown as { renderOrder: number }).renderOrder).toBe(40);
	expect((lyric.glow as unknown as { renderOrder: number }).renderOrder).toBe(41);
	expect((lyric.readability as unknown as { renderOrder: number }).renderOrder).toBe(42);
	expect((lyric.textMesh as unknown as { renderOrder: number }).renderOrder).toBe(43);
	expect((lyric.sparks as unknown as { renderOrder: number }).renderOrder).toBe(44);
});

test("buildLyricGroup uses facing-aware shader materials for glow readability and sun", async () => {
	const lyric = await buildLyricGroup("test", DEFAULT_LYRIC_PALETTE, {
		threeFactory: makeFakeThree(),
		dotTexture: makeFakeDotTexture(),
	});
	expect((lyric.glowMat as unknown as { fragmentShader: string }).fragmentShader).toContain("gl_FrontFacing");
	expect((lyric.readabilityMat as unknown as { fragmentShader: string }).fragmentShader).toContain("gl_FrontFacing");
	expect((lyric.sunMat as unknown as { fragmentShader: string }).fragmentShader).toContain("gl_FrontFacing");
});

test("buildLyricGroup sun position/scale match baseline 8837-8838", async () => {
	const lyric = await buildLyricGroup("test", DEFAULT_LYRIC_PALETTE, {
		threeFactory: makeFakeThree(),
		dotTexture: makeFakeDotTexture(),
	});
	const sun = lyric.sun as unknown as {
		position: { x: number; y: number; z: number };
		scale: { x: number; y: number; z: number };
	};
	expect(sun.position.x).toBeCloseTo(0, 6);
	expect(sun.position.y).toBeCloseTo(0.02, 6);
	expect(sun.position.z).toBeCloseTo(-0.03, 6);
	expect(sun.scale.x).toBeCloseTo(0.78, 6);
	expect(sun.scale.y).toBeCloseTo(0.58, 6);
	expect(sun.scale.z).toBe(1);
});

test("buildLyricGroup glow scale is (1, 1.06, 1) per baseline 8853", async () => {
	const lyric = await buildLyricGroup("test", DEFAULT_LYRIC_PALETTE, {
		threeFactory: makeFakeThree(),
		dotTexture: makeFakeDotTexture(),
	});
	const glow = lyric.glow as unknown as { scale: { x: number; y: number; z: number } };
	expect(glow.scale.x).toBeCloseTo(1, 6);
	expect(glow.scale.y).toBeCloseTo(1.06, 6);
	expect(glow.scale.z).toBeCloseTo(1, 6);
});

test("buildLyricGroup sparks geometry has position(3) and seed(1) attributes sized 132", async () => {
	const lyric = await buildLyricGroup("test", DEFAULT_LYRIC_PALETTE, {
		threeFactory: makeFakeThree(),
		dotTexture: makeFakeDotTexture(),
		rand: () => 0.5,
	});
	const geo = (lyric.sparks as unknown as { geometry: { attributes: Record<string, { itemSize: number; count: number; array: Float32Array }> } }).geometry;
	expect(geo.attributes.position.itemSize).toBe(3);
	expect(geo.attributes.seed.itemSize).toBe(1);
	expect(geo.attributes.position.count).toBe(132);
	expect(geo.attributes.seed.count).toBe(132);
	expect(geo.attributes.position.array.length).toBe(132 * 3);
	expect(geo.attributes.seed.array.length).toBe(132);
});

test("buildLyricGroup sparks.visible defaults to false; opts.lyricGlowParticles=true flips it on", async () => {
	const off = await buildLyricGroup("test", DEFAULT_LYRIC_PALETTE, {
		threeFactory: makeFakeThree(),
		dotTexture: makeFakeDotTexture(),
	});
	expect((off.sparks as unknown as { visible: boolean }).visible).toBe(false);
	const on = await buildLyricGroup("test", DEFAULT_LYRIC_PALETTE, {
		threeFactory: makeFakeThree(),
		lyricGlowParticles: true,
		dotTexture: makeFakeDotTexture(),
	});
	expect((on.sparks as unknown as { visible: boolean }).visible).toBe(true);
});

test("buildLyricGroup populates userData.lyric with all 16 baseline fields", async () => {
	const lyric = await buildLyricGroup("test", DEFAULT_LYRIC_PALETTE, {
		threeFactory: makeFakeThree(),
		dotTexture: makeFakeDotTexture(),
	});
	const data = (lyric.group as unknown as { userData: { lyric: Record<string, unknown> } }).userData.lyric;
	const expectedKeys = [
		"mask", "textMesh", "readability", "glow", "sparks", "sun",
		"textMat", "readabilityMat", "glowMat", "sparkMat", "sunMat",
		"basePositions", "textWorldW", "textWorldH", "worldW", "worldH",
	];
	for (const k of expectedKeys) {
		expect(Object.prototype.hasOwnProperty.call(data, k)).toBe(true);
	}
	expect(Object.keys(data).length).toBe(expectedKeys.length);
	expect(data.basePositions).toBeInstanceOf(Float32Array);
	expect((data.basePositions as Float32Array).length).toBe(132 * 3);
	expect(typeof data.textWorldW).toBe("number");
	expect(typeof data.textWorldH).toBe("number");
	expect(data.worldW).toBeCloseTo(6.1, 6);
	expect(typeof data.worldH).toBe("number");
});

test("buildLyricGroup sparks uniform uMap points to provided dotTexture; uSize=0.052", async () => {
	const dot = makeFakeDotTexture();
	const lyric = await buildLyricGroup("test", DEFAULT_LYRIC_PALETTE, {
		threeFactory: makeFakeThree(),
		dotTexture: dot,
		pixelScale: 1.35,
	});
	const u = (lyric.sparkMat as unknown as { uniforms: Record<string, { value: unknown }> }).uniforms;
	expect(u.uMap.value).toBe(dot);
	expect(u.uSize.value).toBeCloseTo(0.052, 6);
	expect(u.uOpacity.value).toBe(0);
	expect(u.uPixel.value).toBeCloseTo(1.35, 6);
});

test("buildLyricGroup passes baseline max anisotropy to mask texture", async () => {
	const lyric = await buildLyricGroup("test", DEFAULT_LYRIC_PALETTE, {
		threeFactory: makeFakeThree(),
		dotTexture: makeFakeDotTexture(),
		maxAnisotropy: 7,
	});
	expect((lyric.mask.texture as unknown as { anisotropy: number }).anisotropy).toBe(7);
});

test("updateLyricGroupProgress writes uProgress and lastLyricProgress (clamped 0..1)", async () => {
	const lyric = await buildLyricGroup("test", DEFAULT_LYRIC_PALETTE, {
		threeFactory: makeFakeThree(),
		dotTexture: makeFakeDotTexture(),
	});
	updateLyricGroupProgress(lyric, 0.5);
	const u = (lyric.textMat as unknown as { uniforms: { uProgress: { value: number } } }).uniforms;
	expect(u.uProgress.value).toBeCloseTo(0.5, 6);
	expect((lyric.group as unknown as { userData: Record<string, unknown> }).userData.lastLyricProgress).toBeCloseTo(0.5, 6);
	updateLyricGroupProgress(lyric, 5);
	expect(u.uProgress.value).toBe(1);
	updateLyricGroupProgress(lyric, -2);
	expect(u.uProgress.value).toBe(0);
});

test("disposeLyricGroup-removes children + disposes geometries/materials/per-group textures", async () => {
	const lyric = await buildLyricGroup("test", DEFAULT_LYRIC_PALETTE, {
		threeFactory: makeFakeThree(),
		dotTexture: makeFakeDotTexture(),
	});
	const sunMesh = lyric.sun as unknown as { geometry: { disposed: boolean }; material: { disposed: boolean; map: { disposed: boolean } | null } };
	const glowMesh = lyric.glow as unknown as { geometry: { disposed: boolean }; material: { disposed: boolean; map: { disposed: boolean } | null } };
	const readabilityMesh = lyric.readability as unknown as { geometry: { disposed: boolean }; material: { disposed: boolean; map: { disposed: boolean } | null } };
	const textMesh = lyric.textMesh as unknown as { geometry: { disposed: boolean }; material: { disposed: boolean } };
	const sparks = lyric.sparks as unknown as { geometry: { disposed: boolean }; material: { disposed: boolean } };
	const maskTexture = lyric.mask.texture as unknown as { disposed: boolean } | null;
	disposeLyricGroup(lyric);
	expect(sunMesh.geometry.disposed).toBe(true);
	expect(sunMesh.material.disposed).toBe(true);
	expect(glowMesh.geometry.disposed).toBe(true);
	expect(glowMesh.material.disposed).toBe(true);
	expect(readabilityMesh.geometry.disposed).toBe(true);
	expect(readabilityMesh.material.disposed).toBe(true);
	expect(textMesh.geometry.disposed).toBe(true);
	expect(textMesh.material.disposed).toBe(true);
	expect(sparks.geometry.disposed).toBe(true);
	expect(sparks.material.disposed).toBe(true);
	if (maskTexture) expect(maskTexture.disposed).toBe(true);
	if (sunMesh.material.map) expect(sunMesh.material.map.disposed).toBe(true);
	if (glowMesh.material.map) expect(glowMesh.material.map.disposed).toBe(true);
	if (readabilityMesh.material.map) expect(readabilityMesh.material.map.disposed).toBe(true);
	expect((lyric.group as unknown as { children: unknown[] }).children.length).toBe(0);
});
