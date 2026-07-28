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
import type { StageLyricRasterRow } from "./textures/structured-raster";

export interface LyricMaskRasterRow extends StageLyricRasterRow {
	readonly fontSize: number;
	readonly baselineY: number;
	readonly fitScaleX: number;
	readonly textWidth: number;
	readonly yMin: number;
	readonly yMax: number;
}

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
	readonly rasterRows?: readonly LyricMaskRasterRow[];
	readonly activeYMin?: number;
	readonly activeYMax?: number;
}

export interface MakeLyricMaskOptions extends LyricTextOptions {
	maxLines?: number;
	maxAnisotropy?: number;
	structuredRows?: readonly StageLyricRasterRow[];
	structuredWidth?: number;
}

export const STAGE_LYRIC_MAX_LINES = 1;
export const LYRIC_MASK_W = 2048;
export const LYRIC_MASK_H = 384;

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

function structuredMaskHeight(rows: readonly StageLyricRasterRow[], width: number): number {
	const offsets = rows.map((row) => row.offset);
	const span = Math.max(0, Math.max(...offsets) - Math.min(...offsets));
	return Math.round(clamp(320 + span * 64, LYRIC_MASK_H, width * 0.625));
}

function makeStructuredLyricMask(
	rows: readonly StageLyricRasterRow[],
	THREE: ThreeModule,
	opts: MakeLyricMaskOptions,
): LyricMaskResult {
	const W = Math.round(clamp(Number(opts.structuredWidth) || 1024, 768, 3072));
	const H = structuredMaskHeight(rows, W);
	const maxWidth = W - Math.max(96, W * 0.092);
	const textOpts: LyricTextOptions = {
		lyricFont: opts.lyricFont,
		lyricLetterSpacing: opts.lyricLetterSpacing,
		lyricLineHeight: opts.lyricLineHeight,
		lyricWeight: opts.lyricWeight,
	};
	const rowStepFactor = 1.04 * lyricLineHeightFactor(textOpts);
	const canvas = typeof document !== "undefined" ? document.createElement("canvas") : null;
	const ctx = canvas ? (canvas.getContext("2d") as CanvasRenderingContext2D | null) : null;
	if (canvas) {
		canvas.width = W;
		canvas.height = H;
	}
	let baseFontSize = Math.min(128, W * 0.09375);
	const measure = (row: StageLyricRasterRow, fontSize: number): number => {
		const rowFontSize = fontSize * row.scale;
		const rowOpts = {
			...textOpts,
			...(row.weight === undefined ? {} : { lyricWeight: row.weight }),
		};
		if (ctx) {
			ctx.font = lyricFontCss(rowFontSize, rowOpts);
			return lyricMeasureText(ctx, row.text, rowFontSize, rowOpts);
		}
		return Math.max(1, row.text.length * rowFontSize * 0.55);
	};
	for (; baseFontSize >= 32; baseFontSize -= 4) {
		const widest = Math.max(...rows.map((row) => measure(row, baseFontSize)), 1);
		const lowest = Math.max(...rows.map((row) => row.offset * baseFontSize * rowStepFactor + baseFontSize * row.scale * 0.58));
		const highest = Math.min(...rows.map((row) => row.offset * baseFontSize * rowStepFactor - baseFontSize * row.scale * 0.58));
		if (widest <= maxWidth && lowest - highest <= H - 72) break;
	}
	const rasterRows: LyricMaskRasterRow[] = rows.map((row) => {
		const fontSize = baseFontSize * row.scale;
		const textWidth = measure(row, baseFontSize);
		const fitScaleX = textWidth > maxWidth
			? Math.max(0.62, maxWidth / Math.max(1, textWidth))
			: 1;
		const baselineY = H / 2 + row.offset * baseFontSize * rowStepFactor + fontSize * 0.32;
		return Object.freeze({
			...row,
			fontSize,
			baselineY,
			fitScaleX,
			textWidth: Math.min(maxWidth, textWidth * fitScaleX),
			yMin: clamp(baselineY - fontSize * 0.86, 0, H),
			yMax: clamp(baselineY + fontSize * 0.24, 0, H),
		});
	});
	if (ctx) {
		ctx.clearRect(0, 0, W, H);
		ctx.textAlign = "center";
		ctx.textBaseline = "alphabetic";
		ctx.fillStyle = "#fff";
		for (const row of rasterRows) {
			const rowOpts = {
				...textOpts,
				...(row.weight === undefined ? {} : { lyricWeight: row.weight }),
			};
			ctx.save();
			ctx.globalAlpha = row.alpha;
			ctx.font = lyricFontCss(row.fontSize, rowOpts);
			if (row.fitScaleX < 1) {
				ctx.translate(W / 2, 0);
				ctx.scale(row.fitScaleX, 1);
				lyricFillText(ctx, row.text, 0, row.baselineY, row.fontSize, rowOpts);
			} else {
				lyricFillText(ctx, row.text, W / 2, row.baselineY, row.fontSize, rowOpts);
			}
			ctx.restore();
		}
		applyStonePrintTexture(ctx, W, H, baseFontSize, textOpts);
	}
	let texture: THREE.Texture | null = null;
	if (canvas && typeof THREE.CanvasTexture === "function") {
		texture = new THREE.CanvasTexture(canvas) as THREE.Texture;
		(texture as unknown as { minFilter: number }).minFilter = THREE.LinearFilter;
		(texture as unknown as { magFilter: number }).magFilter = THREE.LinearFilter;
		(texture as unknown as { generateMipmaps: boolean }).generateMipmaps = false;
		(texture as unknown as { anisotropy: number }).anisotropy = opts.maxAnisotropy ?? 1;
	}
	const active = rasterRows.find((row) => row.active) ?? rasterRows[0];
	const widest = Math.max(...rasterRows.map((row) => row.textWidth), 1);
	const yMin = Math.min(...rasterRows.map((row) => row.yMin));
	const yMax = Math.max(...rasterRows.map((row) => row.yMax));
	return {
		texture,
		width: W,
		height: H,
		textWidth: widest,
		textHeight: Math.max(1, yMax - yMin),
		fontSize: baseFontSize,
		lineHeight: baseFontSize * rowStepFactor,
		lineCount: rasterRows.length,
		lines: rasterRows.map((row) => row.text),
		fitScaleX: 1,
		textMin: (W / 2 - (active?.textWidth ?? widest) / 2) / W,
		textMax: (W / 2 + (active?.textWidth ?? widest) / 2) / W,
		rasterRows: Object.freeze(rasterRows),
		activeYMin: (active?.yMin ?? yMin) / H,
		activeYMax: (active?.yMax ?? yMax) / H,
	};
}

export function makeLyricMask(text: string, THREE: ThreeModule, opts: MakeLyricMaskOptions = {}): LyricMaskResult {
	const structuredRows = opts.structuredRows?.filter((row) => row.text.trim().length > 0) ?? [];
	if (structuredRows.length > 0) {
		return makeStructuredLyricMask(structuredRows, THREE, opts);
	}
	const W = LYRIC_MASK_W;
	const H = LYRIC_MASK_H;
	const textOpts: LyricTextOptions = {
		lyricFont: opts.lyricFont,
		lyricLetterSpacing: opts.lyricLetterSpacing,
		lyricLineHeight: opts.lyricLineHeight,
		lyricWeight: opts.lyricWeight,
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
