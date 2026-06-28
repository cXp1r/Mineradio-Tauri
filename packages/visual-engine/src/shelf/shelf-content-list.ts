import type { DetailProfile } from "./shelf-layout-profile";
import { getDefaultShelfLayoutProfile } from "./shelf-layout-profile";
import { SHELF_SETTINGS, type ShelfSettings } from "./shelf-settings";

export const CONTENT_VISIBLE_RADIUS = 5;
export const CONTENT_MAX_RENDER = CONTENT_VISIBLE_RADIUS * 2 + 1;
export const SHELF_CONTENT_ROW_SCREEN_WIDTH = 2.50;
export const SHELF_CONTENT_ROW_SCREEN_HEIGHT = 0.36;
export const SHELF_CONTENT_ROW_SCREEN_PAD_X = 24;
export const SHELF_CONTENT_ROW_SCREEN_PAD_Y = 16;
export const SHELF_CONTENT_PANEL_SCREEN_WIDTH = 2.62;
export const SHELF_CONTENT_PANEL_SCREEN_HEIGHT = 3.02;
export const SHELF_CONTENT_PANEL_SCREEN_PAD = 42;

export type ShelfContentKind = "playlist" | "podcast";
export type ShelfContentPlaceholderKind = "loading" | "error" | "empty";

export interface ShelfContentRow {
	id?: string;
	name: string;
	artist?: string;
	type?: string;
	cover?: string;
	provider?: string;
	kind?: ShelfContentPlaceholderKind;
	sourceId?: string;
	title?: string;
	artists?: string[];
	album?: string;
	coverUrl?: string;
	durationMs?: number;
	playableState?: string;
	qualityHints?: string[];
}

export interface ShelfContentSourceCard {
	id?: string;
	item?: {
		cover?: string;
		playlistId?: string;
		podcastKey?: string;
		provider?: string;
	};
}

export interface ShelfContentOpenOptions {
	playlistId: string;
	title: string;
	kind?: ShelfContentKind;
	sourceCard?: ShelfContentSourceCard | null;
}

export interface ShelfContentListOptions {
	now?: () => number;
	onSelectTick?: (delta: number, kind: "row") => void;
}

export interface ShelfContentSnapshot {
	open: boolean;
	centerTarget: number;
	centerSmooth: number;
	playlistId: string;
	playlistTitle: string;
	contentKind: ShelfContentKind;
	requestToken: number;
	openAnimAt: number;
	rowAnimAt: number;
	renderedStart: number;
	sourceCard: ShelfContentSourceCard | null;
}

export interface ShelfContentRenderWindow {
	start: number;
	end: number;
}

export interface ShelfContentRowLayoutInputs {
	now: number;
	layout?: DetailProfile;
	settings?: ShelfSettings;
	skullSafe?: boolean;
	pointerParallax?: {
		x?: number;
		y?: number;
	};
	pulse?: number;
	rowSettle?: number;
}

export interface ShelfContentRowLayout {
	visible: boolean;
	index: number;
	delta: number;
	absD: number;
	revealRaw: number;
	reveal: number;
	renderOrder: number;
	position: {
		x: number;
		y: number;
		z: number;
	};
	scale: number;
	opacity: number;
	rotation: {
		x: number;
		y: number;
	};
}

export interface ShelfContentScreenPoint {
	x: number;
	y: number;
}

export interface ShelfContentScreenBounds {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}

export interface ShelfContentScreenRow<T = ShelfContentRow> {
	row: T;
	index: number;
	visible?: boolean;
	renderOrder?: number;
	bounds: ShelfContentScreenBounds;
}

export interface ShelfContentScreenPanel {
	visible?: boolean;
	bounds: ShelfContentScreenBounds;
}

export interface ShelfContentScreenTargets {
	rows?: ShelfContentScreenRow[];
	panel?: ShelfContentScreenPanel | null;
}

export interface PickShelfContentRowAtScreenOptions {
	padX?: number;
	padY?: number;
}

export interface ShelfContentScreenRowPick<T = ShelfContentRow> {
	row: T;
	index: number;
	uv: ShelfContentScreenPoint;
	screenPick: true;
}

