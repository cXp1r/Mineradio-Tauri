import {
	activateShelfPrimaryHit,
	type CinemaCamera,
	type ShelfManager,
	type ShelfContentRow,
	type ShelfRaycastCardHit,
	type ShelfPointerRaycastHitGetter,
	type ShelfPointerRaycastInfo,
	type ShelfSelectSoundVariant,
} from "@mineradio/visual-engine";

export interface ShelfPointerInteractionTarget {
	addEventListener(type: string, listener: EventListener, options?: boolean | AddEventListenerOptions): void;
	removeEventListener(type: string, listener: EventListener, options?: boolean | EventListenerOptions): void;
}

export interface ShelfDetailRowClickPayload {
	row: ShelfContentRow;
	index: number;
	action?: ShelfDetailRowAction;
}

export type ShelfDetailRowAction = "row" | "like" | "collect" | "next" | "play";

export interface ShelfPointerInteractionOptions {
	target: ShelfPointerInteractionTarget;
	shelfManager: Pick<
		ShelfManager,
		| "getMode"
		| "getSnapshot"
		| "setSelectedIdx"
		| "clearSelected"
		| "getCenterIdx"
		| "scrollBy"
		| "openDetail"
		| "closeDetail"
		| "hasOpenContent"
		| "getContentList"
		| "getShelfPinnedOpen"
		| "setShelfPinnedOpen"
		| "updateShelfHoverCueFromPointer"
		| "clearShelfHoverCue"
		| "getShelfHoverCueValue"
		| "getShelfHoverCuePreviewVisible"
	>;
	cinema: Pick<CinemaCamera, "setFocusZone">;
	getHit: ShelfPointerRaycastHitGetter;
	getSplashActive: () => boolean;
	getPortrait: () => boolean;
	getWallpaperSafe: () => boolean;
	getViewportWidth: () => number;
	getViewportHeight: () => number;
	getShelfPresence?: () => string | null | undefined;
	getShelfPreviewActive?: () => boolean;
	isDetailWheelTarget?: (event: WheelEvent) => boolean;
	setShelfMode?: (mode: "side") => void;
	onShelfPlayQueueIndex?: (index: number) => void;
	onShelfDetailRowClick?: (payload: ShelfDetailRowClickPayload) => void;
	onShelfSelectFeedback?: (direction: number, variant: ShelfSelectSoundVariant) => void;
	onOpenQueuePanel?: () => void;
}

const UI_TARGET_SELECTOR = [
	"button",
	"input",
	"select",
	"textarea",
	"a",
	"[role=button]",
	"#bottom-bar",
	".search-panel",
	".status-panel",
	".provider-rows",
	".playlist-panel",
	"#playlist-panel",
].join(",");

const BACKGROUND_TARGET_SELECTOR = [
	"html",
	"body",
	"#root",
	".shell",
	"#visual-host",
	"canvas",
].join(",");

const WHEEL_LISTENER_OPTIONS: AddEventListenerOptions = { passive: false, capture: true };
const WHEEL_REMOVE_OPTIONS: EventListenerOptions = { capture: true };

function getShelfWheelZoneWidth(viewportWidth: number, viewportHeight: number): number {
	const portrait = viewportHeight > viewportWidth * 1.08;
	const hotZoneRatio = portrait ? 0.26 : 0.18;
	const hotZoneWidth = Math.min(portrait ? 280 : 360, Math.max(148, viewportWidth * hotZoneRatio));
	const ratioWidth = viewportWidth * (portrait ? 0.24 : 0.18);
	return Math.min(portrait ? 280 : 360, Math.max(hotZoneWidth, ratioWidth));
}

function getShelfHotZoneWidth(viewportWidth: number, viewportHeight: number): number {
	const portrait = viewportHeight > viewportWidth * 1.08;
	const ratio = portrait ? 0.26 : 0.18;
	return Math.min(portrait ? 280 : 360, Math.max(148, viewportWidth * ratio));
}

function getShelfPreviewUseZoneWidth(viewportWidth: number, viewportHeight: number): number {
	return Math.min(820, Math.max(getShelfHotZoneWidth(viewportWidth, viewportHeight), viewportWidth * 0.56));
}

