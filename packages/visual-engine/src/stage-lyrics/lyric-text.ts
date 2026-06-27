export interface LyricTextOptions {
	lyricFont?: string;
	lyricLetterSpacing?: number;
	lyricLineHeight?: number;
}

const DEFAULT_FONT_STACK = '"PingFang SC","Microsoft YaHei","Segoe UI",system-ui,-apple-system,sans-serif';
const DEFAULT_FONT_WEIGHT = 700;

function clampRange(v: number, min: number, max: number): number {
	if (Number.isNaN(v)) return min;
	return Math.max(min, Math.min(max, v));
}

export interface LyricFontConfig {
	weight: number;
	stack: string;
}

export function normalizeFontKey(key: string | undefined): string {
	const k = String(key ?? "").trim().toLowerCase();
	return k === "stone-song" ? "stone-song" : "default";
}

export function resolveFontConfig(opts: LyricTextOptions | undefined): LyricFontConfig {
	return {
		weight: DEFAULT_FONT_WEIGHT,
		stack: DEFAULT_FONT_STACK,
	};
}

export function lyricFontCss(fontSize: number, opts: LyricTextOptions | undefined): string {
	const cfg = resolveFontConfig(opts);
	return `${cfg.weight} ${fontSize}px ${cfg.stack}`;
}

export function lyricLetterSpacingPx(fontSize: number, opts: LyricTextOptions | undefined): number {
	const raw = Number(opts?.lyricLetterSpacing) || 0;
	return clampRange(raw, -0.04, 0.18) * Math.max(1, fontSize || 1);
}

export function lyricLineHeightFactor(opts: LyricTextOptions | undefined): number {
	const raw = Number(opts?.lyricLineHeight) || 1;
	return clampRange(raw, 0.86, 1.35);
}

export function measureTextWithLetterSpacing(
	ctx: CanvasRenderingContext2D,
	text: string,
	spacing: number,
): number {
	const str = String(text ?? "");
	const sp = Number(spacing) || 0;
	if (!sp || str.length < 2) return Math.max(1, ctx.measureText(str).width);
	const chars = Array.from(str);
	let w = 0;
	for (let i = 0; i < chars.length; i++) {
		w += ctx.measureText(chars[i]).width;
		if (i < chars.length - 1) w += sp;
	}
	return Math.max(1, w);
}

export function lyricMeasureText(
	ctx: CanvasRenderingContext2D,
	text: string,
	fontSize: number,
	opts: LyricTextOptions | undefined,
): number {
	return measureTextWithLetterSpacing(ctx, text, lyricLetterSpacingPx(fontSize, opts));
}

export function drawTextWithLetterSpacing(
	ctx: CanvasRenderingContext2D,
	text: string,
	x: number,
	y: number,
	spacing: number,
	stroke: boolean,
): void {
	const str = String(text ?? "");
	const sp = Number(spacing) || 0;
	if (!sp || str.length < 2) {
		if (stroke) ctx.strokeText(str, x, y);
		else ctx.fillText(str, x, y);
		return;
	}
	const chars = Array.from(str);
	const align = ctx.textAlign || "left";
	const width = measureTextWithLetterSpacing(ctx, str, sp);
	let start = x;
	if (align === "center") start = x - width / 2;
	else if (align === "right" || align === "end") start = x - width;
	ctx.textAlign = "left";
	let cursor = start;
	for (let i = 0; i < chars.length; i++) {
		if (stroke) ctx.strokeText(chars[i], cursor, y);
		else ctx.fillText(chars[i], cursor, y);
		cursor += ctx.measureText(chars[i]).width + (i < chars.length - 1 ? sp : 0);
	}
	ctx.textAlign = align;
}

export function lyricFillText(
	ctx: CanvasRenderingContext2D,
	text: string,
	x: number,
	y: number,
	fontSize: number,
	opts: LyricTextOptions | undefined,
): void {
	drawTextWithLetterSpacing(ctx, text, x, y, lyricLetterSpacingPx(fontSize, opts), false);
}

export function lyricStrokeText(
	ctx: CanvasRenderingContext2D,
	text: string,
	x: number,
	y: number,
	fontSize: number,
	opts: LyricTextOptions | undefined,
): void {
	drawTextWithLetterSpacing(ctx, text, x, y, lyricLetterSpacingPx(fontSize, opts), true);
}

export function wrapLyricText(
	ctx: CanvasRenderingContext2D,
	text: string,
	maxWidth: number,
	maxLines: number,
	fontSize: number,
	opts: LyricTextOptions | undefined,
): string[] {
	const str = String(text ?? "").trim();
	const useWords = /\s/.test(str) && /[A-Za-z0-9]/.test(str);
	const units = useWords ? str.split(/(\s+)/).filter(Boolean) : str.split("");
	const lines: string[] = [];
	let line = "";
	for (let i = 0; i < units.length; i++) {
		const test = line + units[i];
		if (lyricMeasureText(ctx, test, fontSize, opts) > maxWidth && line) {
			lines.push(line.trim());
			line = String.prototype.trimStart.call(units[i]);
			if (lines.length >= maxLines) {
				const rest = units.slice(i).join("").trim();
				if (rest) lines[lines.length - 1] = lines[lines.length - 1].replace(/[.。,…，、\s]*$/, "") + "...";
				return lines;
			}
		} else {
			line = test;
		}
	}
	if (line && lines.length < maxLines) lines.push(line.trim());
	return lines.length ? lines : [""];
}

export function applyStonePrintTexture(
	ctx: CanvasRenderingContext2D,
	W: number,
	H: number,
	fontSize: number,
	opts: LyricTextOptions | undefined,
): void {
	if (normalizeFontKey(opts?.lyricFont) !== "stone-song") return;
	const size = clampRange(fontSize || 128, 42, 180);
	const bandTop = H * 0.1;
	const bandH = H * 0.8;
	ctx.save();
	ctx.globalCompositeOperation = "destination-out";
	const noiseW = 300;
	const noiseH = 110;
	const noise = (typeof document !== "undefined" ? document.createElement("canvas") : null) as HTMLCanvasElement | null;
	if (!noise) {
		ctx.restore();
		return;
	}
	noise.width = noiseW;
	noise.height = noiseH;
	const nctx = noise.getContext("2d");
	if (nctx) {
		const img = nctx.createImageData(noiseW, noiseH);
		for (let p = 0; p < noiseW * noiseH; p++) {
			const x0 = p % noiseW;
			const y0 = Math.floor(p / noiseW);
			const vein = Math.sin(x0 * 0.19 + y0 * 0.043) * 0.1 + Math.sin(y0 * 0.31) * 0.06;
			const r = Math.random() + vein;
			let a = 0;
			if (r > 0.82) a = 78 + Math.random() * 92;
			else if (r > 0.62) a = 22 + Math.random() * 54;
			else if (r > 0.48) a = 4 + Math.random() * 24;
			img.data[p * 4] = 255;
			img.data[p * 4 + 1] = 255;
			img.data[p * 4 + 2] = 255;
			img.data[p * 4 + 3] = a;
		}
		nctx.putImageData(img, 0, 0);
	}
	ctx.imageSmoothingEnabled = false;
	ctx.globalAlpha = 0.34;
	ctx.drawImage(noise, 0, bandTop, W, bandH);
	const chips = Math.round(size * 7.2);
	for (let i = 0; i < chips; i++) {
		const x = Math.random() * W;
		const y = bandTop + Math.random() * bandH;
		const w = 0.7 + Math.random() * (size * 0.052);
		ctx.fillRect(x, y, w, 1 + Math.random() * 2);
	}
	ctx.restore();
}