export interface LyricTextOptions {
	lyricFont?: string;
	lyricLetterSpacing?: number;
	lyricLineHeight?: number;
	lyricWeight?: number;
}

const DEFAULT_FONT_STACK = '"PingFang SC","Microsoft YaHei","Segoe UI",system-ui,-apple-system,sans-serif';
const DEFAULT_FONT_WEIGHT = 700;
const FONT_STACKS: Record<string, string> = {
	sans: 'Inter,"Noto Sans SC","PingFang SC","Microsoft YaHei",Arial,sans-serif',
	hei: '"Noto Sans SC","Microsoft YaHei",SimHei,"PingFang SC",sans-serif',
	song: '"Noto Serif SC","Source Han Serif SC",SimSun,"Songti SC",serif',
	"bold-song": '"Source Han Serif SC Heavy","Source Han Serif SC","Noto Serif SC Black","Noto Serif SC","STZhongsong","SimSun",serif',
	"stone-song": '"FZYaSongS-B-GB","FZCuSong-B09S","Source Han Serif SC Heavy","Noto Serif SC Black","STZhongsong","SimSun",serif',
	"kai-song": '"Kaiti SC","STKaiti","KaiTi","Source Han Serif SC","Noto Serif SC",serif',
	"serif-en": 'Georgia,"Times New Roman","Noto Serif SC","Source Han Serif SC",serif',
	gothic: '"UnifrakturCook","UnifrakturMaguntia","Old English Text MT","Blackletter","Cinzel Decorative","Noto Serif SC",serif',
	editorial: '"Didot","Bodoni 72","Libre Baskerville",Georgia,"Noto Serif SC",serif',
	humanist: '"Avenir Next","Segoe UI","Inter","Noto Sans SC","PingFang SC",sans-serif',
	round: '"HarmonyOS Sans SC","Microsoft YaHei UI","PingFang SC","Noto Sans SC",sans-serif',
	mono: '"JetBrains Mono",Consolas,"Noto Sans SC","Microsoft YaHei",monospace',
	display: '"Alibaba PuHuiTi","Noto Sans SC","PingFang SC","Microsoft YaHei",sans-serif',
};
const FONT_WEIGHTS: Record<string, number> = {
	sans: 760,
	hei: 900,
	song: 760,
	"bold-song": 900,
	"stone-song": 900,
	"kai-song": 760,
	"serif-en": 740,
	gothic: 820,
	editorial: 760,
	humanist: 740,
	round: 760,
	mono: 760,
	display: 900,
};

function clampRange(v: number, min: number, max: number): number {
	if (Number.isNaN(v)) return min;
	return Math.max(min, Math.min(max, v));
}

export interface LyricFontConfig {
	weight: number;
	stack: string;
}

export function customLyricFontId(key: string | undefined): string | null {
	const match = String(key ?? "").trim().toLowerCase().match(/^custom:([a-z0-9_-]{6,64})$/);
	return match?.[1] ?? null;
}

export function customLyricFontFamily(key: string | undefined): string | null {
	const id = customLyricFontId(key);
	return id ? `MineRadio Custom ${id}` : null;
}

export function normalizeFontKey(key: string | undefined): string {
	const k = String(key ?? "").trim().toLowerCase();
	if (customLyricFontId(k)) return k;
	return Object.prototype.hasOwnProperty.call(FONT_STACKS, k) ? k : "sans";
}

export function resolveFontConfig(opts: LyricTextOptions | undefined): LyricFontConfig {
	const key = normalizeFontKey(opts?.lyricFont);
	const rawWeight = Number(opts?.lyricWeight);
	const customFamily = customLyricFontFamily(key);
	const weight = key === "stone-song"
		? 900
		: Number.isFinite(rawWeight)
		? Math.round(clampRange(rawWeight, 500, 900) / 50) * 50
		: FONT_WEIGHTS[key] ?? DEFAULT_FONT_WEIGHT;
	return {
		weight,
		stack: customFamily
			? `"${customFamily}",${DEFAULT_FONT_STACK}`
			: FONT_STACKS[key] ?? DEFAULT_FONT_STACK,
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
		const h = 0.45 + Math.random() * (size * 0.026);
		ctx.globalAlpha = 0.16 + Math.random() * 0.36;
		ctx.save();
		ctx.translate(x, y);
		ctx.rotate((Math.random() - 0.5) * 0.38);
		ctx.fillRect(-w / 2, -h / 2, w, h);
		ctx.restore();
	}
	ctx.lineCap = "round";
	for (let s = 0; s < 44; s++) {
		const sx = Math.random() * W;
		const sy = bandTop + Math.random() * bandH;
		ctx.globalAlpha = 0.09 + Math.random() * 0.16;
		ctx.lineWidth = 0.45 + Math.random() * 1.2;
		ctx.beginPath();
		ctx.moveTo(sx, sy);
		ctx.lineTo(sx + 10 + Math.random() * 86, sy + (Math.random() - 0.5) * 4.8);
		ctx.stroke();
	}
	for (let c = 0; c < 26; c++) {
		const cx = Math.random() * W;
		const cy = bandTop + Math.random() * bandH;
		const radius = 1.8 + Math.random() * (size * 0.060);
		ctx.globalAlpha = 0.08 + Math.random() * 0.18;
		ctx.beginPath();
		ctx.ellipse(cx, cy, radius * (0.7 + Math.random() * 1.4), radius * (0.25 + Math.random() * 0.55), Math.random() * Math.PI, 0, Math.PI * 2);
		ctx.fill();
	}
	ctx.restore();
}
