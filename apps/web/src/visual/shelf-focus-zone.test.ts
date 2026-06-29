import { expect, test } from "bun:test";
import {
	attachShelfFocusZonePointerWiring,
	createSecondaryPlaylistEdgeGuard,
	isWallpaperSafeShelfPreset,
	isQueueFocusActive,
	resolveShelfFocusZone,
} from "./shelf-focus-zone";

const baseInput = {
	pointerY: 500,
	viewportHeight: 900,
	queueFocusActive: false,
	shelfHasOpenContent: false,
	shelfCanFocus: true,
	sideShelfFocusHit: false,
	shelfMode: "stage" as const,
	splashActive: false,
	shelfCameraMode: "dynamic" as const,
	portrait: false,
	wallpaperSafe: false,
};

test("isWallpaperSafeShelfPreset follows baseline preset 5 semantics", () => {
	expect(isWallpaperSafeShelfPreset(5)).toBe(true);
	expect(isWallpaperSafeShelfPreset("5")).toBe(true);
	expect(isWallpaperSafeShelfPreset(4)).toBe(false);
	expect(isWallpaperSafeShelfPreset(true)).toBe(false);
	expect(isWallpaperSafeShelfPreset(undefined)).toBe(false);
});

test("resolveShelfFocusZone returns null while splash is active", () => {
	expect(resolveShelfFocusZone({ ...baseInput, splashActive: true })).toEqual({
		type: null,
		immediate: false,
		portrait: false,
		wallpaperSafe: false,
	});
});

test("resolveShelfFocusZone gives queue focus priority and applies immediately", () => {
	expect(resolveShelfFocusZone({
		...baseInput,
		queueFocusActive: true,
		shelfHasOpenContent: true,
		sideShelfFocusHit: true,
	})).toEqual({
		type: "queue",
		immediate: true,
		portrait: false,
		wallpaperSafe: false,
	});
});

test("resolveShelfFocusZone keeps queue focus active when shelf camera mode is static", () => {
	expect(resolveShelfFocusZone({
		...baseInput,
		queueFocusActive: true,
		shelfCameraMode: "static",
	}).type).toBe("queue");
});

test("resolveShelfFocusZone clears shelf focus while shelf camera mode is static", () => {
	const shelfInputs = [
		{ shelfHasOpenContent: true },
		{ sideShelfFocusHit: true },
		{ shelfMode: "stage" as const, pointerY: 700 },
	];

	for (const overrides of shelfInputs) {
		expect(resolveShelfFocusZone({
			...baseInput,
			...overrides,
			shelfCameraMode: "static",
		}).type).toBeNull();
	}
});

test("resolveShelfFocusZone resolves shelf detail before side and stage focus", () => {
	expect(resolveShelfFocusZone({
		...baseInput,
		shelfHasOpenContent: true,
		sideShelfFocusHit: true,
		pointerY: 800,
	}).type).toBe("shelf-detail");
});

test("resolveShelfFocusZone resolves shelf side before stage focus", () => {
	expect(resolveShelfFocusZone({
		...baseInput,
		sideShelfFocusHit: true,
		pointerY: 800,
	}).type).toBe("shelf-side");
});

test("resolveShelfFocusZone resolves shelf stage only below the baseline threshold", () => {
	expect(resolveShelfFocusZone({
		...baseInput,
		pointerY: 495,
		viewportHeight: 900,
	}).type).toBeNull();
	expect(resolveShelfFocusZone({
		...baseInput,
		pointerY: 496,
		viewportHeight: 900,
	}).type).toBe("shelf-stage");
});

test("resolveShelfFocusZone returns null when shelf cannot focus or mode is off", () => {
	expect(resolveShelfFocusZone({
		...baseInput,
		pointerY: 800,
		shelfCanFocus: false,
	}).type).toBeNull();
	expect(resolveShelfFocusZone({
		...baseInput,
		pointerY: 800,
		shelfMode: "off",
	}).type).toBeNull();
});

test("resolveShelfFocusZone passes portrait and wallpaper-safe flags through", () => {
	expect(resolveShelfFocusZone({
		...baseInput,
		queueFocusActive: true,
		portrait: true,
		wallpaperSafe: true,
	})).toEqual({
		type: "queue",
		immediate: true,
		portrait: true,
		wallpaperSafe: true,
	});
});

class FakePointerTarget {
	listeners = new Map<string, Set<(event: { clientX?: number; clientY: number }) => void>>();

	addEventListener(type: string, listener: EventListener): void {
		const set = this.listeners.get(type) ?? new Set<(event: { clientX?: number; clientY: number }) => void>();
		set.add(listener as unknown as (event: { clientX?: number; clientY: number }) => void);
		this.listeners.set(type, set);
	}

	removeEventListener(type: string, listener: EventListener): void {
		this.listeners.get(type)?.delete(listener as unknown as (event: { clientX?: number; clientY: number }) => void);
	}

	emit(type: string, event: { clientX?: number; clientY: number }): void {
		for (const listener of this.listeners.get(type) ?? []) {
			listener(event);
		}
	}

