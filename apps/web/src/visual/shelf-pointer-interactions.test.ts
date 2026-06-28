import { expect, test } from "bun:test";
import type { ShelfManager, ShelfRaycastCardHit } from "@mineradio/visual-engine";
import {
	attachShelfPointerInteractionWiring,
	isShelfInteractionUiTarget,
} from "./shelf-pointer-interactions";

function closedSnapshot() {
	return {
		centerIdx: 0,
		centerSmooth: 0,
		mode: "stage" as const,
		presence: "always" as const,
		shelfPane: "mine" as const,
		shelfVisibility: 1,
		openCardIdx: -1,
		pinnedOpen: false,
		breathPulse: 0,
	};
}

type ShelfPointerInteractionManager = Pick<
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

function makeShelfManagerMock(
	overrides: Partial<ShelfPointerInteractionManager>,
): ShelfPointerInteractionManager {
	return {
		getMode: () => "stage",
		getSnapshot: closedSnapshot,
		setSelectedIdx: () => {},
		clearSelected: () => {},
		getCenterIdx: () => 0,
		scrollBy: () => {},
		openDetail: () => {},
		closeDetail: () => {},
		hasOpenContent: () => false,
		getContentList: () => null,
		getShelfPinnedOpen: () => false,
		setShelfPinnedOpen: () => {},
		updateShelfHoverCueFromPointer: () => {},
		clearShelfHoverCue: () => {},
		getShelfHoverCueValue: () => 0,
		getShelfHoverCuePreviewVisible: () => false,
		...overrides,
	};
}

class FakePointerTarget {
	listeners = new Map<string, Set<(event: unknown) => void>>();
	options = new Map<string, unknown[]>();

	addEventListener(type: string, listener: EventListener, options?: unknown): void {
		const set = this.listeners.get(type) ?? new Set<(event: unknown) => void>();
		set.add(listener as unknown as (event: unknown) => void);
		this.listeners.set(type, set);
		const optionList = this.options.get(type) ?? [];
		optionList.push(options);
		this.options.set(type, optionList);
	}

	removeEventListener(type: string, listener: EventListener): void {
		this.listeners.get(type)?.delete(listener as unknown as (event: unknown) => void);
	}

	emit(type: string, event: unknown): void {
		for (const listener of this.listeners.get(type) ?? []) listener(event);
	}
}

function makeWheelEvent(opts: {
	deltaY: number;
	shiftKey?: boolean;
	target?: unknown;
	clientX?: number;
	clientY?: number;
}) {
	const calls: string[] = [];
	return {
		clientX: opts.clientX ?? 10,
		clientY: opts.clientY ?? 20,
		deltaY: opts.deltaY,
		shiftKey: opts.shiftKey ?? false,
		target: opts.target ?? null,
		preventDefault: () => calls.push("preventDefault"),
		stopImmediatePropagation: () => calls.push("stopImmediatePropagation"),
		calls,
	};
}

function makeContextMenuEvent(opts: {
	target?: unknown;
	clientX?: number;
	clientY?: number;
}) {
	const calls: string[] = [];
	return {
		clientX: opts.clientX ?? 10,
		clientY: opts.clientY ?? 20,
		target: opts.target ?? null,
		preventDefault: () => calls.push("preventDefault"),
		stopPropagation: () => calls.push("stopPropagation"),
		calls,
	};
}

function makeHit(index: number, action: unknown = { kind: "playQueue", index }): ShelfRaycastCardHit {
	return {
		index,
		item: { title: `Card ${index}` },
		mesh: { userData: { action } } as never,
	};
}

test("isShelfInteractionUiTarget conservatively skips controls and shell panels", () => {
	const statusPanel = {
		matches: (selector: string) => selector.split(",").includes(".status-panel"),
		closest: (selector: string) => selector.split(",").includes(".status-panel") ? statusPanel : null,
	};
	const button = {
		matches: (selector: string) => selector.split(",").includes("button"),
		closest: (selector: string) => selector.split(",").includes("button") ? button : null,
	};
	const shellMain = {
		matches: (selector: string) => selector.split(",").includes("main"),
		closest: () => null,
	};
	const canvas = {
		matches: () => false,
		closest: () => null,
	};

	expect(isShelfInteractionUiTarget(button as unknown as EventTarget)).toBe(true);
	expect(isShelfInteractionUiTarget(statusPanel as unknown as EventTarget)).toBe(true);
	expect(isShelfInteractionUiTarget(shellMain as unknown as EventTarget)).toBe(false);
	expect(isShelfInteractionUiTarget(canvas as unknown as EventTarget)).toBe(false);
	expect(isShelfInteractionUiTarget(null)).toBe(false);
});

test("attachShelfPointerInteractionWiring updates hover selection from global pointer movement", () => {
	const target = new FakePointerTarget();
	const selected: number[] = [];
	let hit: ShelfRaycastCardHit | null = makeHit(2);
	const cleanup = attachShelfPointerInteractionWiring({
		target,
		shelfManager: makeShelfManagerMock({
			getMode: () => "stage",
			getSnapshot: closedSnapshot,
			setSelectedIdx: (idx) => selected.push(idx),
			clearSelected: () => selected.push(-1),
			getCenterIdx: () => 0,
			scrollBy: () => {},
			openDetail: () => {},
		}),
		cinema: { setFocusZone: () => {} },
		getHit: () => hit,
		getSplashActive: () => false,
		getPortrait: () => false,
		getWallpaperSafe: () => false,
		getViewportWidth: () => 1200,
		getViewportHeight: () => 900,
	});

	target.emit("pointermove", { clientX: 10, clientY: 20, target: null });
	hit = null;
	target.emit("pointermove", { clientX: 11, clientY: 21, target: null });
	cleanup();

	expect(selected).toEqual([2, -1]);
});

test("attachShelfPointerInteractionWiring skips hover and clicks while pointer is over UI", () => {
	const target = new FakePointerTarget();
	const selected: number[] = [];
	const played: number[] = [];
	const button = {
		matches: (selector: string) => selector.split(",").includes("button"),
		closest: (selector: string) => selector.split(",").includes("button") ? button : null,
	};
	const cleanup = attachShelfPointerInteractionWiring({
		target,
		shelfManager: makeShelfManagerMock({
			getMode: () => "stage",
			getSnapshot: closedSnapshot,
			setSelectedIdx: (idx) => selected.push(idx),
			clearSelected: () => selected.push(-1),
			getCenterIdx: () => 1,
			scrollBy: () => {},
			openDetail: () => {},
		}),
		cinema: { setFocusZone: () => {} },
		getHit: () => makeHit(1, { kind: "playQueue", index: 5 }),
		getSplashActive: () => false,
		getPortrait: () => false,
		getWallpaperSafe: () => false,
		getViewportWidth: () => 1200,
		getViewportHeight: () => 900,
		onShelfPlayQueueIndex: (idx) => played.push(idx),
	});

	target.emit("pointermove", { clientX: 10, clientY: 20, target: button });
	target.emit("click", { clientX: 10, clientY: 20, target: button });
	cleanup();

	expect(selected).toEqual([-1]);
	expect(played).toEqual([]);
});

test("attachShelfPointerInteractionWiring only lets shelf background targets pierce shell chrome", () => {
	const target = new FakePointerTarget();
	const selected: number[] = [];
	const played: number[] = [];
	const unknownChrome = {
		matches: () => false,
		closest: () => null,
	};
	const shellBackground = {
		matches: (selector: string) => selector.split(",").includes(".shell"),
		closest: () => null,
	};
	const cleanup = attachShelfPointerInteractionWiring({
		target,
		shelfManager: makeShelfManagerMock({
			getMode: () => "stage",
			getSnapshot: closedSnapshot,
			setSelectedIdx: (idx) => selected.push(idx),
			clearSelected: () => selected.push(-1),
			getCenterIdx: () => 1,
			scrollBy: () => {},
			openDetail: () => {},
		}),
		cinema: { setFocusZone: () => {} },
		getHit: () => makeHit(1, { kind: "playQueue", index: 5 }),
		getSplashActive: () => false,
		getPortrait: () => false,
		getWallpaperSafe: () => false,
		getViewportWidth: () => 1200,
		getViewportHeight: () => 900,
		onShelfPlayQueueIndex: (idx) => played.push(idx),
	});

	target.emit("pointermove", { clientX: 10, clientY: 20, target: unknownChrome });
	target.emit("click", { clientX: 10, clientY: 20, target: unknownChrome });
	target.emit("pointermove", { clientX: 10, clientY: 20, target: shellBackground });
	target.emit("click", { clientX: 10, clientY: 20, target: shellBackground });
	cleanup();

	expect(selected).toEqual([-1, 1]);
	expect(played).toEqual([5]);
});