export interface ScreenContainsShelfContentPanelOptions {
	pad?: number;
}

export interface ShelfContentPanelOpacityInputs {
	now: number;
	openAnimAt: number;
	settings?: ShelfSettings;
}

export interface ShelfContentList {
	open(opts: ShelfContentOpenOptions): number;
	setRows(rows: ShelfContentRow[], kind?: ShelfContentKind): void;
	setRowsForToken(token: number, rows: ShelfContentRow[], kind?: ShelfContentKind): void;
	setLoading(): void;
	setError(label: string): void;
	setErrorForToken(token: number, label: string): void;
	close(): void;
	isOpen(): boolean;
	getRows(): ShelfContentRow[];
	getCenterIdx(): number;
	scrollBy(delta: number): void;
	next(): void;
	prev(): void;
	update(now: number): void;
	advance(now: number, dt?: number): void;
	computeRenderWindow(): ShelfContentRenderWindow;
	computeRowLayout(rowIndex: number, inputs: ShelfContentRowLayoutInputs): ShelfContentRowLayout;
	setScreenTargets(targets: ShelfContentScreenTargets): void;
	clearScreenTargets(): void;
	pickRowAtScreen(pointer: ShelfContentScreenPoint): ShelfContentScreenRowPick | null;
	screenContainsPanel(pointer: ShelfContentScreenPoint): boolean;
	hasScreenTargetAt(pointer: ShelfContentScreenPoint): boolean;
	getSnapshot(): ShelfContentSnapshot;
}