	count(type: string): number {
		return this.listeners.get(type)?.size ?? 0;
	}
}

test("attachShelfFocusZonePointerWiring calls cinema focus from global pointer movement and removes listeners on cleanup", () => {
	const target = new FakePointerTarget();
	const calls: unknown[] = [];
	const cleanup = attachShelfFocusZonePointerWiring({
		target,
		cinema: {
			setFocusZone: (type, opts) => calls.push([type, opts]),
		},
		shelfManager: {
			getSnapshot: () => ({
				centerIdx: 0,
				centerSmooth: 0,
				mode: "stage",
				presence: "always",
				shelfPane: "mine",
				shelfVisibility: 1,
				openCardIdx: -1,
				pinnedOpen: false,
				breathPulse: 0,
			}),
			getData: () => [{ title: "Queued track" }],
			getMode: () => "stage",
		},
		getSplashActive: () => false,
		getShelfCameraMode: () => "dynamic",
		getPortrait: () => true,
		getWallpaperSafe: () => false,
		getViewportHeight: () => 900,
	});

	expect(target.count("pointermove")).toBe(1);
	expect(target.count("pointerleave")).toBe(1);
	expect(target.count("blur")).toBe(1);

	target.emit("pointermove", { clientY: 700 });
	target.emit("pointerleave", { clientY: 0 });
	target.emit("blur", { clientY: 0 });
	cleanup();
	target.emit("pointermove", { clientY: 700 });
	target.emit("blur", { clientY: 0 });

	expect(calls).toEqual([
		["shelf-stage", { immediate: false, portrait: true, wallpaperSafe: false }],
		[null, { immediate: false, portrait: true, wallpaperSafe: false }],
		[null, { immediate: false, portrait: true, wallpaperSafe: false }],
	]);
	expect(target.count("pointermove")).toBe(0);
	expect(target.count("pointerleave")).toBe(0);
	expect(target.count("blur")).toBe(0);
});

test("attachShelfFocusZonePointerWiring notifies wallpaper-safe shelf focus changes for lyric camera snap", () => {
	const target = new FakePointerTarget();
	const changes: unknown[] = [];
	const cleanup = attachShelfFocusZonePointerWiring({
		target,
		cinema: {
			setFocusZone: () => {},
		},
		shelfManager: {
			getSnapshot: () => ({
				centerIdx: 0,
				centerSmooth: 0,
				mode: "side",
				presence: "always",
				shelfPane: "mine",
				shelfVisibility: 1,
				openCardIdx: -1,
				pinnedOpen: false,
				breathPulse: 0,
			}),
			getData: () => [{ title: "Queued track" }],
			getMode: () => "side",
		},
		getSplashActive: () => false,
		getShelfCameraMode: () => "dynamic",
		getPortrait: () => false,
		getWallpaperSafe: () => true,
		getViewportHeight: () => 900,
		getSideShelfFocusHit: () => true,
		onFocusZoneChange: (result) => changes.push([result.type, result.wallpaperSafe]),
	});

	target.emit("pointermove", { clientX: 1100, clientY: 500 });
	cleanup();

	expect(changes).toEqual([["shelf-side", true]]);
});

test("isQueueFocusActive follows baseline edge trigger band without a panel", () => {
	const basePointer = { clientX: 14, clientY: 133, viewportWidth: 1200, viewportHeight: 900 };
	expect(isQueueFocusActive(basePointer)).toBe(true);
	expect(isQueueFocusActive({ ...basePointer, clientX: 13 })).toBe(false);
	expect(isQueueFocusActive({ ...basePointer, clientX: 78 })).toBe(false);
	expect(isQueueFocusActive({ ...basePointer, clientY: 132 })).toBe(false);
	expect(isQueueFocusActive({ ...basePointer, clientY: 768 })).toBe(false);
});

test("isQueueFocusActive keeps focus inside the active playlist panel padding", () => {
	const panel = {
		active: true,
		peek: false,
		rect: { left: 80, right: 320, top: 140, bottom: 720 },
	};

	expect(isQueueFocusActive({
		clientX: 62,
		clientY: 118,
		viewportWidth: 1200,
		viewportHeight: 900,
	}, panel)).toBe(true);
	expect(isQueueFocusActive({
		clientX: 344,
		clientY: 742,
		viewportWidth: 1200,
		viewportHeight: 900,
	}, panel)).toBe(true);
	expect(isQueueFocusActive({
		clientX: 345,
		clientY: 743,
		viewportWidth: 1200,
		viewportHeight: 900,
	}, panel)).toBe(false);
});

test("isQueueFocusActive preserves peek panel focus up to the baseline right padding", () => {
	const panel = {
		active: false,
		peek: true,
		rect: { left: 80, right: 320, top: 140, bottom: 720 },
	};

	expect(isQueueFocusActive({
		clientX: 371,
		clientY: 40,
		viewportWidth: 1200,
		viewportHeight: 900,
	}, panel)).toBe(true);
	expect(isQueueFocusActive({
		clientX: 372,
		clientY: 40,
		viewportWidth: 1200,
		viewportHeight: 900,
	}, panel)).toBe(false);
});