test("attachShelfPointerInteractionWiring ignores the click after a pointer drag", () => {
	const target = new FakePointerTarget();
	const played: number[] = [];
	const cleanup = attachShelfPointerInteractionWiring({
		target,
		shelfManager: makeShelfManagerMock({
			getMode: () => "stage",
			getSnapshot: closedSnapshot,
			setSelectedIdx: () => {},
			clearSelected: () => {},
			getCenterIdx: () => 1,
			scrollBy: () => {},
			openDetail: () => {},
		}),
		cinema: { setFocusZone: () => {} },
		getHit: () => makeHit(1, { kind: "playQueue", index: 5 }),
		getSplashActive: () => false,
		getPortrait: () => false,
		getWallpaperSafe: () => false,
		getViewportWidth: () => 1200,
		getViewportHeight: () => 900,
		onShelfPlayQueueIndex: (idx) => played.push(idx),
	});

	target.emit("pointerdown", { clientX: 10, clientY: 20, target: null });
	target.emit("pointermove", { clientX: 30, clientY: 45, target: null });
	target.emit("click", { clientX: 30, clientY: 45, target: null });
	target.emit("click", { clientX: 30, clientY: 45, target: null });
	cleanup();

	expect(played).toEqual([5]);
});

test("attachShelfPointerInteractionWiring clears stale drag state across pointerup and cancel", () => {
	const target = new FakePointerTarget();
	const played: number[] = [];
	const cleanup = attachShelfPointerInteractionWiring({
		target,
		shelfManager: makeShelfManagerMock({
			getMode: () => "stage",
			getSnapshot: closedSnapshot,
			setSelectedIdx: () => {},
			clearSelected: () => {},
			getCenterIdx: () => 1,
			scrollBy: () => {},
			openDetail: () => {},
		}),
		cinema: { setFocusZone: () => {} },
		getHit: () => makeHit(1, { kind: "playQueue", index: 5 }),
		getSplashActive: () => false,
		getPortrait: () => false,
		getWallpaperSafe: () => false,
		getViewportWidth: () => 1200,
		getViewportHeight: () => 900,
		onShelfPlayQueueIndex: (idx) => played.push(idx),
	});

	target.emit("pointerdown", { clientX: 10, clientY: 20, target: null });
	target.emit("pointermove", { clientX: 30, clientY: 45, target: null });
	target.emit("pointerup", { clientX: 30, clientY: 45, target: null });
	target.emit("pointerdown", { clientX: 31, clientY: 46, target: null });
	target.emit("pointerup", { clientX: 31, clientY: 46, target: null });
	target.emit("click", { clientX: 31, clientY: 46, target: null });
	target.emit("pointerdown", { clientX: 10, clientY: 20, target: null });
	target.emit("pointermove", { clientX: 22, clientY: 38, target: null });
	target.emit("pointercancel", { clientX: 22, clientY: 38, target: null });
	target.emit("click", { clientX: 22, clientY: 38, target: null });
	cleanup();

	expect(played).toEqual([5, 5]);
});

test("attachShelfPointerInteractionWiring gates hidden side shelf hits", () => {
	const target = new FakePointerTarget();
	const selected: number[] = [];
	const played: number[] = [];
	let shelfVisibility = 0;
	const cleanup = attachShelfPointerInteractionWiring({
		target,
		shelfManager: makeShelfManagerMock({
			getMode: () => "side",
			getSnapshot: () => ({
				...closedSnapshot(),
				mode: "side" as const,
				shelfVisibility,
			}),
			setSelectedIdx: (idx) => selected.push(idx),
			clearSelected: () => selected.push(-1),
			getCenterIdx: () => 1,
			scrollBy: () => {},
			openDetail: () => {},
		}),
		cinema: { setFocusZone: () => {} },
		getHit: () => makeHit(1, { kind: "playQueue", index: 5 }),
		getSplashActive: () => false,
		getPortrait: () => false,
		getWallpaperSafe: () => false,
		getViewportWidth: () => 1200,
		getViewportHeight: () => 900,
		onShelfPlayQueueIndex: (idx) => played.push(idx),
	});

	target.emit("pointermove", { clientX: 10, clientY: 20, target: null });
	target.emit("click", { clientX: 10, clientY: 20, target: null });
	shelfVisibility = 0.35;
	target.emit("pointermove", { clientX: 10, clientY: 20, target: null });
	target.emit("click", { clientX: 10, clientY: 20, target: null });
	cleanup();

	expect(selected).toEqual([-1, 1]);
	expect(played).toEqual([5]);
});

test("attachShelfPointerInteractionWiring updates side auto hover cue inside baseline click hot-zone", () => {
	const target = new FakePointerTarget();
	const cuePointers: Array<{ clientX: number; clientY: number } | null> = [];
	const cleanup = attachShelfPointerInteractionWiring({
		target,
		shelfManager: makeShelfManagerMock({
			getMode: () => "side",
			getSnapshot: () => ({
				...closedSnapshot(),
				mode: "side" as const,
				presence: "auto" as const,
				shelfVisibility: 0,
			}),
			clearSelected: () => {},
			updateShelfHoverCueFromPointer: (pointer) => cuePointers.push(pointer),
			clearShelfHoverCue: () => cuePointers.push(null),
		}),
		cinema: { setFocusZone: () => {} },
		getHit: () => null,
		getSplashActive: () => false,
		getPortrait: () => false,
		getWallpaperSafe: () => false,
		getViewportWidth: () => 1200,
		getViewportHeight: () => 900,
		getShelfPresence: () => "auto",
		getShelfPreviewActive: () => false,
	});

	target.emit("pointermove", { clientX: 1100, clientY: 300, target: null });
	cleanup();

	expect(cuePointers).toEqual([{ clientX: 1100, clientY: 300 }]);
});

test("attachShelfPointerInteractionWiring updates side auto hover cue in preview-use zone only while preview visible", () => {
	const target = new FakePointerTarget();
	const cuePointers: Array<{ clientX: number; clientY: number } | null> = [];
	let previewActive = false;
	const cleanup = attachShelfPointerInteractionWiring({
		target,
		shelfManager: makeShelfManagerMock({
			getMode: () => "side",
			getSnapshot: () => ({
				...closedSnapshot(),
				mode: "side" as const,
				presence: "auto" as const,
				shelfVisibility: previewActive ? 0.18 : 0,
			}),
			clearSelected: () => {},
			updateShelfHoverCueFromPointer: (pointer) => cuePointers.push(pointer),
			clearShelfHoverCue: () => cuePointers.push(null),
		}),
		cinema: { setFocusZone: () => {} },
		getHit: () => null,
		getSplashActive: () => false,
		getPortrait: () => false,
		getWallpaperSafe: () => false,
		getViewportWidth: () => 1200,
		getViewportHeight: () => 900,
		getShelfPresence: () => "auto",
		getShelfPreviewActive: () => previewActive,
	});

	target.emit("pointermove", { clientX: 700, clientY: 300, target: null });
	previewActive = true;
	target.emit("pointermove", { clientX: 700, clientY: 300, target: null });
	cleanup();

	expect(cuePointers).toEqual([null, { clientX: 700, clientY: 300 }]);
});

