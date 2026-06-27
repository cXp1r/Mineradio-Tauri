import type * as THREE from "three";
import type { ThreeModule } from "../runtime/renderer-setup";
import { lyricFillText, lyricFontCss, lyricMeasureText, lyricStrokeText, type LyricTextOptions } from "./lyric-text";

export interface LyricGlowTextureOptions extends LyricTextOptions {
	maxAnisotropy?: number;
}

export function makeLyricGlowTexture(
	text: string,
	fontSize: number,
	textWidth: number,
	lines: string[],
	lineHeight: number,
	fitScaleX: number,
	THREE: ThreeModule,
	opts: LyricGlowTextureOptions = {},
): THREE.Texture | null {
	const cleaned = String(text ?? "")
		.replace(/\s+/g, " ")
		.trim();
	const drawLines = Array.isArray(lines) && lines.length ? lines : [cleaned];
	if (typeof document === "undefined") return null;
	const canvas = document.createElement("canvas");
	const measureCanvas = document.createElement("canvas");
	const measureCtx = measureCanvas.getContext("2d") as CanvasRenderingContext2D | null;
	const textOpts: LyricTextOptions = {
		lyricFont: opts.lyricFont,
		lyricLetterSpacing: opts.lyricLetterSpacing,
		lyricLineHeight: opts.lyricLineHeight,
	};
	const fit = fitScaleX || 1;
	let measuredWidth = Math.max(1, textWidth || (measureCtx ? lyricMeasureText(measureCtx, cleaned, fontSize, textOpts) * fit : 0));
	if (measureCtx) {
		measureCtx.font = lyricFontCss(fontSize, textOpts);
		for (let li = 0; li < drawLines.length; li++)
			measuredWidth = Math.max(measuredWidth, lyricMeasureText(measureCtx, drawLines[li], fontSize, textOpts) * fit);
	}
	const padX = Math.max(160, fontSize * 1.45);
	const padY = Math.max(86, fontSize * 0.78);
	const lh = lineHeight || fontSize * 1.04;
	const blockH = fontSize + (drawLines.length - 1) * lh;
	const W = Math.ceil(measuredWidth + padX * 2);
	const H = Math.ceil(blockH + padY * 2);
	canvas.width = W;
	canvas.height = H;
	const ctx = canvas.getContext("2d") as CanvasRenderingContext2D | null;
	if (!ctx) return null;
	ctx.clearRect(0, 0, W, H);
	ctx.textAlign = "center";
	ctx.textBaseline = "alphabetic";
	ctx.font = lyricFontCss(fontSize, textOpts);
	const y0 = H / 2 - blockH / 2 + fontSize * 0.82;
	const drawGlowText = (dx: number, dy: number) => {
		for (let i = 0; i < drawLines.length; i++) {
			const y = y0 + i * lh + (dy || 0);
			if (fit < 1) {
				ctx.save();
				ctx.translate(W / 2 + (dx || 0), 0);
				ctx.scale(fit, 1);
				if (ctx.lineWidth > 0) lyricStrokeText(ctx, drawLines[i], 0, y, fontSize, textOpts);
				lyricFillText(ctx, drawLines[i], 0, y, fontSize, textOpts);
				ctx.restore();
			} else {
				if (ctx.lineWidth > 0) lyricStrokeText(ctx, drawLines[i], W / 2 + (dx || 0), y, fontSize, textOpts);
				lyricFillText(ctx, drawLines[i], W / 2 + (dx || 0), y, fontSize, textOpts);
			}
		}
	};
	ctx.save();
	ctx.filter = "blur(14px)";
	ctx.globalAlpha = 0.46;
	ctx.fillStyle = "#fff";
	ctx.lineWidth = Math.max(10, fontSize * 0.1);
	ctx.strokeStyle = "#fff";
	drawGlowText(0, 0);
	ctx.restore();
	ctx.save();
	ctx.filter = "blur(34px)";
	ctx.globalAlpha = 0.34;
	ctx.fillStyle = "#fff";
	ctx.lineWidth = Math.max(18, fontSize * 0.18);
	ctx.strokeStyle = "#fff";
	drawGlowText(0, 0);
	ctx.restore();
	ctx.save();
	ctx.filter = "blur(78px)";
	ctx.globalAlpha = 0.22;
	ctx.fillStyle = "#fff";
	ctx.lineWidth = Math.max(28, fontSize * 0.26);
	ctx.strokeStyle = "#fff";
	drawGlowText(0, 0);
	ctx.restore();
	ctx.save();
	ctx.filter = "blur(116px)";
	ctx.globalAlpha = 0.13;
	ctx.fillStyle = "#fff";
	ctx.lineWidth = Math.max(42, fontSize * 0.4);
	ctx.strokeStyle = "#fff";
	drawGlowText(0, 0);
	ctx.restore();
	ctx.save();
	ctx.globalCompositeOperation = "lighter";
	ctx.filter = "blur(8px)";
	ctx.globalAlpha = 0.26;
	ctx.fillStyle = "#fff";
	for (let ri = 0; ri < 8; ri++) {
		const ang = (ri / 8) * Math.PI * 2;
		drawGlowText(Math.cos(ang) * 7, Math.sin(ang) * 4);
	}
	ctx.restore();
	ctx.save();
	ctx.globalCompositeOperation = "destination-in";
	const xMask = ctx.createLinearGradient(0, 0, W, 0);
	xMask.addColorStop(0.0, "rgba(255,255,255,0)");
	xMask.addColorStop(0.1, "rgba(255,255,255,1)");
	xMask.addColorStop(0.9, "rgba(255,255,255,1)");
	xMask.addColorStop(1.0, "rgba(255,255,255,0)");
	ctx.fillStyle = xMask as unknown as string;
	ctx.fillRect(0, 0, W, H);
	const yMask = ctx.createLinearGradient(0, 0, 0, H);
	yMask.addColorStop(0.0, "rgba(255,255,255,0)");
	yMask.addColorStop(0.16, "rgba(255,255,255,1)");
	yMask.addColorStop(0.84, "rgba(255,255,255,1)");
	yMask.addColorStop(1.0, "rgba(255,255,255,0)");
	ctx.fillStyle = yMask as unknown as string;
	ctx.fillRect(0, 0, W, H);
	ctx.restore();
	if (typeof THREE.CanvasTexture !== "function") return null;
	const tex = new THREE.CanvasTexture(canvas) as THREE.Texture;
	(tex as unknown as { minFilter: number }).minFilter = THREE.LinearFilter;
	(tex as unknown as { magFilter: number }).magFilter = THREE.LinearFilter;
	(tex as unknown as { generateMipmaps: boolean }).generateMipmaps = false;
	(tex as unknown as { userData: Record<string, unknown> }).userData = { width: W, height: H, textWidth: measuredWidth };
	(tex as unknown as { anisotropy: number }).anisotropy = Math.min(8, opts.maxAnisotropy ?? 1);
	return tex;
}