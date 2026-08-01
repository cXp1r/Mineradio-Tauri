import type * as THREE from "three";
import type { ThreeModule } from "../runtime/renderer-setup";
import type { LyricMaskResult } from "./lyric-mask";
import { lyricThreeColor, type RGB } from "./color-utils";
import {
	createStageLyricMotionProfile,
	type StageLyricMotionProfile,
} from "./motion/stage-lyric-motion-profile";
import type { LyricPalette } from "./palette";

export interface LyricShaderMaterialOptions {
	lyricsHasNativeKaraoke?: boolean;
	motionProfile?: Readonly<StageLyricMotionProfile>;
	motionSeed?: number;
	timeUniform?: THREE.IUniform<number>;
}

const LYRIC_VERTEX_SHADER = "varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }";

const LYRIC_FRAGMENT_SHADER = [
	"precision highp float;",
	"uniform sampler2D uMap;",
	"uniform float uTime,uProgress,uTextMin,uTextMax,uActiveYMin,uActiveYMax,uOpacity,uFeather,uSolar,uSweep,uShimmer,uGlitch,uGlitchSlice,uGlitchChroma,uGlitchRate,uGlitchSeed,uGlitchBurst,uEdgeBoost,uActiveMix;",
	"uniform vec3 uBaseColor,uHiColor,uGlowColor,uSolarColor;",
	"varying vec2 vUv;",
	"float hash(float n){ return fract(sin(n) * 43758.5453123); }",
	"float hash2(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453123); }",
	"void main(){",
	"  vec2 uv = gl_FrontFacing ? vUv : vec2(1.0 - vUv.x, vUv.y);",
	"  float rasterY = 1.0 - uv.y;",
	"  float activeRowGate = step(uActiveYMin, rasterY) * step(rasterY, uActiveYMax);",
	"  float sliceRows = mix(16.0, 38.0, clamp(uGlitchSlice / 1.4, 0.0, 1.0));",
	"  float row = floor((uv.y + hash(uGlitchSeed) * 0.035) * sliceRows);",
	"  float timeSlot = floor(uTime * mix(7.0, 24.0, clamp(uGlitchRate / 2.2, 0.0, 1.0)) + hash(uGlitchSeed * 1.37) * 5.0);",
	"  float rowRnd = hash2(vec2(row + uGlitchSeed, timeSlot));",
	"  float phaseRnd = hash2(vec2(timeSlot + uGlitchSeed * 0.71, row * 3.17));",
	"  float glitchGate = smoothstep(0.74, 0.99, rowRnd + uGlitchBurst * 0.28) * step(0.001, uGlitch);",
	"  float glitchDir = hash2(vec2(row * 5.11, timeSlot + uGlitchSeed)) < 0.5 ? -1.0 : 1.0;",
	"  float micro = hash2(vec2(floor(uv.x * 19.0) + row, timeSlot * 1.31 + uGlitchSeed));",
	"  float glitchWave = (phaseRnd * 2.0 - 1.0) * (0.55 + micro * 0.95);",
	"  float glitchWidth = (0.0020 + rowRnd * rowRnd * 0.0085) * (0.55 + uGlitchBurst * 1.85);",
	"  vec2 sampleUv = uv + vec2(glitchGate * glitchDir * glitchWave * uGlitch * uGlitchSlice * glitchWidth, 0.0);",
	"  float mask = texture2D(uMap, sampleUv).a;",
	"  if(mask < 0.01) discard;",
	"  float activeMix = clamp(uActiveMix, 0.0, 1.0) * activeRowGate;",
	"  float denom = max(0.001, uTextMax - uTextMin);",
	"  float p = clamp((uv.x - uTextMin) / denom, 0.0, 1.0);",
	"  float filled = (1.0 - smoothstep(uProgress, uProgress + uFeather, p)) * activeMix;",
	"  float edge = (1.0 - smoothstep(0.0, uFeather * 2.8, abs(p - uProgress))) * activeMix;",
	"  float sweepPhase = fract(uTime * (0.28 + uSweep * 0.10));",
	"  float sweepLine = (1.0 - smoothstep(0.0, 0.080, abs((uv.x + uv.y * 0.42) - (sweepPhase * 1.42 - 0.18)))) * activeMix;",
	"  float fineLine = pow(max(0.0, sin((uv.x - uv.y * 0.18 + uTime * 0.82) * 42.0)), 24.0) * uShimmer * activeMix;",
	"  float chromaOffset = (0.0028 + phaseRnd * 0.0048 + uGlitchBurst * 0.0038) * uGlitch * uGlitchChroma;",
	"  float chromaR = texture2D(uMap, sampleUv + vec2(chromaOffset * glitchDir, 0.0)).a;",
	"  float chromaB = texture2D(uMap, sampleUv - vec2(chromaOffset * glitchDir, 0.0)).a;",
	"  vec3 color = mix(uBaseColor, uHiColor, filled * 0.88);",
	"  color += uGlowColor * edge * 0.14 * uEdgeBoost;",
	"  color += uSolarColor * sweepLine * uSweep * (0.12 + filled * 0.30);",
	"  color += uGlowColor * fineLine * (0.08 + filled * 0.18);",
	"  color += vec3(chromaR, mask * 0.18, chromaB) * glitchGate * uGlitch * uGlitchChroma * activeMix * (0.20 + uGlitchBurst * 0.22);",
	"  vec3 solar = uSolarColor;",
	"  color = mix(color, color + solar * 0.34, uSolar * activeMix * (0.25 + filled * 0.45));",
	"  color += solar * edge * uSolar * 0.22;",
	"  float lum = dot(color, vec3(0.299, 0.587, 0.114));",
	"  color += vec3(max(0.0, 0.30 - lum));",
	"  float alpha = max(mask, max(chromaR, chromaB) * glitchGate * uGlitch * (0.30 + uGlitchBurst * 0.32));",
	"  gl_FragColor = vec4(color, alpha * uOpacity);",
	"}",
].join("\n");