test("attachShelfPointerInteractionWiring preserves early side auto preview handoff from cue value before visibility threshold", () => {
	const target = new FakePointerTarget();
	const cuePointers: Array<{ clientX: number; clientY: number } | null> = [];
	const cleanup = attachShelfPointerInteractionWiring({
		target,
		shelfManager: makeShelfManagerMock({
			getMode: () => "side",
			getSnapshot: () => ({
				...closedSnapshot(),
				mode: "side" as const,
				presence: "auto" as const,
				shelfVisibility: 0.04,
			}),
			clearSelected: () => {},
			updateShelfHoverCueFromPointer: (pointer) => cuePointers.push(pointer),
			clearShelfHoverCue: () => cuePointers.push(null),
			getShelfHoverCueValue: () => 0.12,
			getShelfHoverCuePreviewVisible: () => true,
		}),
		cinema: { setFocusZone: () => {} },
		getHit: () => null,
		getSplashActive: () => false,
		getPortrait: () => false,
		getWallpaperSafe: () => false,
		getViewportWidth: () => 1200,
		getViewportHeight: () => 900,
		getShelfPresence: () => "auto",
		getShelfPreviewActive: () => false,
	});

	target.emit("pointermove", { clientX: 700, clientY: 300, target: null });
	cleanup();

	expect(cuePointers).toEqual([{ clientX: 700, clientY: 300 }]);
});

test("attachShelfPointerInteractionWiring clears hover cue on UI target, pointer leave, and mode off", () => {
	const target = new FakePointerTarget();
	const cleared: string[] = [];
	let mode: "side" | "off" = "side";
	const button = {
		matches: (selector: string) => selector.split(",").includes("button"),
		closest: (selector: string) => selector.split(",").includes("button") ? button : null,
	};
	const cleanup = attachShelfPointerInteractionWiring({
		target,
		shelfManager: makeShelfManagerMock({
			getMode: () => mode,
			getSnapshot: () => ({
				...closedSnapshot(),
				mode,
				presence: "auto" as const,
				shelfVisibility: 0.2,
			}),
			clearSelected: () => cleared.push("selection"),
			updateShelfHoverCueFromPointer: () => {},
			clearShelfHoverCue: () => cleared.push("cue"),
		}),
		cinema: { setFocusZone: () => {} },
		getHit: () => null,
		getSplashActive: () => false,
		getPortrait: () => false,
		getWallpaperSafe: () => false,
		getViewportWidth: () => 1200,
		getViewportHeight: () => 900,
		getShelfPresence: () => "auto",
		getShelfPreviewActive: () => true,
	});

	target.emit("pointermove", { clientX: 1100, clientY: 300, target: button });
	target.emit("pointerleave", { clientX: 1100, clientY: 300, target: null });
	mode = "off";
	target.emit("pointermove", { clientX: 1100, clientY: 300, target: null });
	cleanup();

	expect(cleared).toEqual(["cue", "selection", "cue", "selection", "cue", "selection"]);
});

test("attachShelfPointerInteractionWiring passes baseline always-visible side-mode 18px screen pad to hover and click hit lookup", () => {
	const target = new FakePointerTarget();
	const pads: Array<number | undefined> = [];
	const cleanup = attachShelfPointerInteractionWiring({
		target,
		shelfManager: makeShelfManagerMock({
			getMode: () => "side",
			getSnapshot: () => ({
				...closedSnapshot(),
				mode: "side" as const,
				shelfVisibility: 0.9,
			}),
			setSelectedIdx: () => {},
			clearSelected: () => {},
			getCenterIdx: () => 1,
			scrollBy: () => {},
			openDetail: () => {},
		}),
		cinema: { setFocusZone: () => {} },
		getHit: (pointer) => {
			pads.push(pointer.screenPad);
			return makeHit(1, { kind: "playQueue", index: 5 });
		},
		getSplashActive: () => false,
		getPortrait: () => false,
		getWallpaperSafe: () => false,
		getViewportWidth: () => 1200,
		getViewportHeight: () => 900,
		getShelfPresence: () => "always",
	});

	target.emit("pointermove", { clientX: 10, clientY: 20, target: null });
	target.emit("click", { clientX: 10, clientY: 20, target: null });
	cleanup();

	expect(pads).toEqual([18, 18]);
});

test("attachShelfPointerInteractionWiring leaves auto side-mode screen pad undefined for default fallback", () => {
	const target = new FakePointerTarget();
	const pads: Array<number | undefined> = [];
	const cleanup = attachShelfPointerInteractionWiring({
		target,
		shelfManager: makeShelfManagerMock({
			getMode: () => "side",
			getSnapshot: () => ({
				...closedSnapshot(),
				mode: "side" as const,
				shelfVisibility: 0.9,
			}),
			setSelectedIdx: () => {},
			clearSelected: () => {},
			getCenterIdx: () => 1,
			scrollBy: () => {},
			openDetail: () => {},
		}),
		cinema: { setFocusZone: () => {} },
		getHit: (pointer) => {
			pads.push(pointer.screenPad);
			return makeHit(1, { kind: "playQueue", index: 5 });
		},
		getSplashActive: () => false,
		getPortrait: () => false,
		getWallpaperSafe: () => false,
		getViewportWidth: () => 1200,
		getViewportHeight: () => 900,
		getShelfPresence: () => "auto",
	});

	target.emit("pointermove", { clientX: 10, clientY: 20, target: null });
	target.emit("click", { clientX: 10, clientY: 20, target: null });
	cleanup();

	expect(pads).toEqual([undefined, undefined]);
});

test("attachShelfPointerInteractionWiring leaves side pinned screen pad undefined for default padded card hit", () => {
	const target = new FakePointerTarget();
	const pads: Array<number | undefined> = [];
	const cleanup = attachShelfPointerInteractionWiring({
		target,
		shelfManager: makeShelfManagerMock({
			getMode: () => "side",
			getSnapshot: () => ({
				...closedSnapshot(),
				mode: "side" as const,
				shelfVisibility: 0.9,
				pinnedOpen: true,
			}),
			setSelectedIdx: () => {},
			clearSelected: () => {},
			getCenterIdx: () => 1,
			scrollBy: () => {},
			openDetail: () => {},
			getShelfPinnedOpen: () => true,
			setShelfPinnedOpen: () => {},
		}),
		cinema: { setFocusZone: () => {} },
		getHit: (pointer) => {
			pads.push(pointer.screenPad);
			return makeHit(1, { kind: "playQueue", index: 5 });
		},
		getSplashActive: () => false,
		getPortrait: () => false,
		getWallpaperSafe: () => false,
		getViewportWidth: () => 1200,
		getViewportHeight: () => 900,
		getShelfPresence: () => "always",
	});

	target.emit("pointermove", { clientX: 10, clientY: 20, target: null });
	target.emit("click", { clientX: 10, clientY: 20, target: null });
	cleanup();

	expect(pads).toEqual([undefined, undefined]);
});

test("attachShelfPointerInteractionWiring leaves default stage screen pad undefined", () => {
	const target = new FakePointerTarget();
	const pads: Array<number | undefined> = [];
	const cleanup = attachShelfPointerInteractionWiring({
		target,
		shelfManager: makeShelfManagerMock({
			getMode: () => "stage",
			getSnapshot: closedSnapshot,
			setSelectedIdx: () => {},
			clearSelected: () => {},
			getCenterIdx: () => 1,
			scrollBy: () => {},
			openDetail: () => {},
		}),
		cinema: { setFocusZone: () => {} },
		getHit: (pointer) => {
			pads.push(pointer.screenPad);
			return makeHit(1, { kind: "playQueue", index: 5 });
		},
		getSplashActive: () => false,
		getPortrait: () => false,
		getWallpaperSafe: () => false,
		getViewportWidth: () => 1200,
		getViewportHeight: () => 900,
	});

	target.emit("pointermove", { clientX: 10, clientY: 20, target: null });
	target.emit("click", { clientX: 10, clientY: 20, target: null });
	cleanup();

	expect(pads).toEqual([undefined, undefined]);
});

