import type * as THREE from "three";
import type { ShelfItem } from "./shelf-animate";
import { SHELF_SETTINGS } from "./shelf-settings";

export const SHELF_CARD_CANVAS_WIDTH = 720;
export const SHELF_CARD_CANVAS_HEIGHT = 360;
export const SHELF_CARD_GEOMETRY_WIDTH = 2.05;
export const SHELF_CARD_GEOMETRY_HEIGHT = 1.025;

export interface ShelfCardDrawState {
	index: number;
	centered?: boolean;
	selected?: boolean;
	bgOpacity?: number;
	beatProgress?: number;
	dimmed?: boolean;
}

export interface ShelfCardDrawAssets {
	coverImage?: CanvasImageSource | null;
}

export type ShelfCardAction =
	| { kind: "loadPlaylist"; playlistId?: string; title?: string; provider?: string }
	| { kind: "playQueue"; index?: number }
	| { kind: "empty" };

export interface ShelfCardSprite {
	readonly canvas: HTMLCanvasElement;
	readonly context: CanvasRenderingContext2D;
	readonly texture: THREE.CanvasTexture;
	readonly geometry: THREE.PlaneGeometry;
	readonly material: THREE.MeshBasicMaterial;
	readonly mesh: THREE.Mesh;
	update(item: ShelfItem, state?: ShelfCardDrawState): void;
	retire(): void;
	dispose(): void;
}

export interface CreateShelfCardMeshOptions {
	item: ShelfItem;
	index: number;
	three: typeof import("three");
	createCanvas?: () => HTMLCanvasElement;
	createImage?: () => HTMLImageElement;
	drawState?: ShelfCardDrawState;
}

interface ShelfCoverRecord {
	loaded: boolean;
	loading: boolean;
	failed: boolean;
	img: HTMLImageElement | null;
	waiters: Array<(img: HTMLImageElement | null) => void>;
}

const shelfCoverCache = new Map<string, ShelfCoverRecord>();

export function makeShelfCardAction(item: ShelfItem): ShelfCardAction {
	if (item.type === "podcastCollection") {
		return {
			kind: "loadPlaylist",
			playlistId: item.podcastKey ? `podcast:${item.podcastKey}` : undefined,
			title: item.title,
		};
	}
	if (item.type === "queue") {
		return { kind: "playQueue", index: item.queueIndex };
	}
	if (item.type !== "playlist") {
		return { kind: "empty" };
	}
	return {
		kind: "loadPlaylist",
		playlistId: item.playlistId,
		title: item.title,
		provider: item.provider,
	};
}

