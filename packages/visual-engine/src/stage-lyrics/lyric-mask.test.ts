import { expect, test } from "bun:test";
import "../runtime/happy-dom-preload";
import type { ThreeModule } from "../runtime/renderer-setup";
import { makeLyricMask, STAGE_LYRIC_MAX_LINES, LYRIC_MASK_W, LYRIC_MASK_H } from "./lyric-mask";

function makeFakeThree(): ThreeModule {
	const linearFilter = 1006;
	const CanvasTexture = function (image: HTMLCanvasElement) {
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
	} as unknown as ThreeModule["CanvasTexture"];
	const Texture = function () {
		return { isTexture: true, minFilter: 0, magFilter: 0, disposed: false, dispose() { this.disposed = true; } };
	} as unknown as ThreeModule["Texture"];
	return {
		CanvasTexture,
		Texture,
		LinearFilter: linearFilter,
	} as unknown as ThreeModule;
}

test("LYRIC_MASK dimensions and STAGE_LYRIC_MAX_LINES match baseline", () => {
	expect(LYRIC_MASK_W).toBe(2048);
	expect(LYRIC_MASK_H).toBe(384);
	expect(STAGE_LYRIC_MAX_LINES).toBe(1);
});

test("makeLyricMask returns baseline field shape with W=2048 H=384", () => {
	const mask = makeLyricMask("hello world", makeFakeThree());
	expect(mask.width).toBe(2048);
	expect(mask.height).toBe(384);
	expect(mask.lines[0]).toBe("hello world");
	expect(mask.lineCount).toBe(1);
	expect(mask.fitScaleX).toBe(1);
	expect(typeof mask.fontSize).toBe("number");
	expect(mask.fontSize).toBeGreaterThanOrEqual(42);
	expect(mask.fontSize).toBeLessThanOrEqual(128);
	expect(mask.textMin).toBeGreaterThanOrEqual(0);
	expect(mask.textMax).toBeLessThanOrEqual(1);
	expect(mask.textMin).toBeLessThan(mask.textMax);
	expect(mask.texture).not.toBeNull();
});

test("makeLyricMask returns null texture when THREE.CanvasTexture is unavailable", () => {
	const mask = makeLyricMask("hello", {} as unknown as ThreeModule);
	expect(mask.texture).toBeNull();
	expect(mask.width).toBe(2048);
	expect(mask.height).toBe(384);
});

test("makeLyricMask collapses whitespace and trims text", () => {
	const mask = makeLyricMask("   hello   world  ", makeFakeThree());
	expect(mask.lines[0]).toBe("hello world");
});