export function createShelfContentList(opts: ShelfContentListOptions = {}): ShelfContentList {
	const nowFn = opts.now ?? (() => (typeof performance !== "undefined" ? performance.now() / 1000 : Date.now() / 1000));
	let rows: ShelfContentRow[] = [];
	let renderedStart = -1;
	let openState = false;
	let centerTarget = 0;
	let centerSmooth = 0;
	let playlistId = "";
	let playlistTitle = "";
	let contentKind: ShelfContentKind = "playlist";
	let sourceCard: ShelfContentSourceCard | null = null;
	let requestToken = 0;
	let openAnimAt = -10;
	let rowAnimAt = -10;
	let screenRows: ShelfContentScreenRow[] = [];
	let screenPanel: ShelfContentScreenPanel | null = null;

	const clearScreenTargets = () => {
		screenRows = [];
		screenPanel = null;
	};

	return {
		open(openOpts) {
			clearScreenTargets();
			openState = true;
			playlistId = openOpts.playlistId;
			playlistTitle = openOpts.title;
			contentKind = openOpts.kind ?? contentKindFromPlaylistId(openOpts.playlistId);
			sourceCard = openOpts.sourceCard ?? null;
			requestToken++;
			openAnimAt = nowFn();
			rowAnimAt = openAnimAt;
			centerTarget = 0;
			centerSmooth = 0;
			renderedStart = -1;
			rows = [makePlaceholderRow("加载中…", "loading")];
			return requestToken;
		},
		setRows(nextRows, kind) {
			clearScreenTargets();
			rows = nextRows.map(cloneRow);
			if (kind) contentKind = kind;
			centerTarget = 0;
			centerSmooth = 0;
			renderedStart = -1;
			rowAnimAt = nowFn();
		},
		setRowsForToken(token, nextRows, kind) {
			if (!openState || token !== requestToken) return;
			this.setRows(nextRows, kind);
		},
		setLoading() {
			clearScreenTargets();
			rows = [makePlaceholderRow("加载中…", "loading")];
			centerTarget = 0;
			centerSmooth = 0;
			renderedStart = -1;
			rowAnimAt = nowFn();
		},
		setError(label) {
			clearScreenTargets();
			rows = [makePlaceholderRow(label, "error")];
			centerTarget = 0;
			centerSmooth = 0;
			renderedStart = -1;
			rowAnimAt = nowFn();
		},
		setErrorForToken(token, label) {
			if (!openState || token !== requestToken) return;
			this.setError(label);
		},
		close() {
			clearScreenTargets();
			openState = false;
			requestToken++;
			rows = [];
			renderedStart = -1;
			playlistId = "";
			playlistTitle = "";
			contentKind = "playlist";
			sourceCard = null;
		},
		isOpen() {
			return openState;
		},
		getRows() {
			return rows;
		},
		getCenterIdx() {
			return clampInt(Math.round(centerSmooth), 0, Math.max(0, rows.length - 1));
		},
		scrollBy(delta) {
			if (!rows.length) return;
			const previous = Math.round(centerTarget);
			centerTarget = clampInt(centerTarget + delta, 0, rows.length - 1);
			const next = Math.round(centerTarget);
			if (next !== previous) opts.onSelectTick?.(delta, "row");
		},
		next() {
			this.scrollBy(1);
		},
		prev() {
			this.scrollBy(-1);
		},
		update(now) {
			this.advance(now);
		},
		advance() {
			centerSmooth += (centerTarget - centerSmooth) * 0.18;
			if (Math.abs(centerSmooth - centerTarget) < 0.001) centerSmooth = centerTarget;
		},
		computeRenderWindow() {
			if (!rows.length) {
				renderedStart = -1;
				return { start: 0, end: -1 };
			}
			const center = clampInt(Math.round(centerTarget), 0, rows.length - 1);
			let start = Math.max(0, center - CONTENT_VISIBLE_RADIUS);
			let end = Math.min(rows.length - 1, start + CONTENT_MAX_RENDER - 1);
			start = Math.max(0, end - CONTENT_MAX_RENDER + 1);
			renderedStart = start;
			return { start, end };
		},
		computeRowLayout(rowIndex, inputs) {
			return computeContentRowLayout({
				rowIndex,
				centerSmooth,
				rowAnimAt,
				now: inputs.now,
				layout: inputs.layout ?? getDefaultShelfLayoutProfile({ skullSafe: inputs.skullSafe }).detail,
				settings: inputs.settings ?? SHELF_SETTINGS,
				skullSafe: inputs.skullSafe ?? false,
				pointerParallax: inputs.pointerParallax,
				pulse: inputs.pulse,
				rowSettle: inputs.rowSettle,
			});
		},
		setScreenTargets(targets) {
			screenRows = (targets.rows ?? []).map(cloneScreenRow);
			screenPanel = targets.panel ? cloneScreenPanel(targets.panel) : null;
		},
		clearScreenTargets() {
			clearScreenTargets();
		},
		pickRowAtScreen(pointer) {
			return pickShelfContentRowAtScreen(screenRows, pointer);
		},
		screenContainsPanel(pointer) {
			return screenContainsShelfContentPanel(screenPanel, pointer);
		},
		hasScreenTargetAt(pointer) {
			if (pickShelfContentRowAtScreen(screenRows, pointer)) return true;
			return screenContainsShelfContentPanel(screenPanel, pointer);
		},
		getSnapshot() {
			return {
				open: openState,
				centerTarget,
				centerSmooth,
				playlistId,
				playlistTitle,
				contentKind,
				requestToken,
				openAnimAt,
				rowAnimAt,
				renderedStart,
				sourceCard,
			};
		},
	};
}

export interface ComputeContentRowLayoutInput extends ShelfContentRowLayoutInputs {
	rowIndex: number;
	centerSmooth: number;
	rowAnimAt: number;
	layout: DetailProfile;
	settings: ShelfSettings;
}

