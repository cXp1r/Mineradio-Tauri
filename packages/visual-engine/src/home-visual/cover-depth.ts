export interface CoverDepthUniforms {
	uHasDepth: { value: number };
	uAiBoost: { value: number };
}

export type CoverDepthCanvas = CanvasImageSource & {
	width: number;
	height: number;
	getContext?: (contextId: "2d") => {
		drawImage?: (...args: unknown[]) => void;
		getImageData?: (sx: number, sy: number, sw: number, sh: number) => { data: Uint8ClampedArray | Uint8Array };
		createImageData?: (sw: number, sh: number) => { data: Uint8ClampedArray; width: number; height: number };
		putImageData?: (imageData: { data: Uint8ClampedArray; width: number; height: number }, dx: number, dy: number) => void;
	} | null;
};

export type CoverDepthCanvasFactory = (width: number, height: number) => CoverDepthCanvas;

export interface CoverDepthTween {
	setTarget(depthTo: number, aiTo: number, durationMs: number): void;
	advance(dtSeconds: number): void;
}

interface CoverDepthScratch {
	lum: Float32Array;
	blur: Float32Array;
	tmp: Float32Array;
}

const EDGE_SIZE = 256;
const EDGE_COUNT = EDGE_SIZE * EDGE_SIZE;
let sharedScratch: CoverDepthScratch | null = null;
const EDGE_CENTER_BIAS = (() => {
	const bias = new Float32Array(EDGE_COUNT);
	for (let y = 0; y < EDGE_SIZE; y++) {
		for (let x = 0; x < EDGE_SIZE; x++) {
			const i = y * EDGE_SIZE + x;
			const cx = (x / (EDGE_SIZE - 1) - 0.5) * 2;
			const cy = (y / (EDGE_SIZE - 1) - 0.5) * 2;
			const rr = Math.sqrt(cx * cx + cy * cy);
			bias[i] = 1 - Math.min(1, rr * 0.75);
		}
	}
	return bias;
})();

export function visualEase(t: number): number {
	const clamped = Math.max(0, Math.min(1, Number(t) || 0));
	return clamped * clamped * (3 - 2 * clamped);
}

function defaultCreateCanvas(width: number, height: number): CoverDepthCanvas | null {
	if (typeof document === "undefined") return null;
	const cv = document.createElement("canvas");
	cv.width = width;
	cv.height = height;
	return cv as CoverDepthCanvas;
}

function getCoverDepthScratch(count: number): CoverDepthScratch {
	if (!sharedScratch || sharedScratch.lum.length !== count) {
		sharedScratch = {
			lum: new Float32Array(count),
			blur: new Float32Array(count),
			tmp: new Float32Array(count),
		};
	}
	return sharedScratch;
}

