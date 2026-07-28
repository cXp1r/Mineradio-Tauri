import type * as THREE from "three";
import type { ThreeFactory, ThreeModule } from "../runtime/renderer-setup";
import type { LyricMaskResult } from "./lyric-mask";
import { makeLyricMask, type MakeLyricMaskOptions } from "./lyric-mask";
import { getLyricSunBloomTexture } from "./lyric-sun-bloom";
import { makeLyricGlowTexture, type LyricGlowTextureOptions } from "./lyric-glow";
import { makeLyricReadabilityTexture, type LyricReadabilityTextureOptions } from "./lyric-readability";
import { makeLyricShaderMaterial, type LyricShaderMaterialOptions } from "./lyric-shader-material";
import { makeDotTexture } from "./lyric-dot-texture";
import { lyricThreeColor } from "./color-utils";
import { resolveLyricPalette, type LyricPalette } from "./palette";
import type { LyricTextOptions } from "./lyric-text";
import {
	createLyricTextureLease,
	estimateLyricTextureBytes,
	type LyricTextureLease,
} from "./textures/texture-lease";

export interface LyricGroupOptions extends LyricShaderMaterialOptions, LyricTextOptions {
	threeFactory?: ThreeFactory;
	pixelScale?: number;
	lyricGlowParticles?: boolean;
	dotTexture?: THREE.Texture;
	rand?: () => number;
	maxAnisotropy?: number;
	maskOptions?: Omit<MakeLyricMaskOptions, "lyricFont" | "lyricLetterSpacing" | "lyricLineHeight">;
	glowOptions?: LyricGlowTextureOptions;
	readabilityOptions?: LyricReadabilityTextureOptions;
	reserveResources?: () => LyricGroupResourceReservation | null;
	isCancelled?: () => boolean;
}

export interface LyricGroupResourceAllocation {
	readonly textureBytes: number;
	readonly geometryBytes: number;
	readonly released: boolean;
	release(): void;
}

export interface LyricGroupResourceReservation {
	readonly active: boolean;
	readonly committed: boolean;
	readonly allocation: LyricGroupResourceAllocation;
	commit(dispose: () => void): boolean;
	cancel(): void;
}

export class LyricGroupResourceAdmissionError extends Error {
	constructor() {
		super("Stage lyric resource admission was denied before allocation.");
		this.name = "LyricGroupResourceAdmissionError";
	}
}

export class LyricGroupBuildCancelledError extends Error {
	constructor() {
		super("Stage lyric build was cancelled.");
		this.name = "LyricGroupBuildCancelledError";
	}
}

export class LyricGroupResourceCommitError extends Error {
	constructor() {
		super("Stage lyric resource reservation could not be committed.");
		this.name = "LyricGroupResourceCommitError";
	}
}

export interface LyricGroup {
	readonly group: THREE.Group;
	readonly mask: LyricMaskResult;
	readonly textMesh: THREE.Mesh;
	readonly readability: THREE.Mesh;
	readonly glow: THREE.Mesh;
	readonly sparks: THREE.Points;
	readonly sun: THREE.Mesh;
	readonly textMat: THREE.ShaderMaterial;
	readonly readabilityMat: THREE.ShaderMaterial;
	readonly glowMat: THREE.ShaderMaterial;
	readonly sparkMat: THREE.ShaderMaterial;
	readonly sunMat: THREE.ShaderMaterial;
	readonly basePositions: Float32Array;
	readonly textWorldW: number;
	readonly textWorldH: number;
	readonly worldW: number;
	readonly worldH: number;
	readonly textureLeases: readonly LyricTextureLease[];
}

const DEFAULT_THREE_FACTORY: ThreeFactory = async () => await import("three");
const SPARK_COUNT = 132;
const disposedLyricGroups = new WeakSet<object>();
const lyricGroupResourceAllocations = new WeakMap<object, LyricGroupResourceAllocation>();

const FACING_TEXTURE_VERTEX_SHADER = [
	"varying vec2 vUv;",
	"void main(){",
	"  vUv = uv;",
	"  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);",
	"}",
].join("\n");

