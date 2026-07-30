import type * as THREE from "three";
import type { FrameContext } from "../runtime/frame-context";
import type { VisualResourceScope } from "../runtime/resource-scope";
import { computeBreathPulse } from "./breath";
import {
	SHELF_MAX_RENDER,
	SHELF_VISIBLE_RADIUS,
	computeCardLayout,
} from "./card-position";
import { getDefaultShelfLayoutProfile, type ShelfLayoutProfileOverrides } from "./shelf-layout-profile";
import {
	registerShelfResourceBundle,
	type ShelfRenderableResource,
	type ShelfResourceBundle,
} from "./shelf-resource-bundle";
import {
	createReusableObjectPool,
	type ReusableObjectPool,
	type ReusableObjectPoolSnapshot,
} from "./object-pool";
import { computePaneRaw, computeRevealRaw } from "./reveal";
import {
	createShelfCardMesh,
	type ShelfCardSprite,
	type ShelfCardDrawState,
} from "./shelf-card-sprite";
import {
	createShelfContentPanelSprite,
	createShelfContentRowSprite,
	type ShelfContentPanelSprite,
	type ShelfContentRowSprite,
} from "./shelf-content-sprite";
import {
	CONTENT_MAX_RENDER,
	computeContentPanelOpacity,
	createShelfContentList,
	isShelfContentLoadingRow,
	type ShelfContentKind,
	type ShelfContentList,
	type ShelfContentRow,
	type ShelfContentSourceCard,
	type ShelfContentScreenBounds,
	type ShelfContentScreenRow,
} from "./shelf-content-list";
import {
	createShelfState,
	type ShelfMode,
	type ShelfPane,
	type ShelfPresence,
	type ShelfState,
} from "./shelf-state";

const SHELF_DETAIL_GROUP_RENDER_ORDER = 230;

export interface ShelfItem {
	type?: string;
	title?: string;
	sub?: string;
	cover?: string;
	tag?: string;
	playlistId?: string;
	podcastKey?: string;
	queueIndex?: number;
	provider?: string;
}

export interface ShelfManagerOptions {
	scene?: THREE.Scene | null;
	group?: THREE.Group | null;
	three?: typeof import("three") | null;
	document?: Document | null;
	now?: () => number;
	buildNow?: () => number;
	getLayoutProfileOverrides?: () => ShelfLayoutProfileOverrides;
	onOpenDetailContent?: (payload: ShelfOpenDetailContentPayload) => void;
	onDetailPhaseChange?: (phase: ShelfDetailPhase) => void;
	/** Shelf 独占的 child scope；manager.dispose() 会关闭它。 */
	resourceScope?: VisualResourceScope;
}

export interface ShelfOpenDetailContentPayload {
	playlistId: string;
	title: string;
	provider?: string;
	contentKind: ShelfContentKind;
	requestToken: number;
	sourceCard: ShelfContentSourceCard | null;
	item?: ShelfItem;
}

export interface ShelfSnapshot {
	centerIdx: number;
	centerSmooth: number;
	mode: ShelfMode;
	presence: ShelfPresence;
	shelfPane: ShelfPane;
	shelfVisibility: number;
	openCardIdx: number;
	pinnedOpen: boolean;
	breathPulse: number;
}

export interface ShelfResourceDiagnostics {
	readonly cards: ReusableObjectPoolSnapshot;
	readonly detailRows: ReusableObjectPoolSnapshot;
	readonly detailPanels: number;
}

export type ShelfDetailPhase = "closed" | "open" | "closing";

export interface ShelfRaycastCardHit {
	index: number;
	item: ShelfItem;
	mesh: THREE.Mesh;
	point?: THREE.Vector3;
	uv?: THREE.Vector2;
	screenPick?: boolean;
}

export interface ShelfRaycastContentRowHit {
	row: ShelfContentRow;
	index: number;
	mesh: THREE.Mesh;
	point?: THREE.Vector3;
	uv?: THREE.Vector2;
}

export interface ShelfManager {
	getState(): ShelfState;
	setData(items: ShelfItem[], opts?: { asyncBuild?: boolean }): void;
	getData(): ShelfItem[];
	update(ctx: FrameContext): void;
	setMode(mode: ShelfMode): void;
	getMode(): ShelfMode;
	setShelfPresence(presence: ShelfPresence): void;
	getShelfPresence(): ShelfPresence;
	setAppRevealed(revealed: boolean): void;
	setSelectedIdx(idx: number): void;
	setPointerForegroundEligible(eligible: boolean): void;
	getSelectedIdx(): number;
	clearSelected(): void;
	getCenterIdx(): number;
	scrollBy(delta: number): void;
	setShelfPane(pane: ShelfPane, nowSeconds?: number): void;
	getShelfPane(): ShelfPane;
	setShelfVisibility(v: number): void;
	getShelfVisibility(): number;
	setShelfPinnedOpen(open: boolean, nowSeconds?: number): void;
	getShelfPinnedOpen(): boolean;
	updateShelfHoverCueFromPointer(pointer: { clientX: number; clientY: number } | null): void;
	clearShelfHoverCue(): void;
	getShelfHoverCueValue(): number;
	getShelfHoverCuePreviewVisible(): boolean;
	schedulePaneSwitch(dir: number): void;
	openDetail(idx: number, opts?: { playlistId?: string; title?: string }): void;
	closeDetail(opts?: { immediate?: boolean }): void;
	hasOpenContent(): boolean;
	getDetailPhase(): ShelfDetailPhase;
	getContentList(): ShelfContentList | null;
	getSnapshot(): ShelfSnapshot;
	getResourceDiagnostics(): ShelfResourceDiagnostics;
	getRenderedCardCount(): number;
	raycastCards(raycaster: THREE.Raycaster): ShelfRaycastCardHit | null;
	raycastContentRows(raycaster: THREE.Raycaster): ShelfRaycastContentRowHit | null;
	pickCardAtScreen(
		clientX: number,
		clientY: number,
		viewportWidth: number,
		viewportHeight: number,
		camera: THREE.Camera,
		pad?: number,
	): ShelfRaycastCardHit | null;
	dispose(): void;
}

