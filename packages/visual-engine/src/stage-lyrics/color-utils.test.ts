import { expect, test } from "bun:test";
import "../runtime/happy-dom-preload";
import { cssColorToThreeColor, lyricThreeColor } from "./color-utils";
import { DEFAULT_LYRIC_PALETTE, resolveLyricPalette } from "./palette";

test("cssColorToThreeColor parses #ffffff and #fff to {1,1,1}", () => {
	expect(cssColorToThreeColor("#ffffff")).toEqual({ r: 1, g: 1, b: 1 });
	expect(cssColorToThreeColor("#fff")).toEqual({ r: 1, g: 1, b: 1 });
});

test("cssColorToThreeColor parses #000000 to {0,0,0}", () => {
	expect(cssColorToThreeColor("#000000")).toEqual({ r: 0, g: 0, b: 0 });
	expect(cssColorToThreeColor("#000")).toEqual({ r: 0, g: 0, b: 0 });
});

test("cssColorToThreeColor parses rgba() triple to 0..1 floats", () => {
	const c = cssColorToThreeColor("rgba(255,0,128,1)");
	expect(c.r).toBeCloseTo(1, 4);
	expect(c.g).toBeCloseTo(0, 4);
	expect(c.b).toBeCloseTo(128 / 255, 4);
});

test("cssColorToThreeColor falls back when given garbage", () => {
	const c = cssColorToThreeColor("not a color", "#d6f8ff");
	expect(c.r).toBeCloseTo(0xd6 / 255, 4);
	expect(c.g).toBeCloseTo(0xf8 / 255, 4);
	expect(c.b).toBeCloseTo(1, 4);
});

test("cssColorToThreeColor defaults to #d6f8ff when both are absent", () => {
	const c = cssColorToThreeColor(undefined);
	expect(c.r).toBeCloseTo(0xd6 / 255, 4);
	expect(c.g).toBeCloseTo(0xf8 / 255, 4);
	expect(c.b).toBeCloseTo(1, 4);
});

test("cssColorToThreeColor named colors", () => {
	expect(cssColorToThreeColor("white")).toEqual({ r: 1, g: 1, b: 1 });
	expect(cssColorToThreeColor("black")).toEqual({ r: 0, g: 0, b: 0 });
	expect(cssColorToThreeColor("red")).toEqual({ r: 1, g: 0, b: 0 });
});

test("lyricThreeColor lifts dark colors up to minLum", () => {
	const c = lyricThreeColor("#000", undefined, 0.5);
	expect(c.r).toBeCloseTo(0.5, 4);
	expect(c.g).toBeCloseTo(0.5, 4);
	expect(c.b).toBeCloseTo(0.5, 4);
});

test("lyricThreeColor leaves already-bright colors untouched", () => {
	const c = lyricThreeColor("#ffffff", undefined, 0.34);
	expect(c).toEqual({ r: 1, g: 1, b: 1 });
});

test("lyricThreeColor uses default floor 0.34", () => {
	const c = lyricThreeColor("#202020", undefined);
	expect(c.r).toBeCloseTo(0.34, 4);
	expect(c.g).toBeCloseTo(0.34, 4);
	expect(c.b).toBeCloseTo(0.34, 4);
});

test("DEFAULT_LYRIC_PALETTE matches baseline defaults", () => {
	expect(DEFAULT_LYRIC_PALETTE.primary).toBe("#d6f8ff");
	expect(DEFAULT_LYRIC_PALETTE.secondary).toBe("#9cffdf");
	expect(DEFAULT_LYRIC_PALETTE.highlight).toBe("#fff0b8");
	expect(DEFAULT_LYRIC_PALETTE.glowColor).toBe("#9cffdf");
});

test("resolveLyricPalette fills partial inputs with defaults", () => {
	const p = resolveLyricPalette({ highlight: "#ff0000" });
	expect(p.primary).toBe("#d6f8ff");
	expect(p.highlight).toBe("#ff0000");
	expect(p.glowColor).toBe("#9cffdf");
});

test("resolveLyricPalette ignores blank/whitespace entries", () => {
	const p = resolveLyricPalette({ primary: "  ", secondary: "" });
	expect(p.primary).toBe("#d6f8ff");
	expect(p.secondary).toBe("#9cffdf");
});