type LyricShaderColor = THREE.Color | RGB;

export interface LyricShaderMaterialUniforms extends Record<string, THREE.IUniform> {
	readonly uMap: THREE.IUniform<THREE.Texture | null>;
	readonly uTime: THREE.IUniform<number>;
	readonly uProgress: THREE.IUniform<number>;
	readonly uTextMin: THREE.IUniform<number>;
	readonly uTextMax: THREE.IUniform<number>;
	readonly uActiveYMin: THREE.IUniform<number>;
	readonly uActiveYMax: THREE.IUniform<number>;
	readonly uOpacity: THREE.IUniform<number>;
	readonly uBaseColor: THREE.IUniform<LyricShaderColor>;
	readonly uHiColor: THREE.IUniform<LyricShaderColor>;
	readonly uGlowColor: THREE.IUniform<LyricShaderColor>;
	readonly uSolarColor: THREE.IUniform<LyricShaderColor>;
	readonly uFeather: THREE.IUniform<number>;
	readonly uSolar: THREE.IUniform<number>;
	readonly uSweep: THREE.IUniform<number>;
	readonly uShimmer: THREE.IUniform<number>;
	readonly uGlitch: THREE.IUniform<number>;
	readonly uGlitchSlice: THREE.IUniform<number>;
	readonly uGlitchChroma: THREE.IUniform<number>;
	readonly uGlitchRate: THREE.IUniform<number>;
	readonly uGlitchSeed: THREE.IUniform<number>;
	readonly uGlitchBurst: THREE.IUniform<number>;
	readonly uEdgeBoost: THREE.IUniform<number>;
	readonly uActiveMix: THREE.IUniform<number>;
}

export interface LyricShaderMaterialResult {
	material: THREE.ShaderMaterial;
	vertexShader: string;
	fragmentShader: string;
	uniforms: LyricShaderMaterialUniforms;
	motionProfile: Readonly<StageLyricMotionProfile>;
}

function resolveActiveRowBounds(mask: LyricMaskResult): readonly [number, number] {
	const rawMin = Number(mask.activeYMin);
	const rawMax = Number(mask.activeYMax);
	if (!Number.isFinite(rawMin) || !Number.isFinite(rawMax) || rawMax <= rawMin) return [0, 1];
	const min = Math.max(0, Math.min(1, rawMin));
	const max = Math.max(0, Math.min(1, rawMax));
	return max > min ? [min, max] : [0, 1];
}