test("attachShelfPointerInteractionWiring scrolls non-centered clicks and opens centered playlist detail focus", () => {
	const target = new FakePointerTarget();
	const scrolled: number[] = [];
	const focus: unknown[] = [];
	let centerIdx = 1;
	let hit = makeHit(3, { kind: "loadPlaylist", playlistId: "p3", title: "Mix 3" });
	const cleanup = attachShelfPointerInteractionWiring({
		target,
		shelfManager: makeShelfManagerMock({
			getMode: () => "stage",
			getSnapshot: closedSnapshot,
			setSelectedIdx: () => {},
			clearSelected: () => {},
			getCenterIdx: () => centerIdx,
			scrollBy: (delta) => scrolled.push(delta),
			openDetail: (idx) => {
				centerIdx = idx;
			},
		}),
		cinema: { setFocusZone: (type, opts) => focus.push([type, opts]) },
		getHit: () => hit,
		getSplashActive: () => false,
		getPortrait: () => true,
		getWallpaperSafe: () => false,
		getViewportWidth: () => 1200,
		getViewportHeight: () => 900,
	});

	target.emit("click", { clientX: 10, clientY: 20, target: null });
	centerIdx = 3;
	hit = makeHit(3, { kind: "loadPlaylist", playlistId: "p3", title: "Mix 3" });
	target.emit("click", { clientX: 10, clientY: 20, target: null });
	cleanup();

	expect(scrolled).toEqual([2]);
	expect(focus).toEqual([
		["shelf-detail", { immediate: true, portrait: true, wallpaperSafe: false }],
	]);
});

test("attachShelfPointerInteractionWiring scrolls stage card-hit wheel in delta direction and consumes event", () => {
	const target = new FakePointerTarget();
	const scrolled: number[] = [];
	const cleanup = attachShelfPointerInteractionWiring({
		target,
		shelfManager: makeShelfManagerMock({
			getMode: () => "stage",
			getSnapshot: closedSnapshot,
			setSelectedIdx: () => {},
			clearSelected: () => {},
			getCenterIdx: () => 0,
			scrollBy: (delta) => scrolled.push(delta),
			openDetail: () => {},
		}),
		cinema: { setFocusZone: () => {} },
		getHit: () => makeHit(2),
		getSplashActive: () => false,
		getPortrait: () => false,
		getWallpaperSafe: () => false,
		getViewportWidth: () => 1200,
		getViewportHeight: () => 900,
	});

	const down = makeWheelEvent({ deltaY: 120 });
	const up = makeWheelEvent({ deltaY: -80 });
	target.emit("wheel", down);
	target.emit("wheel", up);
	cleanup();

	expect(scrolled).toEqual([1, -1]);
	expect(down.calls).toEqual(["preventDefault", "stopImmediatePropagation"]);
	expect(up.calls).toEqual(["preventDefault", "stopImmediatePropagation"]);
	expect(target.options.get("wheel")).toEqual([{ passive: false, capture: true }]);
});

test("attachShelfPointerInteractionWiring ignores stage wheel without hit unless shift forces shelf scroll", () => {
	const target = new FakePointerTarget();
	const scrolled: number[] = [];
	const cleanup = attachShelfPointerInteractionWiring({
		target,
		shelfManager: makeShelfManagerMock({
			getMode: () => "stage",
			getSnapshot: closedSnapshot,
			setSelectedIdx: () => {},
			clearSelected: () => {},
			getCenterIdx: () => 0,
			scrollBy: (delta) => scrolled.push(delta),
			openDetail: () => {},
		}),
		cinema: { setFocusZone: () => {} },
		getHit: () => null,
		getSplashActive: () => false,
		getPortrait: () => false,
		getWallpaperSafe: () => false,
		getViewportWidth: () => 1200,
		getViewportHeight: () => 900,
	});

	const normal = makeWheelEvent({ deltaY: 120 });
	const forced = makeWheelEvent({ deltaY: -120, shiftKey: true });
	target.emit("wheel", normal);
	target.emit("wheel", forced);
	cleanup();

	expect(scrolled).toEqual([-1]);
	expect(normal.calls).toEqual([]);
	expect(forced.calls).toEqual(["preventDefault", "stopImmediatePropagation"]);
});

test("attachShelfPointerInteractionWiring lets stage shift wheel force scroll even when shelf visibility is low", () => {
	const target = new FakePointerTarget();
	const scrolled: number[] = [];
	const cleanup = attachShelfPointerInteractionWiring({
		target,
		shelfManager: makeShelfManagerMock({
			getMode: () => "stage",
			getSnapshot: () => ({
				...closedSnapshot(),
				shelfVisibility: 0.02,
			}),
			setSelectedIdx: () => {},
			clearSelected: () => {},
			getCenterIdx: () => 0,
			scrollBy: (delta) => scrolled.push(delta),
			openDetail: () => {},
		}),
		cinema: { setFocusZone: () => {} },
		getHit: () => null,
		getSplashActive: () => false,
		getPortrait: () => false,
		getWallpaperSafe: () => false,
		getViewportWidth: () => 1200,
		getViewportHeight: () => 900,
	});

	const forced = makeWheelEvent({ deltaY: 120, shiftKey: true });
	target.emit("wheel", forced);
	cleanup();

	expect(scrolled).toEqual([1]);
	expect(forced.calls).toEqual(["preventDefault", "stopImmediatePropagation"]);
});

test("attachShelfPointerInteractionWiring uses side always-visible 18px pad and scrolls wheel over card hit", () => {
	const target = new FakePointerTarget();
	const pads: Array<number | undefined> = [];
	const scrolled: number[] = [];
	const cleanup = attachShelfPointerInteractionWiring({
		target,
		shelfManager: makeShelfManagerMock({
			getMode: () => "side",
			getSnapshot: () => ({
				...closedSnapshot(),
				mode: "side" as const,
				shelfVisibility: 0.9,
			}),
			setSelectedIdx: () => {},
			clearSelected: () => {},
			getCenterIdx: () => 0,
			scrollBy: (delta) => scrolled.push(delta),
			openDetail: () => {},
		}),
		cinema: { setFocusZone: () => {} },
		getHit: (pointer) => {
			pads.push(pointer.screenPad);
			return makeHit(2);
		},
		getSplashActive: () => false,
		getPortrait: () => false,
		getWallpaperSafe: () => false,
		getViewportWidth: () => 1200,
		getViewportHeight: () => 900,
		getShelfPresence: () => "always",
	});

	const event = makeWheelEvent({ deltaY: 120 });
	target.emit("wheel", event);
	cleanup();

	expect(pads).toEqual([18]);
	expect(scrolled).toEqual([1]);
	expect(event.calls).toEqual(["preventDefault", "stopImmediatePropagation"]);
});

test("attachShelfPointerInteractionWiring lets side pinned wheel scroll over card hit before visibility threshold", () => {
	const target = new FakePointerTarget();
	const pads: Array<number | undefined> = [];
	const scrolled: number[] = [];
	const cleanup = attachShelfPointerInteractionWiring({
		target,
		shelfManager: makeShelfManagerMock({
			getMode: () => "side",
			getSnapshot: () => ({
				...closedSnapshot(),
				mode: "side" as const,
				shelfVisibility: 0.02,
				pinnedOpen: true,
			}),
			setSelectedIdx: () => {},
			clearSelected: () => {},
			getCenterIdx: () => 0,
			scrollBy: (delta) => scrolled.push(delta),
			openDetail: () => {},
			getShelfPinnedOpen: () => true,
			setShelfPinnedOpen: () => {},
		}),
		cinema: { setFocusZone: () => {} },
		getHit: (pointer) => {
			pads.push(pointer.screenPad);
			return makeHit(2);
		},
		getSplashActive: () => false,
		getPortrait: () => false,
		getWallpaperSafe: () => false,
		getViewportWidth: () => 1200,
		getViewportHeight: () => 900,
		getShelfPresence: () => "auto",
	});

	const event = makeWheelEvent({ deltaY: 120 });
	target.emit("wheel", event);
	cleanup();

	expect(pads).toEqual([undefined]);
	expect(scrolled).toEqual([1]);
	expect(event.calls).toEqual(["preventDefault", "stopImmediatePropagation"]);
});

