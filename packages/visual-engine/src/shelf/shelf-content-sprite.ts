import type * as THREE from "three";
import type { ShelfContentRow } from "./shelf-content-list";
import {
	SHELF_CONTENT_PANEL_SCREEN_HEIGHT,
	SHELF_CONTENT_PANEL_SCREEN_WIDTH,
	SHELF_CONTENT_ROW_SCREEN_HEIGHT,
	SHELF_CONTENT_ROW_SCREEN_WIDTH,
} from "./shelf-content-list";

export const SHELF_CONTENT_PANEL_CANVAS_WIDTH = 900;
export const SHELF_CONTENT_PANEL_CANVAS_HEIGHT = 1024;
export const SHELF_CONTENT_ROW_CANVAS_WIDTH = 800;
export const SHELF_CONTENT_ROW_CANVAS_HEIGHT = 104;

export interface ShelfContentPanelSprite {
	readonly canvas: HTMLCanvasElement;
	readonly texture: THREE.CanvasTexture;
	readonly geometry: THREE.PlaneGeometry;
	readonly material: THREE.MeshBasicMaterial;
	readonly mesh: THREE.Mesh;
	update(next: ShelfContentPanelUpdate): void;
	retire(): void;
	dispose(): void;
}

export interface ShelfContentRowSprite {
	readonly canvas: HTMLCanvasElement;
	readonly texture: THREE.CanvasTexture;
	readonly geometry: THREE.PlaneGeometry;
	readonly material: THREE.MeshBasicMaterial;
	readonly mesh: THREE.Mesh;
	index: number;
	row: ShelfContentRow;
	lastCenter: boolean;
	update(row: ShelfContentRow, index: number, centered: boolean): void;
	retire(): void;
	dispose(): void;
}

export interface ShelfContentSpriteOptions {
	three: typeof import("three");
	createCanvas: () => HTMLCanvasElement;
}

export interface ShelfContentPanelMetadata {
	title: string;
	trackCount?: number;
	provider?: string;
	cover?: string;
	coverUrl?: string;
	loading?: boolean;
	error?: string;
	empty?: boolean;
}

export type ShelfContentPanelUpdate = string | ShelfContentPanelMetadata;

