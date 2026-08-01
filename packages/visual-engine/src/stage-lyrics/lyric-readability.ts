import type * as THREE from "three";
import type { ThreeModule } from "../runtime/renderer-setup";
import type { LyricMaskResult } from "./lyric-mask";
import { lyricFontCss, lyricLineHeightFactor, lyricStrokeText, type LyricTextOptions } from "./lyric-text";

export interface LyricReadabilityTextureOptions extends LyricTextOptions {
	maxAnisotropy?: number;
	structuredScale?: number;
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
	const rasterRows = mask?.rasterRows ?? [];
	const structuredScale = rasterRows.length > 0
		? Math.max(0.25, Math.min(1, Number(opts.structuredScale) || 0.4))
		: 1;
	const textOpts: LyricTextOptions = {
		lyricFont: opts.lyricFont,
		lyricLetterSpacing: opts.lyricLetterSpacing,
		lyricLineHeight: opts.lyricLineHeight,
		lyricWeight: opts.lyricWeight,
	};
	const canvas = document.createElement("canvas");
	canvas.width = Math.max(1, Math.round(W * structuredScale));
	canvas.height = Math.max(1, Math.round(H * structuredScale));
	const canvasWidth = canvas.width;
	const canvasHeight = canvas.height;
	const ctx = canvas.getContext("2d") as CanvasRenderingContext2D | null;
	if (!ctx) return null;
	ctx.clearRect(0, 0, canvasWidth, canvasHeight);
	ctx.font = lyricFontCss(fontSize * structuredScale, textOpts);
	ctx.textAlign = "center";
	ctx.textBaseline = "alphabetic";
	ctx.lineJoin = "round";
	ctx.lineCap = "round";
	ctx.miterLimit = 2;
	const blockH = fontSize + (lines.length - 1) * lineHeight;
	const y0 = H / 2 - blockH / 2 + fontSize * 0.82;
	const strokeLines = (dx: number, dy: number, layerAlpha: number) => {
		if (rasterRows.length > 0) {
			for (const row of rasterRows) {
				const rowOpts = {
					...textOpts,
					...(row.weight === undefined ? {} : { lyricWeight: row.weight }),
				};
				ctx.save();
				ctx.globalAlpha = layerAlpha * row.alpha;
				const rowFontSize = row.fontSize * structuredScale;
				const baselineY = row.baselineY * structuredScale;
				ctx.font = lyricFontCss(rowFontSize, rowOpts);
				if (row.fitScaleX < 1) {
					ctx.translate(canvasWidth / 2 + dx, 0);
					ctx.scale(row.fitScaleX, 1);
					lyricStrokeText(ctx, row.text, 0, baselineY + dy, rowFontSize, rowOpts);
				} else {
					lyricStrokeText(ctx, row.text, canvasWidth / 2 + dx, baselineY + dy, rowFontSize, rowOpts);
				}
				ctx.restore();
			}
			return;
		}
		ctx.globalAlpha = layerAlpha;
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
	const effectFontSize = fontSize * structuredScale;
	ctx.save();
	(ctx as unknown as { filter: string }).filter = "blur(14px)";
	ctx.lineWidth = Math.max(7, effectFontSize * 0.16);
	ctx.strokeStyle = "rgba(0,0,0,1)";
	strokeLines(0, fontSize * 0.018, 0.18);
	ctx.restore();
	ctx.save();
	(ctx as unknown as { filter: string }).filter = "blur(5px)";
	ctx.lineWidth = Math.max(4, effectFontSize * 0.075);
	ctx.strokeStyle = "rgba(0,0,0,1)";
	strokeLines(0, fontSize * 0.012, 0.32);
	ctx.restore();
	ctx.save();
	(ctx as unknown as { filter: string }).filter = "blur(4px)";
	ctx.lineWidth = Math.max(4, effectFontSize * 0.07);
	ctx.strokeStyle = "rgba(255,255,255,1)";
	strokeLines(0, 0, 0.15);
	ctx.restore();
	ctx.save();
	(ctx as unknown as { filter: string }).filter = "blur(1.2px)";
	ctx.lineWidth = Math.max(1.6, effectFontSize * 0.03);
	ctx.strokeStyle = "rgba(255,255,255,1)";
	strokeLines(0, 0, 0.26);
	ctx.restore();
	if (typeof THREE.CanvasTexture !== "function") return null;
	const tex = new THREE.CanvasTexture(canvas) as THREE.Texture;
	(tex as unknown as { minFilter: number }).minFilter = THREE.LinearFilter;
	(tex as unknown as { magFilter: number }).magFilter = THREE.LinearFilter;
	(tex as unknown as { generateMipmaps: boolean }).generateMipmaps = false;
	(tex as unknown as { anisotropy: number }).anisotropy = Math.min(8, opts.maxAnisotropy ?? 1);
	return tex;
}