export function createShelfCardMesh(opts: CreateShelfCardMeshOptions): ShelfCardSprite {
	const canvas = opts.createCanvas ? opts.createCanvas() : createDefaultCanvas();
	canvas.width = SHELF_CARD_CANVAS_WIDTH;
	canvas.height = SHELF_CARD_CANVAS_HEIGHT;
	const context = canvas.getContext("2d");
	if (!context) throw new Error("Shelf card canvas 2d context is unavailable");

	const texture = new opts.three.CanvasTexture(canvas);
	texture.minFilter = opts.three.LinearFilter;
	texture.magFilter = opts.three.LinearFilter;
	texture.generateMipmaps = false;
	const material = new opts.three.MeshBasicMaterial({
		map: texture,
		transparent: true,
		opacity: 0.96,
		depthWrite: false,
		depthTest: false,
		side: opts.three.DoubleSide,
	});
	const geometry = new opts.three.PlaneGeometry(
		SHELF_CARD_GEOMETRY_WIDTH,
		SHELF_CARD_GEOMETRY_HEIGHT,
		1,
		1,
	);
	const mesh = new opts.three.Mesh(geometry, material);
	mesh.renderOrder = 50 + opts.index;
	mesh.userData.shelfCardIndex = opts.index;
	mesh.userData.action = makeShelfCardAction(opts.item);
	let retired = false;
	let resourcesDisposed = false;
	let bindingGeneration = 0;
	let bindingKey = "";
	let currentItem = opts.item;
	let currentState: ShelfCardDrawState = opts.drawState ?? { index: opts.index };

	const sprite: ShelfCardSprite = {
		canvas,
		context,
		texture,
		geometry,
		material,
		mesh,
		update(item, state = { index: opts.index }) {
			if (retired) return;
			const nextBindingKey = makeShelfCardBindingKey(item, state.index);
			if (nextBindingKey !== bindingKey) {
				bindingKey = nextBindingKey;
				bindingGeneration += 1;
				mesh.userData.drawKey = undefined;
			}
			currentItem = item;
			currentState = { ...state };
			mesh.userData.shelfCardIndex = state.index;
			mesh.userData.shelfBindingGeneration = bindingGeneration;
			mesh.renderOrder = 50 + state.index;
			const coverImage = item.cover ? getLoadedShelfCover(item.cover) : null;
			drawShelfCard(context, item, state, { coverImage });
			texture.needsUpdate = true;
			mesh.userData.action = makeShelfCardAction(item);
			if (item.cover && !coverImage) {
				const requestedCover = item.cover;
				const requestedGeneration = bindingGeneration;
				requestShelfCover(item.cover, opts.createImage, () => {
					if (
						retired ||
						requestedGeneration !== bindingGeneration ||
						currentItem.cover !== requestedCover
					) return;
					sprite.update(currentItem, currentState);
				});
			}
		},
		retire() {
			if (retired) return;
			retired = true;
			bindingGeneration += 1;
		},
		dispose() {
			if (resourcesDisposed) return;
			resourcesDisposed = true;
			sprite.retire();
			texture.dispose();
			material.dispose();
			geometry.dispose();
		},
	};
	sprite.update(opts.item, opts.drawState ?? { index: opts.index });
	return sprite;
}

function makeShelfCardBindingKey(item: ShelfItem, index: number): string {
	return [
		index,
		item.type || "",
		item.title || "",
		item.sub || "",
		item.cover || "",
		item.tag || "",
		item.playlistId || "",
		item.podcastKey || "",
		item.queueIndex == null ? "" : item.queueIndex,
		item.provider || "",
	].join("|");
}

export function drawShelfCard(
	ctx: CanvasRenderingContext2D,
	item: ShelfItem,
	state: ShelfCardDrawState,
	assets: ShelfCardDrawAssets = {},
): void {
	const w = SHELF_CARD_CANVAS_WIDTH;
	const h = SHELF_CARD_CANVAS_HEIGHT;
	const centered = !!state.centered;
	const selected = !!state.selected;
	const bgOpacity = state.bgOpacity ?? SHELF_SETTINGS.bgOpacity;
	const title = item.title || "未命名歌单";
	const sub = item.sub || (item.type === "queue" ? "播放队列" : "Playlist");
	const tag = item.tag || defaultTagForItem(item);
	const accent = SHELF_SETTINGS.accent;
	const accentRgba = (alpha: number) => hexToRgba(accent, alpha);
	const isNow = item.type === "queue" && item.tag === "正在播放";

	ctx.clearRect(0, 0, w, h);
	ctx.save();
	roundRectPath(ctx, 18, 18, w - 36, h - 36, 34);
	ctx.fillStyle = `rgba(0,0,0,${bgOpacity})`;
	ctx.fill();

	const sheen = ctx.createLinearGradient(0, 0, w, h);
	sheen.addColorStop(0, "rgba(255,255,255,0.10)");
	sheen.addColorStop(1, "rgba(255,255,255,0.018)");
	ctx.fillStyle = sheen;
	ctx.fill();

	ctx.lineWidth = isNow ? 2.2 : 1.1;
	ctx.strokeStyle = isNow ? accentRgba(0.72) : "rgba(255,255,255,0.14)";
	ctx.stroke();

	if (selected) {
		roundRectPath(ctx, 20, 20, w - 40, h - 40, 32);
		ctx.shadowColor = accentRgba(0.58);
		ctx.shadowBlur = 18;
		ctx.strokeStyle = accentRgba(0.72);
		ctx.lineWidth = 2.2;
		ctx.stroke();
		ctx.shadowBlur = 0;
	}

	drawCover(ctx, item, assets.coverImage ?? null);
	drawTextBlock(ctx, tag, title, sub, centered, isNow, accentRgba);
	drawBeatLine(ctx, state.beatProgress ?? 0, isNow, accentRgba);
	if (centered) drawCenterActions(ctx, item, accent, accentRgba);
	if (state.dimmed) drawDofOverlay(ctx);
	ctx.restore();
}