test("isQueueFocusActive applies secondary-left-display seam dwell before queue focus", () => {
	let nowMs = 1000;
	const guard = createSecondaryPlaylistEdgeGuard({ nowMs: () => nowMs });
	const basePointer = { clientX: 36, clientY: 300, viewportWidth: 1200, viewportHeight: 900 };
	const opts = {
		secondaryLeftDisplaySeamGuardActive: true,
		secondaryEdgeGuard: guard,
	};

	expect(isQueueFocusActive({ ...basePointer, clientX: 14 }, null, opts)).toBe(false);
	expect(isQueueFocusActive(basePointer, null, opts)).toBe(false);
	nowMs = 1219;
	expect(isQueueFocusActive(basePointer, null, opts)).toBe(false);
	nowMs = 1220;
	expect(isQueueFocusActive(basePointer, null, opts)).toBe(true);
	expect(isQueueFocusActive({ ...basePointer, clientX: 95 }, null, opts)).toBe(true);
	expect(isQueueFocusActive({ ...basePointer, clientX: 96 }, null, opts)).toBe(false);

	nowMs = 1500;
	expect(isQueueFocusActive({ ...basePointer, clientY: 100 }, null, opts)).toBe(false);
	expect(isQueueFocusActive(basePointer, null, opts)).toBe(false);
});

test("isQueueFocusActive uses secondary seam close and narrower peek padding", () => {
	const guard = createSecondaryPlaylistEdgeGuard({ nowMs: () => 2000 });
	const panel = {
		active: true,
		peek: true,
		rect: { left: 80, right: 320, top: 140, bottom: 720 },
	};
	const opts = {
		secondaryLeftDisplaySeamGuardActive: true,
		secondaryEdgeGuard: guard,
	};

	expect(isQueueFocusActive({
		clientX: 20,
		clientY: 300,
		viewportWidth: 1200,
		viewportHeight: 900,
	}, panel, opts)).toBe(false);
	expect(isQueueFocusActive({
		clientX: 347,
		clientY: 300,
		viewportWidth: 1200,
		viewportHeight: 900,
	}, panel, opts)).toBe(true);
	expect(isQueueFocusActive({
		clientX: 348,
		clientY: 300,
		viewportWidth: 1200,
		viewportHeight: 900,
	}, panel, opts)).toBe(false);
});

test("attachShelfFocusZonePointerWiring lets injected queue focus win immediately", () => {
	const target = new FakePointerTarget();
	const calls: unknown[] = [];
	const cleanup = attachShelfFocusZonePointerWiring({
		target,
		cinema: {
			setFocusZone: (type, opts) => calls.push([type, opts]),
		},
		shelfManager: {
			getSnapshot: () => ({
				centerIdx: 0,
				centerSmooth: 0,
				mode: "stage",
				presence: "always",
				shelfPane: "mine",
				shelfVisibility: 1,
				openCardIdx: -1,
				pinnedOpen: false,
				breathPulse: 0,
			}),
			getData: () => [{ title: "Queued track" }],
			getMode: () => "stage",
		},
		getSplashActive: () => false,
		getShelfCameraMode: () => "dynamic",
		getPortrait: () => false,
		getWallpaperSafe: () => false,
		getViewportHeight: () => 900,
		getQueueFocusActive: () => true,
	} as Parameters<typeof attachShelfFocusZonePointerWiring>[0] & {
		getQueueFocusActive: () => boolean;
	});

	target.emit("pointermove", { clientY: 100 });
	cleanup();

	expect(calls).toEqual([
		["queue", { immediate: true, portrait: false, wallpaperSafe: false }],
	]);
});

test("attachShelfFocusZonePointerWiring lets injected side shelf raycast hit drive side focus", () => {
	const target = new FakePointerTarget();
	const calls: unknown[] = [];
	const cleanup = attachShelfFocusZonePointerWiring({
		target,
		cinema: {
			setFocusZone: (type, opts) => calls.push([type, opts]),
		},
		shelfManager: {
			getSnapshot: () => ({
				centerIdx: 0,
				centerSmooth: 0,
				mode: "side",
				presence: "always",
				shelfPane: "mine",
				shelfVisibility: 1,
				openCardIdx: -1,
				pinnedOpen: false,
				breathPulse: 0,
			}),
			getData: () => [{ title: "Side playlist" }],
			getMode: () => "side",
		},
		getSplashActive: () => false,
		getShelfCameraMode: () => "dynamic",
		getPortrait: () => false,
		getWallpaperSafe: () => false,
		getViewportHeight: () => 900,
		getSideShelfFocusHit: () => true,
	} as Parameters<typeof attachShelfFocusZonePointerWiring>[0] & {
		getSideShelfFocusHit: () => boolean;
	});

	target.emit("pointermove", { clientX: 1180, clientY: 200 });
	cleanup();

	expect(calls).toEqual([
		["shelf-side", { immediate: false, portrait: false, wallpaperSafe: false }],
	]);
});
