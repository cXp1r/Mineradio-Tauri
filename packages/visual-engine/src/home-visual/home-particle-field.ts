import type * as THREE from "three";
import type { ThreeFactory } from "../runtime/renderer-setup";
import type { FxState } from "./fx-defaults";
import type { AudioSnapshot } from "../audio/audio-snapshot";
import type { UniformContainer } from "./sync-uniforms";
import {
	HOME_VISUAL_VERTEX_SHADER,
	HOME_VISUAL_FRAGMENT_SHADER,
	HOME_VISUAL_BLOOM_FRAGMENT_SHADER,
	buildHomeVisualBloomVertexShader,
} from "./home-visual-shaders";
import { RIPPLE_MAX } from "./ripples";

export interface HomeParticleFieldOptions {
	threeFactory?: ThreeFactory;
	coverResolution?: number;
}

export interface HomeParticleField {
	readonly points: THREE.Points;
	readonly bloomPoints: THREE.Points;
	readonly materialUniforms: Record<string, THREE.IUniform>;
	readonly geometry: THREE.BufferGeometry;
	readonly material: THREE.ShaderMaterial;
	readonly bloomMaterial: THREE.ShaderMaterial;
	applyFxState(fx: FxState): void;
	applySnapshotSync(fx: FxState, snapshot: AudioSnapshot, runtimeUniforms: UniformContainer, dt: number): void;
	dispose(): void;
}

const DEFAULT_THREE_FACTORY: ThreeFactory = async () => await import("three");
const PLANE_SIZE = 4.8;

export function normalizeCoverResolution(v: number): number {
	return Math.max(0.75, Math.min(1.55, Number(v) || 1));
}

export function coverParticleGridForResolution(v: number): number {
	const normalized = normalizeCoverResolution(v);
	const grid0 = Math.round(118 * normalized);
	const grid1 = Math.max(88, Math.min(183, grid0));
	return grid1 % 2 ? grid1 : grid1 + 1;
}

type ThreeModule = typeof import("three");

function buildGeometry(THREE: ThreeModule, grid: number): THREE.BufferGeometry {
	const count = grid * grid;
	const positions = new Float32Array(count * 3);
	const uvs = new Float32Array(count * 2);
	const rand = new Float32Array(count);
	const texelStep = 1 / grid;
	for (let i = 0; i < count; i++) {
		const gx = i % grid;
		const gy = Math.floor(i / grid);
		const u = (gx + 0.5) * texelStep;
		const vv = (gy + 0.5) * texelStep;
		const px = gx / (grid - 1);
		const py = gy / (grid - 1);
		positions[i * 3] = (px - 0.5) * PLANE_SIZE;
		positions[i * 3 + 1] = (py - 0.5) * PLANE_SIZE;
		positions[i * 3 + 2] = 0;
		uvs[i * 2] = u;
		uvs[i * 2 + 1] = vv;
		rand[i] = Math.random();
	}
	const geo = new THREE.BufferGeometry();
	geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
	geo.setAttribute("aUv", new THREE.BufferAttribute(uvs, 2));
	geo.setAttribute("aRand", new THREE.BufferAttribute(rand, 1));
	return geo;
}

function makeDotTexture(THREE: ThreeModule): THREE.Texture {
	let tex: THREE.Texture;
	try {
		if (typeof document !== "undefined") {
			const cv = document.createElement("canvas");
			cv.width = 64;
			cv.height = 64;
			const c = cv.getContext("2d");
			if (c) {
				const g = c.createRadialGradient(32, 32, 0, 32, 32, 31);
				g.addColorStop(0.0, "rgba(255,255,255,0.96)");
				g.addColorStop(0.42, "rgba(255,255,255,0.78)");
				g.addColorStop(0.72, "rgba(255,255,255,0.22)");
				g.addColorStop(1.0, "rgba(255,255,255,0)");
				c.fillStyle = g as unknown as string;
				c.fillRect(0, 0, 64, 64);
			}
			if (typeof THREE.CanvasTexture === "function") {
				tex = new THREE.CanvasTexture(cv);
			} else {
				tex = new THREE.Texture();
				(tex as unknown as { image: HTMLCanvasElement }).image = cv;
			}
		} else {
			tex = new THREE.Texture();
		}
	} catch {
		tex = new THREE.Texture();
	}
	tex.minFilter = THREE.LinearFilter;
	tex.magFilter = THREE.LinearFilter;
	return tex;
}

