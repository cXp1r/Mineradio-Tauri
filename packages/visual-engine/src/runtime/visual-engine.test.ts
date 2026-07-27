import { expect, test } from "bun:test";
import "./happy-dom-preload";
import { createVisualEngine } from "./visual-engine";
import type {
	VisualEngineComposition,
	VisualEngineCompositionContext,
	VisualFrameSnapshot,
	ShelfVisualSnapshot,
	VisualSettingsSnapshot,
	VisualVisibilityState,
} from "./visual-engine-contract";

const clock = {
	currentTimeSeconds: () => 0,
	durationSeconds: () => null,
	isPlaying: () => false,
};

const foreground: VisualVisibilityState = {
	documentVisible: true,
	windowVisible: true,
	windowFocused: true,
	windowMinimized: false,
};

function fixedSettings(fps: 30 | 60 = 30): VisualSettingsSnapshot {
	return {
		fx: {},
		coverResolution: 1,
		wallpaperSafe: true,
		backgroundPolicy: "auto",
		foregroundFramePolicy: { mode: "fixed", fps },
		prefersReducedMotion: false,
	};
}

function deferred(): { promise: Promise<void>; resolve(): void; reject(error: unknown): void } {
	let resolvePromise: () => void = () => {};
	let rejectPromise: (error: unknown) => void = () => {};
	const promise = new Promise<void>((resolve, reject) => {
		resolvePromise = resolve;
		rejectPromise = reject;
	});
	return { promise, resolve: resolvePromise, reject: rejectPromise };
}

async function expectRejected(promise: Promise<void>, text: string): Promise<void> {
	let error: unknown = null;
	try {
		await promise;
	} catch (caught) {
		error = caught;
	}
	expect(error).toBeInstanceOf(Error);
	if (!(error instanceof Error)) throw new Error("Expected a rejection error.");
	expect(error.message).toContain(text);
}

test("mount caches the latest snapshot and applies one frozen shared bundle", async () => {
	const captured: { current: VisualEngineCompositionContext | null } = { current: null };
	const applied: VisualFrameSnapshot[] = [];
	const composition: VisualEngineComposition = {
		async mount(nextContext) {
			captured.current = nextContext;
			nextContext.scheduler.registerRuntimeCallbacks({ onAnimation() {} });
		},
		applyFrameSnapshot(snapshot) { applied.push(snapshot); },
		applyPreset() {},
		setVisibility() {},
		dispose() {},
	};
	const engine = createVisualEngine({ mediaClock: clock, createComposition: () => composition });
	const lyrics = { lines: [], fallbackText: "second", hasNativeKaraoke: false };
	const shelf: ShelfVisualSnapshot = { items: [], pane: "fav", mode: "side", cameraMode: "static", presence: "always", mergeCollections: false, mineCount: 0, favCount: 0, secondaryLeftDisplaySeamGuard: false };
	engine.setPlaybackSnapshot({ trackKey: "first", playing: false, durationMs: null, coverUrl: "", beatMapKey: "", beatMap: null, splashActive: false, homeActive: false });
	engine.setPlaybackSnapshot({ trackKey: "latest", playing: true, durationMs: 1, coverUrl: "cover", beatMapKey: "key", beatMap: null, splashActive: false, homeActive: true });
	engine.setLyricsSnapshot(lyrics);
	engine.setShelfSnapshot(shelf);
	engine.setVisualSettings(fixedSettings(60));

	await engine.mount(document.createElement("div"));

	expect(captured.current).not.toBeNull();
	const snapshot = captured.current?.getFrameSnapshot();
	expect(snapshot).toBe(applied[0]);
	expect(snapshot?.revision).toBe(5);
	expect(snapshot?.playback.trackKey).toBe("latest");
	expect(snapshot?.lyrics).toBe(lyrics);
	expect(snapshot?.shelf).toBe(shelf);
	expect(Object.isFrozen(snapshot)).toBe(true);
	engine.dispose();
});