const FACING_TEXTURE_FRAGMENT_SHADER = [
	"precision highp float;",
	"uniform sampler2D uMap;",
	"uniform vec3 uColor;",
	"uniform float uOpacity;",
	"varying vec2 vUv;",
	"void main(){",
	"  vec2 uv = gl_FrontFacing ? vUv : vec2(1.0 - vUv.x, vUv.y);",
	"  vec4 tex = texture2D(uMap, uv);",
	"  if (tex.a <= 0.001) discard;",
	"  gl_FragColor = vec4(tex.rgb * uColor, tex.a * uOpacity);",
	"}",
].join("\n");

const SPARKS_VERTEX_SHADER = [
	"attribute float seed;",
	"uniform float uSize;",
	"uniform float uPixel;",
	"varying float vSeed;",
	"void main(){",
	"  vSeed = seed;",
	"  vec4 mv = modelViewMatrix * vec4(position, 1.0);",
	"  float jitter = 0.58 + fract(sin(seed * 19.17) * 43758.5453) * 1.18;",
	"  float depth = clamp(2.2 / max(0.35, -mv.z), 0.54, 1.55);",
	"  gl_PointSize = uSize * jitter * depth * uPixel * 120.0;",
	"  gl_Position = projectionMatrix * mv;",
	"}",
].join("\n");

const SPARKS_FRAGMENT_SHADER = [
	"precision highp float;",
	"uniform sampler2D uMap;",
	"uniform vec3 uColor;",
	"uniform float uOpacity;",
	"varying float vSeed;",
	"void main(){",
	"  vec4 tex = texture2D(uMap, gl_PointCoord);",
	"  float twinkle = 0.72 + fract(sin(vSeed * 7.31) * 91.7) * 0.28;",
	"  gl_FragColor = vec4(uColor * twinkle, tex.a * uOpacity);",
	"}",
].join("\n");

function disposeObject(obj: unknown): void {
	const o = obj as { geometry?: { dispose?: () => void }; material?: { dispose?: () => void } } | null | undefined;
	if (!o) return;
	try {
		o.geometry?.dispose?.();
	} catch {
		void o;
	}
	try {
		o.material?.dispose?.();
	} catch {
		void o;
	}
}

function textureSize(texture: THREE.Texture | null | undefined, fallbackWidth: number, fallbackHeight: number): {
	width: number;
	height: number;
} {
	const image = (texture as unknown as { image?: { width?: unknown; height?: unknown } } | null | undefined)?.image;
	const width = Number(image?.width);
	const height = Number(image?.height);
	return {
		width: Number.isFinite(width) && width > 0 ? width : fallbackWidth,
		height: Number.isFinite(height) && height > 0 ? height : fallbackHeight,
	};
}

function leaseTexture(
	leases: LyricTextureLease[],
	texture: THREE.Texture | null | undefined,
	ownership: "owned" | "borrowed",
	fallbackWidth: number,
	fallbackHeight: number,
): LyricTextureLease | null {
	if (!texture) return null;
	const size = textureSize(texture, fallbackWidth, fallbackHeight);
	const lease = createLyricTextureLease({
		texture,
		ownership,
		estimatedBytes: estimateLyricTextureBytes(size.width, size.height),
	});
	leases.push(lease);
	return lease;
}

function rgbToThreeColor(THREE: ThreeModule, rgb: ReturnType<typeof lyricThreeColor>): THREE.Color | null {
	if (typeof THREE.Color !== "function") return null;
	return new THREE.Color(rgb.r, rgb.g, rgb.b) as THREE.Color;
}

