import { expect, test } from "bun:test";
import "../runtime/happy-dom-preload";
import type { ThreeFactory, ThreeModule } from "../runtime/renderer-setup";
import {
	buildLyricGroup,
	disposeLyricGroup,
	updateLyricGroupProgress,
	type LyricGroup,
} from "./lyric-builder";
import { DEFAULT_LYRIC_PALETTE } from "./palette";
import { resetLyricSunBloomCache } from "./lyric-sun-bloom";

interface FakeThreeOptions {
	readonly failShaderMaterial?: boolean;
	readonly onCanvasTexture?: (texture: { disposed: boolean; image: HTMLCanvasElement }) => void;
	readonly onPlaneGeometry?: (geometry: { disposed: boolean }) => void;
}

function makeFakeThree(options: FakeThreeOptions = {}): ThreeFactory {
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
		const geometry = { isBufferGeometry: true, isPlaneGeometry: true, disposed: false, dispose() { this.disposed = true; } };
		options.onPlaneGeometry?.(geometry);
		return geometry;
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
		if (options.failShaderMaterial) throw new Error("shader construction failed");
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
		const texture = {
			image,
			isTexture: true,
			minFilter: 0,
			magFilter: 0,
			generateMipmaps: false,
			anisotropy: 1,
			disposed: false,
			dispose() { this.disposed = true; },
		};
		options.onCanvasTexture?.(texture);
		return texture;
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

test("buildLyricGroup gates progress and highlights to the structured active row", async () => {
	const lyric = await buildLyricGroup("fallback", DEFAULT_LYRIC_PALETTE, {
		threeFactory: makeFakeThree(),
		dotTexture: makeFakeDotTexture(),
		maskOptions: {
			structuredRows: [
				{ key: "previous", text: "上一句", alpha: 0.48, scale: 0.82, translationLine: false, active: false, offset: -1.5 },
				{ key: "active", text: "当前正文", alpha: 1, scale: 1, translationLine: false, active: true, offset: 0 },
				{ key: "translation", text: "Current line", alpha: 0.72, scale: 0.7, translationLine: true, active: false, offset: 1.3 },
			],
		},
	});
	const material = lyric.textMat as unknown as {
		fragmentShader: string;
		uniforms: Record<string, { value: number }>;
	};

	expect(lyric.mask.activeYMin).toBeGreaterThan(0);
	expect(lyric.mask.activeYMax).toBeLessThan(1);
	expect(material.uniforms.uActiveYMin?.value).toBeCloseTo(lyric.mask.activeYMin ?? -1, 6);
	expect(material.uniforms.uActiveYMax?.value).toBeCloseTo(lyric.mask.activeYMax ?? -1, 6);
	expect(material.fragmentShader).toContain("float activeRowGate = step(uActiveYMin, rasterY) * step(rasterY, uActiveYMax);");
	expect(material.fragmentShader).toContain("float activeMix = clamp(uActiveMix, 0.0, 1.0) * activeRowGate;");
});

test("disposeLyricGroup removes children, releases owned textures and preserves borrowed textures", async () => {
	const dot = makeFakeDotTexture();
	const lyric = await buildLyricGroup("test", DEFAULT_LYRIC_PALETTE, {
		threeFactory: makeFakeThree(),
		dotTexture: dot,
	});
	const sunMesh = lyric.sun as unknown as { geometry: { disposed: boolean }; material: { disposed: boolean } };
	const glowMesh = lyric.glow as unknown as { geometry: { disposed: boolean }; material: { disposed: boolean } };
	const readabilityMesh = lyric.readability as unknown as { geometry: { disposed: boolean }; material: { disposed: boolean } };
	const textMesh = lyric.textMesh as unknown as { geometry: { disposed: boolean }; material: { disposed: boolean } };
	const sparks = lyric.sparks as unknown as { geometry: { disposed: boolean }; material: { disposed: boolean } };
	const maskTexture = lyric.mask.texture as unknown as { disposed: boolean } | null;
	const sunTexture = (lyric.sunMat as unknown as { uniforms: { uMap: { value: { disposed: boolean } | null } } }).uniforms.uMap.value;
	const glowTexture = (lyric.glowMat as unknown as { uniforms: { uMap: { value: { disposed: boolean } | null } } }).uniforms.uMap.value;
	const readabilityTexture = (lyric.readabilityMat as unknown as { uniforms: { uMap: { value: { disposed: boolean } | null } } }).uniforms.uMap.value;
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
	if (sunTexture) expect(sunTexture.disposed).toBe(false);
	if (glowTexture) expect(glowTexture.disposed).toBe(true);
	if (readabilityTexture) expect(readabilityTexture.disposed).toBe(true);
	expect((dot as unknown as { disposed: boolean }).disposed).toBe(false);
	expect((lyric.group as unknown as { children: unknown[] }).children.length).toBe(0);
});

test("shared sun bloom remains live until its cache owner resets it", async () => {
	resetLyricSunBloomCache();
	const threeFactory = makeFakeThree();
	const first = await buildLyricGroup("first", DEFAULT_LYRIC_PALETTE, {
		threeFactory,
		dotTexture: makeFakeDotTexture(),
	});
	const second = await buildLyricGroup("second", DEFAULT_LYRIC_PALETTE, {
		threeFactory,
		dotTexture: makeFakeDotTexture(),
	});
	const firstSun = (first.sunMat as unknown as { uniforms: { uMap: { value: { disposed: boolean } } } }).uniforms.uMap.value;
	const secondSun = (second.sunMat as unknown as { uniforms: { uMap: { value: unknown } } }).uniforms.uMap.value;
	expect(secondSun).toBe(firstSun);
	disposeLyricGroup(first);
	expect(firstSun.disposed).toBe(false);
	disposeLyricGroup(second);
	expect(firstSun.disposed).toBe(false);
	resetLyricSunBloomCache();
	expect(firstSun.disposed).toBe(true);
});

test("an internally-created dot texture is owned by its lyric group", async () => {
	const lyric = await buildLyricGroup("owned dot", DEFAULT_LYRIC_PALETTE, {
		threeFactory: makeFakeThree(),
	});
	const dot = (lyric.sparkMat as unknown as { uniforms: { uMap: { value: { disposed: boolean } } } }).uniforms.uMap.value;
	disposeLyricGroup(lyric);
	expect(dot.disposed).toBe(true);
});

test("resource admission denial creates no Canvas, Texture, or Geometry", async () => {
	let canvasCreations = 0;
	let textureCreations = 0;
	let geometryCreations = 0;
	let factoryCalls = 0;
	const originalCreateElement = document.createElement.bind(document);
	Object.defineProperty(document, "createElement", {
		configurable: true,
		value(tagName: string, options?: ElementCreationOptions) {
			if (tagName.toLowerCase() === "canvas") canvasCreations += 1;
			return originalCreateElement(tagName, options);
		},
	});
	let buildError: unknown = null;
	try {
		await buildLyricGroup("denied", DEFAULT_LYRIC_PALETTE, {
			threeFactory: async () => {
				factoryCalls += 1;
				return await makeFakeThree({
					onCanvasTexture: () => { textureCreations += 1; },
					onPlaneGeometry: () => { geometryCreations += 1; },
				})();
			},
			reserveResources: () => null,
		});
	} catch (error) {
		buildError = error;
	} finally {
		Object.defineProperty(document, "createElement", {
			configurable: true,
			value: originalCreateElement,
		});
	}

	expect(buildError).toBeInstanceOf(Error);
	expect(factoryCalls).toBe(0);
	expect(canvasCreations).toBe(0);
	expect(textureCreations).toBe(0);
	expect(geometryCreations).toBe(0);
});

test("a failed lyric build cancels its resource reservation exactly once", async () => {
	let active = true;
	let cancelCount = 0;
	let commitCount = 0;
	let allocationReleaseCount = 0;
	const allocation = {
		textureBytes: 1024,
		geometryBytes: 256,
		released: false,
		release() {
			if (this.released) return;
			this.released = true;
			allocationReleaseCount += 1;
		},
	};
	const reservation = {
		get active() { return active; },
		committed: false,
		allocation,
		commit() {
			commitCount += 1;
			return false;
		},
		cancel() {
			cancelCount += 1;
			if (!active) return;
			active = false;
			allocation.release();
		},
	};
	let buildError: unknown = null;
	try {
		await buildLyricGroup("reservation rollback", DEFAULT_LYRIC_PALETTE, {
			threeFactory: makeFakeThree({ failShaderMaterial: true }),
			dotTexture: makeFakeDotTexture(),
			reserveResources: () => reservation,
		});
	} catch (error) {
		buildError = error;
	}

	expect(buildError).toBeInstanceOf(Error);
	expect(cancelCount).toBe(1);
	expect(commitCount).toBe(0);
	expect(allocationReleaseCount).toBe(1);
	expect(reservation.active).toBe(false);
});

test("a cancelled lyric build rolls back its reservation and partial resources exactly once", async () => {
	let cancelled = false;
	let active = true;
	let cancelCount = 0;
	let commitCount = 0;
	let allocationReleaseCount = 0;
	const textures: Array<{ disposed: boolean; image: HTMLCanvasElement }> = [];
	const allocation = {
		textureBytes: 2048,
		geometryBytes: 512,
		released: false,
		release() {
			if (this.released) return;
			this.released = true;
			allocationReleaseCount += 1;
		},
	};
	const reservation = {
		get active() { return active; },
		committed: false,
		allocation,
		commit() {
			commitCount += 1;
			return false;
		},
		cancel() {
			cancelCount += 1;
			if (!active) return;
			active = false;
			allocation.release();
		},
	};
	let buildError: unknown = null;
	try {
		await buildLyricGroup("cancelled build", DEFAULT_LYRIC_PALETTE, {
			threeFactory: makeFakeThree({
				onCanvasTexture: (texture) => {
					textures.push(texture);
					cancelled = true;
				},
			}),
			dotTexture: makeFakeDotTexture(),
			reserveResources: () => reservation,
			isCancelled: () => cancelled,
		});
	} catch (error) {
		buildError = error;
	}

	expect(buildError).toBeInstanceOf(Error);
	expect((buildError as Error).message).toContain("cancelled");
	expect(cancelCount).toBe(1);
	expect(commitCount).toBe(0);
	expect(allocationReleaseCount).toBe(1);
	expect(reservation.active).toBe(false);
	expect(textures).toHaveLength(1);
	expect(textures[0]?.disposed).toBe(true);
	expect(textures[0]?.image.width).toBe(1);
	expect(textures[0]?.image.height).toBe(1);
});

test("a successful lyric build commits its reservation and releases the allocation exactly once", async () => {
	let active = true;
	let committed = false;
	let commitCount = 0;
	let cancelCount = 0;
	let allocationReleaseCount = 0;
	let committedDisposer: (() => void) | null = null;
	const allocation = {
		textureBytes: 4096,
		geometryBytes: 1024,
		released: false,
		release() {
			if (this.released) return;
			this.released = true;
			allocationReleaseCount += 1;
			committedDisposer?.();
		},
	};
	const reservation = {
		get active() { return active; },
		get committed() { return committed; },
		allocation,
		commit(dispose: () => void) {
			if (!active) return false;
			active = false;
			committed = true;
			commitCount += 1;
			committedDisposer = dispose;
			return true;
		},
		cancel() {
			if (!active) return;
			active = false;
			cancelCount += 1;
			allocation.release();
		},
	};
	const lyric = await buildLyricGroup("committed build", DEFAULT_LYRIC_PALETTE, {
		threeFactory: makeFakeThree(),
		dotTexture: makeFakeDotTexture(),
		reserveResources: () => reservation,
	});

	expect(commitCount).toBe(1);
	expect(cancelCount).toBe(0);
	expect(reservation.active).toBe(false);
	expect(reservation.committed).toBe(true);
	expect(allocation.released).toBe(false);
	expect(lyric.textureLeases.some((lease) => !lease.released)).toBe(true);

	disposeLyricGroup(lyric);
	disposeLyricGroup(lyric);
	expect(allocationReleaseCount).toBe(1);
	expect(allocation.released).toBe(true);
	expect(lyric.textureLeases.every((lease) => lease.released)).toBe(true);
	expect((lyric.group as unknown as { children: unknown[] }).children).toHaveLength(0);
});

test("a lost reservation commit rolls back the completed lyric build", async () => {
	let active = true;
	let commitCount = 0;
	let cancelCount = 0;
	let allocationReleaseCount = 0;
	const textures: Array<{ disposed: boolean; image: HTMLCanvasElement }> = [];
	const geometries: Array<{ disposed: boolean }> = [];
	const allocation = {
		textureBytes: 4096,
		geometryBytes: 1024,
		released: false,
		release() {
			if (this.released) return;
			this.released = true;
			allocationReleaseCount += 1;
		},
	};
	const reservation = {
		get active() { return active; },
		committed: false,
		allocation,
		commit() {
			commitCount += 1;
			active = false;
			allocation.release();
			return false;
		},
		cancel() {
			cancelCount += 1;
			if (!active) return;
			active = false;
			allocation.release();
		},
	};
	let buildError: unknown = null;
	try {
		await buildLyricGroup("lost commit", DEFAULT_LYRIC_PALETTE, {
			threeFactory: makeFakeThree({
				onCanvasTexture: (texture) => textures.push(texture),
				onPlaneGeometry: (geometry) => geometries.push(geometry),
			}),
			dotTexture: makeFakeDotTexture(),
			reserveResources: () => reservation,
		});
	} catch (error) {
		buildError = error;
	}

	expect(buildError).toBeInstanceOf(Error);
	expect((buildError as Error).message).toContain("could not be committed");
	expect(commitCount).toBe(1);
	expect(cancelCount).toBe(1);
	expect(allocationReleaseCount).toBe(1);
	expect(textures.length).toBeGreaterThan(0);
	expect(textures.filter((texture) => (
		texture.disposed && texture.image.width === 1 && texture.image.height === 1
	)).length).toBeGreaterThanOrEqual(1);
	expect(textures.some((texture) => !texture.disposed)).toBe(true);
	expect(geometries.length).toBeGreaterThan(0);
	expect(geometries.every((geometry) => geometry.disposed)).toBe(true);
	resetLyricSunBloomCache();
});

test("a failed lyric build rolls back partial textures, canvases, and geometry", async () => {
	const textures: Array<{ disposed: boolean; image: HTMLCanvasElement }> = [];
	const geometries: Array<{ disposed: boolean }> = [];
	const build = buildLyricGroup("rollback", DEFAULT_LYRIC_PALETTE, {
		threeFactory: makeFakeThree({
			failShaderMaterial: true,
			onCanvasTexture: (texture) => textures.push(texture),
			onPlaneGeometry: (geometry) => geometries.push(geometry),
		}),
		dotTexture: makeFakeDotTexture(),
	});

	let buildError: unknown = null;
	try {
		await build;
	} catch (error) {
		buildError = error;
	}
	expect(buildError).toBeInstanceOf(Error);
	expect((buildError as Error).message).toContain("shader construction failed");
	expect(textures.length).toBeGreaterThan(0);
	expect(textures[0]?.disposed).toBe(true);
	expect(textures[0]?.image.width).toBe(1);
	expect(textures[0]?.image.height).toBe(1);
	expect(geometries.length).toBeGreaterThan(0);
	expect(geometries.every((geometry) => geometry.disposed)).toBe(true);
	resetLyricSunBloomCache();
});

test("disposeLyricGroup releases group resources exactly once", () => {
	let geometryDisposals = 0;
	let materialDisposals = 0;
	let leaseReleases = 0;
	const object = () => ({
		geometry: { dispose: () => { geometryDisposals += 1; } },
		material: { dispose: () => { materialDisposals += 1; } },
	});
	const lyric = {
		group: { children: [1, 2, 3] },
		sun: object(),
		glow: object(),
		readability: object(),
		textMesh: object(),
		sparks: object(),
		textureLeases: [{ release: () => { leaseReleases += 1; } }],
	} as unknown as LyricGroup;

	disposeLyricGroup(lyric);
	disposeLyricGroup(lyric);
	expect(geometryDisposals).toBe(5);
	expect(materialDisposals).toBe(5);
	expect(leaseReleases).toBe(1);
});