test("mounted updates do not remount and settings update scheduler policy", async () => {
	let mountCalls = 0;
	const captured: { current: VisualEngineCompositionContext | null } = { current: null };
	const applied: number[] = [];
	const engine = createVisualEngine({
		mediaClock: clock,
		createComposition: () => ({
			async mount(nextContext) { mountCalls += 1; captured.current = nextContext; nextContext.scheduler.registerRuntimeCallbacks({ onAnimation() {} }); },
			applyFrameSnapshot(snapshot) { applied.push(snapshot.revision); },
			applyPreset() {}, setVisibility() {}, dispose() {},
		}),
	});
	await engine.mount(document.createElement("div"));
	engine.setPlaybackSnapshot({ trackKey: "updated", playing: true, durationMs: 1, coverUrl: "", beatMapKey: "", beatMap: null, splashActive: false, homeActive: true });
	engine.setLyricsSnapshot({ lines: [], fallbackText: "updated", hasNativeKaraoke: false });
	engine.setShelfSnapshot({ items: [], pane: "mine", mode: "side", cameraMode: "static", presence: "always", mergeCollections: false, mineCount: 0, favCount: 0, secondaryLeftDisplaySeamGuard: false });
	engine.setVisualSettings(fixedSettings());
	expect(mountCalls).toBe(1);
	expect(applied).toEqual([0, 1, 2, 3, 4]);
	expect(captured.current?.scheduler.getMode()).toBe("foreground");
	engine.dispose();
});

test("a second mount rejects and composition is constructed once", async () => {
	let creations = 0;
	const engine = createVisualEngine({ mediaClock: clock, createComposition: () => {
		creations += 1;
		return { async mount(context) { context.scheduler.registerRuntimeCallbacks({ onAnimation() {} }); }, applyFrameSnapshot() {}, applyPreset() {}, setVisibility() {}, dispose() {} };
	} });
	await engine.mount(document.createElement("div"));
	await expectRejected(engine.mount(document.createElement("div")), "only be mounted once");
	expect(creations).toBe(1);
	engine.dispose();
});

test("disposing an unresolved mount aborts it and releases all resources", async () => {
	const wait = deferred();
	let disposeCalls = 0;
	let released = 0;
	let applied = 0;
	const engine = createVisualEngine({ mediaClock: clock, createComposition: () => ({
		async mount(context) {
			context.resources.register({ owner: "test", kind: "timer", retention: "ephemeral", dispose() { released += 1; } });
			context.scheduler.registerRuntimeCallbacks({ onAnimation() {} });
			await wait.promise;
		},
		applyFrameSnapshot() { applied += 1; }, applyPreset() {}, setVisibility() {}, dispose() { disposeCalls += 1; },
	}) });
	const mounted = engine.mount(document.createElement("div"));
	engine.dispose();
	await expectRejected(mounted, "cancelled");
	expect(disposeCalls).toBe(1);
	expect(released).toBe(1);
	wait.resolve();
	await Promise.resolve();
	expect(applied).toBe(0);
});

test("a mounted facade owns one scheduler handle and cancellation prevents stale callbacks", async () => {
	const originalRequest = globalThis.requestAnimationFrame;
	const originalCancel = globalThis.cancelAnimationFrame;
	let nextHandle = 1;
	let requestCalls = 0;
	const callbacks = new Map<number, FrameRequestCallback>();
	const cancelled: number[] = [];
	globalThis.requestAnimationFrame = (callback) => {
		const handle = nextHandle++;
		requestCalls += 1;
		callbacks.set(handle, callback);
		return handle;
	};
	globalThis.cancelAnimationFrame = (handle) => { cancelled.push(handle); };
	try {
		let animationCalls = 0;
		const engine = createVisualEngine({ mediaClock: clock, createComposition: () => ({
			async mount(context) { context.scheduler.registerRuntimeCallbacks({ onAnimation() { animationCalls += 1; } }); },
			applyFrameSnapshot() {}, applyPreset() {}, setVisibility() {}, dispose() {},
		}) });
		await engine.mount(document.createElement("div"));
		expect(requestCalls).toBe(1);
		const firstHandle = 1;
		engine.dispose();
		expect(cancelled).toEqual([firstHandle]);
		callbacks.get(firstHandle)?.(100);
		expect(animationCalls).toBe(0);
		expect(requestCalls).toBe(1);
	} finally {
		globalThis.requestAnimationFrame = originalRequest;
		globalThis.cancelAnimationFrame = originalCancel;
	}
});