export function isShelfClickZone(
	pointer: { clientX: number; clientY: number },
	viewportWidth: number,
	viewportHeight: number,
	pinnedOpen: boolean,
): boolean {
	const edge = pinnedOpen
		? Math.min(390, Math.max(210, viewportWidth * 0.22))
		: getShelfHotZoneWidth(viewportWidth, viewportHeight);
	return pointer.clientX > viewportWidth - edge && pointer.clientY > 130 && pointer.clientY < viewportHeight - 150;
}

export function isShelfPreviewUseZone(
	pointer: { clientX: number; clientY: number },
	viewportWidth: number,
	viewportHeight: number,
): boolean {
	const edge = getShelfPreviewUseZoneWidth(viewportWidth, viewportHeight);
	return pointer.clientX > viewportWidth - edge && pointer.clientY > 96 && pointer.clientY < viewportHeight - 96;
}

function isShelfWheelZone(event: WheelEvent, viewportWidth: number, viewportHeight: number): boolean {
	const edge = getShelfWheelZoneWidth(viewportWidth, viewportHeight);
	return event.clientX > viewportWidth - edge && event.clientY > 116 && event.clientY < viewportHeight - 116;
}

export function isShelfInteractionUiTarget(target: EventTarget | null): boolean {
	if (!target) return false;
	const maybeElement = target as {
		closest?: (selector: string) => unknown;
		matches?: (selector: string) => boolean;
	};
	try {
		if (typeof maybeElement.matches === "function" && maybeElement.matches(UI_TARGET_SELECTOR)) {
			return true;
		}
		if (typeof maybeElement.closest === "function") {
			return !!maybeElement.closest(UI_TARGET_SELECTOR);
		}
	} catch {
		return true;
	}
	return false;
}

function isShelfInteractionBackgroundTarget(target: EventTarget | null): boolean {
	if (!target) return true;
	const maybeElement = target as {
		matches?: (selector: string) => boolean;
	};
	try {
		return typeof maybeElement.matches === "function" && maybeElement.matches(BACKGROUND_TARGET_SELECTOR);
	} catch {
		return false;
	}
}

function isShelfDetailPlaceholderRow(row: ShelfContentRow): boolean {
	return row.kind === "loading" || row.kind === "error" || row.kind === "empty";
}

function shelfDetailActionFromUv(
	pick: { row: ShelfContentRow; index: number; uv?: { x: number; y: number } | null },
	centerIdx: number,
): ShelfDetailRowAction {
	const selectedRow = Math.abs(pick.index - centerIdx) < 0.5;
	const rowIsPodcastRadio = pick.row.type === "podcast-radio";
	const uv = pick.uv;
	const inButtonY = !!uv && uv.y > 0.20 && uv.y < 0.82;
	if (selectedRow && !rowIsPodcastRadio && inButtonY) {
		if (uv.x > 0.61 && uv.x < 0.68) return "like";
		if (uv.x >= 0.68 && uv.x < 0.75) return "collect";
		if (uv.x >= 0.75 && uv.x < 0.82) return "next";
		if (uv.x >= 0.82) return "play";
	}
	return "play";
}