test("attachShelfPointerInteractionWiring lets side pinned shift wheel force scroll before visibility threshold", () => {
	const target = new FakePointerTarget();
	const scrolled: number[] = [];
	const cleanup = attachShelfPointerInteractionWiring({
		target,
		shelfManager: makeShelfManagerMock({
			getMode: () => "side",
			getSnapshot: () => ({
				...closedSnapshot(),
				mode: "side" as const,
				shelfVisibility: 0.02,
				pinnedOpen: true,
			}),
			setSelectedIdx: () => {},
			clearSelected: () => {},
			getCenterIdx: () => 0,
			scrollBy: (delta) => scrolled.push(delta),
			openDetail: () => {},
			getShelfPinnedOpen: () => true,
			setShelfPinnedOpen: () => {},
		}),
		cinema: { setFocusZone: () => {} },
		getHit: () => null,
		getSplashActive: () => false,
		getPortrait: () => false,
		getWallpaperSafe: () => false,
		getViewportWidth: () => 1200,
		getViewportHeight: () => 900,
		getShelfPresence: () => "auto",
	});

	const event = makeWheelEvent({ deltaY: -120, shiftKey: true });
	target.emit("wheel", event);
	cleanup();

	expect(scrolled).toEqual([-1]);
	expect(event.calls).toEqual(["preventDefault", "stopImmediatePropagation"]);
});

test("attachShelfPointerInteractionWiring lets side always shift wheel force scroll even when shelf visibility is low", () => {
	const target = new FakePointerTarget();
	const scrolled: number[] = [];
	const cleanup = attachShelfPointerInteractionWiring({
		target,
		shelfManager: makeShelfManagerMock({
			getMode: () => "side",
			getSnapshot: () => ({
				...closedSnapshot(),
				mode: "side" as const,
				shelfVisibility: 0.02,
			}),
			setSelectedIdx: () => {},
			clearSelected: () => {},
			getCenterIdx: () => 0,
			scrollBy: (delta) => scrolled.push(delta),
			openDetail: () => {},
		}),
		cinema: { setFocusZone: () => {} },
		getHit: () => null,
		getSplashActive: () => false,
		getPortrait: () => false,
		getWallpaperSafe: () => false,
		getViewportWidth: () => 1200,
		getViewportHeight: () => 900,
		getShelfPresence: () => "always",
	});

	const forced = makeWheelEvent({ deltaY: -120, shiftKey: true });
	target.emit("wheel", forced);
	cleanup();

	expect(scrolled).toEqual([-1]);
	expect(forced.calls).toEqual(["preventDefault", "stopImmediatePropagation"]);
});

test("attachShelfPointerInteractionWiring does not scroll side auto wheel without current preview state", () => {
	const target = new FakePointerTarget();
	const scrolled: number[] = [];
	const cleanup = attachShelfPointerInteractionWiring({
		target,
		shelfManager: makeShelfManagerMock({
			getMode: () => "side",
			getSnapshot: () => ({
				...closedSnapshot(),
				mode: "side" as const,
				shelfVisibility: 0.9,
			}),
			setSelectedIdx: () => {},
			clearSelected: () => {},
			getCenterIdx: () => 0,
			scrollBy: (delta) => scrolled.push(delta),
			openDetail: () => {},
		}),
		cinema: { setFocusZone: () => {} },
		getHit: () => makeHit(2),
		getSplashActive: () => false,
		getPortrait: () => false,
		getWallpaperSafe: () => false,
		getViewportWidth: () => 1200,
		getViewportHeight: () => 900,
		getShelfPresence: () => "auto",
	});

	const normal = makeWheelEvent({ deltaY: 120 });
	const forced = makeWheelEvent({ deltaY: 120, shiftKey: true });
	target.emit("wheel", normal);
	target.emit("wheel", forced);
	cleanup();

	expect(scrolled).toEqual([]);
	expect(normal.calls).toEqual([]);
	expect(forced.calls).toEqual([]);
});

test("attachShelfPointerInteractionWiring lets side auto preview scroll wheel inside baseline wheel zone without card hit", () => {
	const target = new FakePointerTarget();
	const scrolled: number[] = [];
	const cleanup = attachShelfPointerInteractionWiring({
		target,
		shelfManager: makeShelfManagerMock({
			getMode: () => "side",
			getSnapshot: () => ({
				...closedSnapshot(),
				mode: "side" as const,
				shelfVisibility: 0.02,
			}),
			setSelectedIdx: () => {},
			clearSelected: () => {},
			getCenterIdx: () => 0,
			scrollBy: (delta) => scrolled.push(delta),
			openDetail: () => {},
		}),
		cinema: { setFocusZone: () => {} },
		getHit: () => null,
		getSplashActive: () => false,
		getPortrait: () => false,
		getWallpaperSafe: () => false,
		getViewportWidth: () => 1200,
		getViewportHeight: () => 900,
		getShelfPresence: () => "auto",
		getShelfPreviewActive: () => true,
	});

	const event = makeWheelEvent({ deltaY: 120, clientX: 1100, clientY: 300 });
	target.emit("wheel", event);
	cleanup();

	expect(scrolled).toEqual([1]);
	expect(event.calls).toEqual(["preventDefault", "stopImmediatePropagation"]);
});

test("attachShelfPointerInteractionWiring ignores side auto preview wheel outside baseline wheel zone without card hit", () => {
	const target = new FakePointerTarget();
	const scrolled: number[] = [];
	const cleanup = attachShelfPointerInteractionWiring({
		target,
		shelfManager: makeShelfManagerMock({
			getMode: () => "side",
			getSnapshot: () => ({
				...closedSnapshot(),
				mode: "side" as const,
				shelfVisibility: 0.02,
			}),
			setSelectedIdx: () => {},
			clearSelected: () => {},
			getCenterIdx: () => 0,
			scrollBy: (delta) => scrolled.push(delta),
			openDetail: () => {},
		}),
		cinema: { setFocusZone: () => {} },
		getHit: () => null,
		getSplashActive: () => false,
		getPortrait: () => false,
		getWallpaperSafe: () => false,
		getViewportWidth: () => 1200,
		getViewportHeight: () => 900,
		getShelfPresence: () => "auto",
		getShelfPreviewActive: () => true,
	});

	const event = makeWheelEvent({ deltaY: 120, clientX: 900, clientY: 300 });
	target.emit("wheel", event);
	cleanup();

	expect(scrolled).toEqual([]);
	expect(event.calls).toEqual([]);
});

test("attachShelfPointerInteractionWiring lets side auto preview shift wheel force scroll outside wheel zone", () => {
	const target = new FakePointerTarget();
	const scrolled: number[] = [];
	const cleanup = attachShelfPointerInteractionWiring({
		target,
		shelfManager: makeShelfManagerMock({
			getMode: () => "side",
			getSnapshot: () => ({
				...closedSnapshot(),
				mode: "side" as const,
				shelfVisibility: 0.02,
			}),
			setSelectedIdx: () => {},
			clearSelected: () => {},
			getCenterIdx: () => 0,
			scrollBy: (delta) => scrolled.push(delta),
			openDetail: () => {},
		}),
		cinema: { setFocusZone: () => {} },
		getHit: () => null,
		getSplashActive: () => false,
		getPortrait: () => false,
		getWallpaperSafe: () => false,
		getViewportWidth: () => 1200,
		getViewportHeight: () => 900,
		getShelfPresence: () => "auto",
		getShelfPreviewActive: () => true,
	});

	const event = makeWheelEvent({ deltaY: -120, shiftKey: true, clientX: 900, clientY: 300 });
	target.emit("wheel", event);
	cleanup();

	expect(scrolled).toEqual([-1]);
	expect(event.calls).toEqual(["preventDefault", "stopImmediatePropagation"]);
});

test("attachShelfPointerInteractionWiring lets side auto preview card-hit wheel scroll before visibility threshold without screen pad", () => {
	const target = new FakePointerTarget();
	const pads: Array<number | undefined> = [];
	const scrolled: number[] = [];
	const cleanup = attachShelfPointerInteractionWiring({
		target,
		shelfManager: makeShelfManagerMock({
			getMode: () => "side",
			getSnapshot: () => ({
				...closedSnapshot(),
				mode: "side" as const,
				shelfVisibility: 0.02,
			}),
			setSelectedIdx: () => {},
			clearSelected: () => {},
			getCenterIdx: () => 0,
			scrollBy: (delta) => scrolled.push(delta),
			openDetail: () => {},
		}),
		cinema: { setFocusZone: () => {} },
		getHit: (pointer) => {
			pads.push(pointer.screenPad);
			return makeHit(2);
		},
		getSplashActive: () => false,
		getPortrait: () => false,
		getWallpaperSafe: () => false,
		getViewportWidth: () => 1200,
		getViewportHeight: () => 900,
		getShelfPresence: () => "auto",
		getShelfPreviewActive: () => true,
	});

	const event = makeWheelEvent({ deltaY: 120, clientX: 900, clientY: 300 });
	target.emit("wheel", event);
	cleanup();

	expect(pads).toEqual([undefined]);
	expect(scrolled).toEqual([1]);
	expect(event.calls).toEqual(["preventDefault", "stopImmediatePropagation"]);
});