export function createShelfManager(opts: ShelfManagerOptions): ShelfManager {
	const state: ShelfState = createShelfState();
	const scene: THREE.Scene | null = opts.scene ?? null;
	const three = opts.three ?? null;
	const doc = opts.document ?? (typeof document !== "undefined" ? document : null);
	let group: THREE.Group | null = opts.group ?? null;
	const ownsGroup = !group && !!three;
	if (!group && three) {
		group = new three.Group();
		if (scene) scene.add(group);
	}
	const data: ShelfItem[] = [];
	const renderedCards = new Map<number, ShelfCardSprite>();
	let cardPool: ReusableObjectPool<ShelfCardSprite> | null = null;
	let renderedWindowSig = "";
	let renderedWindowAsync = false;
	let asyncBuildJob: { indexes: number[]; next: number; sig: string } | null = null;
	let breathPulseLast = 0;
	let lastFrameNow = 0;
	let lastUpdateDtSeconds = 1 / 60;
	let lastVisualTime = 0;
	const nowFn =
		opts.now ??
		(() => (typeof performance !== "undefined" ? performance.now() : Date.now()));
	const buildNow = opts.buildNow ?? nowFn;
	const contentList = createShelfContentList({ now: () => lastVisualTime });
	const resourceScope = opts.resourceScope;
	const resourceBundles = new Map<ShelfRenderableResource, ShelfResourceBundle>();
	let resourceOwnerGeneration = 0;
	let openDetailCardKey: string | null = null;
	let detailGroup: THREE.Group | null = null;
	let detailPanel: ShelfContentPanelSprite | null = null;
	const detailRows = new Map<number, ShelfContentRowSprite>();
	let detailRowPool: ReusableObjectPool<ShelfContentRowSprite> | null = null;
	let detailRowsSig = "";
	let detailRowsLoadedContentSig = "";
	let rowSettleStartedAt = -Infinity;
	let detailPhase: ShelfDetailPhase = "closed";
	let detailGeneration = 0;
	let detailClosingStartedAt = -Infinity;
	let detailClosingGeneration = 0;

	return {
		getState() {
			return state;
		},
		setData(items, setDataOpts) {
			data.length = 0;
			for (const it of items) data.push(it);
			state.lastSig = `${items.length}::${state.shelfPane}`;
			clampStateToDataLength(items.length);
			renderedWindowSig = "";
			// 生产默认始终走帧预算；仅保留显式 false 作为低层确定性测试缝。
			renderedWindowAsync = setDataOpts?.asyncBuild !== false;
			asyncBuildJob = null;
		},
		getData() {
			return data;
		},
		update(ctx) {
			lastVisualTime = ctx.uniforms.uTime.value;
			advanceDetailClose(lastVisualTime);
			if (lastFrameNow === 0) lastFrameNow = ctx.now;
			const dtMs = Math.max(0, ctx.now - lastFrameNow);
			lastFrameNow = ctx.now;
			lastUpdateDtSeconds = Number.isFinite(ctx.dt) && ctx.dt > 0 ? ctx.dt : dtMs > 0 ? dtMs / 1000 : 1 / 60;

			state.centerSmooth += (state.centerTarget - state.centerSmooth) * 0.16;
			if (Math.abs(state.centerSmooth - state.centerTarget) < 0.001) {
				state.centerSmooth = state.centerTarget;
			}
			if (contentList.isOpen()) contentList.advance(ctx.uniforms.uTime.value);
			advanceRowSettle(ctx.uniforms.uTime.value);
			updateShelfVisibility();

			breathPulseLast = computeBreathPulse(
				ctx.uniforms.uTime.value,
				0,
				state.shelfVisibility,
			);

			if (dtMs > 0) {
				const pulseBucket = Math.round(
					(ctx.uniforms.uBass.value + ctx.uniforms.uBeat.value * 0.85) * 10,
				);
				if (
					pulseBucket !== state.lastCardPulseBucket ||
					ctx.uniforms.uTime.value - state.lastCardRedrawAt > 1.35
				) {
					state.lastCardPulseBucket = pulseBucket;
					state.lastCardRedrawAt = ctx.uniforms.uTime.value;
				}
				if (ctx.uniforms.uTime.value - state.lastUpdate > 0.8) {
					state.lastUpdate = ctx.uniforms.uTime.value;
				}
			}

			if (group) {
				group.visible = shouldShowShelfGroup();
			}
			const pointerSelectionForegroundActive = hasEligiblePointerSelection();
			applyGroupPose(ctx, pointerSelectionForegroundActive);
			rebuildRenderedWindowIfNeeded();
			applyRenderedCardLayout(ctx, pointerSelectionForegroundActive);
			syncDetailContentMeshes(ctx);

			void nowFn;
		},
		setMode(mode) {
			state.mode = mode;
		},
		getMode() {
			return state.mode;
		},
		setShelfPresence(presence) {
			state.presence = presence;
		},
		getShelfPresence() {
			return state.presence;
		},
		setAppRevealed(revealed) {
			state.appRevealed = revealed;
		},
		setSelectedIdx(idx) {
			state.selectedIdx = idx;
		},
		setPointerForegroundEligible(eligible) {
			if (state.pointerForegroundEligible === eligible) return;
			state.pointerForegroundEligible = eligible;
		},
		getSelectedIdx() {
			return state.selectedIdx;
		},
		clearSelected() {
			state.selectedIdx = -1;
		},
		getCenterIdx() {
			return clampInt(Math.round(state.centerSmooth), 0, Math.max(0, data.length - 1));
		},
		scrollBy(delta) {
			if (data.length <= 0) {
				state.centerTarget = 0;
				state.centerIdx = 0;
				return;
			}
			const max = data.length - 1;
			const next = clampInt(Math.round(state.centerTarget + delta), 0, max);
			state.centerTarget = next;
		},
		setShelfPane(pane, nowSeconds) {
			if (pane === state.shelfPane) return;
			const max = Math.max(0, data.length - 1);
			const remembered = Math.max(0, Math.round(state.centerTarget));
			state.paneMemory[state.shelfPane] = remembered;
			state.shelfPane = pane;
			const target = clampInt(state.paneMemory[pane] ?? 0, 0, max);
			state.centerTarget = target;
			state.centerIdx = target;
			state.centerSmooth = clampInt(
				target + (pane === "fav" ? 1.85 : -1.85),
				0,
				max,
			);
			state.paneSwitchDir = pane === "fav" ? 1 : -1;
			const now = nowSeconds ?? nowFn() / 1000;
			state.paneSwitchAt = now;
			state.shelfOpenAnimAt = now;
		},
		getShelfPane() {
			return state.shelfPane;
		},
		setShelfVisibility(v) {
			state.shelfVisibility = v;
		},
		getShelfVisibility() {
			return state.shelfVisibility;
		},
		setShelfPinnedOpen(open, nowSeconds) {
			const nextOpen = !!open;
			if (nextOpen && !state.pinnedOpen) {
				state.shelfOpenAnimAt = nowSeconds ?? nowFn() / 1000;
			}
			state.pinnedOpen = nextOpen;
		},
		getShelfPinnedOpen() {
			return state.pinnedOpen;
		},
		updateShelfHoverCueFromPointer(pointer) {
			updateShelfHoverCueFromPointer(pointer);
		},
		clearShelfHoverCue() {
			updateShelfHoverCueFromPointer(null);
		},
		getShelfHoverCueValue() {
			return state.shelfHoverCue.value;
		},
		getShelfHoverCuePreviewVisible() {
			return isShelfHoverCuePreviewVisible();
		},
		schedulePaneSwitch(dir) {
			state.paneSwitchDir = dir < 0 ? -1 : 1;
		},
		openDetail(idx, detailOpts) {
			detailGeneration += 1;
			setDetailPhase("open");
			detailClosingStartedAt = -Infinity;
			state.openCardIdx = idx;
			state.pinnedOpen = true;
			const item = data[idx];
			openDetailCardKey = shelfItemIdentityKey(item);
			const playlistId = detailOpts?.playlistId ?? item?.playlistId ?? podcastPlaylistId(item?.podcastKey) ?? "";
			const title = detailOpts?.title ?? item?.title ?? "歌单详情";
			const kind: ShelfContentKind = item?.type === "podcast" || item?.podcastKey || playlistId.startsWith("podcast:") ? "podcast" : "playlist";
			const sourceCard = item ? { item } : null;
			const requestToken = contentList.open({
				playlistId,
				title,
				kind,
				sourceCard,
			});
			opts.onOpenDetailContent?.({
				playlistId,
				title,
				provider: item?.provider,
				contentKind: kind,
				requestToken,
				sourceCard,
				item,
			});
		},
		closeDetail(closeOptions) {
			if (closeOptions?.immediate) {
				closeOpenDetail();
				return;
			}
			beginDetailClose();
		},
		hasOpenContent() {
			return contentList.isOpen();
		},
		getDetailPhase() {
			return detailPhase;
		},
		getContentList() {
			return contentList.isOpen() ? contentList : null;
		},
		getSnapshot() {
			return {
				centerIdx: state.centerIdx,
				centerSmooth: state.centerSmooth,
				mode: state.mode,
				presence: state.presence,
				shelfPane: state.shelfPane,
				shelfVisibility: state.shelfVisibility,
				openCardIdx: state.openCardIdx,
				pinnedOpen: state.pinnedOpen,
				breathPulse: breathPulseLast,
			};
		},
		getResourceDiagnostics() {
			return {
				cards: cardPool?.getSnapshot() ?? emptyPoolSnapshot(SHELF_MAX_RENDER),
				detailRows: detailRowPool?.getSnapshot() ?? emptyPoolSnapshot(CONTENT_MAX_RENDER),
				detailPanels: detailPanel ? 1 : 0,
			};
		},
		getRenderedCardCount() {
			return renderedCards.size;
		},
		raycastCards(raycaster) {
			if (!group || !group.visible || renderedCards.size === 0) return null;
			const visibleMeshes: THREE.Mesh[] = [];
			for (const card of renderedCards.values()) {
				if (card.mesh.visible) visibleMeshes.push(card.mesh);
			}
			if (visibleMeshes.length === 0) return null;
			const hits = raycaster.intersectObjects(visibleMeshes, false);
			const first = hits[0];
			if (!first) return null;
			for (const [index, card] of renderedCards) {
				if (card.mesh !== first.object) continue;
				const item = data[index];
				if (!item) return null;
				return {
					index,
					item,
					mesh: card.mesh,
					point: first.point,
					uv: first.uv,
				};
			}
			return null;
		},
		raycastContentRows(raycaster) {
			if (detailPhase !== "open" || !group || !group.visible || !contentList.isOpen() || detailRows.size === 0) return null;
			const visibleMeshes: THREE.Mesh[] = [];
			for (const sprite of detailRows.values()) {
				if (sprite.mesh.visible) visibleMeshes.push(sprite.mesh);
			}
			if (visibleMeshes.length === 0) return null;
			const hits = raycaster.intersectObjects(visibleMeshes, false);
			const first = hits[0];
			if (!first) return null;
			for (const [index, sprite] of detailRows) {
				if (sprite.mesh !== first.object) continue;
				return {
					row: sprite.row,
					index,
					mesh: sprite.mesh,
					point: first.point,
					uv: first.uv,
				};
			}
			return null;
		},
		pickCardAtScreen(clientX, clientY, viewportWidth, viewportHeight, camera, pad) {
			if (!group || !group.visible || !three || renderedCards.size === 0) return null;
			if (viewportWidth <= 0 || viewportHeight <= 0) return null;
			const ordered = [...renderedCards.entries()].sort((a, b) => {
				const ar = a[1].mesh.renderOrder || 0;
				const br = b[1].mesh.renderOrder || 0;
				return br - ar;
			});
			const screenPad = pad == null ? 72 : pad;
			for (const [index, card] of ordered) {
				const uv = screenHitCard(card.mesh, clientX, clientY, viewportWidth, viewportHeight, camera, screenPad);
				if (!uv) continue;
				const item = data[index];
				if (!item) continue;
				return {
					index,
					item,
					mesh: card.mesh,
					uv,
					screenPick: true,
				};
			}
			return null;
		},
		dispose() {
			disposeDetailContentMeshes();
			detailRowPool?.dispose();
			detailRowPool = null;
			contentList.clearScreenTargets();
			disposeRenderedCards();
			cardPool?.dispose();
			cardPool = null;
			resourceScope?.dispose();
			resourceBundles.clear();
			if (group && scene && ownsGroup) {
				scene.remove(group);
			} else if (group && scene && opts.group) {
				scene.remove(group);
			}
			group = null;
		},
	};

	function updateShelfVisibility(): void {
		const dtSeconds = ctxDtSeconds();
		syncShelfHoverCueEligibility();
		tickShelfHoverCue(dtSeconds);
		const target = computeShelfVisibilityTarget();
		const ease = target > state.shelfVisibility ? 0.22 : 0.18;
		state.shelfVisibility += (target - state.shelfVisibility) * ease;
		if (state.shelfVisibility < 0.01 && target === 0) {
			state.shelfVisibility = 0;
		}
		state.shelfVisibility = clampRange(state.shelfVisibility, 0, 1);
	}

	function computeShelfVisibilityTarget(): number {
		if (!state.appRevealed) return 0;
		if (state.mode === "off") return 0;
		const hasData = data.length > 0;
		const contentOpen = state.openCardIdx >= 0;
		if (state.mode === "stage") return hasData ? 1 : 0;
		if (state.mode === "side") {
			if (!hasData && !contentOpen) return 0;
			if (contentOpen) return 1;
			if (state.pinnedOpen && hasData) return 1;
			if (state.presence === "always" && hasData) return 1;
			return state.shelfHoverCue.value > 0.01
				? Math.max(0.16, state.shelfHoverCue.value * 0.88)
				: 0;
		}
		return 0;
	}

	function updateShelfHoverCueFromPointer(pointer: { clientX: number; clientY: number } | null): void {
		const cue = state.shelfHoverCue;
		if (!pointer) {
			if (!cue.guide) cue.target = 0;
			cue.zoneActive = false;
			cue.enteredAt = 0;
			return;
		}
		if (!cue.zoneActive) {
			cue.zoneActive = true;
			cue.enteredAt = nowFn();
		}
		if (!cue.guide) cue.target = 0;
		cue.x = pointer.clientX;
		cue.y = pointer.clientY;
		cue.lastAt = nowFn();
	}

	function isShelfHoverCuePreviewVisible(): boolean {
		const cue = state.shelfHoverCue;
		return cue.guide || cue.zoneActive || cue.target > 0 || cue.value > 0.10 || state.shelfVisibility > 0.12;
	}

	function tickShelfHoverCue(dtSeconds: number): number {
		const cue = state.shelfHoverCue;
		const now = nowFn();
		if (!cue.guide && cue.zoneActive && now - cue.enteredAt > 260) {
			cue.target = 1;
		}
		if (!cue.guide && !cue.zoneActive && now - cue.lastAt > 650) {
			cue.target = 0;
		}
		const target = cue.guide ? 1 : cue.target;
		const rate = target > cue.value ? 0.12 : 0.10;
		cue.value += (target - cue.value) * Math.min(1, rate * Math.max(1, dtSeconds * 60));
		if (cue.value < 0.006 && !target) cue.value = 0;
		cue.value = clampRange(cue.value, 0, 1);
		return cue.value;
	}

	function syncShelfHoverCueEligibility(): void {
		if (state.shelfHoverCue.guide) return;
		if (!state.appRevealed || state.mode !== "side" || state.presence !== "auto" || state.pinnedOpen || state.openCardIdx >= 0 || data.length <= 0) {
			updateShelfHoverCueFromPointer(null);
		}
	}

	function ctxDtSeconds(): number {
		if (!Number.isFinite(lastUpdateDtSeconds)) return 1 / 60;
		return lastUpdateDtSeconds;
	}

	function shouldShowShelfGroup(): boolean {
		if (!state.appRevealed) return false;
		if (state.shelfVisibility <= 0) return false;
		const hasData = data.length > 0;
		const contentOpen = state.openCardIdx >= 0;
		if (state.mode === "stage") return hasData;
		return hasData || contentOpen;
	}

	function rebuildRenderedWindowIfNeeded(): void {
		if (!group || !three || !doc || data.length === 0) {
			disposeRenderedCards();
			renderedWindowSig = "";
			asyncBuildJob = null;
			return;
		}
		if (state.mode === "off" && state.shelfVisibility <= 0) {
			disposeRenderedCards();
			renderedWindowSig = "";
			asyncBuildJob = null;
			return;
		}
		const window = computeRenderWindow();
		const sig = `${window.start}:${window.end}:${data.length}:${state.shelfPane}`;
		if (sig !== renderedWindowSig) {
			const targetIndexes = new Set<number>();
			for (let index = window.start; index <= window.end; index++) targetIndexes.add(index);
			for (const [index, card] of renderedCards) {
				if (targetIndexes.has(index)) continue;
				releaseRenderedCard(index, card);
			}
			renderedWindowSig = sig;
			if (renderedWindowAsync) {
				asyncBuildJob = {
					indexes: [...targetIndexes].filter((index) => !renderedCards.has(index)),
					next: 0,
					sig,
				};
				buildAsyncCards(2);
				return;
			}
			asyncBuildJob = null;
			for (const index of targetIndexes) {
				buildRenderedCard(index);
			}
			return;
		}
		if (asyncBuildJob?.sig === sig) {
			buildAsyncCards(2);
		}
	}

	function applyRenderedCardLayout(
		ctx: FrameContext,
		pointerSelectionForegroundActive: boolean,
	): void {
		if (!group || renderedCards.size === 0) return;
		const profile = getDefaultShelfLayoutProfile(opts.getLayoutProfileOverrides?.());
		const center = state.centerSmooth;
		const mode = state.mode === "stage" ? "stage" : "side";
		const detailOpen = state.openCardIdx >= 0;
		const passiveAlways = state.mode === "side" && state.presence === "always" && !state.pinnedOpen && !detailOpen;
		const sidePointerSelectionActive = pointerSelectionForegroundActive && !detailOpen;
		for (const [index, card] of renderedCards) {
			const absD = Math.abs(index - center);
			const breathPulse = computeBreathPulse(
				ctx.uniforms.uTime.value,
				index,
				state.shelfVisibility,
			);
			const layout = computeCardLayout({
				index,
				centerSmooth: center,
				mode,
				profile,
				fx: { shelfPane: state.shelfPane },
				revealRaw: computeRevealRaw(
					ctx.uniforms.uTime.value,
					state.shelfOpenAnimAt,
					absD,
				),
				paneRaw: computePaneRaw(
					ctx.uniforms.uTime.value,
					state.paneSwitchAt,
					absD,
				),
				absD,
				paneSwitchDir: state.paneSwitchDir,
				pulse: ctx.uniforms.uBeat.value,
				breathPulse,
				lift: index === state.selectedIdx && (mode === "stage" || sidePointerSelectionActive) ? 1 : 0,
				detailOpen,
				passiveAlways,
				pointerParallax: ctx.pointerParallax,
			});
			card.mesh.visible = absD <= SHELF_VISIBLE_RADIUS + 0.55;
			card.mesh.position.set(layout.x, layout.y, layout.z);
			card.mesh.rotation.set(layout.rotationX, layout.rotationY, 0);
			card.mesh.scale.setScalar(layout.scale);
			card.mesh.renderOrder = layout.renderOrder;
			const detailOpacity = detailOpen
				? (state.openCardIdx === index ? 0.16 : 0.08)
				: 1;
			card.material.opacity = layout.opacity * 0.96 * state.shelfVisibility * detailOpacity;
			const color = card.material.color as { setScalar?: (v: number) => void } | undefined;
			color?.setScalar?.(state.openCardIdx >= 0 && state.openCardIdx !== index ? 0.72 : 1);
			updateCardSpriteIfNeeded(card, index, ctx);
		}
	}

	function buildAsyncCards(maxPerFrame: number): void {
		if (!asyncBuildJob || !group || !three || !doc) return;
		const startedAt = buildNow();
		let built = 0;
		while (asyncBuildJob.next < asyncBuildJob.indexes.length && built < maxPerFrame) {
			if (built > 0 && buildNow() - startedAt >= 7) break;
			buildRenderedCard(asyncBuildJob.indexes[asyncBuildJob.next]!);
			asyncBuildJob.next += 1;
			built += 1;
		}
		if (asyncBuildJob.next >= asyncBuildJob.indexes.length) {
			asyncBuildJob = null;
		}
	}

	function buildRenderedCard(index: number): void {
		if (!group || !three || !doc || renderedCards.has(index)) return;
		const item = data[index];
		if (!item) return;
		const pool = ensureCardPool();
		const card = pool?.acquire() ?? null;
		if (!card) return;
		card.update(item, {
			index,
			centered: index === Math.round(state.centerSmooth),
			selected: index === state.selectedIdx,
			beatProgress: 0,
			dimmed: state.openCardIdx >= 0 && state.openCardIdx !== index,
		});
		card.mesh.visible = true;
		card.mesh.renderOrder = 50 + index;
		group.add(card.mesh);
		renderedCards.set(index, card);
	}

	function registerManagedResource<T extends ShelfRenderableResource>(
		resource: T,
		owner: string,
		onRelease: () => void,
	): T {
		const bundle = registerShelfResourceBundle({
			owner,
			resource,
			resourceScope,
			onRelease: () => {
				resourceBundles.delete(resource);
				onRelease();
			},
		});
		resourceBundles.set(resource, bundle);
		return resource;
	}

	function disposeManagedResource(resource: ShelfRenderableResource): void {
		const bundle = resourceBundles.get(resource);
		if (bundle) {
			bundle.release();
			return;
		}
		resource.dispose();
	}

	function releaseCardOwnership(card: ShelfCardSprite): void {
		try {
			group?.remove(card.mesh);
		} catch {
		}
		card.mesh.visible = false;
		for (const [index, current] of [...renderedCards]) {
			if (current === card) renderedCards.delete(index);
		}
		cardPool?.discard(card);
		renderedWindowSig = "";
		asyncBuildJob = null;
	}

	function ensureCardPool(): ReusableObjectPool<ShelfCardSprite> | null {
		if (cardPool) return cardPool;
		if (!three || !doc) return null;
		cardPool = createReusableObjectPool<ShelfCardSprite>({
			capacity: SHELF_MAX_RENDER,
			create: () => {
				const card = createShelfCardMesh({
					item: { type: "empty" },
					index: 0,
					three,
					createCanvas: () => doc.createElement("canvas"),
				});
				return registerManagedResource(
					card,
					`shelf-card:${++resourceOwnerGeneration}`,
					() => releaseCardOwnership(card),
				);
			},
			dispose: disposeManagedResource,
		});
		return cardPool;
	}

	function applyGroupPose(
		ctx: FrameContext,
		pointerSelectionForegroundActive: boolean,
	): void {
		if (!group) return;
		if (!group.position || !group.rotation) return;
		const px = ctx.pointerParallax?.x || 0;
		const py = ctx.pointerParallax?.y || 0;
		if (state.mode === "stage") {
			group.renderOrder = 50;
			group.position.y = Math.sin(ctx.uniforms.uTime.value * 0.3) * 0.04;
			group.position.x = px * 0.10;
			group.position.z = 0;
			group.rotation.y = px * 0.025;
			group.rotation.x = -py * 0.012;
			group.rotation.z = 0;
			return;
		}
		const detailOpen = state.openCardIdx >= 0;
		const passiveAlwaysGroup = state.presence === "always" && !state.pinnedOpen && !detailOpen;
		group.renderOrder = passiveAlwaysGroup && !pointerSelectionForegroundActive ? 30 : 50;
		group.position.set(0, 0, 0);
		group.rotation.y += (px * 0.018 - group.rotation.y) * 0.045;
		group.rotation.x += (-py * 0.010 - group.rotation.x) * 0.045;
		group.rotation.z += (0 - group.rotation.z) * 0.045;
	}

	function hasEligiblePointerSelection(): boolean {
		return state.pointerForegroundEligible
			&& state.selectedIdx >= 0
			&& state.selectedIdx < data.length;
	}

	function updateCardSpriteIfNeeded(
		card: ShelfCardSprite,
		index: number,
		ctx: FrameContext,
	): void {
		const item = data[index];
		if (!item) return;
		const absD = Math.abs(index - state.centerSmooth);
		const drawState: ShelfCardDrawState = {
			index,
			centered: absD < 0.5,
			selected: index === state.selectedIdx,
			beatProgress: Math.min(1, 0.22 + Math.max(0, ctx.uniforms.uBass.value) * 0.62),
			dimmed: state.openCardIdx >= 0 && state.openCardIdx !== index,
		};
		const drawKey = [
			item.type || "",
			item.title || "",
			item.sub || "",
			item.tag || "",
			item.playlistId || "",
			item.podcastKey || "",
			item.queueIndex == null ? "" : item.queueIndex,
			item.cover || "",
			item.provider || "",
			drawState.centered ? 1 : 0,
			drawState.selected ? 1 : 0,
			drawState.dimmed ? 1 : 0,
			Math.round((drawState.beatProgress ?? 0) * 10),
		].join("|");
		const holder = card.mesh.userData as { drawKey?: string };
		if (holder.drawKey === drawKey) return;
		holder.drawKey = drawKey;
		card.update(item, drawState);
	}

	function syncDetailContentMeshes(ctx: FrameContext): void {
		if (
			!contentList.isOpen() ||
			state.openCardIdx < 0 ||
			state.mode === "off" ||
			state.shelfVisibility <= 0 ||
			!group ||
			!group.visible ||
			!three ||
			!doc
		) {
			disposeDetailContentMeshes();
			contentList.clearScreenTargets();
			detailRowsSig = "";
			return;
		}

		ensureDetailPanel();
		applyDetailGroupLayout(ctx);
		if (!detailPanel) return;
		const snapshot = contentList.getSnapshot();
		detailPanel.update(snapshot.playlistTitle);
		detailPanel.material.opacity = computeContentPanelOpacity({
			now: ctx.uniforms.uTime.value,
			openAnimAt: snapshot.openAnimAt,
		}) * detailCloseOpacity(ctx.uniforms.uTime.value);
		detailPanel.mesh.visible = true;

		syncDetailRows(ctx);
		syncDetailScreenTargets(ctx);
	}

	function ensureDetailPanel(): void {
		const targetGroup = ensureDetailGroup();
		if (detailPanel || !targetGroup || !three || !doc) return;
		const panel = createShelfContentPanelSprite({
			three,
			createCanvas: () => doc.createElement("canvas"),
		}, contentList.getSnapshot().playlistTitle);
		detailPanel = registerManagedResource(
			panel,
			`shelf-detail-panel:${++resourceOwnerGeneration}`,
			() => releaseDetailPanelOwnership(panel),
		);
		targetGroup.add(panel.mesh);
	}

	function ensureDetailGroup(): THREE.Group | null {
		if (detailGroup || !group || !three) return detailGroup;
		detailGroup = new three.Group();
		detailGroup.renderOrder = SHELF_DETAIL_GROUP_RENDER_ORDER;
		detailGroup.userData.shelfContentDetailGroup = true;
		group.add(detailGroup);
		return detailGroup;
	}

	function applyDetailGroupLayout(ctx: FrameContext): void {
		const targetGroup = ensureDetailGroup();
		if (!targetGroup) return;
		const layout = getDefaultShelfLayoutProfile(opts.getLayoutProfileOverrides?.()).detail;
		const snapshot = contentList.getSnapshot();
		const intro = 1 - smoothstep01(clampRange((ctx.uniforms.uTime.value - snapshot.openAnimAt) / 0.48, 0, 1));
		const closing = detailCloseProgress(ctx.uniforms.uTime.value);
		const parX = ctx.pointerParallax?.x || 0;
		const parY = ctx.pointerParallax?.y || 0;
		targetGroup.visible = true;
		targetGroup.position.set(
			layout.x + intro * 0.16 + parX * 0.030 + closing * 0.14,
			layout.y - intro * 0.024 + parY * 0.026 - closing * 0.10,
			layout.z - intro * 0.070 + parY * 0.016 - parX * 0.010 - closing * 0.08,
		);
		targetGroup.rotation.set(
			layout.rx - parY * 0.010,
			layout.ry + intro * 0.018 + parX * 0.014 + closing * 0.028,
			0,
		);
		targetGroup.scale.setScalar(layout.scale * (1 - intro * 0.035) * (1 - closing * 0.10));
	}

	function syncDetailRows(ctx: FrameContext): void {
		const targetGroup = ensureDetailGroup();
		if (!targetGroup || !three || !doc) {
			disposeDetailRows();
			return;
		}
		const rows = contentList.getRows();
		const window = contentList.computeRenderWindow();
		const indexes: number[] = [];
		for (let index = window.start; index <= window.end && indexes.length < CONTENT_MAX_RENDER; index++) {
			if (rows[index]) indexes.push(index);
		}
		const sig = indexes.map((index) => {
			const row = rows[index];
			return [
				index,
				row.id || "",
				row.name || "",
				row.artist || "",
				row.kind || "",
				row.provider || "",
			].join(":");
		}).join("|");

		if (sig !== detailRowsSig) {
			maybeStartRowsLoadedIntro(rows, ctx.uniforms.uTime.value);
			for (const [index, sprite] of detailRows) {
				if (indexes.includes(index)) continue;
				releaseDetailRow(index, sprite);
			}
			for (const index of indexes) {
				const row = rows[index];
				if (!row || detailRows.has(index)) continue;
				const centered = Math.abs(index - contentList.getSnapshot().centerSmooth) < 0.5;
				const sprite = ensureDetailRowPool()?.acquire() ?? null;
				if (!sprite) continue;
				sprite.update(row, index, centered);
				sprite.mesh.visible = true;
				targetGroup.add(sprite.mesh);
				detailRows.set(index, sprite);
			}
			detailRowsSig = sig;
		}

		for (const [index, sprite] of detailRows) {
			const row = rows[index];
			if (!row) continue;
			const layout = contentList.computeRowLayout(index, {
				now: ctx.uniforms.uTime.value,
				pointerParallax: ctx.pointerParallax,
				pulse: ctx.uniforms.uBeat.value,
				rowSettle: readGroupRowSettle(),
			});
			sprite.mesh.visible = layout.visible;
			sprite.mesh.renderOrder = layout.renderOrder;
			sprite.mesh.position.set(layout.position.x, layout.position.y, layout.position.z);
			sprite.mesh.rotation.set(layout.rotation.x, layout.rotation.y, 0);
			sprite.mesh.scale.setScalar(layout.scale);
			sprite.material.opacity = layout.opacity * detailCloseOpacity(ctx.uniforms.uTime.value);
			const centered = Math.abs(index - contentList.getSnapshot().centerSmooth) < 0.5;
			if (sprite.row !== row || sprite.index !== index || sprite.lastCenter !== centered) {
				sprite.update(row, index, centered);
			}
		}
	}

	function syncDetailScreenTargets(ctx: FrameContext): void {
		const viewport = getFrameViewport(ctx);
		const camera = ctx.camera;
		if (!viewport || !camera || !detailPanel || !detailGroup || !three) {
			contentList.clearScreenTargets();
			return;
		}
		detailGroup.updateMatrixWorld(true);

		const rowTargets: ShelfContentScreenRow[] = [];
		for (const [index, sprite] of detailRows) {
			const bounds = projectMeshScreenBounds(sprite.mesh, viewport.width, viewport.height, camera);
			if (!bounds) continue;
			rowTargets.push({
				row: sprite.row,
				index,
				visible: sprite.mesh.visible,
				renderOrder: sprite.mesh.renderOrder,
				bounds,
			});
		}
		const panelBounds = projectMeshScreenBounds(detailPanel.mesh, viewport.width, viewport.height, camera);
		contentList.setScreenTargets({
			rows: rowTargets,
			panel: panelBounds ? {
				visible: detailPanel.mesh.visible,
				bounds: panelBounds,
			} : null,
		});
	}

	function projectMeshScreenBounds(
		mesh: THREE.Mesh,
		viewportWidth: number,
		viewportHeight: number,
		camera: THREE.Camera,
	): ShelfContentScreenBounds | null {
		if (!mesh.visible || !group || !group.visible || !three) return null;
		if (viewportWidth <= 0 || viewportHeight <= 0) return null;
		const params = (mesh.geometry as { parameters?: { width?: number; height?: number } } | undefined)?.parameters ?? {};
		const hw = (params.width || 1) / 2;
		const hh = (params.height || 1) / 2;
		const pts = [
			new three.Vector3(-hw, -hh, 0),
			new three.Vector3(hw, -hh, 0),
			new three.Vector3(hw, hh, 0),
			new three.Vector3(-hw, hh, 0),
		];
		let minX = Infinity;
		let minY = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;
		mesh.updateMatrixWorld(true);
		for (const pt of pts) {
			pt.applyMatrix4(mesh.matrixWorld).project(camera);
			const x = (pt.x + 1) * viewportWidth / 2;
			const y = (1 - pt.y) * viewportHeight / 2;
			minX = Math.min(minX, x);
			maxX = Math.max(maxX, x);
			minY = Math.min(minY, y);
			maxY = Math.max(maxY, y);
		}
		if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
			return null;
		}
		return { minX, minY, maxX, maxY };
	}

	function getFrameViewport(ctx: FrameContext): { width: number; height: number } | null {
		const fromCtx = ctx as FrameContext & {
			viewport?: { width?: number; height?: number };
		};
		const ctxWidth = fromCtx.viewport?.width;
		const ctxHeight = fromCtx.viewport?.height;
		if (Number.isFinite(ctxWidth) && Number.isFinite(ctxHeight) && ctxWidth! > 0 && ctxHeight! > 0) {
			return { width: ctxWidth!, height: ctxHeight! };
		}
		if (typeof window !== "undefined" && window.innerWidth > 0 && window.innerHeight > 0) {
			return { width: window.innerWidth, height: window.innerHeight };
		}
		const root = doc?.documentElement;
		if (root && root.clientWidth > 0 && root.clientHeight > 0) {
			return { width: root.clientWidth, height: root.clientHeight };
		}
		return null;
	}

	function readGroupRowSettle(): number {
		const userData = group?.userData as { rowSettle?: number } | undefined;
		const rowSettle = userData?.rowSettle;
		return Number.isFinite(rowSettle) ? rowSettle! : 0;
	}

	function maybeStartRowsLoadedIntro(rows: ShelfContentRow[], nowSeconds: number): void {
		if (!group || !group.userData) return;
		if (rows.length === 0) return;
		if (rows.every((row) => isShelfContentLoadingRow(row))) return;
		const contentSig = rows.map((row, index) => [
			index,
			row.id || "",
			row.name || "",
			row.artist || "",
			row.kind || "",
			row.provider || "",
		].join(":")).join("|");
		if (!contentSig || contentSig === detailRowsLoadedContentSig) return;
		detailRowsLoadedContentSig = contentSig;
		rowSettleStartedAt = nowSeconds;
		group.userData.rowSettle = 1;
	}

	function advanceRowSettle(nowSeconds: number): void {
		if (!group || !group.userData) return;
		const current = group.userData.rowSettle;
		if (!Number.isFinite(current) || current <= 0) return;
		const elapsed = nowSeconds - rowSettleStartedAt;
		if (!Number.isFinite(elapsed) || elapsed <= 0) return;
		if (elapsed >= 0.76) {
			group.userData.rowSettle = 0;
			return;
		}
		const t = Math.max(0, Math.min(1, elapsed / 0.76));
		group.userData.rowSettle = Math.pow(2, -10 * t);
	}

	function disposeDetailContentMeshes(): void {
		disposeDetailRows();
		detailRowPool?.dispose();
		detailRowPool = null;
		if (detailPanel) {
			disposeManagedResource(detailPanel);
		}
		if (detailGroup) {
			try {
				group?.remove(detailGroup);
			} catch {
			}
			detailGroup = null;
		}
		detailRowsLoadedContentSig = "";
		rowSettleStartedAt = -Infinity;
		if (group?.userData) group.userData.rowSettle = 0;
	}

	function disposeDetailRows(): void {
		if (detailRows.size === 0) return;
		for (const [index, sprite] of [...detailRows]) {
			releaseDetailRow(index, sprite);
		}
		detailRowsSig = "";
	}

	function releaseDetailPanelOwnership(panel: ShelfContentPanelSprite): void {
		try {
			detailGroup?.remove(panel.mesh);
		} catch {
		}
		panel.mesh.visible = false;
		if (detailPanel === panel) detailPanel = null;
		contentList.clearScreenTargets();
	}

	function releaseDetailRowOwnership(sprite: ShelfContentRowSprite): void {
		try {
			detailGroup?.remove(sprite.mesh);
		} catch {
		}
		sprite.mesh.visible = false;
		for (const [index, current] of [...detailRows]) {
			if (current === sprite) detailRows.delete(index);
		}
		detailRowPool?.discard(sprite);
		detailRowsSig = "";
	}

	function releaseDetailRow(index: number, sprite: ShelfContentRowSprite): void {
		try {
			detailGroup?.remove(sprite.mesh);
		} catch {
		}
		sprite.mesh.visible = false;
		detailRows.delete(index);
		detailRowPool?.release(sprite);
	}

	function ensureDetailRowPool(): ReusableObjectPool<ShelfContentRowSprite> | null {
		if (detailRowPool) return detailRowPool;
		if (!three || !doc) return null;
		detailRowPool = createReusableObjectPool<ShelfContentRowSprite>({
			capacity: CONTENT_MAX_RENDER,
			create: () => {
				const sprite = createShelfContentRowSprite({
					three,
					createCanvas: () => doc.createElement("canvas"),
				}, { name: "", kind: "empty" }, 0, false);
				return registerManagedResource(
					sprite,
					`shelf-detail-row:${++resourceOwnerGeneration}`,
					() => releaseDetailRowOwnership(sprite),
				);
			},
			dispose: disposeManagedResource,
		});
		return detailRowPool;
	}

	function computeRenderWindow(): { start: number; end: number } {
		const roundedCenter = clampInt(Math.round(state.centerSmooth), 0, Math.max(0, data.length - 1));
		state.centerIdx = roundedCenter;
		let start = Math.max(0, roundedCenter - SHELF_VISIBLE_RADIUS);
		let end = Math.min(data.length - 1, roundedCenter + SHELF_VISIBLE_RADIUS);
		const count = end - start + 1;
		if (count < SHELF_MAX_RENDER && data.length > count) {
			const need = SHELF_MAX_RENDER - count;
			const growLeft = Math.min(start, Math.ceil(need / 2));
			start -= growLeft;
			const growRight = Math.min(data.length - 1 - end, need - growLeft);
			end += growRight;
			if (end - start + 1 < SHELF_MAX_RENDER) {
				start = Math.max(0, end - SHELF_MAX_RENDER + 1);
			}
		}
		return { start, end };
	}

	function disposeRenderedCards(): void {
		if (renderedCards.size === 0) return;
		for (const [index, card] of [...renderedCards]) {
			releaseRenderedCard(index, card);
		}
	}

	function releaseRenderedCard(index: number, card: ShelfCardSprite): void {
		try {
			group?.remove(card.mesh);
		} catch {
		}
		card.mesh.visible = false;
		renderedCards.delete(index);
		cardPool?.release(card);
	}

	function screenHitCard(
		mesh: THREE.Mesh,
		clientX: number,
		clientY: number,
		viewportWidth: number,
		viewportHeight: number,
		camera: THREE.Camera,
		pad: number,
	): THREE.Vector2 | null {
		if (!mesh.visible || !group || !group.visible || !three) return null;
		const params = (mesh.geometry as { parameters?: { width?: number; height?: number } } | undefined)?.parameters ?? {};
		const hw = (params.width || 1.7) / 2;
		const hh = (params.height || 0.85) / 2;
		const pts = [
			new three.Vector3(-hw, -hh, 0),
			new three.Vector3(hw, -hh, 0),
			new three.Vector3(hw, hh, 0),
			new three.Vector3(-hw, hh, 0),
		];
		let minX = Infinity;
		let minY = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;
		mesh.updateMatrixWorld(true);
		for (const pt of pts) {
			pt.applyMatrix4(mesh.matrixWorld).project(camera);
			const x = (pt.x + 1) * viewportWidth / 2;
			const y = (1 - pt.y) * viewportHeight / 2;
			minX = Math.min(minX, x);
			maxX = Math.max(maxX, x);
			minY = Math.min(minY, y);
			maxY = Math.max(maxY, y);
		}
		if (clientX < minX - pad || clientX > maxX + pad || clientY < minY - pad || clientY > maxY + pad) {
			return null;
		}
		const u = clampRange((clientX - minX) / Math.max(1, maxX - minX), 0, 1);
		const v = 1 - clampRange((clientY - minY) / Math.max(1, maxY - minY), 0, 1);
		return new three.Vector2(u, v);
	}

	function clampStateToDataLength(length: number): void {
		if (length <= 0) {
			state.centerIdx = 0;
			state.centerTarget = 0;
			state.centerSmooth = 0;
			state.selectedIdx = -1;
			closeOpenDetail();
			return;
		}
		const max = length - 1;
		state.centerIdx = clampInt(state.centerIdx, 0, max);
		state.centerTarget = clampInt(state.centerTarget, 0, max);
		state.centerSmooth = clampInt(state.centerSmooth, 0, max);
		if (state.selectedIdx > max) state.selectedIdx = -1;
		if (state.openCardIdx > max) {
			closeOpenDetail();
			return;
		}
		if (state.openCardIdx >= 0) {
			const nextOpenDetailCardKey = shelfItemIdentityKey(data[state.openCardIdx]);
			if (!nextOpenDetailCardKey || nextOpenDetailCardKey !== openDetailCardKey) {
				closeOpenDetail();
			}
		}
	}

	function beginDetailClose(): void {
		if (detailPhase === "closed" || detailPhase === "closing") return;
		detailGeneration += 1;
		detailClosingGeneration = detailGeneration;
		detailClosingStartedAt = Number.isFinite(lastVisualTime) && lastVisualTime > 0
			? lastVisualTime
			: nowFn() / 1000;
		setDetailPhase("closing");
		state.selectedIdx = -1;
		contentList.clearScreenTargets();
	}

	function advanceDetailClose(nowSeconds: number): void {
		if (detailPhase !== "closing") return;
		if (detailClosingGeneration !== detailGeneration) return;
		if (nowSeconds - detailClosingStartedAt + 1e-9 < 0.18) return;
		closeOpenDetail(detailClosingGeneration);
	}

	function detailCloseOpacity(nowSeconds: number): number {
		return 1 - detailCloseProgress(nowSeconds);
	}

	function detailCloseProgress(nowSeconds: number): number {
		if (detailPhase !== "closing") return 0;
		return smoothstep01(clampRange((nowSeconds - detailClosingStartedAt) / 0.18, 0, 1));
	}

	function closeOpenDetail(expectedGeneration?: number): void {
		if (expectedGeneration != null && expectedGeneration !== detailGeneration) return;
		detailGeneration += 1;
		setDetailPhase("closed");
		detailClosingStartedAt = -Infinity;
		state.openCardIdx = -1;
		openDetailCardKey = null;
		contentList.close();
		disposeDetailContentMeshes();
		contentList.clearScreenTargets();
		detailRowsSig = "";
	}

	function setDetailPhase(next: ShelfDetailPhase): void {
		if (detailPhase === next) return;
		detailPhase = next;
		opts.onDetailPhaseChange?.(next);
	}
}

function clampInt(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) return min;
	return Math.max(min, Math.min(max, value));
}

function emptyPoolSnapshot(capacity: number): ReusableObjectPoolSnapshot {
	return {
		capacity,
		created: 0,
		active: 0,
		idle: 0,
		disposed: false,
	};
}

function clampRange(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) return min;
	return Math.max(min, Math.min(max, value));
}

function smoothstep01(value: number): number {
	return value * value * (3 - 2 * value);
}

function podcastPlaylistId(podcastKey: string | undefined): string | undefined {
	if (!podcastKey) return undefined;
	return podcastKey.startsWith("podcast:") ? podcastKey : `podcast:${podcastKey}`;
}

function shelfItemIdentityKey(item: ShelfItem | undefined): string | null {
	if (!item) return null;
	return [
		item.type || "",
		item.provider || "",
		item.playlistId || "",
		item.podcastKey || "",
		item.queueIndex == null ? "" : item.queueIndex,
		item.cover || "",
		item.title || "",
	].join("|");
}

export async function createShelfManagerWithThree(
	opts: Omit<ShelfManagerOptions, "three"> = {},
): Promise<ShelfManager> {
	const three = await import("three");
	return createShelfManager({ ...opts, three });
}
