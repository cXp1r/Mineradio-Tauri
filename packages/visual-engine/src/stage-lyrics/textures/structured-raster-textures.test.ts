import { expect, test } from "bun:test";
import "../../runtime/happy-dom-preload";
import type { ThreeModule } from "../../runtime/renderer-setup";
import { makeLyricGlowTexture } from "../lyric-glow";
import { makeLyricMask } from "../lyric-mask";
import { makeLyricReadabilityTexture } from "../lyric-readability";

function makeFakeThree(): ThreeModule {
	const CanvasTexture = function (image: HTMLCanvasElement) {
		return {
			image,
			isTexture: true,
			minFilter: 0,
			magFilter: 0,
			generateMipmaps: false,
			anisotropy: 1,
			dispose() {},
		};
	} as unknown as ThreeModule["CanvasTexture"];
	return {
		CanvasTexture,
		LinearFilter: 1006,
	} as unknown as ThreeModule;
}

function makeCanvasDocument(): Document {
	return {
		createElement(tagName: string) {
			if (tagName !== "canvas") throw new Error(`Unexpected element: ${tagName}`);
			const context = new Proxy<Record<string, unknown>>({}, {
				get(_target, property) {
					if (property === "measureText") return (text: string) => ({ width: text.length * 64 });
					if (property === "createLinearGradient") return () => ({ addColorStop() {} });
					return () => {};
			},
				set(target, property, value) {
					target[String(property)] = value;
					return true;
			},
			});
			return {
				width: 0,
				height: 0,
				getContext: () => context,
			};
		},
	} as unknown as Document;
}

test("structured glow and readability preserve row metrics at bounded auxiliary resolution", () => {
	const originalDocument = globalThis.document;
	Object.defineProperty(globalThis, "document", {
		configurable: true,
		value: makeCanvasDocument(),
	});
	try {
		const THREE = makeFakeThree();
		const mask = makeLyricMask("fallback", THREE, {
		structuredRows: [
			{ key: "current", text: "当前句", alpha: 1, scale: 1, translationLine: false, active: true, offset: 0 },
			{ key: "translation", text: "Current line", alpha: 0.72, scale: 0.7, weight: 650, translationLine: true, active: false, offset: 1.35 },
			{ key: "next", text: "下一句", alpha: 0.42, scale: 0.82, translationLine: false, active: false, offset: 2.5 },
		],
		});
		const readability = makeLyricReadabilityTexture(mask, THREE);
		const glow = makeLyricGlowTexture(
		"fallback",
		mask.fontSize,
		mask.textWidth,
		mask.lines,
		mask.lineHeight,
		mask.fitScaleX,
		THREE,
		{
			structuredRows: mask.rasterRows,
			canvasWidth: mask.width,
			canvasHeight: mask.height,
		},
		);

		expect(mask.rasterRows).toHaveLength(3);
		expect(mask.width).toBe(1024);
		expect((readability as unknown as { image: HTMLCanvasElement }).image.width).toBe(Math.round(mask.width * 0.4));
		expect((readability as unknown as { image: HTMLCanvasElement }).image.height).toBe(Math.round(mask.height * 0.4));
		expect((glow as unknown as { image: HTMLCanvasElement }).image.width).toBe(Math.round(mask.width * 0.4));
		expect((glow as unknown as { image: HTMLCanvasElement }).image.height).toBe(Math.round(mask.height * 0.4));
	} finally {
		Object.defineProperty(globalThis, "document", {
			configurable: true,
			value: originalDocument,
		});
	}
});