test("mount rejection rolls back despite resource disposal failures", async () => {
	let disposed = 0;
	let released = 0;
	const engine = createVisualEngine({ mediaClock: clock, createComposition: () => ({
		async mount(context) {
			context.resources.register({ owner: "bad", kind: "timer", retention: "ephemeral", dispose() { throw new Error("release failed"); } });
			context.resources.register({ owner: "good", kind: "timer", retention: "ephemeral", dispose() { released += 1; } });
			throw new Error("mount failed");
		},
		applyFrameSnapshot() {}, applyPreset() {}, setVisibility() {}, dispose() { disposed += 1; },
	}) });
	const originalConsoleError = console.error;
	console.error = () => {};
	try {
		await expectRejected(engine.mount(document.createElement("div")), "mount failed");
	} finally {
		console.error = originalConsoleError;
	}
	expect(disposed).toBe(1);
	expect(released).toBe(1);
});

test("missing runtime registration rejects without scheduling work", async () => {
	const engine = createVisualEngine({ mediaClock: clock, createComposition: () => ({
		async mount() {}, applyFrameSnapshot() {}, applyPreset() {}, setVisibility() {}, dispose() {},
	}) });
	await expectRejected(engine.mount(document.createElement("div")), "runtime callbacks");
});

test("visibility and presets delegate only while mounted, and dispose is reentrant-safe", async () => {
	const visibility: VisualVisibilityState = { ...foreground, windowFocused: false };
	let presets = 0;
	const visibilities: VisualVisibilityState[] = [];
	let disposeCalls = 0;
	let engine: ReturnType<typeof createVisualEngine>;
	engine = createVisualEngine({ mediaClock: clock, createComposition: () => ({
		async mount(context) { context.scheduler.registerRuntimeCallbacks({ onAnimation() {} }); },
		applyFrameSnapshot() {}, applyPreset() { presets += 1; }, setVisibility(state) { visibilities.push(state); },
		dispose() { disposeCalls += 1; engine.dispose(); },
	}) });
	engine.applyPreset(2);
	engine.setVisibility(visibility);
	await engine.mount(document.createElement("div"));
	expect(presets).toBe(0);
	expect(visibilities).toEqual([visibility]);
	engine.applyPreset(3);
	engine.setVisibility(foreground);
	expect(presets).toBe(1);
	expect(visibilities).toEqual([visibility, foreground]);
	engine.dispose();
	engine.dispose();
	engine.applyPreset(4);
	engine.setVisibility(visibility);
	expect(disposeCalls).toBe(1);
	expect(presets).toBe(1);
});

test("performance projects merged budgets and returns a copy", async () => {
	const captured: { current: VisualEngineCompositionContext | null } = { current: null };
	const engine = createVisualEngine({ mediaClock: clock, resourceBudget: { textureBytes: 42 }, createComposition: () => ({
		async mount(context) { captured.current = context; context.scheduler.registerRuntimeCallbacks({ onAnimation() {} }); },
		applyFrameSnapshot() {}, applyPreset() {}, setVisibility() {}, dispose() {},
	}) });
	await engine.mount(document.createElement("div"));
	if (!captured.current) throw new Error("Expected a composition context.");
	captured.current.tasks.enqueue({
		owner: "test",
		key: "queued",
		priority: "normal",
		cost: 7,
		run() {},
		commit() {},
	});
	const first = engine.getPerformanceSnapshot();
	expect(first.runtime.mounted).toBe(true);
	expect(first.runtime.running).toBe(true);
	expect(first.runtime.mode).toBe("foreground");
	expect(first.resources.budget.textureBytes).toBe(42);
	expect(first.resources.budget.meshCount).toBeGreaterThanOrEqual(0);
	expect(first.resources.current.queuedTaskCost).toBe(7);
	expect(first.tasks.queued).toBe(1);
	const second = engine.getPerformanceSnapshot();
	expect(second).not.toBe(first);
	expect(second.runtime).not.toBe(first.runtime);
	expect(second.runtime.running).toBe(true);
	engine.dispose();
	const disposed = engine.getPerformanceSnapshot();
	expect(disposed.runtime.mounted).toBe(false);
	expect(disposed.runtime.running).toBe(false);
	expect(disposed.runtime.generation).toBeGreaterThan(first.runtime.generation);
});
