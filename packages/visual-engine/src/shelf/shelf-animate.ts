import type * as THREE from "three";
import type { FrameContext } from "../runtime/frame-context";
import { computeBreathPulse } from "./breath";
import {
	SHELF_MAX_RENDER,
	SHELF_VISIBLE_RADIUS,
	computeCardLayout,
} from "./card-position";
import { getDefaultShelfLayoutProfile } from "./shelf-layout-profile";
import { computePaneRaw, computeRevealRaw } from "./reveal";
import {
	createShelfCardMesh,
	type ShelfCardSprite,
	type ShelfCardDrawState,
} from "./shelf-card-sprite";
import {
	createShelfState,
	type ShelfMode,
	type ShelfPane,
	type ShelfState,
} from "./shelf-state";

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
}

export interface ShelfSnapshot {
	centerIdx: number;
	centerSmooth: number;
	mode: ShelfMode;
	shelfPane: ShelfPane;
	shelfVisibility: number;
	openCardIdx: number;
	breathPulse: number;
}

export interface ShelfRaycastCardHit {
	index: number;
	item: ShelfItem;
	mesh: THREE.Mesh;
	point?: THREE.Vector3;
	uv?: THREE.Vector2;
	screenPick?: boolean;
}

export interface ShelfManager {
	getState(): ShelfState;
	setData(items: ShelfItem[], opts?: { asyncBuild?: boolean }): void;
	getData(): ShelfItem[];
	update(ctx: FrameContext): void;
	setMode(mode: ShelfMode): void;
	getMode(): ShelfMode;
	setSelectedIdx(idx: number): void;
	getSelectedIdx(): number;
	clearSelected(): void;
	getCenterIdx(): number;
	scrollBy(delta: number): void;
	setShelfPane(pane: ShelfPane, nowSeconds?: number): void;
	getShelfPane(): ShelfPane;
	setShelfVisibility(v: number): void;
	getShelfVisibility(): number;
	schedulePaneSwitch(dir: number): void;
	openDetail(idx: number, opts?: { playlistId?: string; title?: string }): void;
	closeDetail(opts?: { immediate?: boolean }): void;
	getSnapshot(): ShelfSnapshot;
	getRenderedCardCount(): number;
	raycastCards(raycaster: THREE.Raycaster): ShelfRaycastCardHit | null;
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
	let renderedWindowSig = "";
	let breathPulseLast = 0;
	let lastFrameNow = 0;
	const nowFn =
		opts.now ??
		(() => (typeof performance !== "undefined" ? performance.now() : Date.now()));

	return {
		getState() {
			return state;
		},
		setData(items) {
			data.length = 0;
			for (const it of items) data.push(it);
			state.lastSig = `${items.length}::${state.shelfPane}`;
			clampStateToDataLength(items.length);
			renderedWindowSig = "";
		},
		getData() {
			return data;
		},
		update(ctx) {
			if (lastFrameNow === 0) lastFrameNow = ctx.now;
			const dtMs = Math.max(0, ctx.now - lastFrameNow);
			lastFrameNow = ctx.now;

			state.centerSmooth += (state.centerTarget - state.centerSmooth) * 0.16;
			if (Math.abs(state.centerSmooth - state.centerTarget) < 0.001) {
				state.centerSmooth = state.centerTarget;
			}

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
				group.visible =
					state.shelfVisibility > 0 &&
					data.length > 0 &&
					state.mode !== "off";
			}
			rebuildRenderedWindowIfNeeded();
			applyRenderedCardLayout(ctx);

			void nowFn;
		},
		setMode(mode) {
			state.mode = mode;
		},
		getMode() {
			return state.mode;
		},
		setSelectedIdx(idx) {
			state.selectedIdx = idx;
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
		schedulePaneSwitch(dir) {
			state.paneSwitchDir = dir < 0 ? -1 : 1;
		},
		openDetail(idx) {
			state.openCardIdx = idx;
		},
		closeDetail() {
			state.openCardIdx = -1;
		},
		getSnapshot() {
			return {
				centerIdx: state.centerIdx,
				centerSmooth: state.centerSmooth,
				mode: state.mode,
				shelfPane: state.shelfPane,
				shelfVisibility: state.shelfVisibility,
				openCardIdx: state.openCardIdx,
				breathPulse: breathPulseLast,
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
			disposeRenderedCards();
			if (group && scene && ownsGroup) {
				scene.remove(group);
			} else if (group && scene && opts.group) {
				scene.remove(group);
			}
			group = null;
		},
	};

	function rebuildRenderedWindowIfNeeded(): void {
		if (!group || !three || !doc || state.mode === "off" || data.length === 0) {
			disposeRenderedCards();
			renderedWindowSig = "";
			return;
		}
		const window = computeRenderWindow();
		const sig = `${window.start}:${window.end}:${data.length}:${state.shelfPane}`;
		if (sig === renderedWindowSig) return;
		disposeRenderedCards();
		for (let index = window.start; index <= window.end; index++) {
			const item = data[index];
			if (!item) continue;
			const card = createShelfCardMesh({
				item,
				index,
				three,
				createCanvas: () => doc.createElement("canvas"),
				drawState: {
					index,
					centered: index === Math.round(state.centerSmooth),
					selected: index === state.selectedIdx,
					beatProgress: 0,
					dimmed: state.openCardIdx >= 0 && state.openCardIdx !== index,
				},
			});
			card.mesh.renderOrder = 50 + index;
			group.add(card.mesh);
			renderedCards.set(index, card);
		}
		renderedWindowSig = sig;
	}

	function applyRenderedCardLayout(ctx: FrameContext): void {
		if (!group || renderedCards.size === 0) return;
		const profile = getDefaultShelfLayoutProfile();
		const center = state.centerSmooth;
		const mode = state.mode === "stage" ? "stage" : "side";
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
				lift: index === state.selectedIdx ? 1 : 0,
				detailOpen: state.openCardIdx >= 0,
			});
			card.mesh.visible = absD <= SHELF_VISIBLE_RADIUS + 0.55;
			card.mesh.position.set(layout.x, layout.y, layout.z);
			card.mesh.rotation.set(0, layout.rotationY, 0);
			card.mesh.scale.setScalar(layout.scale);
			card.mesh.renderOrder = layout.renderOrder;
			card.material.opacity = layout.opacity * 0.96 * state.shelfVisibility;
			const color = card.material.color as { setScalar?: (v: number) => void } | undefined;
			color?.setScalar?.(state.openCardIdx >= 0 && state.openCardIdx !== index ? 0.72 : 1);
			updateCardSpriteIfNeeded(card, index, ctx);
		}
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
		for (const card of renderedCards.values()) {
			try {
				group?.remove(card.mesh);
			} catch {
			}
			card.dispose();
		}
		renderedCards.clear();
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
			state.openCardIdx = -1;
			return;
		}
		const max = length - 1;
		state.centerIdx = clampInt(state.centerIdx, 0, max);
		state.centerTarget = clampInt(state.centerTarget, 0, max);
		state.centerSmooth = clampInt(state.centerSmooth, 0, max);
		if (state.selectedIdx > max) state.selectedIdx = -1;
		if (state.openCardIdx > max) state.openCardIdx = -1;
	}
}

function clampInt(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) return min;
	return Math.max(min, Math.min(max, value));
}

function clampRange(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) return min;
	return Math.max(min, Math.min(max, value));
}

export async function createShelfManagerWithThree(
	opts: Omit<ShelfManagerOptions, "three"> = {},
): Promise<ShelfManager> {
	const three = await import("three");
	return createShelfManager({ ...opts, three });
}
