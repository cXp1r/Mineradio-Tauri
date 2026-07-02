import type * as THREE from "three";
import { coverTextureSizeForResolution } from "./home-particle-field";
import {
	buildEdgeAndDepthCanvas,
	createCoverDepthTween,
	mergeAiDepthIntoEdgeCanvas,
	type CoverDepthCanvas,
	type CoverDepthCanvasFactory,
	type CoverDepthTween,
} from "./cover-depth";

export interface HomeCoverTextureUniforms {
	uCoverTex: { value: THREE.Texture };
	uPrevCoverTex: { value: THREE.Texture };
	uEdgeTex?: { value: THREE.Texture };
	uColorMixT: { value: number };
	uHasCover: { value: number };
	uLoading?: { value: number };
	uHasDepth?: { value: number };
	uAiBoost?: { value: number };
}

export type HomeCoverImage = CanvasImageSource | { width?: number; height?: number; src?: string };
export type HomeCoverLoader = (url: string) => Promise<HomeCoverImage>;
export type HomeAiDepthEstimator = (image: HomeCoverImage) => Promise<HomeCoverImage | null>;
export type HomeAiDepthMerger = (heuristic: HomeCoverImage, ai: HomeCoverImage) => HomeCoverImage | null;
export type HomeCoverCanvasFactory = (width: number, height: number) => CanvasImageSource & {
	width: number;
	height: number;
	getContext?: (contextId: "2d") => CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
};

export interface HomeCoverTextureControllerOptions {
	uniforms: HomeCoverTextureUniforms;
	loadImage?: HomeCoverLoader;
	buildEdgeDepth?: (image: HomeCoverImage) => HomeCoverImage | null;
	aiDepthEnabled?: boolean;
	estimateAiDepth?: HomeAiDepthEstimator;
	mergeAiDepth?: HomeAiDepthMerger;
	onCoverPrepared?: (image: HomeCoverImage) => void;
	colorMixDurationMs?: number;
	coverResolution?: number;
	createCanvas?: HomeCoverCanvasFactory;
	createDepthCanvas?: CoverDepthCanvasFactory;
}

export interface HomeCoverTextureController {
	setCoverUrl(url: string | null | undefined): void;
	setAiDepthEnabled(enabled: boolean): void;
	advanceColorMix(dtSeconds: number): void;
	advanceDepth(dtSeconds: number): void;
	getCurrentUrl(): string;
	whenIdle(): Promise<void>;
}