test("attachShelfPointerInteractionWiring does not use preview wheel zone for side always normal wheel without card hit", () => {
	const target = new FakePointerTarget();
	const scrolled: number[] = [];
	const cleanup = attachShelfPointerInteractionWiring({
		target,
		shelfManager: makeShelfManagerMock({
			getMode: () => "side",
			getSnapshot: () => ({
				...closedSnapshot(),
				mode: "side" as const,
				shelfVisibility: 0.9,
			}),
			setSelectedIdx: () => {},
			clearSelected: () => {},
			getCenterIdx: () => 0,
			scrollBy: (delta) => scrolled.push(delta),
			openDetail: () => {},
		}),
		cinema: { setFocusZone: () => {} },
		getHit: () => null,
		getSplashActive: () => false,
		getPortrait: () => false,
		getWallpaperSafe: () => false,
		getViewportWidth: () => 1200,
		getViewportHeight: () => 900,
		getShelfPresence: () => "always",
		getShelfPreviewActive: () => true,
	});

	const event = makeWheelEvent({ deltaY: 120, clientX: 1100, clientY: 300 });
	target.emit("wheel", event);
	cleanup();

	expect(scrolled).toEqual([]);
	expect(event.calls).toEqual([]);
});

test("attachShelfPointerInteractionWiring lets side pinned normal wheel scroll inside baseline wheel zone without card hit", () => {
	const target = new FakePointerTarget();
	const scrolled: number[] = [];
	const cleanup = attachShelfPointerInteractionWiring({
		target,
		shelfManager: makeShelfManagerMock({
			getMode: () => "side",
			getSnapshot: () => ({
				...closedSnapshot(),
				mode: "side" as const,
				shelfVisibility: 0.02,
				pinnedOpen: true,
			}),
			setSelectedIdx: () => {},
			clearSelected: () => {},
			getCenterIdx: () => 0,
			scrollBy: (delta) => scrolled.push(delta),
			openDetail: () => {},
			getShelfPinnedOpen: () => true,
			setShelfPinnedOpen: () => {},
		}),
		cinema: { setFocusZone: () => {} },
		getHit: () => null,
		getSplashActive: () => false,
		getPortrait: () => false,
		getWallpaperSafe: () => false,
		getViewportWidth: () => 1200,
		getViewportHeight: () => 900,
		getShelfPresence: () => "auto",
		getShelfPreviewActive: () => true,
	});

	const event = makeWheelEvent({ deltaY: 120, clientX: 1100, clientY: 300 });
	target.emit("wheel", event);
	cleanup();

	expect(scrolled).toEqual([1]);
	expect(event.calls).toEqual(["preventDefault", "stopImmediatePropagation"]);
});

test("attachShelfPointerInteractionWiring ignores side pinned normal wheel outside baseline wheel zone without card hit", () => {
	const target = new FakePointerTarget();
	const scrolled: number[] = [];
	const cleanup = attachShelfPointerInteractionWiring({
		target,
		shelfManager: makeShelfManagerMock({
			getMode: () => "side",
			getSnapshot: () => ({
				...closedSnapshot(),
				mode: "side" as const,
				shelfVisibility: 0.02,
				pinnedOpen: true,
			}),
			setSelectedIdx: () => {},
			clearSelected: () => {},
			getCenterIdx: () => 0,
			scrollBy: (delta) => scrolled.push(delta),
			openDetail: () => {},
			getShelfPinnedOpen: () => true,
			setShelfPinnedOpen: () => {},
		}),
		cinema: { setFocusZone: () => {} },
		getHit: () => null,
		getSplashActive: () => false,
		getPortrait: () => false,
		getWallpaperSafe: () => false,
		getViewportWidth: () => 1200,
		getViewportHeight: () => 900,
		getShelfPresence: () => "auto",
		getShelfPreviewActive: () => true,
	});

	const event = makeWheelEvent({ deltaY: 120, clientX: 900, clientY: 300 });
	target.emit("wheel", event);
	cleanup();

	expect(scrolled).toEqual([]);
	expect(event.calls).toEqual([]);
});

test("attachShelfPointerInteractionWiring applies portrait side pinned wheel-zone geometry", () => {
	const target = new FakePointerTarget();
	const scrolled: number[] = [];
	const cleanup = attachShelfPointerInteractionWiring({
		target,
		shelfManager: makeShelfManagerMock({
			getMode: () => "side",
			getSnapshot: () => ({
				...closedSnapshot(),
				mode: "side" as const,
				shelfVisibility: 0.02,
				pinnedOpen: true,
			}),
			setSelectedIdx: () => {},
			clearSelected: () => {},
			getCenterIdx: () => 0,
			scrollBy: (delta) => scrolled.push(delta),
			openDetail: () => {},
			getShelfPinnedOpen: () => true,
			setShelfPinnedOpen: () => {},
		}),
		cinema: { setFocusZone: () => {} },
		getHit: () => null,
		getSplashActive: () => false,
		getPortrait: () => true,
		getWallpaperSafe: () => false,
		getViewportWidth: () => 600,
		getViewportHeight: () => 900,
		getShelfPresence: () => "auto",
		getShelfPreviewActive: () => true,
	});

	const inside = makeWheelEvent({ deltaY: 120, clientX: 500, clientY: 300 });
	const outsideY = makeWheelEvent({ deltaY: 120, clientX: 500, clientY: 800 });
	target.emit("wheel", inside);
	target.emit("wheel", outsideY);
	cleanup();

	expect(scrolled).toEqual([1]);
	expect(inside.calls).toEqual(["preventDefault", "stopImmediatePropagation"]);
	expect(outsideY.calls).toEqual([]);
});

test("attachShelfPointerInteractionWiring applies portrait side auto preview wheel-zone geometry", () => {
	const target = new FakePointerTarget();
	const scrolled: number[] = [];
	const cleanup = attachShelfPointerInteractionWiring({
		target,
		shelfManager: makeShelfManagerMock({
			getMode: () => "side",
			getSnapshot: () => ({
				...closedSnapshot(),
				mode: "side" as const,
				shelfVisibility: 0.02,
			}),
			setSelectedIdx: () => {},
			clearSelected: () => {},
			getCenterIdx: () => 0,
			scrollBy: (delta) => scrolled.push(delta),
			openDetail: () => {},
		}),
		cinema: { setFocusZone: () => {} },
		getHit: () => null,
		getSplashActive: () => false,
		getPortrait: () => true,
		getWallpaperSafe: () => false,
		getViewportWidth: () => 600,
		getViewportHeight: () => 900,
		getShelfPresence: () => "auto",
		getShelfPreviewActive: () => true,
	});

	const inside = makeWheelEvent({ deltaY: 120, clientX: 500, clientY: 300 });
	const outsideY = makeWheelEvent({ deltaY: 120, clientX: 500, clientY: 800 });
	target.emit("wheel", inside);
	target.emit("wheel", outsideY);
	cleanup();

	expect(scrolled).toEqual([1]);
	expect(inside.calls).toEqual(["preventDefault", "stopImmediatePropagation"]);
	expect(outsideY.calls).toEqual([]);
});

