import type * as THREE from "three";
import type { ThreeModule } from "../runtime/renderer-setup";
import type { LyricMaskResult } from "./lyric-mask";
import { lyricThreeColor, type RGB } from "./color-utils";
import type { LyricPalette } from "./palette";

export interface LyricShaderMaterialOptions {
	lyricsHasNativeKaraoke?: boolean;
}

const LYRIC_VERTEX_SHADER = "varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }";

const LYRIC_FRAGMENT_SHADER = [
	"precision highp float;",
	"uniform sampler2D uMap;",
	"uniform float uProgress,uTextMin,uTextMax,uOpacity,uFeather,uSolar;",
	"uniform vec3 uBaseColor,uHiColor,uGlowColor,uSolarColor;",
	"varying vec2 vUv;",
	"void main(){",
	"  vec2 uv = gl_FrontFacing ? vUv : vec2(1.0 - vUv.x, vUv.y);",
	"  float mask = texture2D(uMap, uv).a;",
	"  if(mask < 0.01) discard;",
	"  float denom = max(0.001, uTextMax - uTextMin);",
	"  float p = clamp((uv.x - uTextMin) / denom, 0.0, 1.0);",
	"  float filled = 1.0 - smoothstep(uProgress, uProgress + uFeather, p);",
	"  float edge = 1.0 - smoothstep(0.0, uFeather * 2.8, abs(p - uProgress));",
	"  vec3 color = mix(uBaseColor, uHiColor, filled * 0.88);",
	"  color += uGlowColor * edge * 0.14;",
	"  vec3 solar = uSolarColor;",
	"  color = mix(color, color + solar * 0.34, uSolar * (0.25 + filled * 0.45));",
	"  color += solar * edge * uSolar * 0.22;",
	"  float lum = dot(color, vec3(0.299, 0.587, 0.114));",
	"  color += vec3(max(0.0, 0.30 - lum));",
	"  gl_FragColor = vec4(color, mask * uOpacity);",
	"}",
].join("\n");

export interface LyricShaderMaterialResult {
	material: THREE.ShaderMaterial;
	vertexShader: string;
	fragmentShader: string;
}

export function makeLyricShaderMaterial(
	mask: LyricMaskResult,
	pal: LyricPalette,
	THREE: ThreeModule,
	opts: LyricShaderMaterialOptions = {},
): LyricShaderMaterialResult {
	const native = !!opts.lyricsHasNativeKaraoke;
	const uBaseColor: RGB = lyricThreeColor(pal.primary, "#d6f8ff", 0.38);
	const uHiColor: RGB = lyricThreeColor(pal.highlight || pal.primary, "#fff0b8", 0.48);
	const uGlowColor: RGB = lyricThreeColor(pal.glowColor || pal.secondary, "#9cffdf", 0.36);
	const uSolarColor: RGB = lyricThreeColor(pal.highlight || pal.secondary || pal.primary, "#fff0b8", 0.5);
	const baseColor = (typeof THREE.Color === "function" ? new THREE.Color(uBaseColor.r, uBaseColor.g, uBaseColor.b) : null) as THREE.Color | null;
	const hiColor = (typeof THREE.Color === "function" ? new THREE.Color(uHiColor.r, uHiColor.g, uHiColor.b) : null) as THREE.Color | null;
	const glowColor = (typeof THREE.Color === "function" ? new THREE.Color(uGlowColor.r, uGlowColor.g, uGlowColor.b) : null) as THREE.Color | null;
	const solarColor = (typeof THREE.Color === "function" ? new THREE.Color(uSolarColor.r, uSolarColor.g, uSolarColor.b) : null) as THREE.Color | null;
	const material = new THREE.ShaderMaterial({
		uniforms: {
			uMap: { value: mask.texture },
			uProgress: { value: 0 },
			uTextMin: { value: mask.textMin },
			uTextMax: { value: mask.textMax },
			uOpacity: { value: 0 },
			uBaseColor: { value: baseColor ?? uBaseColor },
			uHiColor: { value: hiColor ?? uHiColor },
			uGlowColor: { value: glowColor ?? uGlowColor },
			uSolarColor: { value: solarColor ?? uSolarColor },
			uFeather: { value: native ? 0.03 : 0.055 },
			uSolar: { value: 0 },
		},
		vertexShader: LYRIC_VERTEX_SHADER,
		fragmentShader: LYRIC_FRAGMENT_SHADER,
		transparent: true,
		depthWrite: false,
		depthTest: false,
		side: THREE.DoubleSide,
	} as THREE.ShaderMaterialParameters);
	return { material, vertexShader: LYRIC_VERTEX_SHADER, fragmentShader: LYRIC_FRAGMENT_SHADER };
}

export { LYRIC_FRAGMENT_SHADER, LYRIC_VERTEX_SHADER };