const HTTP_URL_RE = /^https?:\/\//i;
const INLINE_IMAGE_URL_RE = /^data:image\//i;
const BLOB_URL_RE = /^blob:/i;
const SAME_ORIGIN_IMAGE_PROXY_RE = /^\/image-proxy(?:[/?#]|$)/i;

function isAllowedCoverUrl(url: string): boolean {
	return HTTP_URL_RE.test(url) || INLINE_IMAGE_URL_RE.test(url) || BLOB_URL_RE.test(url) || SAME_ORIGIN_IMAGE_PROXY_RE.test(url);
}

export { coverTextureSizeForResolution } from "./home-particle-field";

function defaultCreateCanvas(width: number, height: number): ReturnType<HomeCoverCanvasFactory> | null {
	if (typeof document === "undefined") return null;
	const cv = document.createElement("canvas");
	cv.width = width;
	cv.height = height;
	return cv as ReturnType<HomeCoverCanvasFactory>;
}

function imageNaturalDimension(image: HomeCoverImage, axis: "width" | "height"): number {
	const naturalKey = axis === "width" ? "naturalWidth" : "naturalHeight";
	const value = (image as unknown as Record<string, unknown>)[naturalKey] ?? (image as unknown as Record<string, unknown>)[axis];
	return Math.max(1, Number(value) || 1);
}

export function prepareSquareCoverCanvas(
	image: HomeCoverImage,
	opts: {
		coverResolution?: number;
		createCanvas?: HomeCoverCanvasFactory;
	} = {},
): HomeCoverImage {
	const size = coverTextureSizeForResolution(opts.coverResolution ?? 1.55);
	const createCanvas = opts.createCanvas ?? defaultCreateCanvas;
	const cv = createCanvas(size, size);
	if (!cv || typeof cv.getContext !== "function") return image;
	cv.width = size;
	cv.height = size;
	const ctx = cv.getContext("2d");
	if (!ctx || typeof ctx.drawImage !== "function") return image;
	const iw = imageNaturalDimension(image, "width");
	const ih = imageNaturalDimension(image, "height");
	const square = Math.min(iw, ih);
	ctx.drawImage(image as CanvasImageSource, (iw - square) / 2, (ih - square) / 2, square, square, 0, 0, size, size);
	return cv;
}

function loadImageElement(url: string, crossOrigin: boolean): Promise<HomeCoverImage> {
	if (typeof Image === "undefined") return Promise.reject(new Error("Image unavailable"));
	return new Promise((resolve, reject) => {
		const img = new Image();
		if (crossOrigin) img.crossOrigin = "anonymous";
		img.decoding = "async";
		img.onload = () => resolve(img);
		img.onerror = () => reject(new Error(`failed to load cover image: ${url}`));
		img.src = url;
	});
}

function proxiedCoverFallbackUrl(url: string): string | null {
	try {
		const base = typeof location !== "undefined" && location.href ? location.href : "http://127.0.0.1/";
		const parsed = new URL(url, base);
		if (!parsed.pathname.endsWith("/image-proxy")) return null;
		const direct = parsed.searchParams.get("url")?.trim() ?? "";
		if (!HTTP_URL_RE.test(direct)) return null;
		return direct;
	} catch {
		return null;
	}
}

async function defaultLoadImage(url: string): Promise<HomeCoverImage> {
	try {
		return await loadImageElement(url, true);
	} catch (firstError) {
		const directFallback = proxiedCoverFallbackUrl(url);
		if (
			typeof fetch !== "function" ||
			typeof URL === "undefined" ||
			typeof URL.createObjectURL !== "function"
		) {
			if (directFallback) return await loadImageElement(directFallback, true);
			throw firstError;
		}
		try {
			const res = await fetch(url, { cache: "force-cache" });
			if (res.ok) {
				const contentType = res.headers.get("content-type") ?? "";
				if (!contentType || /^image\//i.test(contentType)) {
					const blobUrl = URL.createObjectURL(await res.blob());
					try {
						return await loadImageElement(blobUrl, false);
					} finally {
						if (typeof setTimeout === "function") {
							setTimeout(() => URL.revokeObjectURL(blobUrl), 30_000);
						} else {
							URL.revokeObjectURL(blobUrl);
						}
					}
				}
			}
		} catch {
			// 与原项目一致，代理路径失败后继续尝试原始封面 URL。
		}
		if (directFallback) return await loadImageElement(directFallback, true);
		throw firstError;
	}
}

function markTextureImage(tex: THREE.Texture, image: HomeCoverImage): void {
	(tex as unknown as { image: HomeCoverImage }).image = image;
	(tex as unknown as { needsUpdate: boolean }).needsUpdate = true;
}

function resetDepthUniforms(uniforms: HomeCoverTextureUniforms): void {
	if (uniforms.uHasDepth) uniforms.uHasDepth.value = 0;
	if (uniforms.uAiBoost) uniforms.uAiBoost.value = 0;
}

function buildDepthImage(
	image: HomeCoverImage,
	opts: HomeCoverTextureControllerOptions,
): HomeCoverImage | null {
	if (opts.buildEdgeDepth) return opts.buildEdgeDepth(image);
	return buildEdgeAndDepthCanvas(image as CanvasImageSource, {
		createCanvas: opts.createDepthCanvas,
	}) as CoverDepthCanvas | null;
}

async function maybeBuildAiDepthImage(
	preparedImage: HomeCoverImage,
	heuristicImage: HomeCoverImage | null,
	opts: HomeCoverTextureControllerOptions,
): Promise<{ image: HomeCoverImage | null; aiBoostTarget: number; durationMs: number }> {
	if (!heuristicImage || !opts.aiDepthEnabled || !opts.estimateAiDepth) {
		return { image: heuristicImage, aiBoostTarget: 0.55, durationMs: 180 };
	}
	const aiImage = await opts.estimateAiDepth(preparedImage);
	if (!aiImage) return { image: heuristicImage, aiBoostTarget: 0.55, durationMs: 180 };
	const merge = opts.mergeAiDepth ?? ((heuristic, ai) => mergeAiDepthIntoEdgeCanvas(heuristic as CoverDepthCanvas, ai as CoverDepthCanvas));
	return {
		image: merge(heuristicImage, aiImage) ?? heuristicImage,
		aiBoostTarget: 1,
		durationMs: 360,
	};
}

export function createHomeCoverTextureController(
	opts: HomeCoverTextureControllerOptions,
): HomeCoverTextureController {
	const uniforms = opts.uniforms;
	const loadImage = opts.loadImage ?? defaultLoadImage;
	const colorMixDurationMs = Math.max(1, opts.colorMixDurationMs ?? 1400);
	const coverResolution = opts.coverResolution ?? 1.55;
	const depthTween: CoverDepthTween | null = uniforms.uHasDepth && uniforms.uAiBoost
		? createCoverDepthTween({ uHasDepth: uniforms.uHasDepth, uAiBoost: uniforms.uAiBoost })
		: null;
	let currentUrl = "";
	let token = 0;
	let pending: Promise<void> | null = null;
	let aiDepthEnabled = !!opts.aiDepthEnabled;
	let preparedCoverImage: HomeCoverImage | null = null;
	let heuristicEdgeImage: HomeCoverImage | null = null;
	let currentEdgeIsAiMerged = false;

	function clearCover(): void {
		token += 1;
		currentUrl = "";
		preparedCoverImage = null;
		heuristicEdgeImage = null;
		currentEdgeIsAiMerged = false;
		uniforms.uHasCover.value = 0;
		uniforms.uColorMixT.value = 1;
		if (uniforms.uLoading) uniforms.uLoading.value = 0;
		depthTween?.setTarget(0, 0, 1);
		resetDepthUniforms(uniforms);
		pending = null;
	}

	async function applyAiDepthForCurrent(runToken: number): Promise<void> {
		if (!preparedCoverImage || !heuristicEdgeImage || !uniforms.uEdgeTex) return;
		const { image: edgeImage, aiBoostTarget, durationMs } = await maybeBuildAiDepthImage(preparedCoverImage, heuristicEdgeImage, {
			...opts,
			aiDepthEnabled,
		});
		if (runToken !== token || !edgeImage || !uniforms.uEdgeTex) return;
		markTextureImage(uniforms.uEdgeTex.value, edgeImage);
		currentEdgeIsAiMerged = aiBoostTarget >= 0.99;
		depthTween?.setTarget(1, aiBoostTarget, durationMs);
	}

	function rebuildHeuristicDepthFromPrepared(): HomeCoverImage | null {
		if (!preparedCoverImage || !uniforms.uEdgeTex) return null;
		try {
			return buildDepthImage(preparedCoverImage, opts);
		} catch {
			return null;
		}
	}

	function setCoverUrl(rawUrl: string | null | undefined): void {
		const url = String(rawUrl ?? "").trim();
		if (!url || !isAllowedCoverUrl(url)) {
			clearCover();
			return;
		}
		if (url === currentUrl && uniforms.uHasCover.value > 0.5) return;
		currentUrl = url;
		const runToken = ++token;
		if (uniforms.uLoading) uniforms.uLoading.value = 1;
		pending = loadImage(url)
			.then(async (image) => {
				if (runToken !== token) return;
				const preparedImage = prepareSquareCoverCanvas(image, { coverResolution, createCanvas: opts.createCanvas });
				preparedCoverImage = preparedImage;
				heuristicEdgeImage = null;
				currentEdgeIsAiMerged = false;
				if (uniforms.uHasCover.value > 0.5 && uniforms.uCoverTex.value.image) {
					markTextureImage(uniforms.uPrevCoverTex.value, uniforms.uCoverTex.value.image as HomeCoverImage);
				}
				markTextureImage(uniforms.uCoverTex.value, preparedImage);
				uniforms.uHasCover.value = 1;
				uniforms.uColorMixT.value = 0;
				if (uniforms.uLoading) uniforms.uLoading.value = 0;
				try {
					opts.onCoverPrepared?.(preparedImage);
				} catch {
					// 封面已经进入主纹理；取色/歌词调色失败只能降级，不能阻断粒子封面显示。
				}

				let builtHeuristicEdgeImage: HomeCoverImage | null = null;
				try {
					builtHeuristicEdgeImage = uniforms.uEdgeTex ? buildDepthImage(preparedImage, opts) : null;
				} catch {
					builtHeuristicEdgeImage = null;
				}
				if (runToken !== token) return;
				if (builtHeuristicEdgeImage && uniforms.uEdgeTex) {
					// 缓存启发式深度，切换 AI depth 时避免重复加载/准备封面。
					heuristicEdgeImage = builtHeuristicEdgeImage;
					markTextureImage(uniforms.uEdgeTex.value, heuristicEdgeImage);
					currentEdgeIsAiMerged = false;
					depthTween?.setTarget(1, 0.55, 180);
				} else {
					depthTween?.setTarget(0, 0, 1);
					resetDepthUniforms(uniforms);
					return;
				}

				await applyAiDepthForCurrent(runToken);
			})
		.catch(() => {
			if (runToken !== token) return;
			uniforms.uHasCover.value = 0;
			if (uniforms.uLoading) uniforms.uLoading.value = 0;
			depthTween?.setTarget(0, 0, 1);
			resetDepthUniforms(uniforms);
		});
	}

	function advanceColorMix(dtSeconds: number): void {
		if (uniforms.uColorMixT.value >= 1) return;
		const dt = Number.isFinite(dtSeconds) ? Math.max(0, dtSeconds) : 0;
		uniforms.uColorMixT.value = Math.min(1, uniforms.uColorMixT.value + (dt * 1000) / colorMixDurationMs);
	}

	return {
		setCoverUrl,
		setAiDepthEnabled(enabled) {
			const next = !!enabled;
			if (next === aiDepthEnabled) return;
			aiDepthEnabled = next;
			if (!currentUrl) return;
			const runToken = ++token;
			if (!aiDepthEnabled) {
				if (currentEdgeIsAiMerged) {
					const rebuilt = rebuildHeuristicDepthFromPrepared();
					if (rebuilt) heuristicEdgeImage = rebuilt;
				}
				if (heuristicEdgeImage && uniforms.uEdgeTex) {
					markTextureImage(uniforms.uEdgeTex.value, heuristicEdgeImage);
					currentEdgeIsAiMerged = false;
					depthTween?.setTarget(1, 0.55, 180);
					pending = Promise.resolve();
					return;
				}
			} else if (preparedCoverImage && heuristicEdgeImage && uniforms.uEdgeTex) {
				pending = applyAiDepthForCurrent(runToken);
				return;
			}
			if (currentUrl) {
				const url = currentUrl;
				currentUrl = "";
				setCoverUrl(url);
			}
		},
		advanceColorMix,
		advanceDepth(dtSeconds) {
			depthTween?.advance(dtSeconds);
		},
		getCurrentUrl() {
			return currentUrl;
		},
		whenIdle() {
			return pending ?? Promise.resolve();
		},
	};
}