export function computeContentRowLayout(input: ComputeContentRowLayoutInput): ShelfContentRowLayout {
	const delta = input.rowIndex - input.centerSmooth;
	const absD = Math.abs(delta);
	if (absD > CONTENT_VISIBLE_RADIUS + 0.5) {
		return makeHiddenLayout(input.rowIndex, delta, absD);
	}

	const revealRaw = clampRange((input.now - input.rowAnimAt - absD * 0.040) / 0.72, 0, 1);
	const reveal = smoothstep01(revealRaw);
	const parX = input.pointerParallax?.x ?? 0;
	const parY = input.pointerParallax?.y ?? 0;
	const parWeight = Math.max(0, 1 - absD * 0.12);
	const pulse = input.pulse ?? 0;
	const settle = input.rowSettle ?? 0;
	const skullDetail = input.skullSafe ?? false;
	const rowBaseX = skullDetail ? 0.22 : -0.04;
	const rowSpreadX = skullDetail ? 0.030 : 0.014;
	const rowIntroX = skullDetail ? 0.58 : 0.38;
	const rowCenterZ = skullDetail ? 0.62 : 0.62;
	const rowBackZ = skullDetail ? 0.58 : 0.58;
	const rowDepthStep = skullDetail ? 0.046 : 0.048;

	let px = rowBaseX + absD * rowSpreadX + (1 - reveal) * (rowIntroX + absD * rowSpreadX);
	let py = -delta * input.layout.rowStep + (1 - reveal) * (0.20 + (delta < 0 ? -0.10 : 0.10));
	let pz = (absD < 0.5 ? rowCenterZ : (rowBackZ - absD * rowDepthStep)) - (1 - reveal) * (skullDetail ? 0.10 : 0.16);

	px += settle * ((skullDetail ? 0.11 : 0.12) + absD * (skullDetail ? 0.010 : 0.012));
	py += settle * (delta < 0 ? -0.08 : 0.08);
	pz -= settle * (skullDetail ? 0.045 : 0.08);
	px += parX * (skullDetail ? 0.022 : 0.026) * parWeight;
	py += parY * (skullDetail ? 0.024 : 0.036) * parWeight;
	pz += (parY * (skullDetail ? 0.014 : 0.024) - parX * (skullDetail ? 0.010 : 0.020)) * parWeight;

	const scale = (absD < 0.5 ? 1.00 : Math.max(0.66, 0.94 - absD * 0.070)) *
		(0.90 + reveal * 0.10) *
		(1 + pulse * 0.052) *
		(1 - settle * 0.025) *
		input.layout.rowScale;
	const rowOpacityBase = Math.min(1, (absD < 0.5 ? 1.0 : Math.max(0.34, 1.0 - absD * 0.12)) * reveal + pulse * 0.14);
	const rowOpacityScale = absD < 0.5 ? Math.max(0.94, input.settings.opacity) : input.settings.opacity;

	return {
		visible: true,
		index: input.rowIndex,
		delta,
		absD,
		revealRaw,
		reveal,
		renderOrder: 240 + Math.round((CONTENT_VISIBLE_RADIUS + 1 - Math.min(absD, CONTENT_VISIBLE_RADIUS + 1)) * 14),
		position: {
			x: px,
			y: py,
			z: pz,
		},
		scale,
		opacity: Math.min(1, rowOpacityBase * rowOpacityScale),
		rotation: {
			y: (skullDetail ? -0.070 : 0.10) + (1 - reveal) * (skullDetail ? 0.018 : 0.052) + parX * (skullDetail ? 0.010 : 0.018) * parWeight,
			x: (skullDetail ? 0.010 : 0) - delta * (skullDetail ? 0.010 : 0.022) - parY * (skullDetail ? 0.006 : 0.014) * parWeight,
		},
	};
}

export function computeContentPanelOpacity(input: ShelfContentPanelOpacityInputs): number {
	const settings = input.settings ?? SHELF_SETTINGS;
	let pr = clampRange((input.now - input.openAnimAt) / 0.72, 0, 1);
	pr = smoothstep01(pr);
	return 0.86 * pr * settings.opacity;
}

