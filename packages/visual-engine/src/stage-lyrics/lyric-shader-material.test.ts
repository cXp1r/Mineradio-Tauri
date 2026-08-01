import { expect, test } from "bun:test";
import "../runtime/happy-dom-preload";
import type { ThreeModule } from "../runtime/renderer-setup";
import { makeLyricMask } from "./lyric-mask";
import { makeLyricShaderMaterial, LYRIC_FRAGMENT_SHADER, LYRIC_VERTEX_SHADER } from "./lyric-shader-material";
import { normalizeStageLyricsSettings } from "./model/stage-lyrics-settings";
import { createStageLyricMotionProfile } from "./motion/stage-lyric-motion-profile";
import { DEFAULT_LYRIC_PALETTE } from "./palette";

function makeFakeThree(): ThreeModule {
	const Color = function (r: number, g: number, b: number) {
		return { r, g, b, isColor: true, copy(c: { r: number; g: number; b: number }) { (this as { r: number }).r = c.r; (this as { g: number }).g = c.g; (this as { b: number }).b = c.b; } };
	} as unknown as ThreeModule["Color"];
	const ShaderMaterial = function (params: Record<string, unknown>) {
		return {
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
	} as unknown as ThreeModule["ShaderMaterial"];
	const CanvasTexture = function (image: HTMLCanvasElement) {
		return { image, isTexture: true, disposed: false, dispose() { this.disposed = true; } };
	} as unknown as ThreeModule["CanvasTexture"];
	const Texture = function () {
		return { isTexture: true, disposed: false, dispose() { this.disposed = true; } };
	} as unknown as ThreeModule["Texture"];
	return {
		Color,
		ShaderMaterial,
		CanvasTexture,
		Texture,
		LinearFilter: 1006,
		DoubleSide: 2,
		AdditiveBlending: 2,
	} as unknown as ThreeModule;
}

test("makeLyricShaderMaterial exposes the characterized Stage motion uniform surface", () => {
	const mask = makeLyricMask("hello", makeFakeThree());
	const { material } = makeLyricShaderMaterial(mask, DEFAULT_LYRIC_PALETTE, makeFakeThree());
	const uniforms = (material as unknown as { uniforms: Record<string, { value: unknown }> }).uniforms;
	const expectedNames = [
		"uMap", "uTime", "uProgress", "uTextMin", "uTextMax", "uActiveYMin", "uActiveYMax", "uOpacity",
		"uBaseColor", "uHiColor", "uGlowColor", "uSolarColor",
		"uFeather", "uSolar", "uSweep", "uShimmer", "uGlitch",
		"uGlitchSlice", "uGlitchChroma", "uGlitchRate", "uGlitchSeed",
		"uGlitchBurst", "uEdgeBoost", "uActiveMix",
	];
	for (const name of expectedNames) {
		expect(Object.prototype.hasOwnProperty.call(uniforms, name)).toBe(true);
	}
	expect(Object.keys(uniforms).length).toBe(expectedNames.length);
});

test("makeLyricShaderMaterial initializes the default float profile and dormant glitch runtime", () => {
	const mask = makeLyricMask("hello", makeFakeThree());
	const THREE = makeFakeThree();
	const { material } = makeLyricShaderMaterial(mask, DEFAULT_LYRIC_PALETTE, THREE);
	const u = (material as unknown as { uniforms: Record<string, { value: number | unknown }> }).uniforms;
	expect(u.uTime.value).toBe(0);
	expect(u.uProgress.value).toBe(0);
	expect(u.uOpacity.value).toBe(0);
	expect(u.uTextMin.value).toBeCloseTo(mask.textMin, 6);
	expect(u.uTextMax.value).toBeCloseTo(mask.textMax, 6);
	expect(u.uActiveYMin.value).toBe(0);
	expect(u.uActiveYMax.value).toBe(1);
	expect(u.uFeather.value).toBe(0.055);
	expect(u.uSolar.value).toBe(0);
	expect(u.uSweep.value).toBe(0.36);
	expect(u.uShimmer.value).toBe(0.14);
	expect(u.uGlitch.value).toBe(0);
	expect(u.uGlitchSlice.value).toBe(0);
	expect(u.uGlitchChroma.value).toBe(0);
	expect(u.uGlitchRate.value).toBe(1);
	expect(Number(u.uGlitchSeed.value)).toBeGreaterThanOrEqual(0);
	expect(Number(u.uGlitchSeed.value)).toBeLessThan(997);
	expect(u.uGlitchBurst.value).toBe(0);
	expect(u.uEdgeBoost.value).toBe(1.04);
	expect(u.uActiveMix.value).toBe(1);
});

test("makeLyricShaderMaterial maps a typed glitch profile and reuses the runtime time uniform", () => {
	const mask = makeLyricMask("hello", makeFakeThree());
	const timeUniform = { value: 8.25 };
	const motionProfile = createStageLyricMotionProfile(normalizeStageLyricsSettings({
		motionStyle: "glitch",
		glitchIntensity: 1.25,
		glitchSlice: 1.1,
		glitchChroma: 1.4,
		glitchRate: 1.8,
	}));
	const result = makeLyricShaderMaterial(mask, DEFAULT_LYRIC_PALETTE, makeFakeThree(), {
		motionProfile,
		motionSeed: 313.5,
		timeUniform,
	});
	const u = (result.material as unknown as { uniforms: Record<string, { value: number | unknown }> }).uniforms;

	expect((result.material as unknown as { uniforms: Record<string, unknown> }).uniforms.uTime).toBe(timeUniform);
	expect(result.motionProfile).toBe(motionProfile);
	expect({
		sweep: u.uSweep.value,
		shimmer: u.uShimmer.value,
		glitch: u.uGlitch.value,
		slice: u.uGlitchSlice.value,
		chroma: u.uGlitchChroma.value,
		rate: u.uGlitchRate.value,
		seed: u.uGlitchSeed.value,
		burst: u.uGlitchBurst.value,
		edgeBoost: u.uEdgeBoost.value,
		activeMix: u.uActiveMix.value,
	}).toEqual({
		sweep: 0.54,
		shimmer: 0.28,
		glitch: 1.25,
		slice: 1.1,
		chroma: 1.4,
		rate: 1.8,
		seed: 313.5,
		burst: 0,
		edgeBoost: 1.18,
		activeMix: 1,
	});
});

test("makeLyricShaderMaterial uFeather=0.030 when lyricsHasNativeKaraoke=true", () => {
	const mask = makeLyricMask("hello", makeFakeThree());
	const { material } = makeLyricShaderMaterial(mask, DEFAULT_LYRIC_PALETTE, makeFakeThree(), { lyricsHasNativeKaraoke: true });
	const u = (material as unknown as { uniforms: Record<string, { value: number }> }).uniforms;
	expect(u.uFeather.value).toBe(0.03);
});

test("makeLyricShaderMaterial vertexShader matches baseline 8780", () => {
	expect(LYRIC_VERTEX_SHADER).toBe("varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }");
	const mask = makeLyricMask("hello", makeFakeThree());
	const { material } = makeLyricShaderMaterial(mask, DEFAULT_LYRIC_PALETTE, makeFakeThree());
	expect((material as unknown as { vertexShader: string }).vertexShader).toBe(LYRIC_VERTEX_SHADER);
});

test("makeLyricShaderMaterial fragmentShader exposes the characterized motion and glitch paths", () => {
	expect(LYRIC_FRAGMENT_SHADER).toContain("uProgress");
	expect(LYRIC_FRAGMENT_SHADER).toContain("uFeather");
	expect(LYRIC_FRAGMENT_SHADER).toContain("uSolar");
	expect(LYRIC_FRAGMENT_SHADER).toContain("uSolarColor");
	expect(LYRIC_FRAGMENT_SHADER).toContain("uTime");
	expect(LYRIC_FRAGMENT_SHADER).toContain("uSweep");
	expect(LYRIC_FRAGMENT_SHADER).toContain("uShimmer");
	expect(LYRIC_FRAGMENT_SHADER).toContain("uGlitchSlice");
	expect(LYRIC_FRAGMENT_SHADER).toContain("uGlitchChroma");
	expect(LYRIC_FRAGMENT_SHADER).toContain("uGlitchRate");
	expect(LYRIC_FRAGMENT_SHADER).toContain("uGlitchSeed");
	expect(LYRIC_FRAGMENT_SHADER).toContain("uGlitchBurst");
	expect(LYRIC_FRAGMENT_SHADER).toContain("uEdgeBoost");
	expect(LYRIC_FRAGMENT_SHADER).toContain("uActiveMix");
	expect(LYRIC_FRAGMENT_SHADER).toContain("uActiveYMin");
	expect(LYRIC_FRAGMENT_SHADER).toContain("uActiveYMax");
	expect(LYRIC_FRAGMENT_SHADER).toContain("gl_FrontFacing");
	expect(LYRIC_FRAGMENT_SHADER).toContain("float rasterY = 1.0 - uv.y;");
	expect(LYRIC_FRAGMENT_SHADER).toContain("float activeRowGate = step(uActiveYMin, rasterY) * step(rasterY, uActiveYMax);");
	expect(LYRIC_FRAGMENT_SHADER).toContain("float activeMix = clamp(uActiveMix, 0.0, 1.0) * activeRowGate;");
	expect(LYRIC_FRAGMENT_SHADER).toContain("vec2 sampleUv = uv + vec2(");
	expect(LYRIC_FRAGMENT_SHADER).toContain("float sweepLine =");
	expect(LYRIC_FRAGMENT_SHADER).toContain("float fineLine =");
	expect(LYRIC_FRAGMENT_SHADER).toContain("float chromaR = texture2D(");
	expect(LYRIC_FRAGMENT_SHADER).toContain("float chromaB = texture2D(");
	expect(LYRIC_FRAGMENT_SHADER).toContain("filled = (1.0 - smoothstep(uProgress, uProgress + uFeather, p)) * activeMix");
	expect(LYRIC_FRAGMENT_SHADER).toContain("color += uGlowColor * edge * 0.14 * uEdgeBoost;");
	expect(LYRIC_FRAGMENT_SHADER).toContain("gl_FragColor = vec4(color, alpha * uOpacity);");
	const mask = makeLyricMask("hello", makeFakeThree());
	const { material } = makeLyricShaderMaterial(mask, DEFAULT_LYRIC_PALETTE, makeFakeThree());
	expect((material as unknown as { fragmentShader: string }).fragmentShader).toBe(LYRIC_FRAGMENT_SHADER);
});

test("makeLyricShaderMaterial flags transparent/depthWrite=false/depthTest=false/DoubleSide per baseline 8805", () => {
	const mask = makeLyricMask("hello", makeFakeThree());
	const m = makeLyricShaderMaterial(mask, DEFAULT_LYRIC_PALETTE, makeFakeThree()).material as unknown as {
		transparent: boolean;
		depthWrite: boolean;
		depthTest: boolean;
		side: number;
	};
	expect(m.transparent).toBe(true);
	expect(m.depthWrite).toBe(false);
	expect(m.depthTest).toBe(false);
	expect(m.side).toBe(2);
});
