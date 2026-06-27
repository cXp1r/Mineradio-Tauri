import type * as THREE from "three";
import type { ThreeModule } from "../runtime/renderer-setup";
import {
	applyStonePrintTexture,
	lyricFillText,
	lyricFontCss,
	lyricLineHeightFactor,
	lyricMeasureText,
	wrapLyricText,
	type LyricTextOptions,
} from "./lyric-text";

export interface LyricMaskResult {
	texture: THREE.Texture | null;
	width: number;
	height: number;
	textWidth: number;
	textHeight: number;
	fontSize: number;
	lineHeight: number;
	lineCount: number;
	lines: string[];
	fitScaleX: number;
	textMin: number;
	textMax: number;
}

export interface MakeLyricMaskOptions extends LyricTextOptions {
	maxLines?: number;
	maxAnisotropy?: number;
}

export const STAGE_LYRIC_MAX_LINES = 1;
export const LYRIC_MASK_W = 2048;
export const LYRIC_MASK_H = 384;

export function makeLyricMask(text: string, THREE: ThreeModule, opts: MakeLyricMaskOptions = {}): LyricMaskResult {
	const W = LYRIC_MASK_W;
	const H = LYRIC_MASK_H;
	const textOpts: LyricTextOptions = {
		lyricFont: opts.lyricFont,
		lyricLetterSpacing: opts.lyricLetterSpacing,
		lyricLineHeight: opts.lyricLineHeight,
	};
	const cleaned = String(text ?? "")
		.replace(/\s+/g, " ")
		.trim();
	const maxWidth = W - 190;
	const maxLines = opts.maxLines ?? STAGE_LYRIC_MAX_LINES;
	let fontSize = 128;
	let lines: string[] = [cleaned];
	let widest = 1;

	const canvas = typeof document !== "undefined" ? document.createElement("canvas") : null;
	const ctx = canvas ? (canvas.getContext("2d") as CanvasRenderingContext2D | null) : null;
	if (canvas) {
		canvas.width = W;
		canvas.height = H;
	}

	if (ctx) {
		for (; fontSize >= 42; fontSize -= 4) {
			ctx.font = lyricFontCss(fontSize, textOpts);
			lines =
				maxLines > 1 && lyricMeasureText(ctx, cleaned, fontSize, textOpts) > maxWidth
					? wrapLyricText(ctx, cleaned, maxWidth, maxLines, fontSize, textOpts)
					: [cleaned];
			widest = 1;
			for (let li = 0; li < lines.length; li++) widest = Math.max(widest, lyricMeasureText(ctx, lines[li], fontSize, textOpts));
			if (widest <= maxWidth) break;
		}
		ctx.font = lyricFontCss(fontSize, textOpts);
		if (!lines.length) lines = [""];
		widest = 1;
		for (let mi = 0; mi < lines.length; mi++) widest = Math.max(widest, lyricMeasureText(ctx, lines[mi], fontSize, textOpts));
	} else {
		const estimate = Math.max(0, cleaned.length) * Math.max(1, fontSize * 0.55);
		widest = estimate;
	}

	let width = Math.min(maxWidth, Math.max(1, widest));
	let fitScaleX = maxLines <= 1 && widest > maxWidth ? Math.max(0.68, maxWidth / Math.max(1, widest)) : 1;
	if (fitScaleX < 1) width = Math.min(maxWidth, widest * fitScaleX);
	const lineHeight = fontSize * (lines.length > 1 ? 1.02 : 1.0) * lyricLineHeightFactor(textOpts);
	const blockH = fontSize + (lines.length - 1) * lineHeight;
	const x = W / 2;
	const y0 = H / 2 - blockH / 2 + fontSize * 0.82;

	if (ctx) {
		ctx.clearRect(0, 0, W, H);
		ctx.textAlign = "center";
		ctx.textBaseline = "alphabetic";
		ctx.fillStyle = "#fff";
		for (let di = 0; di < lines.length; di++) {
			if (fitScaleX < 1) {
				ctx.save();
				ctx.translate(x, 0);
				ctx.scale(fitScaleX, 1);
				lyricFillText(ctx, lines[di], 0, y0 + di * lineHeight, fontSize, textOpts);
				ctx.restore();
			} else {
				lyricFillText(ctx, lines[di], x, y0 + di * lineHeight, fontSize, textOpts);
			}
		}
		applyStonePrintTexture(ctx, W, H, fontSize, textOpts);
	}

	let texture: THREE.Texture | null = null;
	if (canvas && typeof THREE.CanvasTexture === "function") {
		texture = new THREE.CanvasTexture(canvas) as THREE.Texture;
		(texture as unknown as { minFilter: number }).minFilter = THREE.LinearFilter;
		(texture as unknown as { magFilter: number }).magFilter = THREE.LinearFilter;
		(texture as unknown as { generateMipmaps: boolean }).generateMipmaps = false;
		const maxAniso = opts.maxAnisotropy ?? Math.min(8, 1);
		(texture as unknown as { anisotropy: number }).anisotropy = maxAniso;
	}

	return {
		texture,
		width: W,
		height: H,
		textWidth: width,
		textHeight: blockH,
		fontSize,
		lineHeight,
		lineCount: lines.length,
		lines,
		fitScaleX,
		textMin: (W / 2 - width / 2) / W,
		textMax: (W / 2 + width / 2) / W,
	};
}