export function makeLyricShaderMaterial(
	mask: LyricMaskResult,
	pal: LyricPalette,
	THREE: ThreeModule,
	opts: LyricShaderMaterialOptions = {},
): LyricShaderMaterialResult {
	const native = !!opts.lyricsHasNativeKaraoke;
	const motionProfile = opts.motionProfile ?? createStageLyricMotionProfile(undefined, {
		lyricsHasNativeKaraoke: native,
	});
	const timeUniform = opts.timeUniform ?? { value: 0 };
	const motionSeed = Number.isFinite(opts.motionSeed)
		? Number(opts.motionSeed)
		: Math.random() * 997;
	const [activeYMin, activeYMax] = resolveActiveRowBounds(mask);
	const uBaseColor: RGB = lyricThreeColor(pal.primary, "#d6f8ff", 0.38);
	const uHiColor: RGB = lyricThreeColor(pal.highlight || pal.primary, "#fff0b8", 0.48);
	const uGlowColor: RGB = lyricThreeColor(pal.glowColor || pal.secondary, "#9cffdf", 0.36);
	const uSolarColor: RGB = lyricThreeColor(pal.highlight || pal.secondary || pal.primary, "#fff0b8", 0.5);
	const baseColor = (typeof THREE.Color === "function" ? new THREE.Color(uBaseColor.r, uBaseColor.g, uBaseColor.b) : null) as THREE.Color | null;
	const hiColor = (typeof THREE.Color === "function" ? new THREE.Color(uHiColor.r, uHiColor.g, uHiColor.b) : null) as THREE.Color | null;
	const glowColor = (typeof THREE.Color === "function" ? new THREE.Color(uGlowColor.r, uGlowColor.g, uGlowColor.b) : null) as THREE.Color | null;
	const solarColor = (typeof THREE.Color === "function" ? new THREE.Color(uSolarColor.r, uSolarColor.g, uSolarColor.b) : null) as THREE.Color | null;
	const shaderUniforms: LyricShaderMaterialUniforms = {
		uMap: { value: mask.texture },
		uTime: timeUniform,
		uProgress: { value: 0 },
		uTextMin: { value: mask.textMin },
		uTextMax: { value: mask.textMax },
		uActiveYMin: { value: activeYMin },
		uActiveYMax: { value: activeYMax },
		uOpacity: { value: 0 },
		uBaseColor: { value: baseColor ?? uBaseColor },
		uHiColor: { value: hiColor ?? uHiColor },
		uGlowColor: { value: glowColor ?? uGlowColor },
		uSolarColor: { value: solarColor ?? uSolarColor },
		uFeather: { value: native ? 0.03 : 0.055 },
		uSolar: { value: 0 },
		uSweep: { value: motionProfile.sweep },
		uShimmer: { value: motionProfile.shimmer },
		uGlitch: { value: motionProfile.glitch },
		uGlitchSlice: { value: motionProfile.glitchSlice },
		uGlitchChroma: { value: motionProfile.glitchChroma },
		uGlitchRate: { value: motionProfile.glitchRate },
		uGlitchSeed: { value: motionSeed },
		uGlitchBurst: { value: 0 },
		uEdgeBoost: { value: motionProfile.edgeBoost },
		uActiveMix: { value: 1 },
	};
	const material = new THREE.ShaderMaterial({
		uniforms: shaderUniforms,
		vertexShader: LYRIC_VERTEX_SHADER,
		fragmentShader: LYRIC_FRAGMENT_SHADER,
		transparent: true,
		depthWrite: false,
		depthTest: false,
		side: THREE.DoubleSide,
	} as THREE.ShaderMaterialParameters);
	return {
		material,
		vertexShader: LYRIC_VERTEX_SHADER,
		fragmentShader: LYRIC_FRAGMENT_SHADER,
		uniforms: shaderUniforms,
		motionProfile,
	};
}

export { LYRIC_FRAGMENT_SHADER, LYRIC_VERTEX_SHADER };