function makePlaceholderTexture(THREE: ThreeModule, fillStyle: string): THREE.Texture {
	const tex = new THREE.Texture();
	try {
		if (typeof document !== "undefined") {
			const c = document.createElement("canvas");
			c.width = 4;
			c.height = 4;
			const x = c.getContext("2d");
			if (x) {
				x.fillStyle = fillStyle as unknown as string;
				x.fillRect(0, 0, 4, 4);
			}
			(tex as unknown as { image: HTMLCanvasElement }).image = c;
			(tex as unknown as { needsUpdate: boolean }).needsUpdate = true;
		}
	} catch {
		void fillStyle;
	}
	tex.minFilter = THREE.LinearFilter;
	tex.magFilter = THREE.LinearFilter;
	return tex;
}

function makeUniformsRecord(THREE: ThreeModule, coverRes: number): Record<string, THREE.IUniform> {
	const dotTex = makeDotTexture(THREE);
	const coverTex = makePlaceholderTexture(THREE, "#1c1c28");
	const prevCoverTex = makePlaceholderTexture(THREE, "#1c1c28");
	const edgeTex = makePlaceholderTexture(THREE, "rgba(128,0,0,255)");
	const rippleTex = makeRippleTexture(THREE);
	return {
		uTime: { value: 0 },
		uBass: { value: 0 },
		uMid: { value: 0 },
		uTreble: { value: 0 },
		uBeat: { value: 0 },
		uEnergy: { value: 0 },
		uBurstAmt: { value: 0 },
		uVinylSpin: { value: 0 },
		uPreset: { value: 0 },
		uIntensity: { value: 0.85 },
		uDepth: { value: 1.0 },
		uPointScale: { value: 1.0 },
		uSpeed: { value: 1.0 },
		uTwist: { value: 0 },
		uColorBoost: { value: 1.1 },
		uScatter: { value: 0 },
		uCoverRes: { value: coverRes },
		uBgFade: { value: 0.20 },
		uBloomStrength: { value: 0.62 },
		uBloomSize: { value: 2.65 },
		uTintColor: { value: new THREE.Color("#9db8cf") },
		uTintStrength: { value: 0 },
		uCoverTex: { value: coverTex },
		uPrevCoverTex: { value: prevCoverTex },
		uColorMixT: { value: 1.0 },
		uEdgeTex: { value: edgeTex },
		uRippleTex: { value: rippleTex },
		uRippleCount: { value: 0 },
		uDotTex: { value: dotTex },
		uHasCover: { value: 0 },
		uHasDepth: { value: 0 },
		uEdgeEnabled: { value: 1 },
		uAiBoost: { value: 0 },
		uMouseXY: { value: new THREE.Vector2(-999, -999) },
		uMouseActive: { value: 0 },
		uHandXY: { value: new THREE.Vector2(-999, -999) },
		uHandActive: { value: 0 },
		uGestureGrip: { value: 0 },
		uPixel: { value: 1 },
		uAlpha: { value: 0 },
		uParticleDim: { value: 1 },
		uFloatAlpha: { value: 0 },
		uLoading: { value: 0 },
	};
}

function makeRippleTexture(THREE: ThreeModule): THREE.Texture {
	const data = new Float32Array(RIPPLE_MAX * 4);
	let tex: THREE.Texture;
	if (typeof THREE.DataTexture === "function") {
		tex = new THREE.DataTexture(data, 1, RIPPLE_MAX, THREE.RGBAFormat, THREE.FloatType);
	} else {
		tex = new THREE.Texture();
		(tex as unknown as { image: { data: Float32Array; width: number; height: number } }).image = {
			data,
			width: 1,
			height: RIPPLE_MAX,
		};
	}
	(tex as unknown as { image?: { data?: Float32Array; width?: number; height?: number } }).image = {
		...((tex as unknown as { image?: object }).image ?? {}),
		data,
		width: 1,
		height: RIPPLE_MAX,
	};
	tex.magFilter = THREE.NearestFilter;
	tex.minFilter = THREE.NearestFilter;
	return tex;
}