export function createShelfContentPanelSprite(
	opts: ShelfContentSpriteOptions,
	title: string,
): ShelfContentPanelSprite {
	const canvas = opts.createCanvas();
	canvas.width = SHELF_CONTENT_PANEL_CANVAS_WIDTH;
	canvas.height = SHELF_CONTENT_PANEL_CANVAS_HEIGHT;
	const texture = makeTexture(opts.three, canvas);
	const material = new opts.three.MeshBasicMaterial({
		map: texture,
		transparent: true,
		opacity: 0.86,
		depthWrite: false,
		depthTest: false,
		side: opts.three.DoubleSide,
	});
	const geometry = new opts.three.PlaneGeometry(
		SHELF_CONTENT_PANEL_SCREEN_WIDTH,
		SHELF_CONTENT_PANEL_SCREEN_HEIGHT,
		1,
		1,
	);
	const mesh = new opts.three.Mesh(geometry, material);
	mesh.position.set(-0.02, 0, 0.20);
	mesh.renderOrder = 232;
	mesh.userData.shelfContentDetail = true;
	mesh.userData.shelfContentKind = "panel";
	let retired = false;
	let resourcesDisposed = false;

	const sprite: ShelfContentPanelSprite = {
		canvas,
		texture,
		geometry,
		material,
		mesh,
		update(nextTitle) {
			if (retired) return;
			drawPanel(canvas, nextTitle);
			texture.needsUpdate = true;
		},
		retire() {
			retired = true;
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
	sprite.update(title);
	return sprite;
}

export function createShelfContentRowSprite(
	opts: ShelfContentSpriteOptions,
	row: ShelfContentRow,
	index: number,
	centered: boolean,
): ShelfContentRowSprite {
	const canvas = opts.createCanvas();
	canvas.width = SHELF_CONTENT_ROW_CANVAS_WIDTH;
	canvas.height = SHELF_CONTENT_ROW_CANVAS_HEIGHT;
	const texture = makeTexture(opts.three, canvas);
	const material = new opts.three.MeshBasicMaterial({
		map: texture,
		transparent: true,
		opacity: 0.96,
		depthWrite: false,
		depthTest: false,
		side: opts.three.DoubleSide,
	});
	const geometry = new opts.three.PlaneGeometry(
		SHELF_CONTENT_ROW_SCREEN_WIDTH,
		SHELF_CONTENT_ROW_SCREEN_HEIGHT,
		1,
		1,
	);
	const mesh = new opts.three.Mesh(geometry, material);
	mesh.renderOrder = 240 + index;
	mesh.userData.shelfContentDetail = true;
	mesh.userData.shelfContentKind = "row";
	mesh.userData.shelfContentRowIndex = index;
	let bindingGeneration = 0;
	let bindingKey = "";
	let retired = false;
	let resourcesDisposed = false;

	const sprite: ShelfContentRowSprite = {
		canvas,
		texture,
		geometry,
		material,
		mesh,
		index,
		row,
		lastCenter: centered,
		update(nextRow, nextIndex, nextCentered) {
			if (retired) return;
			const nextBindingKey = makeShelfContentRowBindingKey(nextRow, nextIndex);
			if (nextBindingKey !== bindingKey) {
				bindingKey = nextBindingKey;
				bindingGeneration += 1;
			}
			this.index = nextIndex;
			this.row = nextRow;
			this.lastCenter = nextCentered;
			mesh.userData.shelfContentRowIndex = nextIndex;
			mesh.userData.shelfBindingGeneration = bindingGeneration;
			mesh.renderOrder = 240 + nextIndex;
			drawRow(canvas, nextRow, nextIndex, nextCentered);
			texture.needsUpdate = true;
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
	sprite.update(row, index, centered);
	return sprite;
}

function makeShelfContentRowBindingKey(row: ShelfContentRow, index: number): string {
	return [
		index,
		row.id || "",
		row.name || "",
		row.title || "",
		row.artist || "",
		row.album || "",
		row.provider || "",
		row.kind || "",
		row.type || "",
		row.cover || "",
		row.coverUrl || "",
	].join("|");
}

function makeTexture(
	three: typeof import("three"),
	canvas: HTMLCanvasElement,
): THREE.CanvasTexture {
	const texture = new three.CanvasTexture(canvas);
	texture.minFilter = three.LinearFilter;
	texture.magFilter = three.LinearFilter;
	texture.generateMipmaps = false;
	return texture;
}

function drawPanel(canvas: HTMLCanvasElement, next: ShelfContentPanelUpdate): void {
	const ctx = canvas.getContext("2d");
	if (!ctx) return;
	const meta = normalizePanelMetadata(next);
	const w = canvas.width;
	const h = canvas.height;
	ctx.clearRect(0, 0, w, h);
	roundRectPath(ctx, 24, 28, w - 48, h - 56, 34);
	const bg = ctx.createLinearGradient(0, 0, w, h);
	bg.addColorStop(0, "rgba(0,0,0,0.86)");
	bg.addColorStop(1, "rgba(0,0,0,0.68)");
	ctx.fillStyle = bg;
	ctx.fill();
	ctx.strokeStyle = "rgba(255,255,255,0.16)";
	ctx.lineWidth = 1.4;
	ctx.stroke();

	drawPanelCover(ctx, meta);

	const hasCover = Boolean(meta.cover || meta.coverUrl);
	const titleX = hasCover ? 202 : 72;
	const titleMaxWidth = hasCover ? w - 274 : w - 144;
	ctx.font = "800 38px Inter, Microsoft YaHei, Arial";
	ctx.fillStyle = "rgba(255,246,220,0.94)";
	ctx.fillText(trimToWidth(ctx, meta.title || "歌单详情", titleMaxWidth), titleX, 92);
	ctx.font = "500 18px Inter, Microsoft YaHei, Arial";
	ctx.fillStyle = "rgba(122,240,255,0.62)";
	ctx.fillText(buildPanelSubtitle(meta), titleX + 2, 128);
	const status = panelStatusText(meta);
	if (status) {
		ctx.font = "700 20px Inter, Microsoft YaHei, Arial";
		ctx.fillStyle = meta.error ? "rgba(255,126,126,0.88)" : "rgba(122,240,255,0.82)";
		ctx.fillText(status, titleX + 2, 166);
	}
	ctx.fillStyle = "rgba(122,240,255,0.34)";
	ctx.fillRect(72, 204, w - 144, 2);
}

function drawRow(
	canvas: HTMLCanvasElement,
	row: ShelfContentRow,
	index: number,
	centered: boolean,
): void {
	const ctx = canvas.getContext("2d");
	if (!ctx) return;
	const w = canvas.width;
	const h = canvas.height;
	ctx.clearRect(0, 0, w, h);

	if (isPlaceholderRow(row)) {
		drawPlaceholderRow(ctx, canvas, row, centered);
		return;
	}

	roundRectPath(ctx, 14, 10, w - 28, h - 20, 22);
	ctx.fillStyle = centered ? "rgba(8,14,24,0.92)" : "rgba(0,0,0,0.62)";
	ctx.fill();
	ctx.strokeStyle = centered ? "rgba(122,240,255,0.48)" : "rgba(255,255,255,0.10)";
	ctx.lineWidth = centered ? 1.6 : 1;
	ctx.stroke();
	ctx.font = "700 18px Inter, Arial";
	ctx.fillStyle = centered ? "rgba(122,240,255,0.95)" : "rgba(255,255,255,0.34)";
	ctx.fillText(String(index + 1).padStart(2, "0"), 32, 52);
	drawRowCover(ctx, row, centered);
	ctx.font = centered ? "800 24px Inter, Microsoft YaHei, Arial" : "600 20px Inter, Microsoft YaHei, Arial";
	ctx.fillStyle = centered ? "rgba(255,247,224,0.96)" : "rgba(255,255,255,0.80)";
	ctx.fillText(trimToWidth(ctx, row.title || row.name || "", w - 302), 130, 44);
	ctx.font = "500 15px Inter, Microsoft YaHei, Arial";
	ctx.fillStyle = centered ? "rgba(255,255,255,0.88)" : "rgba(255,255,255,0.64)";
	ctx.fillText(trimToWidth(ctx, buildRowSubtitle(row), w - 342), 130, 72);
	drawRowRightMeta(ctx, row, centered, w);
}

function normalizePanelMetadata(next: ShelfContentPanelUpdate): ShelfContentPanelMetadata {
	if (typeof next === "string") return { title: next };
	return next;
}

function drawPanelCover(
	ctx: CanvasRenderingContext2D,
	meta: ShelfContentPanelMetadata,
): void {
	const hasCover = Boolean(meta.cover || meta.coverUrl);
	if (!hasCover) return;
	const x = 72;
	const y = 66;
	const size = 104;
	roundRectPath(ctx, x, y, size, size, 20);
	const bg = ctx.createLinearGradient(x, y, x + size, y + size);
	bg.addColorStop(0, "rgba(122,240,255,0.28)");
	bg.addColorStop(1, "rgba(255,246,220,0.16)");
	ctx.fillStyle = bg;
	ctx.fill();
	ctx.strokeStyle = "rgba(255,255,255,0.22)";
	ctx.lineWidth = 1.2;
	ctx.stroke();
	ctx.fillStyle = "rgba(255,255,255,0.42)";
	ctx.fillRect(x + 28, y + 70, 48, 3);
	fillCircle(ctx, x + 52, y + 43, 16, "rgba(255,255,255,0.22)");
}

function buildPanelSubtitle(meta: ShelfContentPanelMetadata): string {
	const parts: string[] = [];
	if (Number.isFinite(meta.trackCount)) parts.push(`${meta.trackCount} 首`);
	if (meta.provider) parts.push(meta.provider);
	return parts.length ? parts.join(" · ") : "详情列表";
}

function panelStatusText(meta: ShelfContentPanelMetadata): string {
	if (meta.loading) return "正在载入歌单";
	if (meta.error) return meta.error;
	if (meta.empty) return "歌单暂无可播放歌曲";
	return "";
}

function isPlaceholderRow(row: ShelfContentRow): boolean {
	return row.kind === "loading" || row.kind === "error" || row.kind === "empty";
}

function drawPlaceholderRow(
	ctx: CanvasRenderingContext2D,
	canvas: HTMLCanvasElement,
	row: ShelfContentRow,
	centered: boolean,
): void {
	const w = canvas.width;
	const h = canvas.height;
	const tone = row.kind === "error"
		? {
			bg: centered ? "rgba(38,12,18,0.90)" : "rgba(26,8,12,0.66)",
			stroke: "rgba(255,126,126,0.34)",
			icon: "rgba(255,126,126,0.86)",
			sub: "rgba(255,205,205,0.62)",
		}
		: row.kind === "empty"
			? {
				bg: centered ? "rgba(18,18,18,0.88)" : "rgba(0,0,0,0.58)",
				stroke: "rgba(255,246,220,0.18)",
				icon: "rgba(255,246,220,0.62)",
				sub: "rgba(255,255,255,0.54)",
			}
			: {
				bg: centered ? "rgba(8,24,30,0.90)" : "rgba(0,14,18,0.62)",
				stroke: "rgba(122,240,255,0.36)",
				icon: "rgba(122,240,255,0.84)",
				sub: "rgba(210,250,255,0.62)",
			};
	roundRectPath(ctx, 14, 10, w - 28, h - 20, 22);
	ctx.fillStyle = tone.bg;
	ctx.fill();
	ctx.strokeStyle = tone.stroke;
	ctx.lineWidth = centered ? 1.6 : 1;
	ctx.stroke();
	fillCircle(ctx, 58, 52, 14, tone.icon);
	ctx.font = centered ? "800 23px Inter, Microsoft YaHei, Arial" : "700 20px Inter, Microsoft YaHei, Arial";
	ctx.fillStyle = tone.icon;
	ctx.fillText(placeholderTitle(row), 90, 46);
	ctx.font = "500 15px Inter, Microsoft YaHei, Arial";
	ctx.fillStyle = tone.sub;
	ctx.fillText(placeholderSubtitle(row), 90, 72);
}

function placeholderTitle(row: ShelfContentRow): string {
	if (row.kind === "loading") return "正在载入歌单";
	if (row.kind === "empty") return "歌单暂无可播放歌曲";
	return row.name || "歌单加载失败";
}

function placeholderSubtitle(row: ShelfContentRow): string {
	if (row.kind === "loading") return "请稍候";
	if (row.kind === "empty") return "换一个歌单试试";
	return "请稍后重试";
}

function drawRowCover(
	ctx: CanvasRenderingContext2D,
	row: ShelfContentRow,
	centered: boolean,
): void {
	const x = 70;
	const y = 28;
	const size = 48;
	roundRectPath(ctx, x, y, size, size, 12);
	const bg = ctx.createLinearGradient(x, y, x + size, y + size);
	if (row.cover || row.coverUrl) {
		bg.addColorStop(0, "rgba(122,240,255,0.28)");
		bg.addColorStop(1, "rgba(255,246,220,0.18)");
	} else {
		bg.addColorStop(0, centered ? "rgba(255,255,255,0.12)" : "rgba(255,255,255,0.08)");
		bg.addColorStop(1, "rgba(122,240,255,0.08)");
	}
	ctx.fillStyle = bg;
	ctx.fill();
	ctx.strokeStyle = row.cover || row.coverUrl ? "rgba(255,255,255,0.20)" : "rgba(255,255,255,0.10)";
	ctx.lineWidth = 1;
	ctx.stroke();
	fillCircle(
		ctx,
		x + size / 2,
		y + size / 2,
		row.cover || row.coverUrl ? 10 : 8,
		row.cover || row.coverUrl ? "rgba(255,255,255,0.24)" : "rgba(255,255,255,0.14)",
	);
}

function fillCircle(
	ctx: CanvasRenderingContext2D,
	x: number,
	y: number,
	radius: number,
	fillStyle: string,
): void {
	const maybeArc = ctx as CanvasRenderingContext2D & {
		arc?: (x: number, y: number, radius: number, startAngle: number, endAngle: number) => void;
	};
	ctx.beginPath();
	if (typeof maybeArc.arc === "function") {
		maybeArc.arc(x, y, radius, 0, Math.PI * 2);
	} else {
		roundRectPath(ctx, x - radius, y - radius, radius * 2, radius * 2, radius);
	}
	ctx.fillStyle = fillStyle;
	ctx.fill();
}

function buildRowSubtitle(row: ShelfContentRow): string {
	const artists = row.artists?.length ? row.artists.join(" / ") : row.artist;
	return [artists, row.album, row.provider].filter(Boolean).join(" · ");
}

function drawRowRightMeta(
	ctx: CanvasRenderingContext2D,
	row: ShelfContentRow,
	centered: boolean,
	w: number,
): void {
	const rightX = w - 34;
	ctx.textAlign = "right";
	const duration = formatDuration(row.durationMs);
	if (duration) {
		ctx.font = "700 16px Inter, Arial";
		ctx.fillStyle = centered ? "rgba(255,246,220,0.84)" : "rgba(255,255,255,0.54)";
		ctx.fillText(duration, rightX, 42);
	}
	const quality = formatQuality(row.qualityHints);
	if (quality) {
		ctx.font = "800 13px Inter, Arial";
		ctx.fillStyle = centered ? "rgba(122,240,255,0.86)" : "rgba(122,240,255,0.56)";
		ctx.fillText(quality, rightX, 68);
	}
	const state = formatPlayableState(row.playableState);
	if (state) {
		ctx.font = "800 13px Inter, Microsoft YaHei, Arial";
		ctx.fillStyle = "rgba(255,188,126,0.92)";
		ctx.fillText(state, quality ? rightX - 76 : rightX, 68);
	}
	ctx.textAlign = "start";
}

function formatDuration(durationMs: number | undefined): string {
	if (!Number.isFinite(durationMs) || durationMs === undefined || durationMs < 0) return "";
	const totalSeconds = Math.floor(durationMs / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatQuality(qualityHints: string[] | undefined): string {
	if (!qualityHints?.length) return "";
	return qualityHints.filter(Boolean).slice(0, 2).join(" / ");
}

function formatPlayableState(playableState: string | undefined): string {
	const state = String(playableState || "").trim();
	if (!state || /^playable$/i.test(state) || /^unknown$/i.test(state)) return "";
	const known: Record<string, string> = {
		vip: "VIP",
		vip_required: "VIP",
		fee: "付费",
		unavailable: "不可播放",
		nocopyright: "无版权",
		noCopyright: "无版权",
	};
	return known[state] ?? state.toUpperCase();
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

function trimToWidth(
	ctx: CanvasRenderingContext2D,
	text: string,
	maxWidth: number,
): string {
	if (ctx.measureText(text).width <= maxWidth) return text;
	let next = text;
	while (next.length > 1 && ctx.measureText(`${next}...`).width > maxWidth) {
		next = next.slice(0, -1);
	}
	return `${next}...`;
}
