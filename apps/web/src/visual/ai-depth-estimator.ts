import type { HomeAiDepthEstimator, HomeCoverImage } from "@mineradio/visual-engine";

export const TRANSFORMERS_JSDELIVR_URL = "https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2";
export const AI_DEPTH_MODEL_ID = "Xenova/depth-anything-small-hf";
export const AI_DEPTH_STATUS_EVENT = "mineradio-ai-depth-status";

export interface AiDepthStatusDetail {
	visible: boolean;
	text: string;
	toast?: string;
}

type DepthPipeline = (input: unknown) => Promise<unknown>;
type TransformersModule = {
	env?: {
		allowLocalModels?: boolean;
		backends?: {
			onnx?: {
				wasm?: {
					numThreads?: number;
				};
			};
		};
	};
	pipeline: (task: "depth-estimation", model: string) => Promise<DepthPipeline>;
};

type RemoteImport = (url: string) => Promise<TransformersModule>;
type DepthCanvasFactory = (size: number) => (CanvasImageSource & {
	width: number;
	height: number;
	getContext?: (contextId: "2d") => CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
	toDataURL?: (type?: string, quality?: unknown) => string;
}) | null;

export interface JsDelivrAiDepthEstimatorOptions {
	importModule?: RemoteImport;
	createCanvas?: DepthCanvasFactory;
	now?: () => number;
	minGapMs?: number;
	cooldownMs?: number;
	onStatus?: (detail: AiDepthStatusDetail) => void;
}

let sharedPipelinePromise: Promise<DepthPipeline> | null = null;

function defaultImportModule(url: string): Promise<TransformersModule> {
	return import(/* @vite-ignore */ url) as Promise<TransformersModule>;
}

function defaultCreateCanvas(size: number): ReturnType<DepthCanvasFactory> | null {
	if (typeof document === "undefined") return null;
	const cv = document.createElement("canvas");
	cv.width = size;
	cv.height = size;
	return cv as ReturnType<DepthCanvasFactory>;
}

function emitAiDepthStatus(
	detail: AiDepthStatusDetail,
	onStatus?: (detail: AiDepthStatusDetail) => void,
): void {
	onStatus?.(detail);
	if (typeof window === "undefined") return;
	window.dispatchEvent(new CustomEvent<AiDepthStatusDetail>(AI_DEPTH_STATUS_EVENT, { detail }));
}

async function loadPipeline(
	importModule: RemoteImport,
	onStatus?: (detail: AiDepthStatusDetail) => void,
): Promise<DepthPipeline> {
	if (!sharedPipelinePromise) {
		emitAiDepthStatus({ visible: true, text: "加载 AI 深度模型 (首次需下载 50MB)…" }, onStatus);
		sharedPipelinePromise = (async () => {
				const mod = await importModule(TRANSFORMERS_JSDELIVR_URL);
				if (mod.env) {
					mod.env.allowLocalModels = false;
					const wasm = mod.env.backends?.onnx?.wasm;
					if (wasm) wasm.numThreads = 1;
				}
				const pipeline = await mod.pipeline("depth-estimation", AI_DEPTH_MODEL_ID);
				return pipeline;
			})()
			.catch((error) => {
				sharedPipelinePromise = null;
				throw error;
			});
	}
	return await sharedPipelinePromise;
}

function throwIfAborted(signal?: AbortSignal): void {
	if (!signal?.aborted) return;
	throw signal.reason ?? new DOMException("Aborted", "AbortError");
}

function makeAIDepthInputCanvas(
	image: HomeCoverImage,
	createCanvas: DepthCanvasFactory,
	reuseCanvas?: ReturnType<DepthCanvasFactory> | null,
): HomeCoverImage {
	const cv = reuseCanvas ?? createCanvas(160);
	if (!cv || typeof cv.getContext !== "function") return image;
	cv.width = 160;
	cv.height = 160;
	const ctx = cv.getContext("2d");
	if (!ctx || typeof ctx.drawImage !== "function") return image;
	try {
		ctx.drawImage(image as CanvasImageSource, 0, 0, 160, 160);
		return cv;
	} catch {
		return image;
	}
}

async function canvasLikeFromDepthResult(result: unknown, signal?: AbortSignal): Promise<HomeCoverImage | null> {
	const record = result as Record<string, unknown> | null;
	const raw = record && (record.depth ?? record.predicted_depth ?? result);
	if (!raw) return null;
	const maybeCanvas = raw as { toCanvas?: () => Promise<HomeCoverImage> | HomeCoverImage };
	if (typeof maybeCanvas.toCanvas === "function") {
		const canvas = await maybeCanvas.toCanvas();
		throwIfAborted(signal);
		return canvas;
	}
	return raw as HomeCoverImage;
}

export function createJsDelivrAiDepthEstimator(
	opts: JsDelivrAiDepthEstimatorOptions = {},
): HomeAiDepthEstimator {
	const importModule = opts.importModule ?? defaultImportModule;
	const createCanvas = opts.createCanvas ?? defaultCreateCanvas;
	const now = opts.now ?? (() => performance.now());
	const minGapMs = opts.minGapMs ?? 18000;
	const cooldownMs = opts.cooldownMs ?? 120000;
	const onStatus = opts.onStatus;
	let lastRunAt = -Infinity;
	let failUntil = 0;
	let busy = false;
	let inputCanvas: ReturnType<DepthCanvasFactory> | null = null;

	return async (image, signal) => {
		const current = now();
		if (busy || current < failUntil || current - lastRunAt < minGapMs) return null;
		const previousLastRunAt = lastRunAt;
		lastRunAt = current;
		busy = true;
		let hidden = false;
		const hide = (toast?: string) => {
			if (hidden) return;
			hidden = true;
			emitAiDepthStatus({ visible: false, text: "", ...(toast ? { toast } : {}) }, onStatus);
		};
		try {
			throwIfAborted(signal);
			emitAiDepthStatus({ visible: true, text: "后台增强封面深度…" }, onStatus);
			const pipeline = await loadPipeline(importModule, onStatus);
			throwIfAborted(signal);
			inputCanvas = inputCanvas ?? createCanvas(160);
			const inputCanvasImage = inputCanvas
				? makeAIDepthInputCanvas(image, createCanvas, inputCanvas)
				: image;
			let input: unknown = inputCanvasImage;
			try {
				const maybeDataUrl = (inputCanvasImage as { toDataURL?: (type?: string, quality?: unknown) => string }).toDataURL;
				if (typeof maybeDataUrl === "function") input = maybeDataUrl.call(inputCanvasImage, "image/jpeg", 0.82);
			} catch {
				input = inputCanvasImage;
			}
			const result = await pipeline(input);
			throwIfAborted(signal);
			const canvas = await canvasLikeFromDepthResult(result, signal);
			throwIfAborted(signal);
			hide(canvas ? "AI 深度已后台增强" : undefined);
			return canvas;
		} catch {
			if (signal?.aborted) {
				lastRunAt = previousLastRunAt;
				hide();
				return null;
			}
			failUntil = now() + cooldownMs;
			hide();
			return null;
		} finally {
			busy = false;
		}
	};
}

export function resetJsDelivrAiDepthPipelineForTests(): void {
	sharedPipelinePromise = null;
}