test("attachShelfPointerInteractionWiring scrolls open detail content-list wheel target without first-level shelf scroll", () => {
	const target = new FakePointerTarget();
	const shelfScrolled: number[] = [];
	const contentScrolled: number[] = [];
	const cleanup = attachShelfPointerInteractionWiring({
		target,
		shelfManager: makeShelfManagerMock({
			getMode: () => "stage",
			getSnapshot: () => ({
				...closedSnapshot(),
				openCardIdx: 2,
			}),
			setSelectedIdx: () => {},
			clearSelected: () => {},
			getCenterIdx: () => 0,
			scrollBy: (delta) => shelfScrolled.push(delta),
			openDetail: () => {},
			hasOpenContent: () => true,
			getContentList: () => ({
				scrollBy: (delta: number) => contentScrolled.push(delta),
			}) as never,
		}),
		cinema: { setFocusZone: () => {} },
		getHit: () => makeHit(2),
		getSplashActive: () => false,
		getPortrait: () => false,
		getWallpaperSafe: () => false,
		getViewportWidth: () => 1200,
		getViewportHeight: () => 900,
		isDetailWheelTarget: () => true,
	});

	const down = makeWheelEvent({ deltaY: 120 });
	const up = makeWheelEvent({ deltaY: -80 });
	target.emit("wheel", down);
	target.emit("wheel", up);
	cleanup();

	expect(contentScrolled).toEqual([1, -1]);
	expect(shelfScrolled).toEqual([]);
	expect(down.calls).toEqual(["preventDefault", "stopImmediatePropagation"]);
	expect(up.calls).toEqual(["preventDefault", "stopImmediatePropagation"]);
});

test("attachShelfPointerInteractionWiring ignores open detail wheel target miss without first-level shelf scroll", () => {
	const target = new FakePointerTarget();
	const shelfScrolled: number[] = [];
	const contentScrolled: number[] = [];
	const cleanup = attachShelfPointerInteractionWiring({
		target,
		shelfManager: makeShelfManagerMock({
			getMode: () => "stage",
			getSnapshot: () => ({
				...closedSnapshot(),
				openCardIdx: 2,
			}),
			setSelectedIdx: () => {},
			clearSelected: () => {},
			getCenterIdx: () => 0,
			scrollBy: (delta) => shelfScrolled.push(delta),
			openDetail: () => {},
			hasOpenContent: () => true,
			getContentList: () => ({
				scrollBy: (delta: number) => contentScrolled.push(delta),
			}) as never,
		}),
		cinema: { setFocusZone: () => {} },
		getHit: () => makeHit(2),
		getSplashActive: () => false,
		getPortrait: () => false,
		getWallpaperSafe: () => false,
		getViewportWidth: () => 1200,
		getViewportHeight: () => 900,
		isDetailWheelTarget: () => false,
	});

	const event = makeWheelEvent({ deltaY: 120 });
	target.emit("wheel", event);
	cleanup();

	expect(contentScrolled).toEqual([]);
	expect(shelfScrolled).toEqual([]);
	expect(event.calls).toEqual([]);
});

test("attachShelfPointerInteractionWiring ignores open detail wheel when no detail target predicate is provided", () => {
	const target = new FakePointerTarget();
	const shelfScrolled: number[] = [];
	const contentScrolled: number[] = [];
	const cleanup = attachShelfPointerInteractionWiring({
		target,
		shelfManager: makeShelfManagerMock({
			getMode: () => "stage",
			getSnapshot: () => ({
				...closedSnapshot(),
				openCardIdx: 2,
			}),
			setSelectedIdx: () => {},
			clearSelected: () => {},
			getCenterIdx: () => 0,
			scrollBy: (delta) => shelfScrolled.push(delta),
			openDetail: () => {},
			hasOpenContent: () => true,
			getContentList: () => ({
				scrollBy: (delta: number) => contentScrolled.push(delta),
			}) as never,
		}),
		cinema: { setFocusZone: () => {} },
		getHit: () => makeHit(2),
		getSplashActive: () => false,
		getPortrait: () => false,
		getWallpaperSafe: () => false,
		getViewportWidth: () => 1200,
		getViewportHeight: () => 900,
	});

	const event = makeWheelEvent({ deltaY: 120 });
	target.emit("wheel", event);
	cleanup();

	expect(contentScrolled).toEqual([]);
	expect(shelfScrolled).toEqual([]);
	expect(event.calls).toEqual([]);
});

test("attachShelfPointerInteractionWiring keeps UI splash and off gates ahead of detail wheel targets", () => {
	const target = new FakePointerTarget();
	const shelfScrolled: number[] = [];
	const contentScrolled: number[] = [];
	const button = {
		matches: (selector: string) => selector.split(",").includes("button"),
		closest: (selector: string) => selector.split(",").includes("button") ? button : null,
	};
	let splashActive = false;
	let mode: "stage" | "off" = "stage";
	const cleanup = attachShelfPointerInteractionWiring({
		target,
		shelfManager: makeShelfManagerMock({
			getMode: () => mode,
			getSnapshot: () => ({
				...closedSnapshot(),
				mode,
				openCardIdx: 2,
			}),
			setSelectedIdx: () => {},
			clearSelected: () => {},
			getCenterIdx: () => 0,
			scrollBy: (delta) => shelfScrolled.push(delta),
			openDetail: () => {},
			hasOpenContent: () => true,
			getContentList: () => ({
				scrollBy: (delta: number) => contentScrolled.push(delta),
			}) as never,
		}),
		cinema: { setFocusZone: () => {} },
		getHit: () => makeHit(2),
		getSplashActive: () => splashActive,
		getPortrait: () => false,
		getWallpaperSafe: () => false,
		getViewportWidth: () => 1200,
		getViewportHeight: () => 900,
		isDetailWheelTarget: () => true,
	});

	const ui = makeWheelEvent({ deltaY: 120, target: button });
	target.emit("wheel", ui);
	splashActive = true;
	const splash = makeWheelEvent({ deltaY: 120 });
	target.emit("wheel", splash);
	splashActive = false;
	mode = "off";
	const off = makeWheelEvent({ deltaY: 120 });
	target.emit("wheel", off);
	cleanup();

	expect(contentScrolled).toEqual([]);
	expect(shelfScrolled).toEqual([]);
	expect(ui.calls).toEqual([]);
	expect(splash.calls).toEqual([]);
	expect(off.calls).toEqual([]);
});

test("attachShelfPointerInteractionWiring contextmenu toggles side pinned state and focus", () => {
	const target = new FakePointerTarget();
	const pinnedCalls: boolean[] = [];
	const focus: unknown[] = [];
	let pinnedOpen = false;
	const cleanup = attachShelfPointerInteractionWiring({
		target,
		shelfManager: makeShelfManagerMock({
			getMode: () => "side",
			getSnapshot: () => ({
				...closedSnapshot(),
				mode: "side" as const,
				pinnedOpen,
			}),
			setSelectedIdx: () => {},
			clearSelected: () => {},
			getCenterIdx: () => 0,
			scrollBy: () => {},
			openDetail: () => {},
			getShelfPinnedOpen: () => pinnedOpen,
			setShelfPinnedOpen: (open) => {
				pinnedOpen = open;
				pinnedCalls.push(open);
			},
		}),
		cinema: { setFocusZone: (type, opts) => focus.push([type, opts]) },
		getHit: () => null,
		getSplashActive: () => false,
		getPortrait: () => true,
		getWallpaperSafe: () => false,
		getViewportWidth: () => 1200,
		getViewportHeight: () => 900,
	});

	const open = makeContextMenuEvent({});
	target.emit("contextmenu", open);
	const close = makeContextMenuEvent({});
	target.emit("contextmenu", close);
	cleanup();

	expect(open.calls).toEqual(["preventDefault", "stopPropagation"]);
	expect(close.calls).toEqual(["preventDefault", "stopPropagation"]);
	expect(pinnedCalls).toEqual([true, false]);
	expect(focus).toEqual([
		["shelf-side", { immediate: true, portrait: true, wallpaperSafe: false }],
		[null, { immediate: true, portrait: true, wallpaperSafe: false }],
	]);
});