function makeFacingTextureMaterial(
	THREE: ThreeModule,
	texture: THREE.Texture | null,
	color: ReturnType<typeof lyricThreeColor>,
	opacity: number,
	blending: number,
): THREE.ShaderMaterial {
	const baseColor = rgbToThreeColor(THREE, color) ?? color;
	const material = new THREE.ShaderMaterial({
		uniforms: {
			uMap: { value: texture },
			uColor: { value: baseColor },
			uOpacity: { value: opacity },
		},
		vertexShader: FACING_TEXTURE_VERTEX_SHADER,
		fragmentShader: FACING_TEXTURE_FRAGMENT_SHADER,
		transparent: true,
		depthWrite: false,
		depthTest: false,
		side: THREE.DoubleSide,
		blending,
	} as THREE.ShaderMaterialParameters) as THREE.ShaderMaterial;
	(material as unknown as { color: unknown; opacity: number }).color = baseColor;
	(material as unknown as { opacity: number }).opacity = opacity;
	return material;
}

export async function buildLyricGroup(
	text: string,
	palette: Partial<LyricPalette> | undefined,
	opts: LyricGroupOptions = {},
): Promise<LyricGroup> {
	const factory = opts.threeFactory ?? DEFAULT_THREE_FACTORY;
	const throwIfCancelled = () => {
		if (opts.isCancelled?.()) throw new LyricGroupBuildCancelledError();
	};
	throwIfCancelled();
	const reservation = opts.reserveResources?.();
	if (opts.reserveResources && !reservation) {
		throw new LyricGroupResourceAdmissionError();
	}
	const textureLeases: LyricTextureLease[] = [];
	const rollback: Array<() => void> = [];
	const trackTexture = (
		texture: THREE.Texture | null | undefined,
		ownership: "owned" | "borrowed",
		fallbackWidth: number,
		fallbackHeight: number,
	) => {
		const lease = leaseTexture(textureLeases, texture, ownership, fallbackWidth, fallbackHeight);
		if (lease) rollback.push(() => lease.release());
	};
	const trackDisposable = <T extends { dispose?: () => void }>(resource: T): T => {
		rollback.push(() => {
			try {
				resource.dispose?.();
			} catch {
				// 失败构建必须继续逆序释放其余已创建资源。
			}
		});
		return resource;
	};
	try {
	throwIfCancelled();
	const THREE = await factory();
	throwIfCancelled();
	const pal = resolveLyricPalette(palette);
	const rand = opts.rand ?? Math.random;
	const cleaned = String(text ?? "")
		.replace(/\s+/g, " ")
		.trim();
	const maskTextOpts: LyricTextOptions = {
		lyricFont: opts.lyricFont,
		lyricLetterSpacing: opts.lyricLetterSpacing,
		lyricLineHeight: opts.lyricLineHeight,
		lyricWeight: opts.lyricWeight,
	};
	const mask = makeLyricMask(cleaned, THREE, { ...(opts.maskOptions ?? {}), maxAnisotropy: opts.maxAnisotropy, ...maskTextOpts });
	trackTexture(mask.texture, "owned", mask.width, mask.height);
	throwIfCancelled();
	const worldW = 6.1;
	const worldH = worldW * (mask.height / mask.width);
	const geo = trackDisposable(new THREE.PlaneGeometry(worldW, worldH, 1, 1) as THREE.PlaneGeometry);
	const textWorldW = worldW * (mask.textWidth / mask.width);
	const textWorldH = worldH * ((mask.textHeight || mask.fontSize) / mask.height);

	const group = new THREE.Group() as THREE.Group;
	(group as unknown as { renderOrder: number }).renderOrder = 42;
	group.position.set((rand() - 0.5) * 0.08, 0.2, 1.46);
	group.scale.setScalar(0.96);
	group.userData.age = 0;
	group.userData.state = "in";
	group.userData.lastLyricProgress = -1;
	group.userData.floatSeed = rand() * 100;

	const sunBloomTex = getLyricSunBloomTexture(THREE);
	trackTexture(sunBloomTex, "borrowed", 1024, 512);
	const sunMatColor = lyricThreeColor(pal.highlight || pal.secondary || pal.primary, "#ffe7a6", 0.5);
	const sunMat = trackDisposable(makeFacingTextureMaterial(THREE, sunBloomTex, sunMatColor, 0, THREE.AdditiveBlending));
	const sunWorldW0 = Math.max(textWorldW + worldH * 1.1, textWorldW * 1.18);
	const sunWorldW = Math.min(worldW * 1.16, Math.max(worldH * 1.35, sunWorldW0));
	const sunWorldH = Math.max(worldH * 1.02, Math.min(worldH * 1.54, worldH + textWorldW * 0.07));
	const sunGeometry = trackDisposable(new THREE.PlaneGeometry(sunWorldW, sunWorldH, 1, 1) as THREE.PlaneGeometry);
	const sun = new THREE.Mesh(sunGeometry, sunMat) as THREE.Mesh;
	(sun as unknown as { renderOrder: number }).renderOrder = 40;
	sun.position.set(0, 0.02, -0.03);
	sun.scale.set(0.78, 0.58, 1);
	group.add(sun);

	const glowOptions: LyricGlowTextureOptions = {
		lyricFont: opts.lyricFont,
		lyricLetterSpacing: opts.lyricLetterSpacing,
		lyricLineHeight: opts.lyricLineHeight,
		lyricWeight: opts.lyricWeight,
		...(mask.rasterRows?.length
			? {
				structuredRows: mask.rasterRows,
				canvasWidth: mask.width,
				canvasHeight: mask.height,
			}
			: {}),
		...(opts.glowOptions ?? {}),
	};
	const glowTex = makeLyricGlowTexture(cleaned, mask.fontSize, mask.textWidth, mask.lines, mask.lineHeight, mask.fitScaleX, THREE, glowOptions);
	trackTexture(glowTex, "owned", mask.width, mask.height);
	throwIfCancelled();
	const glowMatColor = lyricThreeColor(pal.secondary, "#9cffdf", 0.36);
	const glowMat = trackDisposable(makeFacingTextureMaterial(THREE, glowTex, glowMatColor, 0, THREE.AdditiveBlending));
	const glowMeta = (glowTex as unknown as { userData?: { width?: number; height?: number; textWidth?: number } } | null)?.userData ?? {};
	const glowWorldW0 = textWorldW * ((glowMeta.width || mask.width) / Math.max(1, glowMeta.textWidth || mask.textWidth));
	const glowWorldW = Math.min(worldW * 1.1, Math.max(textWorldW + worldH * 0.38, glowWorldW0));
	const glowWorldH0 = worldH * ((glowMeta.height || mask.height) / mask.height);
	const glowWorldH = Math.min(worldH * 1.42, Math.max(worldH * 0.92, glowWorldH0));
	const glowGeometry = trackDisposable(new THREE.PlaneGeometry(glowWorldW, glowWorldH, 1, 1) as THREE.PlaneGeometry);
	const glow = new THREE.Mesh(glowGeometry, glowMat) as THREE.Mesh;
	(glow as unknown as { renderOrder: number }).renderOrder = 41;
	glow.scale.set(1, 1.06, 1);
	group.add(glow);

	const readabilityOptions: LyricReadabilityTextureOptions = {
		maxAnisotropy: opts.maxAnisotropy,
		lyricFont: opts.lyricFont,
		lyricLetterSpacing: opts.lyricLetterSpacing,
		lyricLineHeight: opts.lyricLineHeight,
		lyricWeight: opts.lyricWeight,
		...(opts.readabilityOptions ?? {}),
	};
	const readabilityTex = makeLyricReadabilityTexture(mask, THREE, readabilityOptions);
	trackTexture(readabilityTex, "owned", mask.width, mask.height);
	throwIfCancelled();
	const readabilityMat = trackDisposable(makeFacingTextureMaterial(THREE, readabilityTex, lyricThreeColor("#ffffff", "#ffffff", 0), 0, THREE.NormalBlending));
	const readabilityGeometry = trackDisposable(new THREE.PlaneGeometry(worldW, worldH, 1, 1) as THREE.PlaneGeometry);
	const readability = new THREE.Mesh(readabilityGeometry, readabilityMat) as THREE.Mesh;
	(readability as unknown as { renderOrder: number }).renderOrder = 42;
	readability.position.set(0, 0, -0.012);
	group.add(readability);

	const motionSeed = Number.isFinite(opts.motionSeed) ? Number(opts.motionSeed) : rand() * 997;
	const shaderOpts: LyricShaderMaterialOptions = {
		lyricsHasNativeKaraoke: opts.lyricsHasNativeKaraoke,
		motionProfile: opts.motionProfile,
		motionSeed,
		timeUniform: opts.timeUniform,
	};
	const {
		material: createdTextMat,
		motionProfile,
	} = makeLyricShaderMaterial(mask, pal, THREE, shaderOpts);
	const textMat = trackDisposable(createdTextMat);
	group.userData.motionStyle = motionProfile.style;
	group.userData.motionProfile = motionProfile;
	group.userData.glitchSeed = motionSeed;
	group.userData.glitchBurst = 0;
	group.userData.glitchHold = 0;
	group.userData.glitchNextAt = 0;
	group.userData.glitchLastBeatAt = -10;
	const textMesh = new THREE.Mesh(geo, textMat) as THREE.Mesh;
	(textMesh as unknown as { renderOrder: number }).renderOrder = 43;
	group.add(textMesh);

	const dotTex = opts.dotTexture ?? makeDotTexture(THREE);
	trackTexture(dotTex, opts.dotTexture ? "borrowed" : "owned", 64, 64);
	throwIfCancelled();
	const pgeo = trackDisposable(new THREE.BufferGeometry() as THREE.BufferGeometry);
	const ppos = new Float32Array(SPARK_COUNT * 3);
	const pseed = new Float32Array(SPARK_COUNT);
	for (let i = 0; i < SPARK_COUNT; i++) {
		const angle = rand() * Math.PI * 2;
		const ring = 0.78 + Math.pow(rand(), 1.45) * 0.58;
		const rx = textWorldW * (0.5 + rand() * 0.22) + 0.1;
		const ry = worldH * (0.42 + rand() * 0.22) + 0.08;
		ppos[i * 3] = Math.cos(angle) * rx * ring + (rand() - 0.5) * textWorldW * 0.12;
		ppos[i * 3 + 1] = Math.sin(angle) * ry * ring + (rand() - 0.5) * worldH * 0.14;
		ppos[i * 3 + 2] = (rand() - 0.5) * 0.24;
		pseed[i] = rand() * 1000;
	}
	pgeo.setAttribute("position", new THREE.BufferAttribute(ppos, 3) as THREE.BufferAttribute);
	pgeo.setAttribute("seed", new THREE.BufferAttribute(pseed, 1) as THREE.BufferAttribute);
	const sparkColorRgb = lyricThreeColor(pal.highlight || pal.secondary || pal.primary, "#fff7d2", 0.3);
	const pixelScale = opts.pixelScale ?? 1;
	const pmat = trackDisposable(new THREE.ShaderMaterial({
		uniforms: {
			uMap: { value: dotTex },
			uSize: { value: 0.052 },
			uOpacity: { value: 0 },
			uColor: { value: rgbToThreeColor(THREE, sparkColorRgb) ?? sparkColorRgb },
			uPixel: { value: pixelScale },
		},
		vertexShader: SPARKS_VERTEX_SHADER,
		fragmentShader: SPARKS_FRAGMENT_SHADER,
		transparent: true,
		depthWrite: false,
		depthTest: false,
		blending: THREE.AdditiveBlending,
	} as THREE.ShaderMaterialParameters) as THREE.ShaderMaterial);
	const sparks = new THREE.Points(pgeo, pmat) as THREE.Points;
	(sparks as unknown as { renderOrder: number }).renderOrder = 44;
	(sparks as unknown as { visible: boolean }).visible = !!(opts.lyricGlowParticles ?? false);
	group.add(sparks);

	const basePositions = ppos.slice ? ppos.slice(0) : new Float32Array(ppos);

	group.userData.lyric = {
		mask,
		textMesh,
		readability,
		glow,
		sparks,
		sun,
		textMat,
		readabilityMat,
		glowMat,
		sparkMat: pmat,
		sunMat,
		basePositions,
		textWorldW,
		textWorldH,
		worldW,
		worldH,
	};
	(textMat as unknown as { uniforms: Record<string, { value: unknown }> }).uniforms.uTextOptionsSignature = {
		value: `${maskTextOpts.lyricFont ?? ""}|${maskTextOpts.lyricLetterSpacing ?? ""}|${maskTextOpts.lyricLineHeight ?? ""}|${maskTextOpts.lyricWeight ?? ""}`,
	};

	updateLyricGroupProgress(
		{
			group,
			textMat,
		},
		0,
	);

	const lyric: LyricGroup = {
		group,
		mask,
		textMesh,
		readability,
		glow,
		sparks,
		sun,
		textMat,
		readabilityMat,
		glowMat,
		sparkMat: pmat,
		sunMat,
		basePositions,
		textWorldW,
		textWorldH,
		worldW,
		worldH,
		textureLeases,
	};
	throwIfCancelled();
	if (reservation) {
		if (!reservation.commit(() => disposeLyricGroupResources(lyric))) {
			throw new LyricGroupResourceCommitError();
		}
		lyricGroupResourceAllocations.set(lyric as unknown as object, reservation.allocation);
	}
	rollback.length = 0;
	return lyric;
	} catch (error) {
		for (let index = rollback.length - 1; index >= 0; index -= 1) {
			try {
				rollback[index]();
			} catch {
				// 单个 rollback 失败不能阻断其余部分资源收口。
			}
		}
		try {
			reservation?.cancel();
		} catch {
			// reservation 回滚异常不能掩盖原始构建错误。
		}
		throw error;
	}
}

