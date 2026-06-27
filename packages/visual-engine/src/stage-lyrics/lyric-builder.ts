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

export interface LyricGroupOptions extends LyricShaderMaterialOptions, LyricTextOptions {
	threeFactory?: ThreeFactory;
	pixelScale?: number;
	lyricGlowParticles?: boolean;
	dotTexture?: THREE.Texture;
	rand?: () => number;
	maskOptions?: Omit<MakeLyricMaskOptions, "lyricFont" | "lyricLetterSpacing" | "lyricLineHeight">;
	glowOptions?: LyricGlowTextureOptions;
	readabilityOptions?: LyricReadabilityTextureOptions;
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
	readonly readabilityMat: THREE.MeshBasicMaterial;
	readonly glowMat: THREE.MeshBasicMaterial;
	readonly sparkMat: THREE.ShaderMaterial;
	readonly sunMat: THREE.MeshBasicMaterial;
	readonly basePositions: Float32Array;
	readonly textWorldW: number;
	readonly textWorldH: number;
	readonly worldW: number;
	readonly worldH: number;
}

const DEFAULT_THREE_FACTORY: ThreeFactory = async () => await import("three");
const SPARK_COUNT = 132;

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

function disposeTexture(tex: { dispose?: () => void } | null | undefined): void {
	if (!tex) return;
	try {
		tex.dispose?.();
	} catch {
		void tex;
	}
}

function rgbToThreeColor(THREE: ThreeModule, rgb: ReturnType<typeof lyricThreeColor>): THREE.Color | null {
	if (typeof THREE.Color !== "function") return null;
	return new THREE.Color(rgb.r, rgb.g, rgb.b) as THREE.Color;
}