test("attachShelfPointerInteractionWiring contextmenu promotes off mode to side, pins open, and focuses side", () => {
	const target = new FakePointerTarget();
	const pinnedCalls: boolean[] = [];
	const modeCalls: string[] = [];
	const focus: unknown[] = [];
	let mode: "side" | "off" = "off";
	let pinnedOpen = false;
	const cleanup = attachShelfPointerInteractionWiring({
		target,
		shelfManager: makeShelfManagerMock({
			getMode: () => mode,
			getSnapshot: () => ({
				...closedSnapshot(),
				mode,
				pinnedOpen,
			}),
			setSelectedIdx: () => {},
			clearSelected: () => {},
			getCenterIdx: () => 0,
			scrollBy: () => {},
			openDetail: () => {},
			getShelfPinnedOpen: () => pinnedOpen,
			setShelfPinnedOpen: (open) => {
				pinnedOpen = open;
				pinnedCalls.push(open);
			},
		}),
		cinema: { setFocusZone: (type, opts) => focus.push([type, opts]) },
		getHit: () => null,
		getSplashActive: () => false,
		getPortrait: () => true,
		getWallpaperSafe: () => false,
		getViewportWidth: () => 1200,
		getViewportHeight: () => 900,
		setShelfMode: (nextMode) => {
			mode = nextMode;
			modeCalls.push(nextMode);
		},
	});

	const off = makeContextMenuEvent({});
	target.emit("contextmenu", off);
	cleanup();

	expect(off.calls).toEqual(["preventDefault", "stopPropagation"]);
	expect(modeCalls).toEqual(["side"]);
	expect(pinnedCalls).toEqual([true]);
	expect(focus).toEqual([
		["shelf-side", { immediate: true, portrait: true, wallpaperSafe: false }],
	]);
});

test("attachShelfPointerInteractionWiring contextmenu ignores UI splash and stage mode", () => {
	const target = new FakePointerTarget();
	const pinnedCalls: boolean[] = [];
	const modeCalls: string[] = [];
	const button = {
		matches: (selector: string) => selector.split(",").includes("button"),
		closest: (selector: string) => selector.split(",").includes("button") ? button : null,
	};
	let splashActive = false;
	let mode: "side" | "stage" = "side";
	const cleanup = attachShelfPointerInteractionWiring({
		target,
		shelfManager: makeShelfManagerMock({
			getMode: () => mode,
			getSnapshot: () => ({
				...closedSnapshot(),
				mode,
			}),
			setSelectedIdx: () => {},
			clearSelected: () => {},
			getCenterIdx: () => 0,
			scrollBy: () => {},
			openDetail: () => {},
			getShelfPinnedOpen: () => false,
			setShelfPinnedOpen: (open) => pinnedCalls.push(open),
		}),
		cinema: { setFocusZone: () => {} },
		getHit: () => null,
		getSplashActive: () => splashActive,
		getPortrait: () => false,
		getWallpaperSafe: () => false,
		getViewportWidth: () => 1200,
		getViewportHeight: () => 900,
		setShelfMode: (nextMode) => modeCalls.push(nextMode),
	});

	const ui = makeContextMenuEvent({ target: button });
	target.emit("contextmenu", ui);
	splashActive = true;
	const splash = makeContextMenuEvent({});
	target.emit("contextmenu", splash);
	splashActive = false;
	mode = "stage";
	const stage = makeContextMenuEvent({});
	target.emit("contextmenu", stage);
	cleanup();

	expect(pinnedCalls).toEqual([]);
	expect(modeCalls).toEqual([]);
	expect(ui.calls).toEqual([]);
	expect(splash.calls).toEqual([]);
	expect(stage.calls).toEqual([]);
});

test("attachShelfPointerInteractionWiring contextmenu closes open detail, pins side shelf, and focuses side", () => {
	const target = new FakePointerTarget();
	const pinnedCalls: boolean[] = [];
	const closed: unknown[] = [];
	const focus: unknown[] = [];
	let openCardIdx = 2;
	const cleanup = attachShelfPointerInteractionWiring({
		target,
		shelfManager: makeShelfManagerMock({
			getMode: () => "side",
			getSnapshot: () => ({
				...closedSnapshot(),
				mode: "side" as const,
				openCardIdx,
			}),
			setSelectedIdx: () => {},
			clearSelected: () => {},
			getCenterIdx: () => 0,
			scrollBy: () => {},
			openDetail: () => {},
			closeDetail: (opts) => {
				openCardIdx = -1;
				closed.push(opts);
			},
			getShelfPinnedOpen: () => false,
			setShelfPinnedOpen: (open) => pinnedCalls.push(open),
		}),
		cinema: { setFocusZone: (type, opts) => focus.push([type, opts]) },
		getHit: () => null,
		getSplashActive: () => false,
		getPortrait: () => false,
		getWallpaperSafe: () => true,
		getViewportWidth: () => 1200,
		getViewportHeight: () => 900,
	});

	const event = makeContextMenuEvent({});
	target.emit("contextmenu", event);
	cleanup();

	expect(event.calls).toEqual(["preventDefault", "stopPropagation"]);
	expect(closed).toEqual([{ immediate: true }]);
	expect(pinnedCalls).toEqual([true]);
	expect(focus).toEqual([
		["shelf-side", { immediate: true, portrait: false, wallpaperSafe: true }],
	]);
});

test("attachShelfPointerInteractionWiring ignores first-level wheel over UI, splash, and mode off", () => {
	const target = new FakePointerTarget();
	const scrolled: number[] = [];
	const button = {
		matches: (selector: string) => selector.split(",").includes("button"),
		closest: (selector: string) => selector.split(",").includes("button") ? button : null,
	};
	let splashActive = false;
	let mode: "stage" | "off" = "stage";
	const cleanup = attachShelfPointerInteractionWiring({
		target,
		shelfManager: makeShelfManagerMock({
			getMode: () => mode,
			getSnapshot: () => ({
				...closedSnapshot(),
				mode,
			}),
			setSelectedIdx: () => {},
			clearSelected: () => {},
			getCenterIdx: () => 0,
			scrollBy: (delta) => scrolled.push(delta),
			openDetail: () => {},
		}),
		cinema: { setFocusZone: () => {} },
		getHit: () => makeHit(2),
		getSplashActive: () => splashActive,
		getPortrait: () => false,
		getWallpaperSafe: () => false,
		getViewportWidth: () => 1200,
		getViewportHeight: () => 900,
	});

	const ui = makeWheelEvent({ deltaY: 120, target: button });
	target.emit("wheel", ui);
	splashActive = true;
	const splash = makeWheelEvent({ deltaY: 120 });
	target.emit("wheel", splash);
	splashActive = false;
	mode = "off";
	const off = makeWheelEvent({ deltaY: 120 });
	target.emit("wheel", off);
	cleanup();

	expect(scrolled).toEqual([]);
	expect(ui.calls).toEqual([]);
	expect(splash.calls).toEqual([]);
	expect(off.calls).toEqual([]);
});

test("attachShelfPointerInteractionWiring cleanup removes wheel and contextmenu listeners", () => {
	const target = new FakePointerTarget();
	const scrolled: number[] = [];
	const pinnedCalls: boolean[] = [];
	const cleanup = attachShelfPointerInteractionWiring({
		target,
		shelfManager: makeShelfManagerMock({
			getMode: () => "stage",
			getSnapshot: closedSnapshot,
			setSelectedIdx: () => {},
			clearSelected: () => {},
			getCenterIdx: () => 0,
			scrollBy: (delta) => scrolled.push(delta),
			openDetail: () => {},
			getShelfPinnedOpen: () => false,
			setShelfPinnedOpen: (open) => pinnedCalls.push(open),
			closeDetail: () => {},
		}),
		cinema: { setFocusZone: () => {} },
		getHit: () => makeHit(2),
		getSplashActive: () => false,
		getPortrait: () => false,
		getWallpaperSafe: () => false,
		getViewportWidth: () => 1200,
		getViewportHeight: () => 900,
	});

	cleanup();
	target.emit("wheel", makeWheelEvent({ deltaY: 120 }));
	target.emit("contextmenu", makeContextMenuEvent({}));
	target.emit("pointerleave", { clientX: 1100, clientY: 300, target: null });

	expect(target.listeners.get("wheel")?.size ?? 0).toBe(0);
	expect(target.listeners.get("contextmenu")?.size ?? 0).toBe(0);
	expect(target.listeners.get("pointerleave")?.size ?? 0).toBe(0);
	expect(scrolled).toEqual([]);
	expect(pinnedCalls).toEqual([]);
});
