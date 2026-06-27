import { expect, test } from "bun:test";
import "../runtime/happy-dom-preload";
import type { ThreeModule } from "../runtime/renderer-setup";
import { makeLyricMask } from "./lyric-mask";
import { makeLyricShaderMaterial, LYRIC_FRAGMENT_SHADER, LYRIC_VERTEX_SHADER } from "./lyric-shader-material";
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

test("makeLyricShaderMaterial exposes baseline uniform names", () => {
	const mask = makeLyricMask("hello", makeFakeThree());
	const { material } = makeLyricShaderMaterial(mask, DEFAULT_LYRIC_PALETTE, makeFakeThree());
	const uniforms = (material as unknown as { uniforms: Record<string, { value: unknown }> }).uniforms;
	const expectedNames = [
		"uMap", "uProgress", "uTextMin", "uTextMax", "uOpacity",
		"uBaseColor", "uHiColor", "uGlowColor", "uSolarColor",
		"uFeather", "uSolar",
	];
	for (const name of expectedNames) {
		expect(Object.prototype.hasOwnProperty.call(uniforms, name)).toBe(true);
	}
	expect(Object.keys(uniforms).length).toBe(expectedNames.length);
});

test("makeLyricShaderMaterial initial uniform values match baseline 8769-8778", () => {
	const mask = makeLyricMask("hello", makeFakeThree());
	const THREE = makeFakeThree();
	const { material } = makeLyricShaderMaterial(mask, DEFAULT_LYRIC_PALETTE, THREE);
	const u = (material as unknown as { uniforms: Record<string, { value: number | unknown }> }).uniforms;
	expect(u.uProgress.value).toBe(0);
	expect(u.uOpacity.value).toBe(0);
	expect(u.uTextMin.value).toBeCloseTo(mask.textMin, 6);
	expect(u.uTextMax.value).toBeCloseTo(mask.textMax, 6);
	expect(u.uFeather.value).toBe(0.055);
	expect(u.uSolar.value).toBe(0);
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

test("makeLyricShaderMaterial fragmentShader ported verbatim (22 lines, all uniforms present)", () => {
	expect(LYRIC_FRAGMENT_SHADER.split("\n").length).toBe(22);
	expect(LYRIC_FRAGMENT_SHADER).toContain("uProgress");
	expect(LYRIC_FRAGMENT_SHADER).toContain("uFeather");
	expect(LYRIC_FRAGMENT_SHADER).toContain("uSolar");
	expect(LYRIC_FRAGMENT_SHADER).toContain("uSolarColor");
	expect(LYRIC_FRAGMENT_SHADER).toContain("gl_FrontFacing");
	expect(LYRIC_FRAGMENT_SHADER).toContain("smoothstep(uProgress, uProgress + uFeather, p)");
	expect(LYRIC_FRAGMENT_SHADER).toContain("gl_FragColor = vec4(color, mask * uOpacity);");
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