export function updateLyricGroupProgress(lyric: Pick<LyricGroup, "textMat" | "group">, progress: number): void {
	const p = Math.max(0, Math.min(1, Number(progress) || 0));
	const u = (lyric.textMat as unknown as { uniforms: { uProgress: { value: number } } }).uniforms;
	u.uProgress.value = p;
	(lyric.group as unknown as { userData: Record<string, unknown> }).userData.lastLyricProgress = p;
}

export function getLyricGroupResourceAllocation(
	lyric: LyricGroup,
): LyricGroupResourceAllocation | undefined {
	return lyricGroupResourceAllocations.get(lyric as unknown as object);
}

function disposeLyricGroupResources(lyric: LyricGroup): void {
	const disposalKey = lyric as unknown as object;
	if (disposedLyricGroups.has(disposalKey)) return;
	disposedLyricGroups.add(disposalKey);
	const { group } = lyric;
	disposeObject(lyric.sun);
	disposeObject(lyric.glow);
	disposeObject(lyric.readability);
	disposeObject(lyric.textMesh);
	if (lyric.sparks) {
		const sparkObj: { geometry?: { dispose?: () => void }; material?: { dispose?: () => void } } = {
			geometry: lyric.sparks.geometry as unknown as { dispose?: () => void } | undefined,
			material: lyric.sparks.material as unknown as { dispose?: () => void } | undefined,
		};
		disposeObject(sparkObj);
	}
	for (const lease of lyric.textureLeases) {
		try {
			lease.release();
		} catch {
			// 单个 lease 释放失败不能阻断其余 group 资源收口。
		}
	}
	if (group) {
		const children = (group as unknown as { children: unknown[] }).children;
		if (Array.isArray(children)) children.length = 0;
		try {
			(group as unknown as { userData: Record<string, unknown> }).userData.lyric = null;
		} catch {
			void group;
		}
	}
}

export function disposeLyricGroup(lyric: LyricGroup): void {
	const allocation = getLyricGroupResourceAllocation(lyric);
	try {
		if (allocation && !allocation.released) allocation.release();
	} finally {
		disposeLyricGroupResources(lyric);
	}
}