export function pickShelfContentRowAtScreen<T>(
	rows: Array<ShelfContentScreenRow<T>>,
	pointer: ShelfContentScreenPoint,
	options: PickShelfContentRowAtScreenOptions = {},
): ShelfContentScreenRowPick<T> | null {
	if (!isFiniteScreenPoint(pointer)) return null;

	const padX = options.padX ?? SHELF_CONTENT_ROW_SCREEN_PAD_X;
	const padY = options.padY ?? SHELF_CONTENT_ROW_SCREEN_PAD_Y;
	const ordered = rows
		.filter((row) => row.visible !== false)
		.sort((a, b) => (b.renderOrder ?? 0) - (a.renderOrder ?? 0));

	for (const row of ordered) {
		const bounds = normalizeScreenBounds(row.bounds);
		if (!bounds) continue;
		if (
			pointer.x < bounds.minX - padX ||
			pointer.x > bounds.maxX + padX ||
			pointer.y < bounds.minY - padY ||
			pointer.y > bounds.maxY + padY
		) {
			continue;
		}

		const u = clampRange((pointer.x - bounds.minX) / Math.max(1, bounds.maxX - bounds.minX), 0, 1);
		const v = 1 - clampRange((pointer.y - bounds.minY) / Math.max(1, bounds.maxY - bounds.minY), 0, 1);
		return { row: row.row, index: row.index, uv: { x: u, y: v }, screenPick: true };
	}

	return null;
}

export function screenContainsShelfContentPanel(
	panel: ShelfContentScreenPanel | null | undefined,
	pointer: ShelfContentScreenPoint,
	options: ScreenContainsShelfContentPanelOptions = {},
): boolean {
	if (!panel || panel.visible === false) return false;
	if (!isFiniteScreenPoint(pointer)) return false;
	const pad = options.pad ?? SHELF_CONTENT_PANEL_SCREEN_PAD;
	const bounds = normalizeScreenBounds(panel.bounds);
	if (!bounds) return false;
	return pointer.x >= bounds.minX - pad &&
		pointer.x <= bounds.maxX + pad &&
		pointer.y >= bounds.minY - pad &&
		pointer.y <= bounds.maxY + pad;
}

export function isShelfContentLoadingRow(row: ShelfContentRow | undefined): boolean {
	return row?.kind === "loading" || /加载中|正在载入/.test(String(row?.name || ""));
}

function makePlaceholderRow(name: string, kind: ShelfContentPlaceholderKind): ShelfContentRow {
	return { name, artist: "", kind };
}

function contentKindFromPlaylistId(playlistId: string): ShelfContentKind {
	return String(playlistId || "").startsWith("podcast:") ? "podcast" : "playlist";
}

function cloneRow(row: ShelfContentRow): ShelfContentRow {
	return { ...row };
}

function cloneScreenRow(row: ShelfContentScreenRow): ShelfContentScreenRow {
	return {
		...row,
		bounds: { ...row.bounds },
	};
}

function cloneScreenPanel(panel: ShelfContentScreenPanel): ShelfContentScreenPanel {
	return {
		...panel,
		bounds: { ...panel.bounds },
	};
}

function makeHiddenLayout(rowIndex: number, delta: number, absD: number): ShelfContentRowLayout {
	return {
		visible: false,
		index: rowIndex,
		delta,
		absD,
		revealRaw: 0,
		reveal: 0,
		renderOrder: 0,
		position: { x: 0, y: 0, z: 0 },
		scale: 0,
		opacity: 0,
		rotation: { x: 0, y: 0 },
	};
}

function smoothstep01(t: number): number {
	return t * t * (3 - 2 * t);
}

function clampInt(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) return min;
	return Math.max(min, Math.min(max, Math.round(value)));
}

function clampRange(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) return min;
	return Math.max(min, Math.min(max, value));
}

function isFiniteScreenPoint(point: ShelfContentScreenPoint): boolean {
	return Number.isFinite(point.x) && Number.isFinite(point.y);
}

function normalizeScreenBounds(bounds: ShelfContentScreenBounds): ShelfContentScreenBounds | null {
	if (
		!Number.isFinite(bounds.minX) ||
		!Number.isFinite(bounds.minY) ||
		!Number.isFinite(bounds.maxX) ||
		!Number.isFinite(bounds.maxY)
	) {
		return null;
	}

	const normalized = {
		minX: Math.min(bounds.minX, bounds.maxX),
		minY: Math.min(bounds.minY, bounds.maxY),
		maxX: Math.max(bounds.minX, bounds.maxX),
		maxY: Math.max(bounds.minY, bounds.maxY),
	};

	if (normalized.maxX <= normalized.minX || normalized.maxY <= normalized.minY) return null;
	return normalized;
}
