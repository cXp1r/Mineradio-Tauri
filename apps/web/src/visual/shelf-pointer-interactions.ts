import {
	activateShelfPrimaryHit,
	type CinemaCamera,
	type ShelfManager,
	type ShelfRaycastCardHit,
	type ShelfPointerRaycastHitGetter,
	type ShelfPointerRaycastInfo,
} from "@mineradio/visual-engine";

export interface ShelfPointerInteractionTarget {
	addEventListener(type: string, listener: EventListener): void;
	removeEventListener(type: string, listener: EventListener): void;
}

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
	>;
	cinema: Pick<CinemaCamera, "setFocusZone">;
	getHit: ShelfPointerRaycastHitGetter;
	getSplashActive: () => boolean;
	getPortrait: () => boolean;
	getWallpaperSafe: () => boolean;
	getViewportWidth: () => number;
	getViewportHeight: () => number;
	getShelfPresence?: () => string | null | undefined;
	onShelfPlayQueueIndex?: (index: number) => void;
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

	const canStartInteraction = (event: Event): boolean => {
		if (opts.getSplashActive()) return false;
		if (opts.shelfManager.getMode() === "off") return false;
		if (opts.shelfManager.getSnapshot().openCardIdx >= 0) return false;
		if (isShelfInteractionUiTarget(event.target)) return false;
		if (!isShelfInteractionBackgroundTarget(event.target)) return false;
		return true;
	};

	const canUseHit = (hit: ReturnType<ShelfPointerRaycastHitGetter>): hit is ShelfRaycastCardHit => {
		if (!hit) return false;
		const snapshot = opts.shelfManager.getSnapshot();
		const mode = opts.shelfManager.getMode();
		if (mode === "stage") return true;
		if (mode !== "side") return false;
		return snapshot.shelfVisibility > 0.34;
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
			screenPad: mode === "side" && shelfAlwaysVisible && snapshot.shelfVisibility > 0.34 ? 18 : undefined,
		};
	};

	const onPointerMove: EventListener = (event) => {
		const pointerEvent = event as PointerEvent;
		if (pointerDownAt) {
			const dx = pointerEvent.clientX - pointerDownAt.x;
			const dy = pointerEvent.clientY - pointerDownAt.y;
			if (Math.hypot(dx, dy) > 6) hadDrag = true;
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
	};

	const onClick: EventListener = (event) => {
		pointerDownAt = null;
		if (suppressNextClick || hadDrag) {
			suppressNextClick = false;
			hadDrag = false;
			return;
		}
		if (!canStartInteraction(event)) return;
		const hit = opts.getHit(pointerInfoFromEvent(event as MouseEvent));
		if (!canUseHit(hit)) return;
		activateShelfPrimaryHit({
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
	};

	opts.target.addEventListener("pointerdown", onPointerDown);
	opts.target.addEventListener("pointerup", onPointerUp);
	opts.target.addEventListener("pointercancel", onPointerCancel);
	opts.target.addEventListener("pointermove", onPointerMove);
	opts.target.addEventListener("click", onClick);
	opts.target.addEventListener("blur", onPointerCancel);

	return () => {
		disposed = true;
		opts.target.removeEventListener("pointerdown", onPointerDown);
		opts.target.removeEventListener("pointerup", onPointerUp);
		opts.target.removeEventListener("pointercancel", onPointerCancel);
		opts.target.removeEventListener("pointermove", onPointerMove);
		opts.target.removeEventListener("click", onClick);
		opts.target.removeEventListener("blur", onPointerCancel);
	};
}