function createDefaultCanvas(): HTMLCanvasElement {
	if (typeof document === "undefined" || typeof document.createElement !== "function") {
		throw new Error("Shelf card canvas requires a document or injected createCanvas");
	}
	return document.createElement("canvas");
}

function roundRectPath(
	ctx: CanvasRenderingContext2D,
	x: number,
	y: number,
	w: number,
	h: number,
	r: number,
): void {
	ctx.beginPath();
	const maybeRoundRect = ctx as CanvasRenderingContext2D & {
		roundRect?: (x: number, y: number, w: number, h: number, r: number) => void;
	};
	if (typeof maybeRoundRect.roundRect === "function") {
		maybeRoundRect.roundRect(x, y, w, h, r);
		return;
	}
	ctx.moveTo(x + r, y);
	ctx.lineTo(x + w - r, y);
	ctx.lineTo(x + w, y + r);
	ctx.lineTo(x + w, y + h - r);
	ctx.lineTo(x + w - r, y + h);
	ctx.lineTo(x + r, y + h);
	ctx.lineTo(x, y + h - r);
	ctx.lineTo(x, y + r);
}

function drawCover(ctx: CanvasRenderingContext2D, item: ShelfItem, image: CanvasImageSource | null): void {
	const pad = 18;
	const x = pad + 6;
	const y = pad + 4;
	const size = SHELF_CARD_CANVAS_HEIGHT - pad * 2 - 8;
	roundRectPath(ctx, x, y, size, size, 24);
	ctx.fillStyle = "rgba(255,255,255,0.04)";
	ctx.fill();
	if (image) {
		ctx.save();
		roundRectPath(ctx, x, y, size, size, 24);
		ctx.clip();
		ctx.drawImage(image, x, y, size, size);
		ctx.restore();
		return;
	}
	ctx.strokeStyle = "rgba(255,255,255,0.18)";
	ctx.lineWidth = 2;
	ctx.stroke();

	ctx.fillStyle = "rgba(255,255,255,0.72)";
	ctx.font = "700 44px system-ui, sans-serif";
	ctx.textAlign = "center";
	ctx.textBaseline = "middle";
	const mark = item.type === "queue" ? "Q" : (item.title || "M").slice(0, 1).toUpperCase();
	ctx.fillText(mark, x + size / 2, y + size / 2);
}

function drawTextBlock(
	ctx: CanvasRenderingContext2D,
	tag: string,
	title: string,
	sub: string,
	centered: boolean,
	isNow: boolean,
	accentRgba: (alpha: number) => string,
): void {
	const tx = 18 + (SHELF_CARD_CANVAS_HEIGHT - 18 * 2 - 8) + 32;
	ctx.textAlign = "left";
	ctx.textBaseline = "alphabetic";
	ctx.font = "700 17px Inter, Arial, sans-serif";
	ctx.fillStyle = isNow ? accentRgba(0.92) : "rgba(255,255,255,0.92)";
	ctx.fillText(trimToWidth(ctx, tag, 330), tx, 54);

	ctx.font = "700 30px Inter, Arial, sans-serif";
	ctx.fillStyle = "rgba(255,255,255,0.96)";
	wrapText(ctx, title, tx, 96, SHELF_CARD_CANVAS_WIDTH - tx - 32, 36, 2);

	ctx.font = "400 17px Inter, Arial, sans-serif";
	ctx.fillStyle = "rgba(255,255,255,0.52)";
	wrapText(ctx, sub, tx, 174, SHELF_CARD_CANVAS_WIDTH - tx - 32, 24, 2);
	if (centered) {
		ctx.fillStyle = accentRgba(0.72);
		ctx.fillText("", tx, 210);
	}
}

