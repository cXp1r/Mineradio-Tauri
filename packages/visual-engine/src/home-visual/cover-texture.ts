import type * as THREE from "three";
import { createCancellationScope, type CancellationScope, type CancellationTicket } from "../runtime/cancellation-scope";
import type { BudgetTaskQueue, BudgetTaskSettlement } from "../runtime/budget-task-queue";
import type { VisualResourceHandle, VisualResourceScope } from "../runtime/resource-scope";
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
export type HomeCoverLoader = (url: string, signal?: AbortSignal) => Promise<HomeCoverImage>;
export type HomeAiDepthEstimator = (image: HomeCoverImage, signal?: AbortSignal) => Promise<HomeCoverImage | null>;
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
	runtime?: HomeCoverRuntimeOptions;
}

export interface HomeCoverRuntimeOptions {
	readonly cancellationScope?: CancellationScope;
	readonly taskQueue?: BudgetTaskQueue;
	readonly resourceScope?: VisualResourceScope;
}

export interface HomeCoverTextureController {
	setCoverUrl(url: string | null | undefined): void;
	setAiDepthEnabled(enabled: boolean): void;
	advanceColorMix(dtSeconds: number): void;
	advanceDepth(dtSeconds: number): void;
	getCurrentUrl(): string;
	whenIdle(): Promise<void>;
	setRuntimeActive(active: boolean): void;
	dispose(): void;
}