export function attachShelfPointerInteractionWiring(
	opts: ShelfPointerInteractionOptions,
): () => void {
	let disposed = false;
	let pointerDownAt: { x: number; y: number } | null = null;
	let hadDrag = false;
	let suppressNextClick = false;

	const clearSelection = (): void => {
		if (disposed) return;
		opts.shelfManager.clearSelected();
	};

	const clearHoverCueAndSelection = (): void => {
		if (disposed) return;
		opts.shelfManager.clearShelfHoverCue();
		opts.shelfManager.clearSelected();
	};

	const isShelfPinnedOpen = (): boolean => {
		return opts.shelfManager.getShelfPinnedOpen();
	};

	const isSideAutoPreviewActive = (): boolean => {
		if (opts.shelfManager.getMode() !== "side") return false;
		if (isShelfPinnedOpen()) return false;
		if (opts.getShelfPresence?.() !== "auto") return false;
		return opts.getShelfPreviewActive?.() === true || opts.shelfManager.getShelfHoverCuePreviewVisible();
	};

	const canStartInteraction = (event: Event): boolean => {
		if (opts.getSplashActive()) return false;
		if (opts.shelfManager.getMode() === "off") return false;
		if (opts.shelfManager.getSnapshot().openCardIdx >= 0) return false;
		if (isShelfInteractionUiTarget(event.target)) return false;
		if (!isShelfInteractionBackgroundTarget(event.target)) return false;
		return true;
	};

	const canShowShelfHoverCueAt = (event: PointerEvent | MouseEvent): boolean => {
		if (opts.getSplashActive()) return false;
		if (opts.shelfManager.getMode() !== "side") return false;
		if (isShelfPinnedOpen()) return false;
		const snapshot = opts.shelfManager.getSnapshot();
		if (snapshot.openCardIdx >= 0) return false;
		if (isShelfInteractionUiTarget(event.target)) return false;
		if (!isShelfInteractionBackgroundTarget(event.target)) return false;
		if (opts.getShelfPresence?.() !== "auto") return false;
		const viewportWidth = opts.getViewportWidth();
		const viewportHeight = opts.getViewportHeight();
		if (isShelfClickZone(event, viewportWidth, viewportHeight, false)) return true;
		return isSideAutoPreviewActive() && isShelfPreviewUseZone(event, viewportWidth, viewportHeight);
	};

	const canUseHit = (hit: ReturnType<ShelfPointerRaycastHitGetter>): hit is ShelfRaycastCardHit => {
		if (!hit) return false;
		const snapshot = opts.shelfManager.getSnapshot();
		const mode = opts.shelfManager.getMode();
		if (mode === "stage") return true;
		if (mode !== "side") return false;
		if (isShelfPinnedOpen()) return true;
		return snapshot.shelfVisibility > 0.34;
	};

	const canUseWheelHit = (hit: ReturnType<ShelfPointerRaycastHitGetter>): hit is ShelfRaycastCardHit => {
		if (!hit) return false;
		const mode = opts.shelfManager.getMode();
		if (mode === "stage") return true;
		if (mode !== "side") return false;
		if (isShelfPinnedOpen() || isSideAutoPreviewActive()) return true;
		return opts.getShelfPresence?.() === "always" && canUseHit(hit);
	};

	const canForceWheelScroll = (event: WheelEvent): boolean => {
		if (!event.shiftKey) return false;
		const mode = opts.shelfManager.getMode();
		if (mode === "stage") return true;
		if (mode !== "side") return false;
		return isShelfPinnedOpen() || isSideAutoPreviewActive() || opts.getShelfPresence?.() === "always";
	};

	const canUsePreviewWheelZone = (event: WheelEvent): boolean => {
		if (!isSideAutoPreviewActive()) return false;
		return isShelfWheelZone(event, opts.getViewportWidth(), opts.getViewportHeight());
	};

	const canUsePinnedWheelZone = (event: WheelEvent): boolean => {
		if (opts.shelfManager.getMode() !== "side") return false;
		if (!isShelfPinnedOpen()) return false;
		return isShelfWheelZone(event, opts.getViewportWidth(), opts.getViewportHeight());
	};

	const canUseDetailWheel = (event: WheelEvent): boolean => {
		if (opts.getSplashActive()) return false;
		if (opts.shelfManager.getMode() === "off") return false;
		if (!opts.shelfManager.hasOpenContent()) return false;
		if (isShelfInteractionUiTarget(event.target)) return false;
		if (!isShelfInteractionBackgroundTarget(event.target)) return false;
		if (opts.isDetailWheelTarget) return opts.isDetailWheelTarget(event);
		const contentList = opts.shelfManager.getContentList();
		if (typeof contentList?.hasScreenTargetAt !== "function") return false;
		return contentList.hasScreenTargetAt({ x: event.clientX, y: event.clientY }) === true;
	};

	const canUseDetailClick = (event: MouseEvent): boolean => {
		if (opts.getSplashActive()) return false;
		if (opts.shelfManager.getMode() === "off") return false;
		if (!opts.shelfManager.hasOpenContent()) return false;
		if (isShelfInteractionUiTarget(event.target)) return false;
		if (!isShelfInteractionBackgroundTarget(event.target)) return false;
		return true;
	};

	const pointerInfoFromEvent = (event: PointerEvent | MouseEvent): ShelfPointerRaycastInfo => {
		const mode = opts.shelfManager.getMode();
		const snapshot = opts.shelfManager.getSnapshot();
		const shelfAlwaysVisible = opts.getShelfPresence?.() === "always";
		return {
			clientX: event.clientX,
			clientY: event.clientY,
			viewportWidth: opts.getViewportWidth(),
			viewportHeight: opts.getViewportHeight(),
			screenPad: mode === "side" && !isShelfPinnedOpen() && shelfAlwaysVisible ? 18 : undefined,
		};
	};

	const onPointerMove: EventListener = (event) => {
		const pointerEvent = event as PointerEvent;
		if (pointerDownAt) {
			const dx = pointerEvent.clientX - pointerDownAt.x;
			const dy = pointerEvent.clientY - pointerDownAt.y;
			if (Math.hypot(dx, dy) > 6) hadDrag = true;
		}
		if (canShowShelfHoverCueAt(pointerEvent)) {
			opts.shelfManager.updateShelfHoverCueFromPointer({
				clientX: pointerEvent.clientX,
				clientY: pointerEvent.clientY,
			});
		} else {
			opts.shelfManager.clearShelfHoverCue();
		}
		if (!canStartInteraction(event)) {
			clearSelection();
			return;
		}
		const hit = opts.getHit(pointerInfoFromEvent(pointerEvent));
		if (canUseHit(hit)) {
			opts.shelfManager.setSelectedIdx(hit.index);
		} else {
			clearSelection();
		}
	};

	const onPointerDown: EventListener = (event) => {
		const pointerEvent = event as PointerEvent;
		pointerDownAt = { x: pointerEvent.clientX, y: pointerEvent.clientY };
		hadDrag = false;
		suppressNextClick = false;
	};

	const onPointerUp: EventListener = () => {
		pointerDownAt = null;
		suppressNextClick = hadDrag;
		hadDrag = false;
	};

	const onPointerCancel: EventListener = () => {
		pointerDownAt = null;
		hadDrag = false;
		suppressNextClick = false;
		clearHoverCueAndSelection();
	};

	const onPointerLeave: EventListener = () => {
		clearHoverCueAndSelection();
	};

	const onClick: EventListener = (event) => {
		pointerDownAt = null;
		if (suppressNextClick || hadDrag) {
			suppressNextClick = false;
			hadDrag = false;
			return;
		}
		if (opts.shelfManager.hasOpenContent()) {
			const mouseEvent = event as MouseEvent;
			if (!canUseDetailClick(mouseEvent)) return;
			const contentList = opts.shelfManager.getContentList();
			const pick = contentList?.pickRowAtScreen?.({ x: mouseEvent.clientX, y: mouseEvent.clientY }) ?? null;
			if (!pick || isShelfDetailPlaceholderRow(pick.row)) return;
			mouseEvent.preventDefault?.();
			mouseEvent.stopImmediatePropagation?.();
			opts.onShelfSelectFeedback?.(pick.index - opts.shelfManager.getCenterIdx(), "row");
			opts.onShelfDetailRowClick?.({
				row: pick.row,
				index: pick.index,
				action: shelfDetailActionFromUv(pick, opts.shelfManager.getCenterIdx()),
			});
			return;
		}
		if (!canStartInteraction(event)) return;
		const hit = opts.getHit(pointerInfoFromEvent(event as MouseEvent));
		if (!canUseHit(hit)) return;
		const activation = activateShelfPrimaryHit({
			hit,
			getCenterIdx: opts.shelfManager.getCenterIdx,
			scrollBy: opts.shelfManager.scrollBy,
			openDetail: opts.shelfManager.openDetail,
			onPlayQueueIndex: opts.onShelfPlayQueueIndex,
			onOpenQueuePanel: opts.onOpenQueuePanel,
			onOpenDetail: () => {
				opts.cinema.setFocusZone("shelf-detail", {
					immediate: true,
					portrait: opts.getPortrait(),
					wallpaperSafe: opts.getWallpaperSafe(),
				});
			},
		});
		if (activation.kind === "scroll") {
			opts.onShelfSelectFeedback?.(activation.delta, "card");
		}
	};

	const onWheel: EventListener = (event) => {
		const wheelEvent = event as WheelEvent;
		if (opts.shelfManager.hasOpenContent()) {
			if (!canUseDetailWheel(wheelEvent)) return;
			const contentList = opts.shelfManager.getContentList();
			if (!contentList) return;
			wheelEvent.preventDefault();
			wheelEvent.stopImmediatePropagation();
			const direction = wheelEvent.deltaY > 0 ? 1 : -1;
			contentList.scrollBy(direction);
			opts.onShelfSelectFeedback?.(direction, "row");
			return;
		}
		if (!canStartInteraction(event)) return;
		const hit = opts.getHit(pointerInfoFromEvent(wheelEvent));
		if (
			!canUseWheelHit(hit)
			&& !canForceWheelScroll(wheelEvent)
			&& !canUsePreviewWheelZone(wheelEvent)
			&& !canUsePinnedWheelZone(wheelEvent)
		) return;
		wheelEvent.preventDefault();
		wheelEvent.stopImmediatePropagation();
		const direction = wheelEvent.deltaY > 0 ? 1 : -1;
		opts.shelfManager.scrollBy(direction);
		opts.onShelfSelectFeedback?.(direction, "card");
	};

	const onContextMenu: EventListener = (event) => {
		if (opts.getSplashActive()) return;
		if (isShelfInteractionUiTarget(event.target)) return;
		if (!isShelfInteractionBackgroundTarget(event.target)) return;
		let mode = opts.shelfManager.getMode();
		if (mode !== "side" && mode !== "off") return;
		event.preventDefault();
		event.stopPropagation?.();
		if (mode === "off") {
			opts.setShelfMode?.("side");
			mode = "side";
		}
		const focusSide = (): void => {
			opts.cinema.setFocusZone("shelf-side", {
				immediate: true,
				portrait: opts.getPortrait(),
				wallpaperSafe: opts.getWallpaperSafe(),
			});
		};
		if (opts.shelfManager.getSnapshot().openCardIdx >= 0) {
			opts.shelfManager.closeDetail({ immediate: true });
			opts.shelfManager.setShelfPinnedOpen(true);
			focusSide();
			return;
		}
		const nextOpen = !isShelfPinnedOpen();
		opts.shelfManager.setShelfPinnedOpen(nextOpen);
		opts.cinema.setFocusZone(nextOpen ? "shelf-side" : null, {
			immediate: true,
			portrait: opts.getPortrait(),
			wallpaperSafe: opts.getWallpaperSafe(),
		});
	};

	opts.target.addEventListener("pointerdown", onPointerDown);
	opts.target.addEventListener("pointerup", onPointerUp);
	opts.target.addEventListener("pointercancel", onPointerCancel);
	opts.target.addEventListener("pointerleave", onPointerLeave);
	opts.target.addEventListener("pointermove", onPointerMove);
	opts.target.addEventListener("click", onClick);
	opts.target.addEventListener("wheel", onWheel, WHEEL_LISTENER_OPTIONS);
	opts.target.addEventListener("contextmenu", onContextMenu);
	opts.target.addEventListener("blur", onPointerCancel);

	return () => {
		disposed = true;
		opts.target.removeEventListener("pointerdown", onPointerDown);
		opts.target.removeEventListener("pointerup", onPointerUp);
		opts.target.removeEventListener("pointercancel", onPointerCancel);
		opts.target.removeEventListener("pointerleave", onPointerLeave);
		opts.target.removeEventListener("pointermove", onPointerMove);
		opts.target.removeEventListener("click", onClick);
		opts.target.removeEventListener("wheel", onWheel, WHEEL_REMOVE_OPTIONS);
		opts.target.removeEventListener("contextmenu", onContextMenu);
		opts.target.removeEventListener("blur", onPointerCancel);
	};
}
