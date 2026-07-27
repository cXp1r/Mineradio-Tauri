import { expect, test } from "bun:test";
import "./happy-dom-preload";
import { createVisualEngine } from "./visual-engine";
import type {
	VisualEngineComposition,
	VisualEngineCompositionContext,
	VisualFrameSnapshot,
	PlaybackVisualSnapshot,
	ShelfVisualSnapshot,
	VisualSettingsSnapshot,
	VisualVisibilityState,
} from "./visual-engine-contract";
import type { VisualResourceHandle, VisualResourceScope } from "./resource-scope";

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

const backgroundVisibility: VisualVisibilityState = {
	...foreground,
	documentVisible: false,
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

function playbackSnapshot(trackKey: string): PlaybackVisualSnapshot {
	return {
		trackKey,
		playing: false,
		durationMs: null,
		coverUrl: "",
		beatMapKey: "",
		beatMap: null,
		splashActive: false,
		homeActive: false,
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

function installAnimationFrameHarness(): {
	readonly callbacks: Map<number, FrameRequestCallback>;
	readonly cancelled: number[];
	readonly requested: number;
	restore(): void;
} {
	const originalRequest = globalThis.requestAnimationFrame;
	const originalCancel = globalThis.cancelAnimationFrame;
	let requested = 0;
	const callbacks = new Map<number, FrameRequestCallback>();
	const cancelled: number[] = [];
	globalThis.requestAnimationFrame = (callback) => {
		requested += 1;
		callbacks.set(requested, callback);
		return requested;
	};
	globalThis.cancelAnimationFrame = (handle) => { cancelled.push(handle); };
	return {
		callbacks,
		cancelled,
		get requested() { return requested; },
		restore() {
			globalThis.requestAnimationFrame = originalRequest;
			globalThis.cancelAnimationFrame = originalCancel;
		},
	};
}

function installTimerHarness(): {
	readonly callbacks: Map<number, () => void>;
	readonly cleared: number[];
	readonly requested: number;
	restore(): void;
} {
	const originalSetTimeout = globalThis.setTimeout;
	const originalClearTimeout = globalThis.clearTimeout;
	let requested = 0;
	const callbacks = new Map<number, () => void>();
	const cleared: number[] = [];
	globalThis.setTimeout = ((handler: TimerHandler) => {
		if (typeof handler !== "function") throw new Error("Expected a timer callback.");
		requested += 1;
		callbacks.set(requested, () => { handler(); });
		return requested;
	}) as typeof globalThis.setTimeout;
	globalThis.clearTimeout = ((handle?: number) => {
		if (handle === undefined) return;
		cleared.push(handle);
		callbacks.delete(handle);
	}) as typeof globalThis.clearTimeout;
	return {
		callbacks,
		cleared,
		get requested() { return requested; },
		restore() {
			globalThis.setTimeout = originalSetTimeout;
			globalThis.clearTimeout = originalClearTimeout;
		},
	};
}

interface SchedulerAuthorityAction {
	readonly name: string;
	invoke(scheduler: VisualEngineCompositionContext["scheduler"]): void;
}

const schedulerAuthorityActions: readonly SchedulerAuthorityAction[] = [
	{ name: "start", invoke: (scheduler) => scheduler.start() },
	{ name: "stop", invoke: (scheduler) => scheduler.stop() },
	{ name: "dispose", invoke: (scheduler) => scheduler.dispose() },
	{ name: "setVisibility", invoke: (scheduler) => scheduler.setVisibility(foreground) },
	{ name: "setBackgroundPolicy", invoke: (scheduler) => scheduler.setBackgroundPolicy("release") },
	{ name: "setForegroundFramePolicy", invoke: (scheduler) => scheduler.setForegroundFramePolicy({ mode: "fixed", fps: 30 }) },
];
const schedulerPolicyAuthorityActions = schedulerAuthorityActions.slice(3);

interface RuntimeServiceAuthorityAction {
	readonly name: "resources" | "tasks";
	invoke(context: VisualEngineCompositionContext): void;
}

const runtimeServiceAuthorityActions: readonly RuntimeServiceAuthorityAction[] = [
	{ name: "resources", invoke: (context) => { context.resources.dispose(); } },
	{ name: "tasks", invoke: (context) => { context.tasks.dispose(); } },
];

interface RuntimeCallbackInvalidationAction {
	readonly name: string;
	invoke(context: VisualEngineCompositionContext): void;
}

const runtimeCallbackInvalidationActions: readonly RuntimeCallbackInvalidationAction[] = [
	{ name: "caught resources dispose", invoke(context) { try { context.resources.dispose(); } catch {} } },
	{ name: "caught tasks dispose", invoke(context) { try { context.tasks.dispose(); } catch {} } },
	{ name: "caught scheduler stop", invoke(context) { try { context.scheduler.stop(); } catch {} } },
	{ name: "uncaught scheduler dispose", invoke(context) { context.scheduler.dispose(); } },
	{ name: "closed cancellation", invoke(context) { context.cancellation.dispose(); } },
];

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

test("an unresolved mount commits only the latest complete snapshot bundle", async () => {
	const wait = deferred();
	let mountCalls = 0;
	const applied: VisualFrameSnapshot[] = [];
	const engine = createVisualEngine({ mediaClock: clock, createComposition: () => ({
		async mount(context) {
			mountCalls += 1;
			context.scheduler.registerRuntimeCallbacks({ onAnimation() {} });
			await wait.promise;
		},
		applyFrameSnapshot(snapshot) { applied.push(snapshot); },
		applyPreset() {}, setVisibility() {}, dispose() {},
	}) });
	const mounted = engine.mount(document.createElement("div"));
	engine.setPlaybackSnapshot({ trackKey: "first", playing: false, durationMs: null, coverUrl: "", beatMapKey: "", beatMap: null, splashActive: false, homeActive: false });
	engine.setPlaybackSnapshot({ trackKey: "latest", playing: true, durationMs: 99, coverUrl: "cover", beatMapKey: "beat", beatMap: null, splashActive: false, homeActive: true });
	engine.setLyricsSnapshot({ lines: [], fallbackText: "latest lyrics", hasNativeKaraoke: false });
	engine.setShelfSnapshot({ items: [], pane: "fav", mode: "stage", cameraMode: "static", presence: "always", mergeCollections: false, mineCount: 0, favCount: 1, secondaryLeftDisplaySeamGuard: false });
	engine.setVisualSettings(fixedSettings(30));
	engine.setVisualSettings(fixedSettings(60));
	wait.resolve();
	await mounted;

	expect(mountCalls).toBe(1);
	expect(applied).toHaveLength(1);
	expect(applied[0]?.revision).toBe(6);
	expect(applied[0]?.playback.trackKey).toBe("latest");
	expect(applied[0]?.lyrics.fallbackText).toBe("latest lyrics");
	expect(applied[0]?.shelf.pane).toBe("fav");
	expect(applied[0]?.settings.foregroundFramePolicy).toEqual({ mode: "fixed", fps: 60 });
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

test("mounted settings drive fixed cadence and background scheduler policy", async () => {
	const originalRequest = globalThis.requestAnimationFrame;
	const originalCancel = globalThis.cancelAnimationFrame;
	let nextHandle = 1;
	const callbacks = new Map<number, FrameRequestCallback>();
	const cancelled: number[] = [];
	globalThis.requestAnimationFrame = (callback) => {
		const handle = nextHandle++;
		callbacks.set(handle, callback);
		return handle;
	};
	globalThis.cancelAnimationFrame = (handle) => { cancelled.push(handle); };
	try {
		const decisions: boolean[] = [];
		const captured: { current: VisualEngineCompositionContext | null } = { current: null };
		const engine = createVisualEngine({ mediaClock: clock, createComposition: () => ({
			async mount(nextContext) {
				captured.current = nextContext;
				nextContext.scheduler.registerRuntimeCallbacks({ onAnimation(_now, decision) { decisions.push(decision.run); } });
			},
			applyFrameSnapshot() {}, applyPreset() {}, setVisibility() {}, dispose() {},
		}) });
		await engine.mount(document.createElement("div"));
		engine.setVisualSettings(fixedSettings(30));
		callbacks.get(1)?.(0);
		callbacks.get(2)?.(16);
		expect(decisions).toEqual([true, false]);

		engine.setVisibility({ ...foreground, documentVisible: false });
		engine.setVisualSettings({ ...fixedSettings(30), backgroundPolicy: "keep" });
		expect(captured.current?.scheduler.getMode()).toBe("background");
		expect(callbacks.has(4)).toBe(true);
		engine.setVisualSettings({ ...fixedSettings(30), backgroundPolicy: "release" });
		expect(captured.current?.scheduler.getMode()).toBe("released");
		expect(cancelled).toContain(4);
		engine.dispose();
	} finally {
		globalThis.requestAnimationFrame = originalRequest;
		globalThis.cancelAnimationFrame = originalCancel;
	}
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
	const started = deferred();
	let disposeCalls = 0;
	let released = 0;
	let applied = 0;
	const engine = createVisualEngine({ mediaClock: clock, createComposition: () => ({
		async mount(context) {
			context.resources.register({ owner: "test", kind: "timer", retention: "ephemeral", dispose() { released += 1; } });
			context.scheduler.registerRuntimeCallbacks({ onAnimation() {} });
			started.resolve();
			await wait.promise;
		},
		applyFrameSnapshot() { applied += 1; }, applyPreset() {}, setVisibility() {}, dispose() { disposeCalls += 1; },
	}) });
	const mounted = engine.mount(document.createElement("div"));
	await started.promise;
	engine.dispose();
	await expectRejected(mounted, "cancelled");
	expect(disposeCalls).toBe(1);
	expect(released).toBe(1);
	wait.resolve();
	await Promise.resolve();
	expect(applied).toBe(0);
});

test("a synchronous mount disposal and throw cannot leak an unhandled rejection", async () => {
	const unhandled: unknown[] = [];
	const onUnhandled = (event: PromiseRejectionEvent) => {
		unhandled.push(event.reason);
		event.preventDefault();
	};
	globalThis.addEventListener("unhandledrejection", onUnhandled);
	let engine: ReturnType<typeof createVisualEngine>;
	let disposeCalls = 0;
	try {
		engine = createVisualEngine({ mediaClock: clock, createComposition: () => ({
			mount() {
				engine.dispose();
				throw new Error("synchronous mount failure");
			},
			applyFrameSnapshot() {}, applyPreset() {}, setVisibility() {}, dispose() { disposeCalls += 1; },
		}) });
		await expectRejected(engine.mount(document.createElement("div")), "cancelled");
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		expect(unhandled).toEqual([]);
		expect(disposeCalls).toBe(1);
	} finally {
		globalThis.removeEventListener("unhandledrejection", onUnhandled);
	}
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

test("an incomplete RAF pair uses timeout for both scheduling and cancellation", async () => {
	const originalRequest = globalThis.requestAnimationFrame;
	const originalCancel = globalThis.cancelAnimationFrame;
	const originalSetTimeout = globalThis.setTimeout;
	const originalClearTimeout = globalThis.clearTimeout;
	let rafRequests = 0;
	let timeoutRequests = 0;
	const clearedTimeouts: number[] = [];
	globalThis.requestAnimationFrame = () => { rafRequests += 1; return rafRequests; };
	Reflect.deleteProperty(globalThis, "cancelAnimationFrame");
	globalThis.setTimeout = () => { timeoutRequests += 1; return 100 + timeoutRequests; };
	globalThis.clearTimeout = (handle) => {
		if (handle !== undefined) clearedTimeouts.push(handle);
	};
	try {
		const engine = createVisualEngine({ mediaClock: clock, createComposition: () => ({
			async mount(context) { context.scheduler.registerRuntimeCallbacks({ onAnimation() {} }); },
			applyFrameSnapshot() {}, applyPreset() {}, setVisibility() {}, dispose() {},
		}) });
		await engine.mount(document.createElement("div"));
		expect(rafRequests).toBe(0);
		expect(timeoutRequests).toBe(1);
		engine.dispose();
		expect(clearedTimeouts).toEqual([101]);
	} finally {
		globalThis.requestAnimationFrame = originalRequest;
		globalThis.cancelAnimationFrame = originalCancel;
		globalThis.setTimeout = originalSetTimeout;
		globalThis.clearTimeout = originalClearTimeout;
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
	const originalRequest = globalThis.requestAnimationFrame;
	const originalCancel = globalThis.cancelAnimationFrame;
	const originalSetTimeout = globalThis.setTimeout;
	let frames = 0;
	let timers = 0;
	globalThis.requestAnimationFrame = () => { frames += 1; return frames; };
	globalThis.cancelAnimationFrame = () => {};
	globalThis.setTimeout = (handler, timeout, ...arguments_) => {
		timers += 1;
		return originalSetTimeout(handler, timeout, ...arguments_);
	};
	try {
		let disposed = 0;
		let released = 0;
		let visibilityCalls = 0;
		let frameCalls = 0;
		const engine = createVisualEngine({
			mediaClock: clock,
			initialVisibility: { ...foreground, windowMinimized: true },
			createComposition: () => ({
				async mount(context) {
					context.resources.register({ owner: "test", kind: "timer", retention: "ephemeral", dispose() { released += 1; } });
				},
				applyFrameSnapshot() { frameCalls += 1; },
				applyPreset() {},
				setVisibility() { visibilityCalls += 1; },
				dispose() { disposed += 1; },
			}),
		});
		await expectRejected(engine.mount(document.createElement("div")), "registration");
		expect(disposed).toBe(1);
		expect(released).toBe(1);
		expect(frames).toBe(0);
		expect(timers).toBe(0);
		expect(frameCalls).toBe(0);
		expect(visibilityCalls).toBe(0);
	} finally {
		globalThis.requestAnimationFrame = originalRequest;
		globalThis.cancelAnimationFrame = originalCancel;
		globalThis.setTimeout = originalSetTimeout;
	}
});

test("a stale mount completion cannot start scheduler handles after disposal", async () => {
	const originalRequest = globalThis.requestAnimationFrame;
	const originalCancel = globalThis.cancelAnimationFrame;
	let requested = 0;
	globalThis.requestAnimationFrame = () => { requested += 1; return requested; };
	globalThis.cancelAnimationFrame = () => {};
	try {
		const wait = deferred();
		const started = deferred();
		let applied = 0;
		const engine = createVisualEngine({ mediaClock: clock, createComposition: () => ({
			async mount(context) {
				context.scheduler.registerRuntimeCallbacks({ onAnimation() {} });
				started.resolve();
				await wait.promise;
			},
			applyFrameSnapshot() { applied += 1; }, applyPreset() {}, setVisibility() {}, dispose() {},
		}) });
		const mounted = engine.mount(document.createElement("div"));
		await started.promise;
		engine.dispose();
		await expectRejected(mounted, "cancelled");
		wait.resolve();
		await Promise.resolve();
		expect(requested).toBe(0);
		expect(applied).toBe(0);
	} finally {
		globalThis.requestAnimationFrame = originalRequest;
		globalThis.cancelAnimationFrame = originalCancel;
	}
});

test("an initial composition delegate failure rejects before scheduler start and rolls back once", async () => {
	const frames = installAnimationFrameHarness();
	try {
		let disposed = 0;
		let released = 0;
		let visibilityCalls = 0;
		const engine = createVisualEngine({ mediaClock: clock, createComposition: () => ({
			async mount(context) {
				context.resources.register({ owner: "test", kind: "timer", retention: "ephemeral", dispose() { released += 1; } });
				context.scheduler.registerRuntimeCallbacks({ onAnimation() {} });
			},
			applyFrameSnapshot() { throw new Error("initial frame failed"); },
			applyPreset() {},
			setVisibility() { visibilityCalls += 1; },
			dispose() { disposed += 1; },
		}) });
		await expectRejected(engine.mount(document.createElement("div")), "initial frame failed");
		expect(frames.requested).toBe(0);
		expect(frames.cancelled).toEqual([]);
		expect(disposed).toBe(1);
		expect(released).toBe(1);
		expect(visibilityCalls).toBe(0);
	} finally {
		frames.restore();
	}
});

test("unregistering scheduler callbacks during initial delegates rejects before any handle starts", async () => {
	const frames = installAnimationFrameHarness();
	try {
		let unregister = () => {};
		let disposed = 0;
		const engine = createVisualEngine({ mediaClock: clock, createComposition: () => ({
			async mount(context) {
				unregister = context.scheduler.registerRuntimeCallbacks({ onAnimation() {} });
			},
			applyFrameSnapshot() { unregister(); },
			applyPreset() {}, setVisibility() {}, dispose() { disposed += 1; },
		}) });
		await expectRejected(engine.mount(document.createElement("div")), "registration");
		expect(frames.requested).toBe(0);
		expect(frames.cancelled).toEqual([]);
		expect(disposed).toBe(1);
	} finally {
		frames.restore();
	}
});

test("initial delegate reentrancy stabilizes the latest cached state before scheduler start", async () => {
	const frames = installAnimationFrameHarness();
	try {
		const latestSettings: VisualSettingsSnapshot = {
			...fixedSettings(30),
			backgroundPolicy: "keep",
		};
		const latestVisibility: VisualVisibilityState = {
			...foreground,
			documentVisible: false,
		};
		const applied: VisualFrameSnapshot[] = [];
		const visibilityCalls: VisualVisibilityState[] = [];
		const frameModes: { readonly trackKey: string; readonly mode: string }[] = [];
		const visibilityModes: { readonly documentVisible: boolean; readonly mode: string }[] = [];
		const decisions: boolean[] = [];
		let presetCalls = 0;
		let delegateDepth = 0;
		let maxDelegateDepth = 0;
		let reentered = false;
		const captured: { context: VisualEngineCompositionContext | null } = { context: null };
		let engine: ReturnType<typeof createVisualEngine>;
		engine = createVisualEngine({ mediaClock: clock, createComposition: () => ({
			async mount(nextContext) {
				captured.context = nextContext;
				nextContext.scheduler.registerRuntimeCallbacks({
					onAnimation(_now, decision) { decisions.push(decision.run); },
				});
			},
			applyFrameSnapshot(snapshot) {
				delegateDepth += 1;
				maxDelegateDepth = Math.max(maxDelegateDepth, delegateDepth);
				try {
					applied.push(snapshot);
					frameModes.push({
						trackKey: snapshot.playback.trackKey,
						mode: captured.context?.scheduler.getMode() ?? "missing",
					});
					if (reentered) return;
					reentered = true;
					engine.setPlaybackSnapshot({ trackKey: "latest", playing: true, durationMs: 1, coverUrl: "cover", beatMapKey: "beat", beatMap: null, splashActive: false, homeActive: true });
					engine.setVisualSettings(latestSettings);
					engine.setVisibility(latestVisibility);
					engine.applyPreset(9);
				} finally {
					delegateDepth -= 1;
				}
			},
			applyPreset() { presetCalls += 1; },
			setVisibility(state) {
				visibilityCalls.push(state);
				visibilityModes.push({
					documentVisible: state.documentVisible,
					mode: captured.context?.scheduler.getMode() ?? "missing",
				});
			},
			dispose() {},
		}) });

		await engine.mount(document.createElement("div"));

		expect(maxDelegateDepth).toBe(1);
		expect(presetCalls).toBe(0);
		expect(applied.length).toBeGreaterThan(1);
		expect(applied.at(-1)?.playback.trackKey).toBe("latest");
		expect(applied.at(-1)?.settings).toBe(latestSettings);
		expect(visibilityCalls.at(-1)).toEqual(latestVisibility);
		expect(frameModes.at(-1)).toEqual({ trackKey: "latest", mode: "background" });
		expect(visibilityModes.at(-1)).toEqual({ documentVisible: false, mode: "background" });
		expect(captured.context?.scheduler.getMode()).toBe("background");
		expect(frames.requested).toBe(1);
		expect(frames.cancelled).toEqual([]);

		frames.callbacks.get(1)?.(0);
		frames.callbacks.get(2)?.(16);
		expect(decisions).toEqual([true, false]);
		engine.dispose();
	} finally {
		frames.restore();
	}
});

test("initial stabilization replays only the delegate whose revision changed", async () => {
	for (const changedKind of ["frame", "visibility"] as const) {
		const frames = installAnimationFrameHarness();
		try {
			let changed = false;
			let frameCalls = 0;
			let visibilityCalls = 0;
			let engine: ReturnType<typeof createVisualEngine>;
			engine = createVisualEngine({ mediaClock: clock, createComposition: () => ({
				async mount(context) {
					context.scheduler.registerRuntimeCallbacks({ onAnimation() {} });
				},
				applyFrameSnapshot() {
					frameCalls += 1;
					if (changedKind !== "frame" || changed) return;
					changed = true;
					engine.setPlaybackSnapshot(playbackSnapshot("latest"));
				},
				applyPreset() {},
				setVisibility() {
					visibilityCalls += 1;
					if (changedKind !== "visibility" || changed) return;
					changed = true;
					engine.setVisibility(backgroundVisibility);
				},
				dispose() {},
			}) });

			await engine.mount(document.createElement("div"));

			expect(frameCalls).toBe(changedKind === "frame" ? 2 : 1);
			expect(visibilityCalls).toBe(changedKind === "visibility" ? 2 : 1);
			engine.dispose();
		} finally {
			frames.restore();
		}
	}
});

test("initial delegate synchronization fails closed when frame revisions never stabilize", async () => {
	const frames = installAnimationFrameHarness();
	try {
		let frameCalls = 0;
		let compositionDisposals = 0;
		let engine: ReturnType<typeof createVisualEngine>;
		engine = createVisualEngine({ mediaClock: clock, createComposition: () => ({
			async mount(context) {
				context.scheduler.registerRuntimeCallbacks({ onAnimation() {} });
			},
			applyFrameSnapshot() {
				frameCalls += 1;
				if (frameCalls >= 100) return;
				engine.setPlaybackSnapshot({ trackKey: String(frameCalls), playing: false, durationMs: null, coverUrl: "", beatMapKey: "", beatMap: null, splashActive: false, homeActive: false });
			},
			applyPreset() {}, setVisibility() {}, dispose() { compositionDisposals += 1; },
		}) });

		await expectRejected(engine.mount(document.createElement("div")), "stabilize");
		expect(frameCalls).toBeGreaterThan(1);
		expect(frameCalls).toBeLessThan(100);
		expect(frames.requested).toBe(0);
		expect(frames.cancelled).toEqual([]);
		expect(compositionDisposals).toBe(1);
	} finally {
		frames.restore();
	}
});

test("a caught scheduler ownership violation during initial commit still rejects mount", async () => {
	const frames = installAnimationFrameHarness();
	try {
		let scheduler: VisualEngineCompositionContext["scheduler"] | null = null;
		const engine = createVisualEngine({ mediaClock: clock, createComposition: () => ({
			async mount(context) {
				scheduler = context.scheduler;
				context.scheduler.registerRuntimeCallbacks({ onAnimation() {} });
			},
			applyFrameSnapshot() {
				try {
					scheduler?.stop();
				} catch {
					// composition 即使吞掉 ownership 错误，facade 仍必须回滚 mount。
				}
			},
			applyPreset() {}, setVisibility() {}, dispose() {},
		}) });
		await expectRejected(engine.mount(document.createElement("div")), "ownership");
		expect(frames.requested).toBe(0);
		expect(frames.cancelled).toEqual([]);
	} finally {
		frames.restore();
	}
});

test("caught scheduler policy ownership violations during mount still roll back", async () => {
	for (const action of schedulerPolicyAuthorityActions) {
		const frames = installAnimationFrameHarness();
		try {
			let caught = 0;
			let compositionDisposals = 0;
			const engine = createVisualEngine({ mediaClock: clock, createComposition: () => ({
				async mount(context) {
					context.scheduler.registerRuntimeCallbacks({ onAnimation() {} });
					try {
						action.invoke(context.scheduler);
					} catch {
						caught += 1;
					}
				},
				applyFrameSnapshot() {}, applyPreset() {}, setVisibility() {}, dispose() { compositionDisposals += 1; },
			}) });

			await expectRejected(engine.mount(document.createElement("div")), "ownership");
			expect(caught).toBe(1);
			expect(compositionDisposals).toBe(1);
			expect(frames.requested).toBe(0);
			expect(frames.cancelled).toEqual([]);
		} finally {
			frames.restore();
		}
	}
});

test("composition scheduler authority calls during mount reject without touching the raw scheduler", async () => {
	for (const action of schedulerAuthorityActions) {
		const frames = installAnimationFrameHarness();
		try {
			let frameCalls = 0;
			let compositionDisposals = 0;
			let resourceDisposals = 0;
			const engine = createVisualEngine({ mediaClock: clock, createComposition: () => ({
				async mount(context) {
					context.resources.register({ owner: action.name, kind: "timer", retention: "ephemeral", dispose() { resourceDisposals += 1; } });
					context.scheduler.registerRuntimeCallbacks({ onAnimation() {} });
					action.invoke(context.scheduler);
				},
				applyFrameSnapshot() { frameCalls += 1; },
				applyPreset() {}, setVisibility() {}, dispose() { compositionDisposals += 1; },
			}) });
			await expectRejected(engine.mount(document.createElement("div")), "ownership");
			expect(frameCalls).toBe(0);
			expect(compositionDisposals).toBe(1);
			expect(resourceDisposals).toBe(1);
			expect(frames.requested).toBe(0);
			expect(frames.cancelled).toEqual([]);
		} finally {
			frames.restore();
		}
	}
});

test("scheduler authority violations after mount leave mode cadence and handle unchanged", async () => {
	for (const action of schedulerAuthorityActions) {
		const frames = installAnimationFrameHarness();
		try {
			const captured: { scheduler: VisualEngineCompositionContext["scheduler"] | null } = { scheduler: null };
			let compositionDisposals = 0;
			const decisions: boolean[] = [];
			const engine = createVisualEngine({
				mediaClock: clock,
				initialVisibility: backgroundVisibility,
				createComposition: () => ({
					async mount(context) {
						captured.scheduler = context.scheduler;
						context.scheduler.registerRuntimeCallbacks({ onAnimation(_now, decision) { decisions.push(decision.run); } });
					},
					applyFrameSnapshot() {}, applyPreset() {}, setVisibility() {}, dispose() { compositionDisposals += 1; },
				}),
			});
			engine.setVisualSettings({
				...fixedSettings(60),
				backgroundPolicy: "keep",
				foregroundFramePolicy: { mode: "vsync" },
			});
			await engine.mount(document.createElement("div"));
			const scheduler = captured.scheduler;
			if (!scheduler) throw new Error("Expected captured scheduler.");

			expect(scheduler.getMode()).toBe("background");
			expect(() => action.invoke(scheduler)).toThrow("ownership");
			expect(scheduler.getMode()).toBe("background");
			expect(frames.requested).toBe(1);
			expect(frames.cancelled).toEqual([]);
			frames.callbacks.get(1)?.(0);
			frames.callbacks.get(2)?.(16);
			expect(decisions).toEqual([true, true]);
			const liveRuntime = engine.getPerformanceSnapshot().runtime;
			expect(liveRuntime.mounted).toBe(true);
			expect(liveRuntime.running).toBe(true);
			expect(compositionDisposals).toBe(0);

			engine.dispose();
			expect(frames.cancelled).toEqual([3]);
			expect(compositionDisposals).toBe(1);
			const disposedMode = scheduler.getMode();
			const disposedGeneration = scheduler.getGeneration();
			expect(() => action.invoke(scheduler)).toThrow("ownership");
			expect(scheduler.getMode()).toBe(disposedMode);
			expect(scheduler.getGeneration()).toBe(disposedGeneration);
		} finally {
			frames.restore();
		}
	}
});

for (const action of runtimeServiceAuthorityActions) {
	test(`caught root ${action.name} disposal during mount rejects before commit`, async () => {
		const frames = installAnimationFrameHarness();
		let engine: ReturnType<typeof createVisualEngine> | null = null;
		try {
			let caught = 0;
			let compositionDisposals = 0;
			engine = createVisualEngine({ mediaClock: clock, createComposition: () => ({
				async mount(context) {
					context.scheduler.registerRuntimeCallbacks({ onAnimation() {} });
					try {
						action.invoke(context);
					} catch {
						caught += 1;
					}
				},
				applyFrameSnapshot() {}, applyPreset() {}, setVisibility() {}, dispose() { compositionDisposals += 1; },
			}) });

			await expectRejected(engine.mount(document.createElement("div")), "ownership");
			expect(caught).toBe(1);
			expect(compositionDisposals).toBe(1);
			expect(frames.requested).toBe(0);
			const runtime = engine.getPerformanceSnapshot().runtime;
			expect(runtime.mounted).toBe(false);
			expect(runtime.running).toBe(false);
		} finally {
			engine?.dispose();
			frames.restore();
		}
	});

	test(`root ${action.name} disposal is rejected without touching the live service`, async () => {
		const frames = installAnimationFrameHarness();
		let engine: ReturnType<typeof createVisualEngine> | null = null;
		try {
			const captured: { context: VisualEngineCompositionContext | null } = { context: null };
			let compositionDisposals = 0;
			engine = createVisualEngine({ mediaClock: clock, createComposition: () => ({
				async mount(nextContext) {
					captured.context = nextContext;
					nextContext.scheduler.registerRuntimeCallbacks({ onAnimation() {} });
				},
				applyFrameSnapshot() {}, applyPreset() {}, setVisibility() {}, dispose() { compositionDisposals += 1; },
			}) });
			await engine.mount(document.createElement("div"));
			const context = captured.context;
			if (!context) throw new Error("Expected mounted composition context.");

			expect(() => action.invoke(context)).toThrow("ownership");
			if (action.name === "resources") {
				const handle = context.resources.register({ owner: "guard", kind: "timer", retention: "ephemeral", dispose() {} });
				expect(handle.disposed).toBe(false);
				handle.dispose();
			} else {
				expect(context.tasks.enqueue({ owner: "guard", key: "live", priority: "critical", cost: 1, run() {}, commit() {} })).toBe(true);
				context.tasks.cancelOwner("guard");
			}
			expect(() => engine?.setPlaybackSnapshot(playbackSnapshot("still-live"))).not.toThrow();
			const runtime = engine.getPerformanceSnapshot().runtime;
			expect(runtime.mounted).toBe(true);
			expect(runtime.running).toBe(true);
			expect(compositionDisposals).toBe(0);
			expect(frames.cancelled).toEqual([]);
		} finally {
			engine?.dispose();
			frames.restore();
		}
	});

	test(`caught root ${action.name} disposal from a mounted delegate fails closed`, async () => {
		const frames = installAnimationFrameHarness();
		let engine: ReturnType<typeof createVisualEngine> | null = null;
		try {
			let context: VisualEngineCompositionContext | null = null;
			let armed = false;
			let caught = 0;
			let compositionDisposals = 0;
			engine = createVisualEngine({ mediaClock: clock, createComposition: () => ({
				async mount(nextContext) {
					context = nextContext;
					nextContext.scheduler.registerRuntimeCallbacks({ onAnimation() {} });
				},
				applyFrameSnapshot() {
					if (!armed || !context) return;
					try {
						action.invoke(context);
					} catch {
						caught += 1;
					}
				},
				applyPreset() {}, setVisibility() {}, dispose() { compositionDisposals += 1; },
			}) });
			await engine.mount(document.createElement("div"));
			armed = true;

			expect(() => engine?.setPlaybackSnapshot(playbackSnapshot(action.name))).toThrow("ownership");
			expect(caught).toBe(1);
			expect(compositionDisposals).toBe(1);
			expect(frames.cancelled).toEqual([1]);
			const runtime = engine.getPerformanceSnapshot().runtime;
			expect(runtime.mounted).toBe(false);
			expect(runtime.running).toBe(false);
		} finally {
			engine?.dispose();
			frames.restore();
		}
	});
}

for (const action of schedulerAuthorityActions) {
	test(`caught scheduler ${action.name} ownership inside a mounted frame delegate fails closed`, async () => {
		const frames = installAnimationFrameHarness();
		let engine: ReturnType<typeof createVisualEngine> | null = null;
		try {
			const captured: { context: VisualEngineCompositionContext | null } = { context: null };
			let armed = false;
			let caught = 0;
			let compositionDisposals = 0;
			let resourceDisposals = 0;
			engine = createVisualEngine({ mediaClock: clock, createComposition: () => ({
				async mount(context) {
					captured.context = context;
					context.resources.register({ owner: action.name, kind: "texture", retention: "persistent", estimatedBytes: 1, dispose() { resourceDisposals += 1; } });
					context.tasks.enqueue({ owner: action.name, key: "queued", priority: "critical", cost: 1, run() {}, commit() {} });
					context.scheduler.registerRuntimeCallbacks({ onAnimation() {} });
				},
				applyFrameSnapshot() {
					if (!armed || !captured.context) return;
					try {
						action.invoke(captured.context.scheduler);
					} catch {
						caught += 1;
					}
				},
				applyPreset() {}, setVisibility() {}, dispose() { compositionDisposals += 1; },
			}) });
			await engine.mount(document.createElement("div"));
			armed = true;

			expect(() => engine?.setPlaybackSnapshot(playbackSnapshot(action.name))).toThrow("ownership");
			expect(caught).toBe(1);
			expect(compositionDisposals).toBe(1);
			expect(resourceDisposals).toBe(1);
			expect(frames.cancelled).toEqual([1]);
			const disposed = engine.getPerformanceSnapshot();
			expect(disposed.runtime.mounted).toBe(false);
			expect(disposed.tasks.cancelled).toBe(1);
			expect(disposed.resources.releases).toBe(2);
			const generation = captured.context?.scheduler.getGeneration();
			engine.dispose();
			expect(captured.context?.scheduler.getGeneration()).toBe(generation);
			expect(compositionDisposals).toBe(1);
			expect(resourceDisposals).toBe(1);
		} finally {
			engine?.dispose();
			frames.restore();
		}
	});
}

for (const boundary of ["animation", "maintenance"] as const) {
	for (const action of runtimeCallbackInvalidationActions) {
		test(`${boundary} callback ${action.name} fails closed without rescheduling`, async () => {
			const frames = installAnimationFrameHarness();
			const timers = installTimerHarness();
			let engine: ReturnType<typeof createVisualEngine> | null = null;
			try {
				const captured: { context: VisualEngineCompositionContext | null } = { context: null };
				let callbackCalls = 0;
				let compositionDisposals = 0;
				let resourceDisposals = 0;
				engine = createVisualEngine({
					mediaClock: clock,
					initialVisibility: boundary === "maintenance" ? backgroundVisibility : foreground,
					createComposition: () => ({
						async mount(context) {
							captured.context = context;
							context.resources.register({ owner: action.name, kind: "texture", retention: "persistent", estimatedBytes: 1, dispose() { resourceDisposals += 1; } });
							context.tasks.enqueue({ owner: action.name, key: boundary, priority: "critical", cost: 1, run() {}, commit() {} });
							context.scheduler.registerRuntimeCallbacks({
								onAnimation() {
									if (boundary !== "animation") return;
									callbackCalls += 1;
									action.invoke(context);
								},
								onMaintenance() {
									if (boundary !== "maintenance") return;
									callbackCalls += 1;
									action.invoke(context);
								},
							});
						},
						applyFrameSnapshot() {}, applyPreset() {}, setVisibility() {}, dispose() { compositionDisposals += 1; },
					}),
				});
				await engine.mount(document.createElement("div"));
				const staleFrame = frames.callbacks.get(1);
				const staleTimer = timers.callbacks.get(1);
				expect(frames.requested).toBe(boundary === "animation" ? 1 : 0);
				expect(timers.requested).toBe(boundary === "maintenance" ? 1 : 0);

				const originalConsoleError = console.error;
				console.error = () => {};
				try {
					if (boundary === "animation") staleFrame?.(0);
					else staleTimer?.();
				} finally {
					console.error = originalConsoleError;
				}

				expect(callbackCalls).toBe(1);
				expect(frames.requested).toBe(boundary === "animation" ? 1 : 0);
				expect(timers.requested).toBe(boundary === "maintenance" ? 1 : 0);
				expect(compositionDisposals).toBe(1);
				expect(resourceDisposals).toBe(1);
				const disposed = engine.getPerformanceSnapshot();
				expect(disposed.runtime.mounted).toBe(false);
				expect(disposed.runtime.running).toBe(false);
				expect(disposed.tasks.cancelled).toBe(1);
				expect(disposed.resources.releases).toBe(2);
				const generation = captured.context?.scheduler.getGeneration();

				if (boundary === "animation") staleFrame?.(16);
				else staleTimer?.();
				engine.dispose();
				expect(callbackCalls).toBe(1);
				expect(frames.requested).toBe(boundary === "animation" ? 1 : 0);
				expect(timers.requested).toBe(boundary === "maintenance" ? 1 : 0);
				expect(captured.context?.scheduler.getGeneration()).toBe(generation);
				expect(compositionDisposals).toBe(1);
				expect(resourceDisposals).toBe(1);
			} finally {
				engine?.dispose();
				frames.restore();
				timers.restore();
			}
		});
	}

	test(`${boundary} callback ordinary errors remain isolated and keep scheduling`, async () => {
		const frames = installAnimationFrameHarness();
		const timers = installTimerHarness();
		let engine: ReturnType<typeof createVisualEngine> | null = null;
		try {
			let callbackCalls = 0;
			let compositionDisposals = 0;
			const runCallback = () => {
				callbackCalls += 1;
				if (callbackCalls === 1) throw new Error("ordinary callback failure");
			};
			engine = createVisualEngine({
				mediaClock: clock,
				initialVisibility: boundary === "maintenance" ? backgroundVisibility : foreground,
				createComposition: () => ({
					async mount(context) {
						context.scheduler.registerRuntimeCallbacks({
							onAnimation() { if (boundary === "animation") runCallback(); },
							onMaintenance() { if (boundary === "maintenance") runCallback(); },
						});
					},
					applyFrameSnapshot() {}, applyPreset() {}, setVisibility() {}, dispose() { compositionDisposals += 1; },
				}),
			});
			await engine.mount(document.createElement("div"));

			const originalConsoleError = console.error;
			console.error = () => {};
			try {
				if (boundary === "animation") {
					frames.callbacks.get(1)?.(0);
					frames.callbacks.get(2)?.(16);
				} else {
					timers.callbacks.get(1)?.();
					timers.callbacks.get(2)?.();
				}
			} finally {
				console.error = originalConsoleError;
			}

			expect(callbackCalls).toBe(2);
			expect(frames.requested).toBe(boundary === "animation" ? 3 : 0);
			expect(timers.requested).toBe(boundary === "maintenance" ? 3 : 0);
			expect(engine.getPerformanceSnapshot().runtime.mounted).toBe(true);
			expect(compositionDisposals).toBe(0);
			engine.dispose();
			expect(frames.cancelled).toEqual(boundary === "animation" ? [3] : []);
			expect(timers.cleared).toEqual(boundary === "maintenance" ? [3] : []);
			expect(compositionDisposals).toBe(1);
		} finally {
			engine?.dispose();
			frames.restore();
			timers.restore();
		}
	});
}

test("unregistering runtime callbacks after mount immediately disposes the facade", async () => {
	const frames = installAnimationFrameHarness();
	try {
		let unregister: (() => void) | null = null;
		let compositionDisposals = 0;
		const engine = createVisualEngine({ mediaClock: clock, createComposition: () => ({
			async mount(context) {
				unregister = context.scheduler.registerRuntimeCallbacks({ onAnimation() {} });
			},
			applyFrameSnapshot() {}, applyPreset() {}, setVisibility() {},
			dispose() {
				compositionDisposals += 1;
				unregister?.();
			},
		}) });
		await engine.mount(document.createElement("div"));
		if (!unregister) throw new Error("Expected unregister callback.");

		expect(() => unregister?.()).not.toThrow();
		expect(frames.requested).toBe(1);
		expect(frames.cancelled).toEqual([1]);
		const disposedRuntime = engine.getPerformanceSnapshot().runtime;
		expect(disposedRuntime.mounted).toBe(false);
		expect(disposedRuntime.running).toBe(false);
		expect(compositionDisposals).toBe(1);
		expect(() => unregister?.()).not.toThrow();
		engine.dispose();
		expect(frames.cancelled).toEqual([1]);
		expect(compositionDisposals).toBe(1);
	} finally {
		frames.restore();
	}
});

test("cleanup reports the scheduler stopped before composition disposal reentrancy", async () => {
	const frames = installAnimationFrameHarness();
	try {
		let observedRuntime: { readonly mounted: boolean; readonly running: boolean } | null = null;
		let engine: ReturnType<typeof createVisualEngine>;
		engine = createVisualEngine({ mediaClock: clock, createComposition: () => ({
			async mount(context) {
				context.scheduler.registerRuntimeCallbacks({ onAnimation() {} });
			},
			applyFrameSnapshot() {}, applyPreset() {}, setVisibility() {},
			dispose() {
				const runtime = engine.getPerformanceSnapshot().runtime;
				observedRuntime = { mounted: runtime.mounted, running: runtime.running };
			},
		}) });
		await engine.mount(document.createElement("div"));

		engine.dispose();

		expect(frames.cancelled).toEqual([1]);
		expect(observedRuntime).toEqual({ mounted: false, running: false });
	} finally {
		frames.restore();
	}
});

test("mounted facade serializes same-type reentrant delegates and applies the latest value", async () => {
	const frames = installAnimationFrameHarness();
	try {
		type ActiveDelegate = "frame" | "settings" | "visibility" | "preset";
		let activeDelegate: ActiveDelegate | null = null;
		let delegateDepth = 0;
		let maxDelegateDepth = 0;
		const frameTracks: string[] = [];
		const settingsRates: number[] = [];
		const visibilityStates: boolean[] = [];
		const presets: number[] = [];
		const captured: { context: VisualEngineCompositionContext | null } = { context: null };
		let engine: ReturnType<typeof createVisualEngine>;
		const runDelegate = (operation: () => void) => {
			delegateDepth += 1;
			maxDelegateDepth = Math.max(maxDelegateDepth, delegateDepth);
			try {
				operation();
			} finally {
				delegateDepth -= 1;
			}
		};
		engine = createVisualEngine({ mediaClock: clock, createComposition: () => ({
			async mount(context) {
				captured.context = context;
				context.scheduler.registerRuntimeCallbacks({ onAnimation() {} });
			},
			applyFrameSnapshot(snapshot) {
				if (activeDelegate === "frame") {
					runDelegate(() => {
						frameTracks.push(snapshot.playback.trackKey);
						if (snapshot.playback.trackKey === "outer") engine.setPlaybackSnapshot(playbackSnapshot("inner"));
					});
					return;
				}
				if (activeDelegate !== "settings") return;
				runDelegate(() => {
					const policy = snapshot.settings.foregroundFramePolicy;
					const fps = policy.mode === "fixed" ? policy.fps : 0;
					settingsRates.push(fps);
					if (fps === 30) engine.setVisualSettings(fixedSettings(60));
				});
			},
			applyPreset(preset) {
				if (activeDelegate !== "preset") return;
				runDelegate(() => {
					presets.push(preset);
					if (preset === 1) engine.applyPreset(2);
				});
			},
			setVisibility(state) {
				if (activeDelegate !== "visibility") return;
				runDelegate(() => {
					visibilityStates.push(state.documentVisible);
					if (!state.documentVisible) engine.setVisibility(foreground);
				});
			},
			dispose() {},
		}) });
		await engine.mount(document.createElement("div"));

		activeDelegate = "frame";
		maxDelegateDepth = 0;
		engine.setPlaybackSnapshot(playbackSnapshot("outer"));
		expect(frameTracks).toEqual(["outer", "inner"]);
		expect(maxDelegateDepth).toBe(1);
		expect(captured.context?.getFrameSnapshot().playback.trackKey).toBe("inner");

		activeDelegate = "settings";
		maxDelegateDepth = 0;
		engine.setVisualSettings(fixedSettings(30));
		expect(settingsRates).toEqual([30, 60]);
		expect(maxDelegateDepth).toBe(1);
		expect(captured.context?.getFrameSnapshot().settings.foregroundFramePolicy).toEqual({ mode: "fixed", fps: 60 });

		activeDelegate = "visibility";
		maxDelegateDepth = 0;
		engine.setVisibility(backgroundVisibility);
		expect(visibilityStates).toEqual([false, true]);
		expect(maxDelegateDepth).toBe(1);
		expect(captured.context?.scheduler.getMode()).toBe("foreground");

		activeDelegate = "preset";
		maxDelegateDepth = 0;
		engine.applyPreset(1);
		expect(presets).toEqual([1, 2]);
		expect(maxDelegateDepth).toBe(1);
		engine.dispose();
	} finally {
		frames.restore();
	}
});

test("mounted facade serializes cross-type reentrancy and converges cache raw scheduler and composition", async () => {
	const frames = installAnimationFrameHarness();
	try {
		const latestSettings: VisualSettingsSnapshot = {
			...fixedSettings(30),
			backgroundPolicy: "keep",
		};
		const frameStates: { readonly trackKey: string; readonly fps: number }[] = [];
		const visibilityStates: boolean[] = [];
		const presets: number[] = [];
		const decisions: boolean[] = [];
		const captured: { context: VisualEngineCompositionContext | null } = { context: null };
		let armed = false;
		let frameTriggered = false;
		let visibilityTriggered = false;
		let delegateDepth = 0;
		let maxDelegateDepth = 0;
		let engine: ReturnType<typeof createVisualEngine>;
		const runDelegate = (operation: () => void) => {
			delegateDepth += 1;
			maxDelegateDepth = Math.max(maxDelegateDepth, delegateDepth);
			try {
				operation();
			} finally {
				delegateDepth -= 1;
			}
		};
		engine = createVisualEngine({ mediaClock: clock, createComposition: () => ({
			async mount(context) {
				captured.context = context;
				context.scheduler.registerRuntimeCallbacks({ onAnimation(_now, decision) { decisions.push(decision.run); } });
			},
			applyFrameSnapshot(snapshot) {
				if (!armed) return;
				runDelegate(() => {
					const policy = snapshot.settings.foregroundFramePolicy;
					frameStates.push({
						trackKey: snapshot.playback.trackKey,
						fps: policy.mode === "fixed" ? policy.fps : 0,
					});
					if (frameTriggered || snapshot.playback.trackKey !== "outer") return;
					frameTriggered = true;
					engine.setVisualSettings(latestSettings);
					engine.setVisibility(backgroundVisibility);
					engine.applyPreset(7);
				});
			},
			applyPreset(preset) {
				if (!armed) return;
				runDelegate(() => { presets.push(preset); });
			},
			setVisibility(state) {
				if (!armed) return;
				runDelegate(() => {
					visibilityStates.push(state.documentVisible);
					if (visibilityTriggered || state.documentVisible) return;
					visibilityTriggered = true;
					engine.setPlaybackSnapshot(playbackSnapshot("from-visibility"));
				});
			},
			dispose() {},
		}) });
		await engine.mount(document.createElement("div"));
		armed = true;

		engine.setPlaybackSnapshot(playbackSnapshot("outer"));

		expect(maxDelegateDepth).toBe(1);
		expect(frameStates.at(-1)).toEqual({ trackKey: "from-visibility", fps: 30 });
		expect(visibilityStates.at(-1)).toBe(false);
		expect(presets).toEqual([7]);
		expect(captured.context?.getFrameSnapshot().playback.trackKey).toBe("from-visibility");
		expect(captured.context?.getFrameSnapshot().settings).toBe(latestSettings);
		expect(captured.context?.scheduler.getMode()).toBe("background");
		const activeHandle = frames.requested;
		frames.callbacks.get(activeHandle)?.(0);
		frames.callbacks.get(activeHandle + 1)?.(16);
		expect(decisions).toEqual([true, false]);
		engine.dispose();
	} finally {
		frames.restore();
	}
});

test("mounted delegate dispatch fails closed when reentrancy never stabilizes", async () => {
	type ReentrantKind = "frame" | "visibility" | "preset";
	const kinds: readonly ReentrantKind[] = ["frame", "visibility", "preset"];
	for (const kind of kinds) {
		const frames = installAnimationFrameHarness();
		try {
			let armed = false;
			let calls = 0;
			let delegateDepth = 0;
			let maxDelegateDepth = 0;
			let compositionDisposals = 0;
			let engine: ReturnType<typeof createVisualEngine>;
			const invoke = (value: number) => {
				if (kind === "frame") engine.setPlaybackSnapshot(playbackSnapshot(String(value)));
				else if (kind === "visibility") engine.setVisibility(backgroundVisibility);
				else engine.applyPreset(value);
			};
			const reenter = () => {
				if (!armed) return;
				delegateDepth += 1;
				maxDelegateDepth = Math.max(maxDelegateDepth, delegateDepth);
				try {
					calls += 1;
					if (calls < 100) invoke(calls);
				} finally {
					delegateDepth -= 1;
				}
			};
			engine = createVisualEngine({ mediaClock: clock, createComposition: () => ({
				async mount(context) { context.scheduler.registerRuntimeCallbacks({ onAnimation() {} }); },
				applyFrameSnapshot() { if (kind === "frame") reenter(); },
				applyPreset() { if (kind === "preset") reenter(); },
				setVisibility() { if (kind === "visibility") reenter(); },
				dispose() { compositionDisposals += 1; },
			}) });
			await engine.mount(document.createElement("div"));
			armed = true;

			expect(() => invoke(0)).toThrow("stabilize");
			expect(calls).toBeGreaterThan(1);
			expect(calls).toBeLessThan(100);
			expect(maxDelegateDepth).toBe(1);
			expect(compositionDisposals).toBe(1);
			expect(engine.getPerformanceSnapshot().runtime.mounted).toBe(false);
			expect(frames.cancelled).toHaveLength(1);
		} finally {
			frames.restore();
		}
	}
});

test("mounted dispatch cleans up when a delegate closes the cancellation scope", async () => {
	const frames = installAnimationFrameHarness();
	try {
		let armed = false;
		let compositionDisposals = 0;
		let context: VisualEngineCompositionContext | null = null;
		const engine = createVisualEngine({ mediaClock: clock, createComposition: () => ({
			async mount(nextContext) {
				context = nextContext;
				nextContext.scheduler.registerRuntimeCallbacks({ onAnimation() {} });
			},
			applyFrameSnapshot() {
				if (armed) context?.cancellation.dispose();
			},
			applyPreset() {}, setVisibility() {}, dispose() { compositionDisposals += 1; },
		}) });
		await engine.mount(document.createElement("div"));
		armed = true;

		expect(() => engine.setPlaybackSnapshot(playbackSnapshot("cancel"))).not.toThrow();

		const runtime = engine.getPerformanceSnapshot().runtime;
		expect(runtime.mounted).toBe(false);
		expect(runtime.running).toBe(false);
		expect(compositionDisposals).toBe(1);
		expect(frames.cancelled).toEqual([1]);
	} finally {
		frames.restore();
	}
});

test("a mounted frame delegate failure invalidates and cleans up the facade", async () => {
	const frames = installAnimationFrameHarness();
	try {
		let failFrame = false;
		let disposed = 0;
		const engine = createVisualEngine({ mediaClock: clock, createComposition: () => ({
			async mount(context) { context.scheduler.registerRuntimeCallbacks({ onAnimation() {} }); },
			applyFrameSnapshot() { if (failFrame) throw new Error("frame delegate failed"); },
			applyPreset() {}, setVisibility() {}, dispose() { disposed += 1; },
		}) });
		await engine.mount(document.createElement("div"));
		failFrame = true;
		expect(() => engine.setPlaybackSnapshot({ trackKey: "failed", playing: false, durationMs: null, coverUrl: "", beatMapKey: "", beatMap: null, splashActive: false, homeActive: false })).toThrow("frame delegate failed");
		const performance = engine.getPerformanceSnapshot();
		expect(performance.runtime.mounted).toBe(false);
		expect(performance.runtime.running).toBe(false);
		expect(disposed).toBe(1);
		expect(frames.requested).toBe(1);
		expect(frames.cancelled).toEqual([1]);
	} finally {
		frames.restore();
	}
});

test("mounted settings visibility and preset delegate failures all fail closed", async () => {
	type FailureCase = {
		readonly name: "settings" | "visibility" | "preset";
		invoke(engine: ReturnType<typeof createVisualEngine>): void;
	};
	const cases: readonly FailureCase[] = [
		{ name: "settings", invoke: (engine) => engine.setVisualSettings(fixedSettings(30)) },
		{ name: "visibility", invoke: (engine) => engine.setVisibility({ ...foreground, windowFocused: false }) },
		{ name: "preset", invoke: (engine) => engine.applyPreset(4) },
	];
	for (const failure of cases) {
		let armed = false;
		let disposed = 0;
		const engine = createVisualEngine({ mediaClock: clock, createComposition: () => ({
			async mount(context) { context.scheduler.registerRuntimeCallbacks({ onAnimation() {} }); },
			applyFrameSnapshot() {
				if (armed && failure.name === "settings") throw new Error("settings delegate failed");
			},
			applyPreset() {
				if (armed && failure.name === "preset") throw new Error("preset delegate failed");
			},
			setVisibility() {
				if (armed && failure.name === "visibility") throw new Error("visibility delegate failed");
			},
			dispose() { disposed += 1; },
		}) });
		await engine.mount(document.createElement("div"));
		armed = true;
		expect(() => failure.invoke(engine)).toThrow(`${failure.name} delegate failed`);
		const performance = engine.getPerformanceSnapshot();
		expect(performance.runtime.mounted).toBe(false);
		expect(performance.runtime.running).toBe(false);
		expect(disposed).toBe(1);
	}
});

test("mounted delegate reentrant disposal is idempotent and preserves later throws", async () => {
	for (const throwAfterDispose of [false, true]) {
		let armed = false;
		let disposed = 0;
		let engine: ReturnType<typeof createVisualEngine>;
		engine = createVisualEngine({ mediaClock: clock, createComposition: () => ({
			async mount(context) { context.scheduler.registerRuntimeCallbacks({ onAnimation() {} }); },
			applyFrameSnapshot() {},
			applyPreset() {
				if (!armed) return;
				engine.dispose();
				if (throwAfterDispose) throw new Error("throw after reentrant dispose");
			},
			setVisibility() {},
			dispose() { disposed += 1; },
		}) });
		await engine.mount(document.createElement("div"));
		armed = true;
		if (throwAfterDispose) {
			expect(() => engine.applyPreset(2)).toThrow("throw after reentrant dispose");
		} else {
			expect(() => engine.applyPreset(2)).not.toThrow();
		}
		expect(disposed).toBe(1);
		expect(engine.getPerformanceSnapshot().runtime.mounted).toBe(false);
	}
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

test("composition resources project texture geometry mesh and cache usage into performance", async () => {
	let disposerCalls = 0;
	const engine = createVisualEngine({ mediaClock: clock, createComposition: () => ({
		async mount(context) {
			context.scheduler.registerRuntimeCallbacks({ onAnimation() {} });
			context.resources.register({ owner: "texture", kind: "texture", retention: "persistent", estimatedBytes: 10, dispose() { disposerCalls += 1; } });
			context.resources.register({ owner: "geometry", kind: "geometry", retention: "rebuildable", estimatedBytes: 20, dispose() { disposerCalls += 1; } });
			context.resources.register({ owner: "mesh", kind: "mesh", retention: "ephemeral", dispose() { disposerCalls += 1; } });
			context.resources.register({ owner: "cache", kind: "cache", retention: "ephemeral", estimatedBytes: 30, dispose() { disposerCalls += 1; } });
		},
		applyFrameSnapshot() {}, applyPreset() {}, setVisibility() {}, dispose() {},
	}) });
	await engine.mount(document.createElement("div"));
	const live = engine.getPerformanceSnapshot();
	expect(live.resources.current).toEqual({ textureBytes: 10, geometryBytes: 20, meshCount: 1, queuedTaskCost: 0, cacheBytes: 30 });
	expect(live.resources.peak).toEqual(live.resources.current);
	expect(live.resources.allocations).toBe(4);
	expect(live.resources.releases).toBe(0);

	engine.dispose();
	const disposed = engine.getPerformanceSnapshot();
	expect(disposerCalls).toBe(4);
	expect(disposed.resources.current).toEqual({ textureBytes: 0, geometryBytes: 0, meshCount: 0, queuedTaskCost: 0, cacheBytes: 0 });
	expect(disposed.resources.releases).toBe(4);
});

test("resource handles retention release child scopes and root disposal release leases once", async () => {
	const captured: {
		root: VisualResourceScope | null;
		child: VisualResourceScope | null;
		texture: VisualResourceHandle | null;
	} = { root: null, child: null, texture: null };
	const disposals = { texture: 0, geometry: 0, mesh: 0, cache: 0 };
	const engine = createVisualEngine({ mediaClock: clock, createComposition: () => ({
		async mount(context) {
			context.scheduler.registerRuntimeCallbacks({ onAnimation() {} });
			captured.root = context.resources;
			captured.child = context.resources.createChild("child");
			captured.texture = captured.child.register({ owner: "texture", kind: "texture", retention: "persistent", estimatedBytes: 5, dispose() { disposals.texture += 1; } });
			captured.child.register({ owner: "geometry", kind: "geometry", retention: "rebuildable", estimatedBytes: 6, dispose() { disposals.geometry += 1; throw new Error("geometry dispose failed"); } });
			captured.child.register({ owner: "mesh", kind: "mesh", retention: "ephemeral", dispose() { disposals.mesh += 1; } });
			context.resources.register({ owner: "cache", kind: "cache", retention: "persistent", estimatedBytes: 7, dispose() { disposals.cache += 1; } });
		},
		applyFrameSnapshot() {}, applyPreset() {}, setVisibility() {}, dispose() {},
	}) });
	await engine.mount(document.createElement("div"));
	if (!captured.root || !captured.child || !captured.texture) throw new Error("Expected captured resource handles.");

	captured.texture.dispose();
	captured.texture.dispose();
	const geometryRelease = captured.root.releaseRetention("rebuildable");
	const duplicateGeometryRelease = captured.root.releaseRetention("rebuildable");
	captured.child.releaseRetention("ephemeral");
	captured.child.releaseRetention("ephemeral");
	const retained = engine.getPerformanceSnapshot();
	expect(disposals).toEqual({ texture: 1, geometry: 1, mesh: 1, cache: 0 });
	expect(geometryRelease.errors).toHaveLength(1);
	expect(duplicateGeometryRelease.errors).toHaveLength(0);
	expect(retained.resources.current).toEqual({ textureBytes: 0, geometryBytes: 0, meshCount: 0, queuedTaskCost: 0, cacheBytes: 7 });
	expect(retained.resources.allocations).toBe(4);
	expect(retained.resources.releases).toBe(3);

	engine.dispose();
	engine.dispose();
	expect(disposals).toEqual({ texture: 1, geometry: 1, mesh: 1, cache: 1 });
	expect(engine.getPerformanceSnapshot().resources.releases).toBe(4);
});

test("hard budget denial rejects optional and background registrations with mount rollback", async () => {
	type DenialCase = {
		readonly kind: "texture" | "cache";
		readonly retention: "ephemeral" | "persistent";
		readonly resourceBudget: { readonly textureBytes?: number; readonly cacheBytes?: number };
	};
	const cases: readonly DenialCase[] = [
		{ kind: "texture", retention: "ephemeral", resourceBudget: { textureBytes: 0 } },
		{ kind: "cache", retention: "persistent", resourceBudget: { cacheBytes: 0 } },
	];
	for (const denial of cases) {
		let compositionDisposals = 0;
		let resourceDisposals = 0;
		let frameCalls = 0;
		const engine = createVisualEngine({
			mediaClock: clock,
			resourceBudget: denial.resourceBudget,
			createComposition: () => ({
				async mount(context) {
					context.resources.register({ owner: denial.kind, kind: denial.kind, retention: denial.retention, estimatedBytes: 1, dispose() { resourceDisposals += 1; } });
				},
				applyFrameSnapshot() { frameCalls += 1; }, applyPreset() {}, setVisibility() {}, dispose() { compositionDisposals += 1; },
			}),
		});
		await expectRejected(engine.mount(document.createElement("div")), "budget denied");
		expect(compositionDisposals).toBe(1);
		expect(resourceDisposals).toBe(0);
		expect(frameCalls).toBe(0);
		const performance = engine.getPerformanceSnapshot();
		expect(performance.resources.allocations).toBe(0);
		expect(performance.resources.current[denial.kind === "texture" ? "textureBytes" : "cacheBytes"]).toBe(0);
	}
});

test("a raw resource registration failure releases its admitted lease", async () => {
	const engine = createVisualEngine({ mediaClock: clock, createComposition: () => ({
		async mount(context) {
			const child = context.resources.createChild("closed");
			child.dispose();
			child.register({ owner: "closed", kind: "texture", retention: "persistent", estimatedBytes: 9, dispose() {} });
		},
		applyFrameSnapshot() {}, applyPreset() {}, setVisibility() {}, dispose() {},
	}) });
	await expectRejected(engine.mount(document.createElement("div")), "closed");
	const performance = engine.getPerformanceSnapshot();
	expect(performance.resources.current.textureBytes).toBe(0);
	expect(performance.resources.allocations).toBe(1);
	expect(performance.resources.releases).toBe(1);
});

test("dispose cancels queued and running context tasks while releasing ledger cost", async () => {
	const completion = deferred();
	const running: { signal: AbortSignal | null } = { signal: null };
	const engine = createVisualEngine({ mediaClock: clock, createComposition: () => ({
		async mount(context) {
			context.scheduler.registerRuntimeCallbacks({ onAnimation() {} });
			context.tasks.enqueue({
				owner: "test",
				key: "running",
				priority: "critical",
				cost: 1,
				run(taskContext) { running.signal = taskContext.signal; return completion.promise; },
				commit() {},
			});
			context.tasks.enqueue({
				owner: "test",
				key: "queued",
				priority: "normal",
				cost: 7,
				run() {},
				commit() {},
			});
			context.tasks.runSlice(1);
		},
		applyFrameSnapshot() {}, applyPreset() {}, setVisibility() {}, dispose() {},
	}) });
	await engine.mount(document.createElement("div"));
	const live = engine.getPerformanceSnapshot();
	expect(live.tasks.running).toBe(1);
	expect(live.tasks.queued).toBe(1);
	expect(live.resources.current.queuedTaskCost).toBe(7);

	engine.dispose();
	expect(running.signal?.aborted).toBe(true);
	const disposed = engine.getPerformanceSnapshot();
	expect(disposed.tasks.running).toBe(0);
	expect(disposed.tasks.queued).toBe(0);
	expect(disposed.tasks.cancelled).toBe(2);
	expect(disposed.resources.current.queuedTaskCost).toBe(0);
	expect(disposed.resources.releases).toBe(2);
	completion.resolve();
});