const HTTP_URL_RE = /^https?:\/\//i;
const INLINE_IMAGE_URL_RE = /^data:image\//i;
const BLOB_URL_RE = /^blob:/i;
const SAME_ORIGIN_IMAGE_PROXY_RE = /^\/image-proxy(?:[/?#]|$)/i;
const HOME_COVER_TEXTURE_CACHE_LIMIT = 18;
let homeCoverControllerSequence = 0;

interface HomeCoverTextureCacheEntry {
	preparedImage: HomeCoverImage;
	heuristicImage: HomeCoverImage | null;
	aiMergedImage: HomeCoverImage | null;
	heuristicImageIsAiMerged: boolean;
	readonly leasesByScope: Map<VisualResourceScope, Map<HomeCoverImage, VisualResourceHandle>>;
}

const homeCoverTextureCache = new Map<string, HomeCoverTextureCacheEntry>();

function isAllowedCoverUrl(url: string): boolean {
	return HTTP_URL_RE.test(url) || INLINE_IMAGE_URL_RE.test(url) || BLOB_URL_RE.test(url) || SAME_ORIGIN_IMAGE_PROXY_RE.test(url);
}

export { coverTextureSizeForResolution } from "./home-particle-field";

export function resetHomeCoverTextureCacheForTests(): void {
	trimHomeCoverTextureCache(0);
}

function estimateImageBytes(image: HomeCoverImage): number {
	return imageNaturalDimension(image, "width") * imageNaturalDimension(image, "height") * 4;
}

export function estimateHomeCoverTextureCacheBytes(): number {
	let total = 0;
	for (const entry of homeCoverTextureCache.values()) {
		const images = new Set<HomeCoverImage>([
			entry.preparedImage,
			...(entry.heuristicImage ? [entry.heuristicImage] : []),
			...(entry.aiMergedImage ? [entry.aiMergedImage] : []),
		]);
		for (const image of images) total += estimateImageBytes(image);
	}
	return total;
}

function disposeCacheEntry(entry: HomeCoverTextureCacheEntry): void {
	for (const leases of entry.leasesByScope.values()) {
		for (const lease of leases.values()) lease.dispose();
		leases.clear();
	}
	entry.leasesByScope.clear();
}

export function trimHomeCoverTextureCache(maxEntries = HOME_COVER_TEXTURE_CACHE_LIMIT): void {
	const limit = Math.max(0, Math.floor(maxEntries));
	while (homeCoverTextureCache.size > limit) {
		const oldest = homeCoverTextureCache.keys().next().value;
		if (!oldest) break;
		const entry = homeCoverTextureCache.get(oldest);
		homeCoverTextureCache.delete(oldest);
		if (entry) disposeCacheEntry(entry);
	}
}

function coverTextureCacheKey(url: string, coverResolution: number): string {
	return `${url}|tex=${coverTextureSizeForResolution(coverResolution)}`;
}

function cacheEntryImages(entry: HomeCoverTextureCacheEntry): Set<HomeCoverImage> {
	return new Set<HomeCoverImage>([
		entry.preparedImage,
		...(entry.heuristicImage ? [entry.heuristicImage] : []),
		...(entry.aiMergedImage ? [entry.aiMergedImage] : []),
	]);
}

function reconcileHomeCoverTextureCacheLeases(
	key: string,
	entry: HomeCoverTextureCacheEntry,
	resourceScope?: VisualResourceScope,
): boolean {
	const images = cacheEntryImages(entry);
	const added: Array<[HomeCoverImage, VisualResourceHandle]> = [];
	let currentLeases = resourceScope ? entry.leasesByScope.get(resourceScope) : undefined;
	if (resourceScope) {
		currentLeases ??= new Map();
		try {
			for (const image of images) {
				const existing = currentLeases.get(image);
				if (existing && !existing.disposed) continue;
				if (existing?.disposed) currentLeases.delete(image);
				const lease = resourceScope.register({
					owner: `home-cover-cache:${key}`,
					kind: "cache",
					retention: "rebuildable",
					estimatedBytes: estimateImageBytes(image),
					dispose() {},
				});
				currentLeases.set(image, lease);
				added.push([image, lease]);
			}
		} catch {
			for (const [image, lease] of added) {
				lease.dispose();
				currentLeases.delete(image);
			}
			return false;
		}
		entry.leasesByScope.set(resourceScope, currentLeases);
	}
	for (const [scope, leases] of entry.leasesByScope) {
		for (const [image, lease] of leases) {
			if (images.has(image) && !lease.disposed) continue;
			if (!lease.disposed) lease.dispose();
			leases.delete(image);
		}
		if (leases.size === 0) entry.leasesByScope.delete(scope);
	}
	return true;
}

function getHomeCoverTextureCache(key: string, resourceScope?: VisualResourceScope): HomeCoverTextureCacheEntry | null {
	const cached = homeCoverTextureCache.get(key);
	if (!cached) return null;
	reconcileHomeCoverTextureCacheLeases(key, cached, resourceScope);
	homeCoverTextureCache.delete(key);
	homeCoverTextureCache.set(key, cached);
	return cached;
}

function setHomeCoverTextureCache(
	key: string,
	entry: Partial<HomeCoverTextureCacheEntry> & { preparedImage: HomeCoverImage },
	resourceScope?: VisualResourceScope,
): HomeCoverTextureCacheEntry | null {
	const previous = homeCoverTextureCache.get(key);
	const next: HomeCoverTextureCacheEntry = {
		preparedImage: entry.preparedImage,
		heuristicImage: entry.heuristicImage ?? null,
		aiMergedImage: entry.aiMergedImage ?? null,
		heuristicImageIsAiMerged: entry.heuristicImageIsAiMerged === true,
		leasesByScope: new Map(
			[...(previous?.leasesByScope ?? [])].map(([scope, leases]) => [scope, new Map(leases)]),
		),
	};
	if (!reconcileHomeCoverTextureCacheLeases(key, next, resourceScope)) return previous ?? null;
	homeCoverTextureCache.delete(key);
	homeCoverTextureCache.set(key, next);
	trimHomeCoverTextureCache();
	return next;
}

function patchHomeCoverTextureCache(key: string, patch: Partial<HomeCoverTextureCacheEntry>, resourceScope?: VisualResourceScope): HomeCoverTextureCacheEntry | null {
	const cached = getHomeCoverTextureCache(key, resourceScope);
	if (!cached) return null;
	return setHomeCoverTextureCache(key, { ...cached, ...patch, preparedImage: patch.preparedImage ?? cached.preparedImage }, resourceScope);
}

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

function loadImageElement(url: string, crossOrigin: boolean, signal?: AbortSignal): Promise<HomeCoverImage> {
	if (typeof Image === "undefined") return Promise.reject(new Error("Image unavailable"));
	return new Promise((resolve, reject) => {
		const img = new Image();
		const abort = () => reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
		if (signal?.aborted) {
			abort();
			return;
		}
		signal?.addEventListener("abort", abort, { once: true });
		if (crossOrigin) img.crossOrigin = "anonymous";
		img.decoding = "async";
		img.onload = () => {
			signal?.removeEventListener("abort", abort);
			resolve(img);
		};
		img.onerror = () => {
			signal?.removeEventListener("abort", abort);
			reject(new Error(`failed to load cover image: ${url}`));
		};
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

async function defaultLoadImage(url: string, signal?: AbortSignal): Promise<HomeCoverImage> {
	try {
		return await loadImageElement(url, true, signal);
	} catch (firstError) {
		if (signal?.aborted) throw firstError;
		const directFallback = proxiedCoverFallbackUrl(url);
		if (
			typeof fetch !== "function" ||
			typeof URL === "undefined" ||
			typeof URL.createObjectURL !== "function"
		) {
			if (directFallback) return await loadImageElement(directFallback, true, signal);
			throw firstError;
		}
		try {
			const res = await fetch(url, { cache: "force-cache", signal });
			if (res.ok) {
				const contentType = res.headers.get("content-type") ?? "";
				if (!contentType || /^image\//i.test(contentType)) {
					const blobUrl = URL.createObjectURL(await res.blob());
					try {
						return await loadImageElement(blobUrl, false, signal);
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
		if (directFallback) return await loadImageElement(directFallback, true, signal);
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

export function createHomeCoverTextureController(
	opts: HomeCoverTextureControllerOptions,
): HomeCoverTextureController {
	const uniforms = opts.uniforms;
	const loadImage = opts.loadImage ?? defaultLoadImage;
	const runtime = opts.runtime;
	const taskQueue = runtime?.taskQueue;
	const resourceScope = runtime?.resourceScope;
	const owner = `home-cover-${++homeCoverControllerSequence}`;
	const cancellationScope = runtime?.cancellationScope
		? runtime.cancellationScope.createChild(owner)
		: createCancellationScope(owner);
	const colorMixDurationMs = Math.max(1, opts.colorMixDurationMs ?? 1400);
	const coverResolution = opts.coverResolution ?? 1.55;
	const depthTween: CoverDepthTween | null = uniforms.uHasDepth && uniforms.uAiBoost
		? createCoverDepthTween({ uHasDepth: uniforms.uHasDepth, uAiBoost: uniforms.uAiBoost })
		: null;
	let currentUrl = "";
	let token = 0;
	let aiDepthEnabled = !!opts.aiDepthEnabled;
	let runtimeActive = true;
	let disposed = false;
	let coverPending = false;
	let aiPending = false;
	let aiEnhancementNeedsResume = false;
	let preparedCoverImage: HomeCoverImage | null = null;
	let heuristicEdgeImage: HomeCoverImage | null = null;
	let aiMergedEdgeImage: HomeCoverImage | null = null;
	let currentEdgeIsAiMerged = false;
	let heuristicEdgeIsAiMerged = false;
	let currentCoverCacheKey = "";
	let coverTicket: CancellationTicket | null = null;
	let aiTicket: CancellationTicket | null = null;

	interface IdleGeneration {
		readonly token: number;
		readonly promise: Promise<void>;
		add(): () => void;
		cancel(): void;
	}

	function createIdleGeneration(generationToken: number): IdleGeneration {
		let pendingCount = 0;
		let closed = false;
		let resolve!: () => void;
		const promise = new Promise<void>((done) => { resolve = done; });
		queueMicrotask(() => {
			if (!closed && pendingCount === 0) {
				closed = true;
				resolve();
			}
		});
		return {
			token: generationToken,
			promise,
			add() {
				if (closed) return () => {};
				pendingCount += 1;
				let settled = false;
				return () => {
					if (settled) return;
					settled = true;
					pendingCount = Math.max(0, pendingCount - 1);
					if (pendingCount === 0 && !closed) {
						closed = true;
						resolve();
					}
				};
			},
			cancel() {
				if (closed) return;
				closed = true;
				resolve();
			},
		};
	}

	let idleGeneration = createIdleGeneration(token);

	function issueTicket(key: "cover-load" | "ai-depth"): CancellationTicket | null {
		if (!cancellationScope.isOpen()) return null;
		try {
			return cancellationScope.issue(owner, `${key}/current`);
		} catch {
			return null;
		}
	}

	function cancelCoverAndAi(): void {
		if (coverPending || aiPending) taskQueue?.cancelOwner(owner);
		coverTicket = issueTicket("cover-load");
		aiTicket = issueTicket("ai-depth");
		coverPending = false;
		aiPending = false;
		idleGeneration.cancel();
	}

	function beginGeneration(): IdleGeneration {
		token += 1;
		aiEnhancementNeedsResume = false;
		cancelCoverAndAi();
		idleGeneration = createIdleGeneration(token);
		return idleGeneration;
	}

	function isCurrent(runToken: number, signal?: AbortSignal): boolean {
		return !disposed && runtimeActive && runToken === token && !signal?.aborted;
	}

	function clearCover(): void {
		beginGeneration().cancel();
		currentUrl = "";
		preparedCoverImage = null;
		heuristicEdgeImage = null;
		aiMergedEdgeImage = null;
		currentEdgeIsAiMerged = false;
		heuristicEdgeIsAiMerged = false;
		currentCoverCacheKey = "";
		aiEnhancementNeedsResume = false;
		uniforms.uHasCover.value = 0;
		uniforms.uColorMixT.value = 1;
		if (uniforms.uLoading) uniforms.uLoading.value = 0;
		depthTween?.setTarget(0, 0, 1);
		resetDepthUniforms(uniforms);
	}

	function applyPreparedCoverImage(preparedImage: HomeCoverImage): void {
		preparedCoverImage = preparedImage;
		heuristicEdgeImage = null;
		aiMergedEdgeImage = null;
		currentEdgeIsAiMerged = false;
		heuristicEdgeIsAiMerged = false;
		aiEnhancementNeedsResume = false;
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
	}

	function applyHeuristicDepthImage(edgeImage: HomeCoverImage, durationMs = 180): void {
		if (!uniforms.uEdgeTex) return;
		heuristicEdgeImage = edgeImage;
		markTextureImage(uniforms.uEdgeTex.value, heuristicEdgeImage);
		currentEdgeIsAiMerged = false;
		heuristicEdgeIsAiMerged = false;
		depthTween?.setTarget(1, 0.55, durationMs);
	}

	function applyCachedCoverDepth(runToken: number, cached: HomeCoverTextureCacheEntry): boolean {
		if (!isCurrent(runToken) || !uniforms.uEdgeTex) return false;
		if (aiDepthEnabled && cached.aiMergedImage) {
			heuristicEdgeImage = cached.heuristicImage;
			aiMergedEdgeImage = cached.aiMergedImage;
			heuristicEdgeIsAiMerged = cached.heuristicImageIsAiMerged;
			markTextureImage(uniforms.uEdgeTex.value, cached.aiMergedImage);
			currentEdgeIsAiMerged = true;
			depthTween?.setTarget(1, 1, 180);
			return false;
		}
		if (cached.heuristicImage && !cached.heuristicImageIsAiMerged) {
			applyHeuristicDepthImage(cached.heuristicImage, 120);
			return aiDepthEnabled;
		}
		const rebuilt = rebuildHeuristicDepthFromPrepared();
		if (!isCurrent(runToken) || !rebuilt) return false;
		applyHeuristicDepthImage(rebuilt, 120);
		if (currentCoverCacheKey) {
			patchHomeCoverTextureCache(currentCoverCacheKey, {
				heuristicImage: rebuilt,
				heuristicImageIsAiMerged: false,
			}, resourceScope);
		}
		return aiDepthEnabled;
	}

	function rebuildHeuristicDepthFromPrepared(): HomeCoverImage | null {
		if (!preparedCoverImage || !uniforms.uEdgeTex) return null;
		try {
			return buildDepthImage(preparedCoverImage, opts);
		} catch {
			return null;
		}
	}

	function onCoverFailure(runToken: number): void {
		if (!isCurrent(runToken)) return;
		uniforms.uHasCover.value = 0;
		if (uniforms.uLoading) uniforms.uLoading.value = 0;
		depthTween?.setTarget(0, 0, 1);
		resetDepthUniforms(uniforms);
	}

	function runTask<Result>(config: {
		readonly generation: IdleGeneration;
		readonly key: "cover-load/current" | "ai-depth/current";
		readonly priority: "visible" | "background";
		readonly run: (signal: AbortSignal) => Result | Promise<Result>;
		readonly commit: (result: Result, signal: AbortSignal) => void;
		readonly onSettled?: (settlement: BudgetTaskSettlement) => void;
	}): boolean {
		const finish = config.generation.add();
		if (taskQueue) {
			const accepted = taskQueue.enqueue({
				owner,
				key: config.key,
				priority: config.priority,
				cost: 1,
				run: ({ signal }) => config.run(signal),
				commit: (result, { signal }) => config.commit(result, signal),
				onSettled(settlement) {
					try {
						config.onSettled?.(settlement);
					} finally {
						finish();
					}
				},
			});
			if (!accepted) {
				config.onSettled?.("cancelled");
				finish();
			}
			return accepted;
		}
		const ticket = config.key.startsWith("cover-load")
			? (coverTicket = issueTicket("cover-load"))
			: (aiTicket = issueTicket("ai-depth"));
		if (!ticket) {
			config.onSettled?.("cancelled");
			finish();
			return false;
		}
		const settleCancelled = () => {
			config.onSettled?.("cancelled");
			finish();
		};
		ticket.signal.addEventListener("abort", settleCancelled, { once: true });
		let result: Result | Promise<Result>;
		try {
			result = config.run(ticket.signal);
		} catch {
			config.onSettled?.(ticket.signal.aborted ? "cancelled" : "failed");
			finish();
			return false;
		}
		void Promise.resolve(result)
			.then((result) => {
				if (!isCurrent(config.generation.token, ticket.signal) || !ticket.isCurrent()) {
					config.onSettled?.("stale");
					return;
				}
				config.commit(result, ticket.signal);
				config.onSettled?.("completed");
			}, () => {
				config.onSettled?.(ticket.signal.aborted ? "cancelled" : "failed");
			})
			.finally(() => {
				ticket.signal.removeEventListener("abort", settleCancelled);
				finish();
			});
		return true;
	}

	function scheduleAiDepth(generation: IdleGeneration): void {
		if (!aiDepthEnabled || !opts.estimateAiDepth || !preparedCoverImage || !heuristicEdgeImage || !uniforms.uEdgeTex) return;
		if (aiMergedEdgeImage) {
			aiEnhancementNeedsResume = false;
			markTextureImage(uniforms.uEdgeTex.value, aiMergedEdgeImage);
			currentEdgeIsAiMerged = true;
			depthTween?.setTarget(1, 1, 180);
			return;
		}
		const prepared = preparedCoverImage;
		const heuristic = heuristicEdgeImage;
		const runToken = generation.token;
		aiEnhancementNeedsResume = false;
		aiPending = true;
		runTask<HomeCoverImage | null>({
			generation,
			key: "ai-depth/current",
			priority: "background",
			run: (signal) => opts.estimateAiDepth?.(prepared, signal) ?? null,
			commit(aiImage, signal) {
				aiPending = false;
				if (!aiImage || !isCurrent(runToken, signal) || !aiDepthEnabled || heuristic !== heuristicEdgeImage || !uniforms.uEdgeTex) return;
				const merge = opts.mergeAiDepth ?? ((base, ai) => mergeAiDepthIntoEdgeCanvas(base as CoverDepthCanvas, ai as CoverDepthCanvas));
				// 合并可能原地改写启发式画布，必须留在 current commit 内。
				const mergedImage = merge(heuristic, aiImage);
				if (!mergedImage || !isCurrent(runToken, signal)) return;
				markTextureImage(uniforms.uEdgeTex.value, mergedImage);
				currentEdgeIsAiMerged = true;
				aiMergedEdgeImage = mergedImage;
				heuristicEdgeIsAiMerged = mergedImage === heuristic;
				if (currentCoverCacheKey) {
					patchHomeCoverTextureCache(currentCoverCacheKey, {
						aiMergedImage: mergedImage,
						heuristicImageIsAiMerged: heuristicEdgeIsAiMerged,
					}, resourceScope);
				}
				depthTween?.setTarget(1, 1, 360);
			},
			onSettled() {
				aiPending = false;
			},
		});
	}

	function setCoverUrl(rawUrl: string | null | undefined): void {
		if (disposed) return;
		const url = String(rawUrl ?? "").trim();
		if (!url || !isAllowedCoverUrl(url)) {
			clearCover();
			return;
		}
		if (url === currentUrl && uniforms.uHasCover.value > 0.5) {
			if (
				runtimeActive &&
				aiEnhancementNeedsResume &&
				aiDepthEnabled &&
				!aiMergedEdgeImage &&
				preparedCoverImage &&
				heuristicEdgeImage
			) {
				token += 1;
				idleGeneration = createIdleGeneration(token);
				scheduleAiDepth(idleGeneration);
			}
			return;
		}
		const generation = beginGeneration();
		if (!runtimeActive) {
			currentUrl = url;
			generation.cancel();
			return;
		}
		currentUrl = url;
		const runToken = generation.token;
		currentCoverCacheKey = coverTextureCacheKey(url, coverResolution);
		if (uniforms.uLoading) uniforms.uLoading.value = 1;
		const cached = getHomeCoverTextureCache(currentCoverCacheKey, resourceScope);
		coverPending = true;
		runTask<{ preparedImage: HomeCoverImage; heuristicImage: HomeCoverImage | null; cached: HomeCoverTextureCacheEntry | null }>({
			generation,
			key: "cover-load/current",
			priority: "visible",
			async run(signal) {
				if (cached) return { preparedImage: cached.preparedImage, heuristicImage: cached.heuristicImage, cached };
				const image = await loadImage(url, signal);
				if (signal.aborted) throw signal.reason;
				const preparedImage = prepareSquareCoverCanvas(image, { coverResolution, createCanvas: opts.createCanvas });
				let heuristicImage: HomeCoverImage | null = null;
				try {
					heuristicImage = uniforms.uEdgeTex ? buildDepthImage(preparedImage, opts) : null;
				} catch {
					heuristicImage = null;
				}
				return { preparedImage, heuristicImage, cached: null };
			},
			commit(result, signal) {
				coverPending = false;
				if (!isCurrent(runToken, signal)) return;
				applyPreparedCoverImage(result.preparedImage);
				if (result.cached) {
					if (applyCachedCoverDepth(runToken, result.cached)) scheduleAiDepth(generation);
					return;
				}
				setHomeCoverTextureCache(currentCoverCacheKey, { preparedImage: result.preparedImage }, resourceScope);
				if (!result.heuristicImage || !uniforms.uEdgeTex) {
					depthTween?.setTarget(0, 0, 1);
					resetDepthUniforms(uniforms);
					return;
				}
				applyHeuristicDepthImage(result.heuristicImage);
				patchHomeCoverTextureCache(currentCoverCacheKey, {
					heuristicImage: result.heuristicImage,
					heuristicImageIsAiMerged: false,
				}, resourceScope);
				scheduleAiDepth(generation);
			},
			onSettled(settlement) {
				coverPending = false;
				if (settlement === "failed" || settlement === "cancelled" && isCurrent(runToken)) onCoverFailure(runToken);
			},
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
			if (disposed) return;
			const next = !!enabled;
			if (next === aiDepthEnabled) return;
			aiDepthEnabled = next;
			if (!currentUrl) return;
			if (!aiDepthEnabled) {
				aiEnhancementNeedsResume = false;
				if (aiPending) taskQueue?.cancelOwner(owner);
				aiTicket = issueTicket("ai-depth");
				aiPending = false;
				if (heuristicEdgeIsAiMerged) {
					const rebuilt = rebuildHeuristicDepthFromPrepared();
					if (rebuilt) {
						heuristicEdgeImage = rebuilt;
						heuristicEdgeIsAiMerged = false;
					} else {
						heuristicEdgeImage = null;
					}
				}
				if (heuristicEdgeImage && uniforms.uEdgeTex) {
					markTextureImage(uniforms.uEdgeTex.value, heuristicEdgeImage);
					currentEdgeIsAiMerged = false;
					depthTween?.setTarget(1, 0.55, 180);
					return;
				}
			} else if (!coverPending && preparedCoverImage && heuristicEdgeImage && uniforms.uEdgeTex) {
				token += 1;
				idleGeneration = createIdleGeneration(token);
				scheduleAiDepth(idleGeneration);
				return;
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
			return idleGeneration.promise;
		},
		setRuntimeActive(active) {
			if (disposed || runtimeActive === !!active) return;
			runtimeActive = !!active;
			if (!runtimeActive) {
				aiEnhancementNeedsResume = !!(
					aiPending &&
					aiDepthEnabled &&
					!aiMergedEdgeImage &&
					currentUrl &&
					preparedCoverImage &&
					heuristicEdgeImage
				);
				cancelCoverAndAi();
				if (uniforms.uLoading) uniforms.uLoading.value = 0;
			}
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			runtimeActive = false;
			cancelCoverAndAi();
			cancellationScope.dispose();
		},
	};
}