export function buildEdgeAndDepthCanvas(
	srcCanvas: CanvasImageSource,
	opts: { createCanvas?: CoverDepthCanvasFactory } = {},
): CoverDepthCanvas | null {
	const createCanvas = opts.createCanvas ?? defaultCreateCanvas;
	const normalized = createCanvas(EDGE_SIZE, EDGE_SIZE);
	const out = createCanvas(EDGE_SIZE, EDGE_SIZE);
	if (!normalized || !out || typeof normalized.getContext !== "function" || typeof out.getContext !== "function") return null;
	normalized.width = EDGE_SIZE;
	normalized.height = EDGE_SIZE;
	out.width = EDGE_SIZE;
	out.height = EDGE_SIZE;
	const sctx = normalized.getContext("2d");
	const octx = out.getContext("2d");
	if (!sctx?.drawImage || !sctx.getImageData || !octx?.createImageData || !octx.putImageData) return null;
	sctx.drawImage(srcCanvas, 0, 0, EDGE_SIZE, EDGE_SIZE);
	const src = sctx.getImageData(0, 0, EDGE_SIZE, EDGE_SIZE).data;
	const count = EDGE_COUNT;
	const scratch = getCoverDepthScratch(count);
	const lum = scratch.lum;
	const blur = scratch.blur;
	const tmp = scratch.tmp;

	for (let i = 0; i < count; i++) {
		const di = i * 4;
		lum[i] = (src[di] * 0.299 + src[di + 1] * 0.587 + src[di + 2] * 0.114) / 255;
	}

	blurH(lum, tmp, 4);
	blurV(tmp, blur, 4);
	const edge = tmp;
	edge.fill(0);
	for (let y = 1; y < EDGE_SIZE - 1; y++) {
		for (let x = 1; x < EDGE_SIZE - 1; x++) {
			const gx = -blur[(y - 1) * EDGE_SIZE + (x - 1)] - 2 * blur[y * EDGE_SIZE + (x - 1)] - blur[(y + 1) * EDGE_SIZE + (x - 1)]
				+ blur[(y - 1) * EDGE_SIZE + (x + 1)] + 2 * blur[y * EDGE_SIZE + (x + 1)] + blur[(y + 1) * EDGE_SIZE + (x + 1)];
			const gy = -blur[(y - 1) * EDGE_SIZE + (x - 1)] - 2 * blur[(y - 1) * EDGE_SIZE + x] - blur[(y - 1) * EDGE_SIZE + (x + 1)]
				+ blur[(y + 1) * EDGE_SIZE + (x - 1)] + 2 * blur[(y + 1) * EDGE_SIZE + x] + blur[(y + 1) * EDGE_SIZE + (x + 1)];
			edge[y * EDGE_SIZE + x] = Math.min(1, Math.sqrt(gx * gx + gy * gy) * 1.4);
		}
	}

	const imgOut = octx.createImageData(EDGE_SIZE, EDGE_SIZE);
	for (let i = 0; i < count; i++) {
		const di = i * 4;
		const depth = Math.min(1, blur[i] * 0.45 + EDGE_CENTER_BIAS[i] * 0.55);
		const fg = Math.min(1, depth * 0.6 + edge[i] * 0.5);
		imgOut.data[di] = Math.round(depth * 255);
		imgOut.data[di + 1] = Math.round(edge[i] * 255);
		imgOut.data[di + 2] = Math.round(fg * 255);
		imgOut.data[di + 3] = Math.round(lum[i] * 255);
	}
	octx.putImageData(imgOut, 0, 0);
	return out;
}

export function mergeAiDepthIntoEdgeCanvas(
	heuristicCanvas: CoverDepthCanvas,
	aiCanvas: CoverDepthCanvas,
): CoverDepthCanvas | null {
	const width = heuristicCanvas.width || EDGE_SIZE;
	const height = heuristicCanvas.height || EDGE_SIZE;
	if (typeof heuristicCanvas.getContext !== "function" || typeof aiCanvas.getContext !== "function") return null;
	const hctx = heuristicCanvas.getContext("2d");
	const actx = aiCanvas.getContext("2d");
	if (!hctx?.getImageData || !hctx.putImageData || !actx?.getImageData) return null;
	const hImg = hctx.getImageData(0, 0, width, height);
	const hData = hImg.data instanceof Uint8ClampedArray ? hImg.data : new Uint8ClampedArray(hImg.data);
	const aData = actx.getImageData(0, 0, width, height).data;
	const count = width * height;
	const values = new Float32Array(count);
	let minV = 1;
	let maxV = 0;
	for (let i = 0; i < count; i++) {
		const di = i * 4;
		const v = (aData[di] * 0.299 + aData[di + 1] * 0.587 + aData[di + 2] * 0.114) / 255;
		values[i] = v;
		if (v < minV) minV = v;
		if (v > maxV) maxV = v;
	}
	let centerSum = 0;
	let centerCount = 0;
	let edgeSum = 0;
	let edgeCount = 0;
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const i = y * width + x;
			const cx = x / Math.max(1, width - 1) - 0.5;
			const cy = y / Math.max(1, height - 1) - 0.5;
			const rr = Math.sqrt(cx * cx + cy * cy);
			if (rr < 0.22) {
				centerSum += values[i];
				centerCount++;
			} else if (rr > 0.46) {
				edgeSum += values[i];
				edgeCount++;
			}
		}
	}
	const invert = (centerSum / Math.max(1, centerCount)) < (edgeSum / Math.max(1, edgeCount));
	const range = Math.max(0.001, maxV - minV);
	for (let i = 0; i < count; i++) {
		let n = (values[i] - minV) / range;
		if (invert) n = 1 - n;
		hData[i * 4] = Math.round(n * 255);
	}
	hctx.putImageData({ data: hData, width, height }, 0, 0);
	return heuristicCanvas;
}

