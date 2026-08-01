import { expect, test } from "bun:test";
import "../runtime/happy-dom-preload";
import {
	applyStonePrintTexture,
	customLyricFontFamily,
	lyricFontCss,
	normalizeFontKey,
	resolveFontConfig,
} from "./lyric-text";

test("stone-song uses baseline forced 900 weight regardless of supplied lyricWeight", () => {
	expect(resolveFontConfig({ lyricFont: "stone-song", lyricWeight: 500 }).weight).toBe(900);
	expect(lyricFontCss(128, { lyricFont: "stone-song", lyricWeight: 500 })).toMatch(/^900 128px /);
});

test("unknown lyric font key falls back to baseline sans key", () => {
	expect(normalizeFontKey("not-a-font")).toBe("sans");
});

test("custom lyric font keys resolve to a stable registered family", () => {
	expect(normalizeFontKey("custom:abc1234")).toBe("custom:abc1234");
	expect(customLyricFontFamily("custom:abc1234")).toBe("MineRadio Custom abc1234");
	expect(resolveFontConfig({ lyricFont: "custom:abc1234" }).stack).toContain("MineRadio Custom abc1234");
});

test("applyStonePrintTexture includes baseline chips scratches and ellipse erosion", () => {
	const calls: string[] = [];
	const ctx = {
		globalCompositeOperation: "source-over",
		globalAlpha: 1,
		imageSmoothingEnabled: true,
		lineCap: "butt",
		lineWidth: 1,
		save: () => calls.push("save"),
		restore: () => calls.push("restore"),
		drawImage: () => calls.push("drawImage"),
		fillRect: () => calls.push("fillRect"),
		translate: () => calls.push("translate"),
		rotate: () => calls.push("rotate"),
		beginPath: () => calls.push("beginPath"),
		moveTo: () => calls.push("moveTo"),
		lineTo: () => calls.push("lineTo"),
		stroke: () => calls.push("stroke"),
		ellipse: () => calls.push("ellipse"),
		fill: () => calls.push("fill"),
	} as unknown as CanvasRenderingContext2D;

	applyStonePrintTexture(ctx, 2048, 384, 128, { lyricFont: "stone-song" });

	expect(calls).toContain("fillRect");
	expect(calls).toContain("lineTo");
	expect(calls).toContain("stroke");
	expect(calls).toContain("ellipse");
	expect(calls).toContain("fill");
});