function drawBeatLine(ctx: CanvasRenderingContext2D, progress: number, isNow: boolean, accentRgba: (alpha: number) => string): void {
	const x = 18 + (SHELF_CARD_CANVAS_HEIGHT - 18 * 2 - 8) + 32;
	const y = SHELF_CARD_CANVAS_HEIGHT - 40;
	const w = Math.min(260, 80 + 320 * clamp01(progress));
	ctx.lineCap = "round";
	ctx.lineWidth = 3.5;
	ctx.strokeStyle = isNow ? accentRgba(0.90) : "rgba(255,255,255,0.30)";
	ctx.beginPath();
	ctx.moveTo(x, y);
	ctx.lineTo(x + w, y);
	ctx.stroke();
}

function drawCenterActions(ctx: CanvasRenderingContext2D, item: ShelfItem, accent: string, accentRgba: (alpha: number) => string): void {
	const tx = 18 + (SHELF_CARD_CANVAS_HEIGHT - 18 * 2 - 8) + 32;
	const actionY = SHELF_CARD_CANVAS_HEIGHT - 96;
	if (item.type === "queue") {
		ctx.font = '600 14px Inter, "Microsoft YaHei", Arial, sans-serif';
		ctx.fillStyle = accentRgba(0.84);
		ctx.fillText("点击播放", tx, actionY + 25);
		return;
	}
	roundRectPath(ctx, tx, actionY, 138, 38, 18);
	const playGrad = ctx.createLinearGradient(tx, actionY, tx + 138, actionY + 38);
	playGrad.addColorStop(0, "rgba(255,255,255,0.88)");
	playGrad.addColorStop(0.55, accentRgba(0.94));
	playGrad.addColorStop(1, accentRgba(0.58));
	ctx.fillStyle = playGrad;
	ctx.fill();
	ctx.strokeStyle = accentRgba(0.44);
	ctx.lineWidth = 1.1;
	ctx.stroke();
	ctx.font = '800 14px Inter, "Microsoft YaHei", Arial, sans-serif';
	ctx.fillStyle = readableInkForHex(accent);
	ctx.fillText("▶ 播放歌单", tx + 25, actionY + 24);

	roundRectPath(ctx, tx + 150, actionY, 104, 38, 18);
	ctx.fillStyle = "rgba(255,255,255,0.055)";
	ctx.fill();
	ctx.strokeStyle = "rgba(255,255,255,0.14)";
	ctx.lineWidth = 1.1;
	ctx.stroke();
	ctx.font = '700 14px Inter, "Microsoft YaHei", Arial, sans-serif';
	ctx.fillStyle = "rgba(255,255,255,0.78)";
	ctx.fillText("详情", tx + 184, actionY + 24);
}

function drawDofOverlay(ctx: CanvasRenderingContext2D): void {
	ctx.fillStyle = "rgba(0,0,0,0.22)";
	roundRectPath(ctx, 18, 18, SHELF_CARD_CANVAS_WIDTH - 36, SHELF_CARD_CANVAS_HEIGHT - 36, 34);
	ctx.fill();
}

function defaultTagForItem(item: ShelfItem): string {
	if (item.type === "podcastCollection") return "PODCAST";
	if (item.type === "queue") return "NOW PLAYING";
	return "PLAYLIST";
}

