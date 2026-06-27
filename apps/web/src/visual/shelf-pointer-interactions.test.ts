import { expect, test } from "bun:test";
import type { ShelfRaycastCardHit } from "@mineradio/visual-engine";
import {
	attachShelfPointerInteractionWiring,
	isShelfInteractionUiTarget,
} from "./shelf-pointer-interactions";

function closedSnapshot() {
	return {
		centerIdx: 0,
		centerSmooth: 0,
		mode: "stage" as const,
		shelfPane: "mine" as const,
		shelfVisibility: 1,
		openCardIdx: -1,
		breathPulse: 0,
	};
}

class FakePointerTarget {
	listeners = new Map<string, Set<(event: unknown) => void>>();

	addEventListener(type: string, listener: EventListener): void {
		const set = this.listeners.get(type) ?? new Set<(event: unknown) => void>();
		set.add(listener as unknown as (event: unknown) => void);
		this.listeners.set(type, set);
	}

	removeEventListener(type: string, listener: EventListener): void {
		this.listeners.get(type)?.delete(listener as unknown as (event: unknown) => void);
	}

	emit(type: string, event: unknown): void {
		for (const listener of this.listeners.get(type) ?? []) listener(event);
	}
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
		shelfManager: {
			getMode: () => "stage",
			getSnapshot: closedSnapshot,
			setSelectedIdx: (idx) => selected.push(idx),
			clearSelected: () => selected.push(-1),
			getCenterIdx: () => 0,
			scrollBy: () => {},
			openDetail: () => {},
		},
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
		shelfManager: {
			getMode: () => "stage",
			getSnapshot: closedSnapshot,
			setSelectedIdx: (idx) => selected.push(idx),
			clearSelected: () => selected.push(-1),
			getCenterIdx: () => 1,
			scrollBy: () => {},
			openDetail: () => {},
		},
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
		shelfManager: {
			getMode: () => "stage",
			getSnapshot: closedSnapshot,
			setSelectedIdx: (idx) => selected.push(idx),
			clearSelected: () => selected.push(-1),
			getCenterIdx: () => 1,
			scrollBy: () => {},
			openDetail: () => {},
		},
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
		shelfManager: {
			getMode: () => "stage",
			getSnapshot: closedSnapshot,
			setSelectedIdx: () => {},
			clearSelected: () => {},
			getCenterIdx: () => 1,
			scrollBy: () => {},
			openDetail: () => {},
		},
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
		shelfManager: {
			getMode: () => "stage",
			getSnapshot: closedSnapshot,
			setSelectedIdx: () => {},
			clearSelected: () => {},
			getCenterIdx: () => 1,
			scrollBy: () => {},
			openDetail: () => {},
		},
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
		shelfManager: {
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
		},
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

test("attachShelfPointerInteractionWiring passes baseline always-visible side-mode 18px screen pad to hover and click hit lookup", () => {
	const target = new FakePointerTarget();
	const pads: Array<number | undefined> = [];
	const cleanup = attachShelfPointerInteractionWiring({
		target,
		shelfManager: {
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
		},
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
		shelfManager: {
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
		},
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

test("attachShelfPointerInteractionWiring leaves default stage screen pad undefined", () => {
	const target = new FakePointerTarget();
	const pads: Array<number | undefined> = [];
	const cleanup = attachShelfPointerInteractionWiring({
		target,
		shelfManager: {
			getMode: () => "stage",
			getSnapshot: closedSnapshot,
			setSelectedIdx: () => {},
			clearSelected: () => {},
			getCenterIdx: () => 1,
			scrollBy: () => {},
			openDetail: () => {},
		},
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
		shelfManager: {
			getMode: () => "stage",
			getSnapshot: closedSnapshot,
			setSelectedIdx: () => {},
			clearSelected: () => {},
			getCenterIdx: () => centerIdx,
			scrollBy: (delta) => scrolled.push(delta),
			openDetail: (idx) => {
				centerIdx = idx;
			},
		},
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