export async function buildLyricGroup(
	text: string,
	palette: Partial<LyricPalette> | undefined,
	opts: LyricGroupOptions = {},
): Promise<LyricGroup> {
	const factory = opts.threeFactory ?? DEFAULT_THREE_FACTORY;
	const THREE = await factory();
	const pal = resolveLyricPalette(palette);
	const rand = opts.rand ?? Math.random;
	const cleaned = String(text ?? "")
		.replace(/\s+/g, " ")
		.trim();
	const maskTextOpts: LyricTextOptions = {
		lyricFont: opts.lyricFont,
		lyricLetterSpacing: opts.lyricLetterSpacing,
		lyricLineHeight: opts.lyricLineHeight,
	};
	const mask = makeLyricMask(cleaned, THREE, { ...(opts.maskOptions ?? {}), ...maskTextOpts });
	const worldW = 6.1;
	const worldH = worldW * (mask.height / mask.width);
	const geo = new THREE.PlaneGeometry(worldW, worldH, 1, 1) as THREE.PlaneGeometry;
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
	const sunMatColor = lyricThreeColor(pal.highlight || pal.secondary || pal.primary, "#ffe7a6", 0.5);
	const sunMat = new THREE.MeshBasicMaterial({
		map: sunBloomTex,
		transparent: true,
		opacity: 0,
		depthWrite: false,
		depthTest: false,
		side: THREE.DoubleSide,
		blending: THREE.AdditiveBlending,
		color: rgbToThreeColor(THREE, sunMatColor) ?? sunMatColor,
	} as THREE.MeshBasicMaterialParameters) as THREE.MeshBasicMaterial;
	const sunWorldW0 = Math.max(textWorldW + worldH * 1.1, textWorldW * 1.18);
	const sunWorldW = Math.min(worldW * 1.16, Math.max(worldH * 1.35, sunWorldW0));
	const sunWorldH = Math.max(worldH * 1.02, Math.min(worldH * 1.54, worldH + textWorldW * 0.07));
	const sun = new THREE.Mesh(new THREE.PlaneGeometry(sunWorldW, sunWorldH, 1, 1) as THREE.PlaneGeometry, sunMat) as THREE.Mesh;
	(sun as unknown as { renderOrder: number }).renderOrder = 40;
	sun.position.set(0, 0.02, -0.03);
	sun.scale.set(0.78, 0.58, 1);
	group.add(sun);

	const glowOptions: LyricGlowTextureOptions = {
		lyricFont: opts.lyricFont,
		lyricLetterSpacing: opts.lyricLetterSpacing,
		lyricLineHeight: opts.lyricLineHeight,
		...(opts.glowOptions ?? {}),
	};
	const glowTex = makeLyricGlowTexture(cleaned, mask.fontSize, mask.textWidth, mask.lines, mask.lineHeight, mask.fitScaleX, THREE, glowOptions);
	const glowMatColor = lyricThreeColor(pal.secondary, "#9cffdf", 0.36);
	const glowMat = new THREE.MeshBasicMaterial({
		map: glowTex,
		transparent: true,
		opacity: 0,
		depthWrite: false,
		depthTest: false,
		side: THREE.DoubleSide,
		blending: THREE.AdditiveBlending,
		color: rgbToThreeColor(THREE, glowMatColor) ?? glowMatColor,
	} as THREE.MeshBasicMaterialParameters) as THREE.MeshBasicMaterial;
	const glowMeta = (glowTex as unknown as { userData?: { width?: number; height?: number; textWidth?: number } } | null)?.userData ?? {};
	const glowWorldW0 = textWorldW * ((glowMeta.width || mask.width) / Math.max(1, glowMeta.textWidth || mask.textWidth));
	const glowWorldW = Math.min(worldW * 1.1, Math.max(textWorldW + worldH * 0.38, glowWorldW0));
	const glowWorldH0 = worldH * ((glowMeta.height || mask.height) / mask.height);
	const glowWorldH = Math.min(worldH * 1.42, Math.max(worldH * 0.92, glowWorldH0));
	const glow = new THREE.Mesh(new THREE.PlaneGeometry(glowWorldW, glowWorldH, 1, 1) as THREE.PlaneGeometry, glowMat) as THREE.Mesh;
	(glow as unknown as { renderOrder: number }).renderOrder = 41;
	glow.scale.set(1, 1.06, 1);
	group.add(glow);

	const readabilityOptions: LyricReadabilityTextureOptions = {
		lyricFont: opts.lyricFont,
		lyricLetterSpacing: opts.lyricLetterSpacing,
		lyricLineHeight: opts.lyricLineHeight,
		...(opts.readabilityOptions ?? {}),
	};
	const readabilityTex = makeLyricReadabilityTexture(mask, THREE, readabilityOptions);
	const readabilityMat = new THREE.MeshBasicMaterial({
		map: readabilityTex,
		transparent: true,
		opacity: 0,
		depthWrite: false,
		depthTest: false,
		side: THREE.DoubleSide,
	} as THREE.MeshBasicMaterialParameters) as THREE.MeshBasicMaterial;
	const readability = new THREE.Mesh(new THREE.PlaneGeometry(worldW, worldH, 1, 1) as THREE.PlaneGeometry, readabilityMat) as THREE.Mesh;
	(readability as unknown as { renderOrder: number }).renderOrder = 42;
	readability.position.set(0, 0, -0.012);
	group.add(readability);

	const shaderOpts: LyricShaderMaterialOptions = { lyricsHasNativeKaraoke: opts.lyricsHasNativeKaraoke };
	const { material: textMat } = makeLyricShaderMaterial(mask, pal, THREE, shaderOpts);
	const textMesh = new THREE.Mesh(geo, textMat) as THREE.Mesh;
	(textMesh as unknown as { renderOrder: number }).renderOrder = 43;
	group.add(textMesh);

	const dotTex = opts.dotTexture ?? makeDotTexture(THREE);
	const pgeo = new THREE.BufferGeometry() as THREE.BufferGeometry;
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
	const pmat = new THREE.ShaderMaterial({
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
	} as THREE.ShaderMaterialParameters) as THREE.ShaderMaterial;
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

	updateLyricGroupProgress(
		{
			group,
			textMat,
		},
		0,
	);

	return {
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
	};
}

export function updateLyricGroupProgress(lyric: Pick<LyricGroup, "textMat" | "group">, progress: number): void {
	const p = Math.max(0, Math.min(1, Number(progress) || 0));
	const u = (lyric.textMat as unknown as { uniforms: { uProgress: { value: number } } }).uniforms;
	u.uProgress.value = p;
	(lyric.group as unknown as { userData: Record<string, unknown> }).userData.lastLyricProgress = p;
}

export function disposeLyricGroup(lyric: LyricGroup): void {
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
	disposeTexture(lyric.mask.texture);
	disposeTexture((lyric.glowMat as unknown as { map?: { dispose?: () => void } }).map);
	disposeTexture((lyric.readabilityMat as unknown as { map?: { dispose?: () => void } }).map);
	disposeTexture((lyric.sparkMat as unknown as { uniforms: { uMap: { value: { dispose?: () => void } } } }).uniforms.uMap.value);
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