function disposeTexture(tex: THREE.Texture | undefined): void {
	if (!tex) return;
	try {
		(tex as unknown as { dispose?: () => void }).dispose?.();
	} catch {
		void tex;
	}
}

export async function createHomeParticleField(
	scene: THREE.Scene,
	opts: HomeParticleFieldOptions = {},
): Promise<HomeParticleField> {
	const factory = opts.threeFactory ?? DEFAULT_THREE_FACTORY;
	const THREE = await factory();
	const coverRes = opts.coverResolution ?? 1.55;
	const grid = coverParticleGridForResolution(coverRes);
	const geo = buildGeometry(THREE, grid);
	const uniforms = makeUniformsRecord(THREE, coverRes);

	const material = new THREE.ShaderMaterial({
		uniforms,
		vertexShader: HOME_VISUAL_VERTEX_SHADER,
		fragmentShader: HOME_VISUAL_FRAGMENT_SHADER,
		transparent: true,
		depthWrite: false,
		blending: THREE.NormalBlending,
	});

	const bloomVs = buildHomeVisualBloomVertexShader(HOME_VISUAL_VERTEX_SHADER);
	const bloomMaterial = new THREE.ShaderMaterial({
		uniforms,
		vertexShader: bloomVs,
		fragmentShader: HOME_VISUAL_BLOOM_FRAGMENT_SHADER,
		transparent: true,
		depthWrite: false,
		depthTest: false,
		blending: THREE.AdditiveBlending,
	});

	const bloomPoints = new THREE.Points(geo, bloomMaterial);
	bloomPoints.frustumCulled = false;
	bloomPoints.renderOrder = 0;
	scene.add(bloomPoints);

	const points = new THREE.Points(geo, material);
	points.frustumCulled = false;
	points.renderOrder = 1;
	scene.add(points);

	const field: HomeParticleField = {
		points,
		bloomPoints,
		materialUniforms: uniforms,
		geometry: geo,
		material,
		bloomMaterial,
		applyFxState(fx) {
			const u = uniforms as unknown as Record<string, { value: unknown }>;
			u.uPreset.value = fx.preset;
			u.uIntensity.value = fx.intensity;
			u.uDepth.value = fx.depth;
			u.uPointScale.value = fx.point;
			u.uSpeed.value = fx.speed;
			u.uTwist.value = fx.twist;
			u.uColorBoost.value = fx.color;
			u.uScatter.value = fx.scatter;
			u.uCoverRes.value = normalizeCoverResolution(fx.coverResolution);
			u.uBgFade.value = fx.bgFade;
			u.uBloomStrength.value = fx.bloom ? fx.bloomStrength : 0;
			u.uEdgeEnabled.value = fx.edge ? 1 : 0;
			bloomPoints.visible = !!(fx.bloom && fx.bloomStrength > 0.01);
		},
		applySnapshotSync(_fx, _snapshot, _runtimeUniforms, _dt) {
			void _fx;
			void _snapshot;
			void _runtimeUniforms;
			void _dt;
		},
		dispose() {
			scene.remove(points);
			scene.remove(bloomPoints);
			geo.dispose();
			material.dispose();
			bloomMaterial.dispose();
			disposeTexture(uniforms.uCoverTex.value as THREE.Texture);
			disposeTexture(uniforms.uPrevCoverTex.value as THREE.Texture);
			disposeTexture(uniforms.uEdgeTex.value as THREE.Texture);
			disposeTexture(uniforms.uRippleTex.value as THREE.Texture);
			disposeTexture(uniforms.uDotTex.value as THREE.Texture);
		},
	};
	return field;
}
