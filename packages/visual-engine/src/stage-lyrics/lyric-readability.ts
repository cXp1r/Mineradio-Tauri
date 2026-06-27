import type * as THREE from "three";
import type { ThreeModule } from "../runtime/renderer-setup";
import type { LyricMaskResult } from "./lyric-mask";
import { lyricFontCss, lyricLineHeightFactor, lyricStrokeText, type LyricTextOptions } from "./lyric-text";

export interface LyricReadabilityTextureOptions extends LyricTextOptions {
	maxAnisotropy?: number;
}

export function makeLyricReadabilityTexture(
	mask: LyricMaskResult,
	THREE: ThreeModule,
	opts: LyricReadabilityTextureOptions = {},
): THREE.Texture | null {
	if (typeof document === "undefined") return null;
	const W = mask?.width || 2048;
	const H = mask?.height || 384;
	const fontSize = mask?.fontSize || 128;
	const lines = mask && Array.isArray(mask.lines) && mask.lines.length ? mask.lines : [""];
	const lineHeight = mask?.lineHeight || fontSize * lyricLineHeightFactor(opts);
	const fitScaleX = mask?.fitScaleX ?? 1;
	const textOpts: LyricTextOptions = {
		lyricFont: opts.lyricFont,
		lyricLetterSpacing: opts.lyricLetterSpacing,
		lyricLineHeight: opts.lyricLineHeight,
	};
	const canvas = document.createElement("canvas");
	canvas.width = W;
	canvas.height = H;
	const ctx = canvas.getContext("2d") as CanvasRenderingContext2D | null;
	if (!ctx) return null;
	ctx.clearRect(0, 0, W, H);
	ctx.font = lyricFontCss(fontSize, textOpts);
	ctx.textAlign = "center";
	ctx.textBaseline = "alphabetic";
	ctx.lineJoin = "round";
	ctx.lineCap = "round";
	ctx.miterLimit = 2;
	const blockH = fontSize + (lines.length - 1) * lineHeight;
	const y0 = H / 2 - blockH / 2 + fontSize * 0.82;
	const strokeLines = (dx: number, dy: number) => {
		for (let i = 0; i < lines.length; i++) {
			const y = y0 + i * lineHeight + (dy || 0);
			if (fitScaleX < 1) {
				ctx.save();
				ctx.translate(W / 2 + (dx || 0), 0);
				ctx.scale(fitScaleX, 1);
				lyricStrokeText(ctx, lines[i], 0, y, fontSize, textOpts);
				ctx.restore();
			} else {
				lyricStrokeText(ctx, lines[i], W / 2 + (dx || 0), y, fontSize, textOpts);
			}
		}
	};
	ctx.save();
	(ctx as unknown as { filter: string }).filter = "blur(14px)";
	ctx.globalAlpha = 0.18;
	ctx.lineWidth = Math.max(18, fontSize * 0.16);
	ctx.strokeStyle = "rgba(0,0,0,1)";
	strokeLines(0, fontSize * 0.018);
	ctx.restore();
	ctx.save();
	(ctx as unknown as { filter: string }).filter = "blur(5px)";
	ctx.globalAlpha = 0.32;
	ctx.lineWidth = Math.max(9, fontSize * 0.075);
	ctx.strokeStyle = "rgba(0,0,0,1)";
	strokeLines(0, fontSize * 0.012);
	ctx.restore();
	ctx.save();
	(ctx as unknown as { filter: string }).filter = "blur(4px)";
	ctx.globalAlpha = 0.15;
	ctx.lineWidth = Math.max(9, fontSize * 0.07);
	ctx.strokeStyle = "rgba(255,255,255,1)";
	strokeLines(0, 0);
	ctx.restore();
	ctx.save();
	(ctx as unknown as { filter: string }).filter = "blur(1.2px)";
	ctx.globalAlpha = 0.26;
	ctx.lineWidth = Math.max(3.2, fontSize * 0.03);
	ctx.strokeStyle = "rgba(255,255,255,1)";
	strokeLines(0, 0);
	ctx.restore();
	if (typeof THREE.CanvasTexture !== "function") return null;
	const tex = new THREE.CanvasTexture(canvas) as THREE.Texture;
	(tex as unknown as { minFilter: number }).minFilter = THREE.LinearFilter;
	(tex as unknown as { magFilter: number }).magFilter = THREE.LinearFilter;
	(tex as unknown as { generateMipmaps: boolean }).generateMipmaps = false;
	(tex as unknown as { anisotropy: number }).anisotropy = Math.min(8, opts.maxAnisotropy ?? 1);
	return tex;
}