function trimToWidth(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
	if (ctx.measureText(text).width <= maxWidth) return text;
	let next = text;
	while (next.length > 1 && ctx.measureText(`${next}…`).width > maxWidth) {
		next = next.slice(0, -1);
	}
	return `${next}…`;
}

function wrapText(
	ctx: CanvasRenderingContext2D,
	text: string,
	x: number,
	y: number,
	maxWidth: number,
	lineHeight: number,
	maxLines: number,
): void {
	const words = String(text || "").split(/\s+/).filter(Boolean);
	const units = words.length > 1 ? words : Array.from(String(text || ""));
	let line = "";
	let lines = 0;
	for (const unit of units) {
		const next = line ? `${line}${words.length > 1 ? " " : ""}${unit}` : unit;
		if (line && ctx.measureText(next).width > maxWidth) {
			ctx.fillText(trimToWidth(ctx, line, maxWidth), x, y + lines * lineHeight);
			lines += 1;
			line = unit;
			if (lines >= maxLines) return;
		} else {
			line = next;
		}
	}
	if (line && lines < maxLines) ctx.fillText(trimToWidth(ctx, line, maxWidth), x, y + lines * lineHeight);
}

function clamp01(v: number): number {
	if (v < 0) return 0;
	if (v > 1) return 1;
	return v;
}

function getLoadedShelfCover(url: string): HTMLImageElement | null {
	const rec = shelfCoverCache.get(url);
	return rec?.loaded ? rec.img : null;
}

function requestShelfCover(
	url: string,
	createImage: (() => HTMLImageElement) | undefined,
	cb: (img: HTMLImageElement | null) => void,
): void {
	if (!url) {
		cb(null);
		return;
	}
	const cached = shelfCoverCache.get(url);
	if (cached?.loaded) {
		setTimeout(() => cb(cached.img), 0);
		return;
	}
	if (cached?.loading) {
		cached.waiters.push(cb);
		return;
	}
	if (cached?.failed) {
		setTimeout(() => cb(null), 0);
		return;
	}
	const img = createImage ? createImage() : createDefaultImage();
	if (!img) {
		shelfCoverCache.set(url, { loaded: false, loading: false, failed: true, img: null, waiters: [] });
		cb(null);
		return;
	}
	const rec: ShelfCoverRecord = { loaded: false, loading: true, failed: false, img: null, waiters: [cb] };
	shelfCoverCache.set(url, rec);
	if (!isInlineCoverSrc(url)) img.crossOrigin = "anonymous";
	img.onload = () => {
		rec.loaded = true;
		rec.loading = false;
		rec.img = img;
		const waiters = rec.waiters.splice(0);
		for (const waiter of waiters) setTimeout(() => waiter(img), 0);
	};
	img.onerror = () => {
		rec.loading = false;
		rec.failed = true;
		const waiters = rec.waiters.splice(0);
		for (const waiter of waiters) setTimeout(() => waiter(null), 0);
	};
	img.src = url;
}

function createDefaultImage(): HTMLImageElement | null {
	if (typeof Image === "undefined") return null;
	return new Image();
}

function isInlineCoverSrc(src: string): boolean {
	return /^data:image\//i.test(src) || /^blob:/i.test(src);
}

function hexToRgba(hex: string, alpha: number): string {
	const normalized = hex.replace(/^#/, "");
	const valid = /^[0-9a-f]{6}$/i.test(normalized) ? normalized : "f4d28a";
	const n = parseInt(valid, 16);
	return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${clamp01(alpha)})`;
}

function readableInkForHex(hex: string): string {
	const normalized = hex.replace(/^#/, "");
	const valid = /^[0-9a-f]{6}$/i.test(normalized) ? normalized : "f4d28a";
	const n = parseInt(valid, 16);
	const r = (n >> 16) & 255;
	const g = (n >> 8) & 255;
	const b = n & 255;
	const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
	return luminance > 0.62 ? "rgba(18,16,12,0.94)" : "rgba(255,255,255,0.94)";
}