export function createCoverDepthTween(uniforms: CoverDepthUniforms): CoverDepthTween {
	let fromDepth = uniforms.uHasDepth.value || 0;
	let fromAi = uniforms.uAiBoost.value || 0;
	let toDepth = fromDepth;
	let toAi = fromAi;
	let duration = 1;
	let elapsed = 0;
	let active = false;

	function apply(t: number): void {
		const eased = visualEase(t);
		uniforms.uHasDepth.value = fromDepth + (toDepth - fromDepth) * eased;
		uniforms.uAiBoost.value = fromAi + (toAi - fromAi) * eased;
	}

	return {
		setTarget(depthTo, aiTo, durationMs) {
			toDepth = Math.max(0, Math.min(1, Number(depthTo) || 0));
			toAi = Math.max(0, Math.min(1, Number(aiTo) || 0));
			duration = Math.max(1, durationMs || 1) / 1000;
			fromDepth = uniforms.uHasDepth.value || 0;
			fromAi = uniforms.uAiBoost.value || 0;
			elapsed = 0;
			if (duration <= 0.001 || (Math.abs(fromDepth - toDepth) < 0.001 && Math.abs(fromAi - toAi) < 0.001)) {
				uniforms.uHasDepth.value = toDepth;
				uniforms.uAiBoost.value = toAi;
				active = false;
				return;
			}
			active = true;
		},
		advance(dtSeconds) {
			if (!active) return;
			const dt = Number.isFinite(dtSeconds) ? Math.max(0, dtSeconds) : 0;
			elapsed += dt;
			const t = Math.min(1, elapsed / duration);
			apply(t);
			if (t >= 1) {
				uniforms.uHasDepth.value = toDepth;
				uniforms.uAiBoost.value = toAi;
				active = false;
			}
		},
	};
}

function blurH(source: Float32Array, dest: Float32Array, radius: number): void {
	for (let y = 0; y < EDGE_SIZE; y++) {
		let sum = 0;
		for (let x = -radius; x <= radius; x++) sum += source[y * EDGE_SIZE + clampInt(x, 0, EDGE_SIZE - 1)];
		for (let x = 0; x < EDGE_SIZE; x++) {
			dest[y * EDGE_SIZE + x] = sum / (2 * radius + 1);
			const xR = Math.min(EDGE_SIZE - 1, x + radius + 1);
			const xL = Math.max(0, x - radius);
			sum += source[y * EDGE_SIZE + xR] - source[y * EDGE_SIZE + xL];
		}
	}
}

function blurV(source: Float32Array, dest: Float32Array, radius: number): void {
	for (let x = 0; x < EDGE_SIZE; x++) {
		let sum = 0;
		for (let y = -radius; y <= radius; y++) sum += source[clampInt(y, 0, EDGE_SIZE - 1) * EDGE_SIZE + x];
		for (let y = 0; y < EDGE_SIZE; y++) {
			dest[y * EDGE_SIZE + x] = sum / (2 * radius + 1);
			const yD = Math.min(EDGE_SIZE - 1, y + radius + 1);
			const yU = Math.max(0, y - radius);
			sum += source[yD * EDGE_SIZE + x] - source[yU * EDGE_SIZE + x];
		}
	}
}

function clampInt(v: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, v));
}
