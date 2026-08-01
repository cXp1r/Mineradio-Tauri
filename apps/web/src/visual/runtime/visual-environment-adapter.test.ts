import { expect, test } from "bun:test";
import { createVisualEnvironmentAdapter } from "./visual-environment-adapter";

interface ListenerTarget {
	addEventListener(type: string, listener: () => void): void;
	removeEventListener(type: string, listener: () => void): void;
}

function createListenerTarget(): ListenerTarget & { emit(type: string): void; count(type: string): number } {
	const listeners = new Map<string, Set<() => void>>();
	return {
		addEventListener(type, listener) {
			let values = listeners.get(type);
			if (!values) listeners.set(type, values = new Set());
			values.add(listener);
		},
		removeEventListener(type, listener) {
			listeners.get(type)?.delete(listener);
		},
		emit(type) {
			for (const listener of [...(listeners.get(type) ?? [])]) listener();
		},
		count(type) {
			return listeners.get(type)?.size ?? 0;
		},
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((next) => { resolve = next; });
	return { promise, resolve };
}

function createReducedMotionQuery(initialMatches: boolean) {
	const listeners = new Set<() => void>();
	let matches = initialMatches;
	return {
		get matches() { return matches; },
		addEventListener(type: "change", listener: () => void) {
			if (type === "change") listeners.add(listener);
		},
		removeEventListener(type: "change", listener: () => void) {
			if (type === "change") listeners.delete(listener);
		},
		emit(nextMatches: boolean) {
			matches = nextMatches;
			for (const listener of [...listeners]) listener();
		},
		listenerCount() {
			return listeners.size;
		},
	};
}

test("visual environment adapter tracks browser visibility, focus, blur, and unsubscribes cleanly", () => {
	const documentTarget = createListenerTarget();
	const windowTarget = createListenerTarget();
	let visibilityState: DocumentVisibilityState = "visible";
	let focused = true;
	const adapter = createVisualEnvironmentAdapter({
		document: {
			...documentTarget,
			get visibilityState() { return visibilityState; },
			hasFocus: () => focused,
		},
		window: windowTarget,
		isNativeRuntime: () => false,
	});
	const snapshots: unknown[] = [];
	const unsubscribe = adapter.subscribe((snapshot) => snapshots.push(snapshot));

	expect(snapshots.at(-1)).toEqual({
		documentVisible: true,
		windowVisible: true,
		windowFocused: true,
		windowMinimized: false,
	});
	visibilityState = "hidden";
	documentTarget.emit("visibilitychange");
	expect(snapshots.at(-1)).toEqual({
		documentVisible: false,
		windowVisible: true,
		windowFocused: true,
		windowMinimized: false,
	});
	focused = false;
	windowTarget.emit("blur");
	expect(snapshots.at(-1)).toEqual({
		documentVisible: false,
		windowVisible: true,
		windowFocused: false,
		windowMinimized: false,
	});
	focused = true;
	windowTarget.emit("focus");
	expect(snapshots.at(-1)).toEqual({
		documentVisible: false,
		windowVisible: true,
		windowFocused: true,
		windowMinimized: false,
	});

	unsubscribe();
	expect(documentTarget.count("visibilitychange")).toBe(0);
	expect(windowTarget.count("focus")).toBe(0);
	expect(windowTarget.count("blur")).toBe(0);
	visibilityState = "visible";
	documentTarget.emit("visibilitychange");
	expect(snapshots.length).toBe(4);
});

test("visual environment adapter suppresses duplicate states and cleans the reduced-motion listener", () => {
	const documentTarget = createListenerTarget();
	const windowTarget = createListenerTarget();
	const reducedMotionQuery = createReducedMotionQuery(true);
	const adapter = createVisualEnvironmentAdapter({
		document: { ...documentTarget, visibilityState: "visible", hasFocus: () => true },
		window: windowTarget,
		reducedMotionMediaQuery: reducedMotionQuery,
	});
	const snapshots: unknown[] = [];
	const unsubscribe = adapter.subscribe((snapshot) => snapshots.push(snapshot));

	expect(adapter.getPrefersReducedMotion()).toBe(true);
	expect(snapshots.length).toBe(1);
	documentTarget.emit("visibilitychange");
	windowTarget.emit("focus");
	expect(snapshots.length).toBe(1);

	reducedMotionQuery.emit(false);
	expect(adapter.getPrefersReducedMotion()).toBe(false);
	expect(reducedMotionQuery.listenerCount()).toBe(1);
	unsubscribe();
	expect(reducedMotionQuery.listenerCount()).toBe(0);
	adapter.dispose();
	adapter.dispose();
});

test("visual environment adapter falls back to a complete legacy reduced-motion listener pair", () => {
	const documentTarget = createListenerTarget();
	const windowTarget = createListenerTarget();
	const listeners = new Set<() => void>();
	let matches = false;
	const adapter = createVisualEnvironmentAdapter({
		document: { ...documentTarget, visibilityState: "visible", hasFocus: () => true },
		window: windowTarget,
		reducedMotionMediaQuery: {
			get matches() { return matches; },
			addEventListener() {},
			addListener(listener) { listeners.add(listener); },
			removeListener(listener) { listeners.delete(listener); },
		},
	});
	const unsubscribe = adapter.subscribe(() => {});

	expect(listeners.size).toBe(1);
	matches = true;
	for (const listener of [...listeners]) listener();
	expect(adapter.getPrefersReducedMotion()).toBe(true);
	unsubscribe();
	expect(listeners.size).toBe(0);
});

test("visual environment adapter reads the browser reduced-motion query when no test source is supplied", () => {
	const documentTarget = createListenerTarget();
	const windowTarget = createListenerTarget();
	const reducedMotionQuery = createReducedMotionQuery(true);
	let queried = "";
	const adapter = createVisualEnvironmentAdapter({
		document: { ...documentTarget, visibilityState: "visible", hasFocus: () => true },
		window: {
			...windowTarget,
			matchMedia(query: string) {
				queried = query;
				return reducedMotionQuery;
			},
		},
	});
	const unsubscribe = adapter.subscribe(() => {});

	expect(queried).toBe("(prefers-reduced-motion: reduce)");
	expect(adapter.getPrefersReducedMotion()).toBe(true);
	unsubscribe();
});

test("resubscribe samples focus and reduced motion changes that occurred without listeners", () => {
	const documentTarget = createListenerTarget();
	const windowTarget = createListenerTarget();
	const reducedMotionQuery = createReducedMotionQuery(false);
	let focused = true;
	const adapter = createVisualEnvironmentAdapter({
		document: {
			...documentTarget,
			visibilityState: "visible",
			hasFocus: () => focused,
		},
		window: windowTarget,
		reducedMotionMediaQuery: reducedMotionQuery,
	});
	const firstSnapshots: unknown[] = [];
	const unsubscribeFirst = adapter.subscribe((snapshot) => firstSnapshots.push(snapshot));
	expect(firstSnapshots.at(-1)).toEqual({
		documentVisible: true,
		windowVisible: true,
		windowFocused: true,
		windowMinimized: false,
	});
	expect(adapter.getPrefersReducedMotion()).toBe(false);
	unsubscribeFirst();

	focused = false;
	reducedMotionQuery.emit(true);
	const secondSnapshots: unknown[] = [];
	const unsubscribeSecond = adapter.subscribe((snapshot) => secondSnapshots.push(snapshot));
	expect(secondSnapshots.at(-1)).toEqual({
		documentVisible: true,
		windowVisible: true,
		windowFocused: false,
		windowMinimized: false,
	});
	expect(adapter.getPrefersReducedMotion()).toBe(true);
	unsubscribeSecond();
});

test("lifecycle resamples focus and reduced motion after listener installation", () => {
	const documentTarget = createListenerTarget();
	const windowTarget = createListenerTarget();
	const reducedMotionListeners = new Set<() => void>();
	let focused = true;
	let matches = false;
	const adapter = createVisualEnvironmentAdapter({
		document: {
			...documentTarget,
			visibilityState: "visible",
			hasFocus: () => focused,
		},
		window: {
			addEventListener(type, listener) {
				windowTarget.addEventListener(type, listener);
				if (type === "focus") {
					focused = false;
					listener();
				}
			},
			removeEventListener: windowTarget.removeEventListener,
		},
		reducedMotionMediaQuery: {
			get matches() { return matches; },
			addEventListener(type, listener) {
				if (type !== "change") return;
				reducedMotionListeners.add(listener);
				matches = true;
				listener();
			},
			removeEventListener(type, listener) {
				if (type === "change") reducedMotionListeners.delete(listener);
			},
		},
	});
	const snapshots: unknown[] = [];
	const unsubscribe = adapter.subscribe((snapshot) => snapshots.push(snapshot));

	expect(snapshots.at(-1)).toEqual({
		documentVisible: true,
		windowVisible: true,
		windowFocused: false,
		windowMinimized: false,
	});
	expect(adapter.getPrefersReducedMotion()).toBe(true);
	unsubscribe();
});

for (const failureMode of ["sync-listen", "async-listen", "initial-get"] as const) {
	test(`new native lifecycle clears stale hidden state before ${failureMode} failure`, async () => {
		const documentTarget = createListenerTarget();
		const windowTarget = createListenerTarget();
		const nativeListener: { current?: (state: { isVisible: boolean; isFocused: boolean; isMinimized: boolean }) => void } = {};
		let listenCalls = 0;
		let getCalls = 0;
		const adapter = createVisualEnvironmentAdapter({
			document: { ...documentTarget, visibilityState: "visible", hasFocus: () => true },
			window: windowTarget,
			nativeSource: {
				getWindowState: () => {
					getCalls += 1;
					if (failureMode === "initial-get" && getCalls === 2) {
						return Promise.reject(new Error("initial get failure"));
					}
					return Promise.resolve({ isVisible: true, isFocused: true, isMinimized: false });
				},
				listenWindowState: (listener) => {
					listenCalls += 1;
					if (listenCalls === 2 && failureMode === "sync-listen") {
						throw new Error("sync listen failure");
					}
					if (listenCalls === 2 && failureMode === "async-listen") {
						return Promise.reject(new Error("async listen failure"));
					}
					nativeListener.current = listener;
					return Promise.resolve(() => {});
				},
			},
		});
		const firstSnapshots: unknown[] = [];
		const unsubscribeFirst = adapter.subscribe((snapshot) => firstSnapshots.push(snapshot));
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		nativeListener.current?.({ isVisible: false, isFocused: false, isMinimized: true });
		expect(firstSnapshots.at(-1)).toEqual({
			documentVisible: true,
			windowVisible: false,
			windowFocused: false,
			windowMinimized: true,
		});
		unsubscribeFirst();

		const secondSnapshots: unknown[] = [];
		const unsubscribeSecond = adapter.subscribe((snapshot) => secondSnapshots.push(snapshot));
		expect(secondSnapshots[0]).toEqual({
			documentVisible: true,
			windowVisible: true,
			windowFocused: true,
			windowMinimized: false,
		});
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		expect(secondSnapshots.at(-1)).toEqual({
			documentVisible: true,
			windowVisible: true,
			windowFocused: true,
			windowMinimized: false,
		});
		unsubscribeSecond();
		expect(documentTarget.count("visibilitychange")).toBe(0);
		expect(windowTarget.count("focus")).toBe(0);
		expect(windowTarget.count("blur")).toBe(0);
	});
}

test("multiple subscriptions clean up independently and retain correct snapshots", () => {
	const documentTarget = createListenerTarget();
	const windowTarget = createListenerTarget();
	const reducedMotionQuery = createReducedMotionQuery(false);
	let focused = true;
	const adapter = createVisualEnvironmentAdapter({
		document: {
			...documentTarget,
			visibilityState: "visible",
			hasFocus: () => focused,
		},
		window: windowTarget,
		reducedMotionMediaQuery: reducedMotionQuery,
	});
	const firstSnapshots: unknown[] = [];
	const secondSnapshots: unknown[] = [];
	const unsubscribeFirst = adapter.subscribe((snapshot) => firstSnapshots.push(snapshot));
	const unsubscribeSecond = adapter.subscribe((snapshot) => secondSnapshots.push(snapshot));
	expect(documentTarget.count("visibilitychange")).toBe(1);
	expect(windowTarget.count("focus")).toBe(1);
	expect(windowTarget.count("blur")).toBe(1);
	expect(reducedMotionQuery.listenerCount()).toBe(1);

	focused = false;
	windowTarget.emit("blur");
	expect(firstSnapshots.at(-1)).toEqual({
		documentVisible: true,
		windowVisible: true,
		windowFocused: false,
		windowMinimized: false,
	});
	expect(secondSnapshots.at(-1)).toEqual(firstSnapshots.at(-1));
	unsubscribeFirst();
	expect(documentTarget.count("visibilitychange")).toBe(1);
	expect(windowTarget.count("focus")).toBe(1);
	expect(windowTarget.count("blur")).toBe(1);
	expect(reducedMotionQuery.listenerCount()).toBe(1);

	const firstCountAfterUnsubscribe = firstSnapshots.length;
	focused = true;
	windowTarget.emit("focus");
	expect(firstSnapshots.length).toBe(firstCountAfterUnsubscribe);
	expect(secondSnapshots.at(-1)).toEqual({
		documentVisible: true,
		windowVisible: true,
		windowFocused: true,
		windowMinimized: false,
	});
	unsubscribeSecond();
	expect(documentTarget.count("visibilitychange")).toBe(0);
	expect(windowTarget.count("focus")).toBe(0);
	expect(windowTarget.count("blur")).toBe(0);
	expect(reducedMotionQuery.listenerCount()).toBe(0);
});

test("multiple subscriptions share one native lifecycle and receive the same native events", async () => {
	const documentTarget = createListenerTarget();
	const windowTarget = createListenerTarget();
	const nativeListener: { current?: (state: { isVisible: boolean; isFocused: boolean; isMinimized: boolean }) => void } = {};
	let listenCalls = 0;
	let getCalls = 0;
	let unlistenCalls = 0;
	const adapter = createVisualEnvironmentAdapter({
		document: { ...documentTarget, visibilityState: "visible", hasFocus: () => true },
		window: windowTarget,
		nativeSource: {
			getWindowState: async () => {
				getCalls += 1;
				return { isVisible: true, isFocused: true, isMinimized: false };
			},
			listenWindowState: async (listener) => {
				listenCalls += 1;
				nativeListener.current = listener;
				return () => { unlistenCalls += 1; };
			},
		},
	});
	const firstSnapshots: unknown[] = [];
	const secondSnapshots: unknown[] = [];
	const unsubscribeFirst = adapter.subscribe((snapshot) => firstSnapshots.push(snapshot));
	const unsubscribeSecond = adapter.subscribe((snapshot) => secondSnapshots.push(snapshot));
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
	expect(listenCalls).toBe(1);
	expect(getCalls).toBe(1);
	expect(documentTarget.count("visibilitychange")).toBe(1);
	expect(windowTarget.count("focus")).toBe(1);
	expect(windowTarget.count("blur")).toBe(1);

	nativeListener.current?.({ isVisible: false, isFocused: false, isMinimized: true });
	expect(firstSnapshots.at(-1)).toEqual({
		documentVisible: true,
		windowVisible: false,
		windowFocused: false,
		windowMinimized: true,
	});
	expect(secondSnapshots.at(-1)).toEqual(firstSnapshots.at(-1));
	const firstCount = firstSnapshots.length;
	unsubscribeFirst();
	expect(unlistenCalls).toBe(0);
	expect(documentTarget.count("visibilitychange")).toBe(1);
	nativeListener.current?.({ isVisible: true, isFocused: true, isMinimized: false });
	expect(firstSnapshots.length).toBe(firstCount);
	expect(secondSnapshots.at(-1)).toEqual({
		documentVisible: true,
		windowVisible: true,
		windowFocused: true,
		windowMinimized: false,
	});

	unsubscribeSecond();
	expect(unlistenCalls).toBe(1);
	expect(documentTarget.count("visibilitychange")).toBe(0);
	expect(windowTarget.count("focus")).toBe(0);
	expect(windowTarget.count("blur")).toBe(0);
	expect(adapter.getSnapshot()).toEqual({
		documentVisible: true,
		windowVisible: true,
		windowFocused: true,
		windowMinimized: false,
	});
});

for (const reentrySource of ["remove", "unlisten"] as const) {
	test(`subscription created inside old ${reentrySource} cleanup receives a complete new lifecycle`, async () => {
		const documentTarget = createListenerTarget();
		const windowTarget = createListenerTarget();
		const reducedMotionQuery = createReducedMotionQuery(false);
		const nativeListeners: Array<(state: { isVisible: boolean; isFocused: boolean; isMinimized: boolean }) => void> = [];
		let nativeListenCalls = 0;
		let reentered = false;
		let nestedUnsubscribe: (() => void) | null = null;
		const nestedSnapshots: unknown[] = [];
		let adapter!: ReturnType<typeof createVisualEnvironmentAdapter>;
		const subscribeDuringCleanup = () => {
			if (reentered) return;
			reentered = true;
			nestedUnsubscribe = adapter.subscribe((snapshot) => nestedSnapshots.push(snapshot));
		};
		adapter = createVisualEnvironmentAdapter({
			document: {
				...documentTarget,
				visibilityState: "visible",
				hasFocus: () => true,
				removeEventListener(type, listener) {
					documentTarget.removeEventListener(type, listener);
					if (reentrySource === "remove" && type === "visibilitychange") subscribeDuringCleanup();
				},
			},
			window: windowTarget,
			reducedMotionMediaQuery: reducedMotionQuery,
			nativeSource: {
				getWindowState: async () => ({ isVisible: true, isFocused: true, isMinimized: false }),
				listenWindowState: async (listener) => {
					nativeListenCalls += 1;
					nativeListeners.push(listener);
					return () => {
						if (reentrySource === "unlisten") subscribeDuringCleanup();
					};
				},
			},
		});
		const unsubscribeFirst = adapter.subscribe(() => {});
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		unsubscribeFirst();
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();

		expect(nativeListenCalls).toBe(2);
		expect(documentTarget.count("visibilitychange")).toBe(1);
		expect(windowTarget.count("focus")).toBe(1);
		expect(windowTarget.count("blur")).toBe(1);
		expect(reducedMotionQuery.listenerCount()).toBe(1);
		nativeListeners.at(-1)?.({ isVisible: false, isFocused: false, isMinimized: true });
		expect(nestedSnapshots.at(-1)).toEqual({
			documentVisible: true,
			windowVisible: false,
			windowFocused: false,
			windowMinimized: true,
		});
		if (nestedUnsubscribe) (nestedUnsubscribe as () => void)();
		expect(documentTarget.count("visibilitychange")).toBe(0);
		expect(windowTarget.count("focus")).toBe(0);
		expect(windowTarget.count("blur")).toBe(0);
		expect(reducedMotionQuery.listenerCount()).toBe(0);
	});
}

test("failed lifecycle replacement from cleanup does not leak the reentrant subscription", () => {
	const documentTarget = createListenerTarget();
	const windowTarget = createListenerTarget();
	let visibilityAdds = 0;
	let reentered = false;
	let nestedUnsubscribe: (() => void) | null = null;
	const nestedSnapshots: unknown[] = [];
	let adapter!: ReturnType<typeof createVisualEnvironmentAdapter>;
	adapter = createVisualEnvironmentAdapter({
		document: {
			...documentTarget,
			visibilityState: "visible",
			hasFocus: () => true,
			addEventListener(type, listener) {
				visibilityAdds += 1;
				if (visibilityAdds === 2) throw new Error("replacement add failure");
				documentTarget.addEventListener(type, listener);
			},
			removeEventListener(type, listener) {
				documentTarget.removeEventListener(type, listener);
				if (type === "visibilitychange" && !reentered) {
					reentered = true;
					nestedUnsubscribe = adapter.subscribe((snapshot) => nestedSnapshots.push(snapshot));
				}
			},
		},
		window: windowTarget,
	});
	const unsubscribeFirst = adapter.subscribe(() => {});
	let caught: unknown = null;
	try {
		unsubscribeFirst();
	} catch (error) {
		caught = error;
	}

	expect(caught).toBeNull();
	expect(nestedSnapshots).toEqual([]);
	expect(documentTarget.count("visibilitychange")).toBe(0);
	expect(windowTarget.count("focus")).toBe(0);
	expect(windowTarget.count("blur")).toBe(0);
	const recoverySnapshots: unknown[] = [];
	const unsubscribeRecovery = adapter.subscribe((snapshot) => recoverySnapshots.push(snapshot));
	expect(visibilityAdds).toBe(3);
	expect(recoverySnapshots.length).toBe(1);
	if (nestedUnsubscribe) (nestedUnsubscribe as () => void)();
	unsubscribeRecovery();
});

test("cancelled failed lifecycle replacement does not escape through old cleanup", () => {
	const documentTarget = createListenerTarget();
	const windowTarget = createListenerTarget();
	let visibilityAdds = 0;
	let reentered = false;
	let nestedUnsubscribe: (() => void) | null = null;
	let adapter!: ReturnType<typeof createVisualEnvironmentAdapter>;
	adapter = createVisualEnvironmentAdapter({
		document: {
			...documentTarget,
			visibilityState: "visible",
			hasFocus: () => true,
			addEventListener(type, listener) {
				visibilityAdds += 1;
				if (visibilityAdds === 2) {
					if (nestedUnsubscribe) (nestedUnsubscribe as () => void)();
					throw new Error("cancelled replacement add failure");
				}
				documentTarget.addEventListener(type, listener);
			},
			removeEventListener(type, listener) {
				documentTarget.removeEventListener(type, listener);
				if (type === "visibilitychange" && !reentered) {
					reentered = true;
					nestedUnsubscribe = adapter.subscribe(() => {});
				}
			},
		},
		window: windowTarget,
	});
	const unsubscribeFirst = adapter.subscribe(() => {});
	let caught: unknown = null;
	try {
		unsubscribeFirst();
	} catch (error) {
		caught = error;
	}

	expect(caught).toBeNull();
	expect(documentTarget.count("visibilitychange")).toBe(0);
	expect(windowTarget.count("focus")).toBe(0);
	expect(windowTarget.count("blur")).toBe(0);
});

test("successful initial subscriber reentry starts native before the nested initial snapshot", () => {
	const documentTarget = createListenerTarget();
	const windowTarget = createListenerTarget();
	const nestedSnapshots: unknown[] = [];
	let nativeListenCalls = 0;
	let reentered = false;
	let nestedUnsubscribe: (() => void) | null = null;
	let adapter!: ReturnType<typeof createVisualEnvironmentAdapter>;
	adapter = createVisualEnvironmentAdapter({
		document: { ...documentTarget, visibilityState: "visible", hasFocus: () => true },
		window: windowTarget,
		nativeSource: {
			getWindowState: async () => ({ isVisible: true, isFocused: true, isMinimized: false }),
			listenWindowState: (listener) => {
				nativeListenCalls += 1;
				listener({ isVisible: false, isFocused: false, isMinimized: true });
				return Promise.resolve(() => {});
			},
		},
	});
	const unsubscribeFirst = adapter.subscribe(() => {
		if (reentered) return;
		reentered = true;
		nestedUnsubscribe = adapter.subscribe((snapshot) => nestedSnapshots.push(snapshot));
	});

	expect(nativeListenCalls).toBe(1);
	expect(nestedSnapshots).toEqual([{
		documentVisible: true,
		windowVisible: false,
		windowFocused: false,
		windowMinimized: true,
	}]);
	unsubscribeFirst();
	if (nestedUnsubscribe) (nestedUnsubscribe as () => void)();
});

test("initial subscriber failure preserves a reentrant subscriber and its native lifecycle", async () => {
	const documentTarget = createListenerTarget();
	const windowTarget = createListenerTarget();
	const nestedSnapshots: unknown[] = [];
	const nativeListener: { current?: (state: { isVisible: boolean; isFocused: boolean; isMinimized: boolean }) => void } = {};
	let nativeListenCalls = 0;
	let nestedUnsubscribe: (() => void) | null = null;
	let adapter!: ReturnType<typeof createVisualEnvironmentAdapter>;
	adapter = createVisualEnvironmentAdapter({
		document: { ...documentTarget, visibilityState: "visible", hasFocus: () => true },
		window: windowTarget,
		nativeSource: {
			getWindowState: async () => ({ isVisible: true, isFocused: true, isMinimized: false }),
			listenWindowState: async (listener) => {
				nativeListenCalls += 1;
				nativeListener.current = listener;
				return () => {};
			},
		},
	});
	let caught: unknown = null;
	try {
		adapter.subscribe(() => {
			nestedUnsubscribe = adapter.subscribe((snapshot) => nestedSnapshots.push(snapshot));
			throw new Error("first subscriber failure");
		});
	} catch (error) {
		caught = error;
	}

	expect((caught as Error).message).toBe("first subscriber failure");
	expect(nativeListenCalls).toBe(1);
	nativeListener.current?.({ isVisible: false, isFocused: false, isMinimized: true });
	expect(nestedSnapshots.at(-1)).toEqual({
		documentVisible: true,
		windowVisible: false,
		windowFocused: false,
		windowMinimized: true,
	});
	if (nestedUnsubscribe) (nestedUnsubscribe as () => void)();
});

for (const failureMode of ["sync-throw", "promise-reject"] as const) {
	test(`dangling native callback is inactive after listen ${failureMode}`, async () => {
		const documentTarget = createListenerTarget();
		const windowTarget = createListenerTarget();
		let danglingListener: ((state: { isVisible: boolean; isFocused: boolean; isMinimized: boolean }) => void) | null = null;
		const adapter = createVisualEnvironmentAdapter({
			document: { ...documentTarget, visibilityState: "visible", hasFocus: () => true },
			window: windowTarget,
			nativeSource: {
				getWindowState: async () => ({ isVisible: true, isFocused: true, isMinimized: false }),
				listenWindowState: (listener) => {
					danglingListener = listener;
					if (failureMode === "sync-throw") throw new Error("listen failure");
					return Promise.reject(new Error("listen rejection"));
				},
			},
		});
		const snapshots: unknown[] = [];
		const unsubscribe = adapter.subscribe((snapshot) => snapshots.push(snapshot));
		await Promise.resolve();
		await Promise.resolve();
		if (danglingListener) {
			(danglingListener as (state: { isVisible: boolean; isFocused: boolean; isMinimized: boolean }) => void)({
				isVisible: false,
				isFocused: false,
				isMinimized: true,
			});
		}
		expect(snapshots.at(-1)).toEqual({
			documentVisible: true,
			windowVisible: true,
			windowFocused: true,
			windowMinimized: false,
		});
		expect(adapter.getSnapshot()).toEqual(snapshots.at(-1));
		unsubscribe();
	});
}

test("dispose reentry from visibility listener installation stops all later installation", () => {
	const documentTarget = createListenerTarget();
	const windowTarget = createListenerTarget();
	const reducedMotionQuery = createReducedMotionQuery(false);
	let nativeListenCalls = 0;
	let adapter!: ReturnType<typeof createVisualEnvironmentAdapter>;
	adapter = createVisualEnvironmentAdapter({
		document: {
			...documentTarget,
			visibilityState: "visible",
			hasFocus: () => true,
			addEventListener(type, listener) {
				adapter.dispose();
				documentTarget.addEventListener(type, listener);
			},
		},
		window: windowTarget,
		reducedMotionMediaQuery: reducedMotionQuery,
		nativeSource: {
			getWindowState: async () => ({ isVisible: true, isFocused: true, isMinimized: false }),
			listenWindowState: async () => {
				nativeListenCalls += 1;
				return () => {};
			},
		},
	});
	const unsubscribe = adapter.subscribe(() => {});

	expect(documentTarget.count("visibilitychange")).toBe(0);
	expect(windowTarget.count("focus")).toBe(0);
	expect(windowTarget.count("blur")).toBe(0);
	expect(reducedMotionQuery.listenerCount()).toBe(0);
	expect(nativeListenCalls).toBe(0);
	unsubscribe();
});

test("dispose reentry from focus listener installation stops blur, media query, and native installation", () => {
	const documentTarget = createListenerTarget();
	const windowTarget = createListenerTarget();
	const reducedMotionQuery = createReducedMotionQuery(false);
	let nativeListenCalls = 0;
	let adapter!: ReturnType<typeof createVisualEnvironmentAdapter>;
	adapter = createVisualEnvironmentAdapter({
		document: { ...documentTarget, visibilityState: "visible", hasFocus: () => true },
		window: {
			addEventListener(type, listener) {
				if (type === "focus") adapter.dispose();
				windowTarget.addEventListener(type, listener);
			},
			removeEventListener: windowTarget.removeEventListener,
		},
		reducedMotionMediaQuery: reducedMotionQuery,
		nativeSource: {
			getWindowState: async () => ({ isVisible: true, isFocused: true, isMinimized: false }),
			listenWindowState: async () => {
				nativeListenCalls += 1;
				return () => {};
			},
		},
	});
	const unsubscribe = adapter.subscribe(() => {});

	expect(documentTarget.count("visibilitychange")).toBe(0);
	expect(windowTarget.count("focus")).toBe(0);
	expect(windowTarget.count("blur")).toBe(0);
	expect(reducedMotionQuery.listenerCount()).toBe(0);
	expect(nativeListenCalls).toBe(0);
	unsubscribe();
});

test("dispose before blur listener registration is compensated after add returns", () => {
	const documentTarget = createListenerTarget();
	const windowTarget = createListenerTarget();
	const reducedMotionQuery = createReducedMotionQuery(false);
	let adapter!: ReturnType<typeof createVisualEnvironmentAdapter>;
	adapter = createVisualEnvironmentAdapter({
		document: { ...documentTarget, visibilityState: "visible", hasFocus: () => true },
		window: {
			addEventListener(type, listener) {
				if (type === "blur") adapter.dispose();
				windowTarget.addEventListener(type, listener);
			},
			removeEventListener: windowTarget.removeEventListener,
		},
		reducedMotionMediaQuery: reducedMotionQuery,
	});
	const unsubscribe = adapter.subscribe(() => {});

	expect(documentTarget.count("visibilitychange")).toBe(0);
	expect(windowTarget.count("focus")).toBe(0);
	expect(windowTarget.count("blur")).toBe(0);
	expect(reducedMotionQuery.listenerCount()).toBe(0);
	unsubscribe();
});

test("dispose before reduced-motion listener registration is compensated after add returns", () => {
	const documentTarget = createListenerTarget();
	const windowTarget = createListenerTarget();
	const reducedMotionTarget = createReducedMotionQuery(false);
	let adapter!: ReturnType<typeof createVisualEnvironmentAdapter>;
	adapter = createVisualEnvironmentAdapter({
		document: { ...documentTarget, visibilityState: "visible", hasFocus: () => true },
		window: windowTarget,
		reducedMotionMediaQuery: {
			get matches() { return reducedMotionTarget.matches; },
			addEventListener(type, listener) {
				adapter.dispose();
				reducedMotionTarget.addEventListener(type, listener);
			},
			removeEventListener: reducedMotionTarget.removeEventListener,
		},
	});
	const unsubscribe = adapter.subscribe(() => {});

	expect(documentTarget.count("visibilitychange")).toBe(0);
	expect(windowTarget.count("focus")).toBe(0);
	expect(windowTarget.count("blur")).toBe(0);
	expect(reducedMotionTarget.listenerCount()).toBe(0);
	unsubscribe();
});

test("dispose reentry from the initial emit stops native installation", () => {
	const documentTarget = createListenerTarget();
	const windowTarget = createListenerTarget();
	const reducedMotionQuery = createReducedMotionQuery(false);
	let nativeListenCalls = 0;
	let adapter!: ReturnType<typeof createVisualEnvironmentAdapter>;
	adapter = createVisualEnvironmentAdapter({
		document: { ...documentTarget, visibilityState: "visible", hasFocus: () => true },
		window: windowTarget,
		reducedMotionMediaQuery: reducedMotionQuery,
		nativeSource: {
			getWindowState: async () => ({ isVisible: true, isFocused: true, isMinimized: false }),
			listenWindowState: async () => {
				nativeListenCalls += 1;
				return () => {};
			},
		},
	});
	const unsubscribe = adapter.subscribe(() => adapter.dispose());

	expect(documentTarget.count("visibilitychange")).toBe(0);
	expect(windowTarget.count("focus")).toBe(0);
	expect(windowTarget.count("blur")).toBe(0);
	expect(reducedMotionQuery.listenerCount()).toBe(0);
	expect(nativeListenCalls).toBe(0);
	unsubscribe();
});

test("dispose reentry inside native listener setup stops initial get and releases the late unlisten", async () => {
	const documentTarget = createListenerTarget();
	const windowTarget = createListenerTarget();
	let getCalls = 0;
	let unlistenCalls = 0;
	let adapter!: ReturnType<typeof createVisualEnvironmentAdapter>;
	adapter = createVisualEnvironmentAdapter({
		document: { ...documentTarget, visibilityState: "visible", hasFocus: () => true },
		window: windowTarget,
		nativeSource: {
			getWindowState: async () => {
				getCalls += 1;
				return { isVisible: true, isFocused: true, isMinimized: false };
			},
			listenWindowState: () => {
				adapter.dispose();
				return Promise.resolve(() => { unlistenCalls += 1; });
			},
		},
	});
	const unsubscribe = adapter.subscribe(() => {});
	await Promise.resolve();
	await Promise.resolve();

	expect(getCalls).toBe(0);
	expect(unlistenCalls).toBe(1);
	expect(documentTarget.count("visibilitychange")).toBe(0);
	expect(windowTarget.count("focus")).toBe(0);
	expect(windowTarget.count("blur")).toBe(0);
	unsubscribe();
});

test("initial listener failure rolls back every installed listener and leaves dispose idempotent", () => {
	const documentTarget = createListenerTarget();
	const windowTarget = createListenerTarget();
	const reducedMotionQuery = createReducedMotionQuery(false);
	const adapter = createVisualEnvironmentAdapter({
		document: { ...documentTarget, visibilityState: "visible", hasFocus: () => true },
		window: windowTarget,
		reducedMotionMediaQuery: reducedMotionQuery,
	});
	let caught: unknown = null;
	try {
		adapter.subscribe(() => { throw new Error("initial listener failure"); });
	} catch (error) {
		caught = error;
	}

	expect((caught as Error).message).toBe("initial listener failure");
	expect(documentTarget.count("visibilitychange")).toBe(0);
	expect(windowTarget.count("focus")).toBe(0);
	expect(windowTarget.count("blur")).toBe(0);
	expect(reducedMotionQuery.listenerCount()).toBe(0);
	adapter.dispose();
	adapter.dispose();
});

test("synchronous native listener setup failure preserves the browser subscription", () => {
	const documentTarget = createListenerTarget();
	const windowTarget = createListenerTarget();
	const reducedMotionQuery = createReducedMotionQuery(false);
	let visibilityState: DocumentVisibilityState = "visible";
	let focused = true;
	const adapter = createVisualEnvironmentAdapter({
		document: {
			...documentTarget,
			get visibilityState() { return visibilityState; },
			hasFocus: () => focused,
		},
		window: windowTarget,
		reducedMotionMediaQuery: reducedMotionQuery,
		nativeSource: {
			getWindowState: async () => ({ isVisible: true, isFocused: true, isMinimized: false }),
			listenWindowState: () => { throw new Error("native setup failure"); },
		},
	});
	const snapshots: unknown[] = [];
	const unsubscribe = adapter.subscribe((snapshot) => snapshots.push(snapshot));
	visibilityState = "hidden";
	documentTarget.emit("visibilitychange");
	focused = false;
	windowTarget.emit("blur");
	expect(snapshots.at(-1)).toEqual({
		documentVisible: false,
		windowVisible: true,
		windowFocused: false,
		windowMinimized: false,
	});
	expect(documentTarget.count("visibilitychange")).toBe(1);
	expect(windowTarget.count("focus")).toBe(1);
	expect(windowTarget.count("blur")).toBe(1);
	expect(reducedMotionQuery.listenerCount()).toBe(1);
	unsubscribe();
	expect(documentTarget.count("visibilitychange")).toBe(0);
	expect(windowTarget.count("focus")).toBe(0);
	expect(windowTarget.count("blur")).toBe(0);
	expect(reducedMotionQuery.listenerCount()).toBe(0);
});

test("rejected native listener setup preserves browser events until unsubscribe", async () => {
	const documentTarget = createListenerTarget();
	const windowTarget = createListenerTarget();
	const reducedMotionQuery = createReducedMotionQuery(false);
	let visibilityState: DocumentVisibilityState = "visible";
	let focused = true;
	const adapter = createVisualEnvironmentAdapter({
		document: {
			...documentTarget,
			get visibilityState() { return visibilityState; },
			hasFocus: () => focused,
		},
		window: windowTarget,
		reducedMotionMediaQuery: reducedMotionQuery,
		nativeSource: {
			getWindowState: async () => ({ isVisible: true, isFocused: true, isMinimized: false }),
			listenWindowState: () => Promise.reject(new Error("native setup rejection")),
		},
	});
	const snapshots: unknown[] = [];
	const unsubscribe = adapter.subscribe((snapshot) => snapshots.push(snapshot));
	await Promise.resolve();
	await Promise.resolve();
	visibilityState = "hidden";
	documentTarget.emit("visibilitychange");
	focused = false;
	windowTarget.emit("blur");
	expect(snapshots.at(-1)).toEqual({
		documentVisible: false,
		windowVisible: true,
		windowFocused: false,
		windowMinimized: false,
	});
	expect(documentTarget.count("visibilitychange")).toBe(1);
	expect(windowTarget.count("focus")).toBe(1);
	expect(windowTarget.count("blur")).toBe(1);
	expect(reducedMotionQuery.listenerCount()).toBe(1);
	unsubscribe();
	expect(documentTarget.count("visibilitychange")).toBe(0);
	expect(windowTarget.count("focus")).toBe(0);
	expect(windowTarget.count("blur")).toBe(0);
	expect(reducedMotionQuery.listenerCount()).toBe(0);
});

test("rejected native initial get preserves native and browser event subscriptions", async () => {
	const documentTarget = createListenerTarget();
	const windowTarget = createListenerTarget();
	let visibilityState: DocumentVisibilityState = "visible";
	const nativeListener: { current?: (state: { isVisible: boolean; isFocused: boolean; isMinimized: boolean }) => void } = {};
	let unlistenCalls = 0;
	const adapter = createVisualEnvironmentAdapter({
		document: {
			...documentTarget,
			get visibilityState() { return visibilityState; },
			hasFocus: () => true,
		},
		window: windowTarget,
		nativeSource: {
			getWindowState: () => Promise.reject(new Error("initial get rejection")),
			listenWindowState: async (listener) => {
				nativeListener.current = listener;
				return () => { unlistenCalls += 1; };
			},
		},
	});
	const snapshots: unknown[] = [];
	const unsubscribe = adapter.subscribe((snapshot) => snapshots.push(snapshot));
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
	nativeListener.current?.({ isVisible: false, isFocused: false, isMinimized: true });
	expect(snapshots.at(-1)).toEqual({
		documentVisible: true,
		windowVisible: false,
		windowFocused: false,
		windowMinimized: true,
	});
	visibilityState = "hidden";
	documentTarget.emit("visibilitychange");
	expect(snapshots.at(-1)).toEqual({
		documentVisible: false,
		windowVisible: false,
		windowFocused: false,
		windowMinimized: true,
	});
	expect(documentTarget.count("visibilitychange")).toBe(1);
	expect(windowTarget.count("focus")).toBe(1);
	expect(windowTarget.count("blur")).toBe(1);
	unsubscribe();
	expect(unlistenCalls).toBe(1);
	expect(documentTarget.count("visibilitychange")).toBe(0);
	expect(windowTarget.count("focus")).toBe(0);
	expect(windowTarget.count("blur")).toBe(0);
});

test("one remove listener failure does not block the remaining subscription cleanup", () => {
	const documentTarget = createListenerTarget();
	const windowTarget = createListenerTarget();
	const reducedMotionQuery = createReducedMotionQuery(false);
	const adapter = createVisualEnvironmentAdapter({
		document: { ...documentTarget, visibilityState: "visible", hasFocus: () => true },
		window: {
			addEventListener: windowTarget.addEventListener,
			removeEventListener(type, listener) {
				windowTarget.removeEventListener(type, listener);
				if (type === "focus") throw new Error("remove focus failure");
			},
		},
		reducedMotionMediaQuery: reducedMotionQuery,
	});
	const unsubscribe = adapter.subscribe(() => {});
	let caught: unknown = null;
	try {
		unsubscribe();
	} catch (error) {
		caught = error;
	}

	expect(caught).toBeNull();
	expect(documentTarget.count("visibilitychange")).toBe(0);
	expect(windowTarget.count("focus")).toBe(0);
	expect(windowTarget.count("blur")).toBe(0);
	expect(reducedMotionQuery.listenerCount()).toBe(0);
});

test("shared native unlisten failure does not block dispose from cleaning browser listeners", async () => {
	const documentTarget = createListenerTarget();
	const windowTarget = createListenerTarget();
	let registration = 0;
	let unlistenCalls = 0;
	const adapter = createVisualEnvironmentAdapter({
		document: { ...documentTarget, visibilityState: "visible", hasFocus: () => true },
		window: windowTarget,
		nativeSource: {
			getWindowState: async () => ({ isVisible: true, isFocused: true, isMinimized: false }),
			listenWindowState: async () => {
				registration += 1;
				return () => {
					unlistenCalls += 1;
					throw new Error("unlisten failure");
				};
			},
		},
	});
	adapter.subscribe(() => {});
	adapter.subscribe(() => {});
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
	let caught: unknown = null;
	try {
		adapter.dispose();
	} catch (error) {
		caught = error;
	}

	expect(caught).toBeNull();
	expect(registration).toBe(1);
	expect(unlistenCalls).toBe(1);
	expect(documentTarget.count("visibilitychange")).toBe(0);
	expect(windowTarget.count("focus")).toBe(0);
	expect(windowTarget.count("blur")).toBe(0);
});

test("visual environment adapter combines native visible, focused, and minimized state", async () => {
	const documentTarget = createListenerTarget();
	const windowTarget = createListenerTarget();
	const nativeListener: { current?: (state: { isVisible: boolean; isFocused: boolean; isMinimized: boolean }) => void } = {};
	const adapter = createVisualEnvironmentAdapter({
		document: { ...documentTarget, visibilityState: "visible", hasFocus: () => true },
		window: windowTarget,
		nativeSource: {
			getWindowState: async () => ({ isVisible: true, isFocused: true, isMinimized: false }),
			listenWindowState: async (listener) => {
				nativeListener.current = listener;
				return () => {};
			},
		},
	});
	const snapshots: unknown[] = [];
	const unsubscribe = adapter.subscribe((snapshot) => snapshots.push(snapshot));
	await Promise.resolve();
	await Promise.resolve();

	nativeListener.current?.({ isVisible: false, isFocused: false, isMinimized: true });
	expect(snapshots.at(-1)).toEqual({
		documentVisible: true,
		windowVisible: false,
		windowFocused: false,
		windowMinimized: true,
	});
	unsubscribe();
});

test("native get state is copied at the adapter boundary", async () => {
	const documentTarget = createListenerTarget();
	const windowTarget = createListenerTarget();
	const sourceState = { isVisible: false, isFocused: false, isMinimized: true };
	const adapter = createVisualEnvironmentAdapter({
		document: { ...documentTarget, visibilityState: "visible", hasFocus: () => true },
		window: windowTarget,
		nativeSource: {
			getWindowState: async () => sourceState,
			listenWindowState: async () => () => {},
		},
	});
	const unsubscribe = adapter.subscribe(() => {});
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
	sourceState.isVisible = true;
	sourceState.isFocused = true;
	sourceState.isMinimized = false;

	expect(adapter.getSnapshot()).toEqual({
		documentVisible: true,
		windowVisible: false,
		windowFocused: false,
		windowMinimized: true,
	});
	unsubscribe();
});

test("native event state is copied at the adapter boundary", async () => {
	const documentTarget = createListenerTarget();
	const windowTarget = createListenerTarget();
	const nativeListener: { current?: (state: { isVisible: boolean; isFocused: boolean; isMinimized: boolean }) => void } = {};
	const adapter = createVisualEnvironmentAdapter({
		document: { ...documentTarget, visibilityState: "visible", hasFocus: () => true },
		window: windowTarget,
		nativeSource: {
			getWindowState: async () => ({ isVisible: true, isFocused: true, isMinimized: false }),
			listenWindowState: async (listener) => {
				nativeListener.current = listener;
				return () => {};
			},
		},
	});
	const unsubscribe = adapter.subscribe(() => {});
	await Promise.resolve();
	await Promise.resolve();
	const eventState = { isVisible: false, isFocused: false, isMinimized: true };
	nativeListener.current?.(eventState);
	eventState.isVisible = true;
	eventState.isFocused = true;
	eventState.isMinimized = false;

	expect(adapter.getSnapshot()).toEqual({
		documentVisible: true,
		windowVisible: false,
		windowFocused: false,
		windowMinimized: true,
	});
	unsubscribe();
});

test("initial native get starts after listener registration and observes state changes from the registration gap", async () => {
	const documentTarget = createListenerTarget();
	const windowTarget = createListenerTarget();
	const listen = deferred<() => void>();
	let getCalls = 0;
	let backingState = { isVisible: true, isFocused: true, isMinimized: false };
	const adapter = createVisualEnvironmentAdapter({
		document: { ...documentTarget, visibilityState: "visible", hasFocus: () => true },
		window: windowTarget,
		nativeSource: {
			getWindowState: () => {
				getCalls += 1;
				return Promise.resolve({ ...backingState });
			},
			listenWindowState: () => listen.promise,
		},
	});
	const snapshots: unknown[] = [];
	const unsubscribe = adapter.subscribe((snapshot) => snapshots.push(snapshot));

	expect(getCalls).toBe(0);
	backingState = { isVisible: false, isFocused: false, isMinimized: true };
	listen.resolve(() => {});
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
	expect(getCalls).toBe(1);
	expect(snapshots.at(-1)).toEqual({
		documentVisible: true,
		windowVisible: false,
		windowFocused: false,
		windowMinimized: true,
	});
	unsubscribe();
});

test("late native get cannot overwrite an event received after listener registration", async () => {
	const documentTarget = createListenerTarget();
	const windowTarget = createListenerTarget();
	const getState = deferred<{ isVisible: boolean; isFocused: boolean; isMinimized: boolean }>();
	const nativeListener: { current?: (state: { isVisible: boolean; isFocused: boolean; isMinimized: boolean }) => void } = {};
	const adapter = createVisualEnvironmentAdapter({
		document: { ...documentTarget, visibilityState: "visible", hasFocus: () => true },
		window: windowTarget,
		nativeSource: {
			getWindowState: () => getState.promise,
			listenWindowState: (listener) => {
				nativeListener.current = listener;
				return Promise.resolve(() => {});
			},
		},
	});
	const snapshots: unknown[] = [];
	const unsubscribe = adapter.subscribe((snapshot) => snapshots.push(snapshot));
	await Promise.resolve();
	await Promise.resolve();
	nativeListener.current?.({ isVisible: false, isFocused: false, isMinimized: true });
	getState.resolve({ isVisible: true, isFocused: true, isMinimized: false });
	await Promise.resolve();
	await Promise.resolve();
	expect(snapshots.at(-1)).toEqual({
		documentVisible: true,
		windowVisible: false,
		windowFocused: false,
		windowMinimized: true,
	});
	unsubscribe();
});

test("unsubscribe or dispose before native listener registration invokes the late unlisten and skips get", async () => {
	for (const cleanupMode of ["unsubscribe", "dispose"] as const) {
		const documentTarget = createListenerTarget();
		const windowTarget = createListenerTarget();
		const listen = deferred<() => void>();
		let getCalls = 0;
		let unlistenCalls = 0;
		const adapter = createVisualEnvironmentAdapter({
			document: { ...documentTarget, visibilityState: "visible", hasFocus: () => true },
			window: windowTarget,
			nativeSource: {
				getWindowState: async () => {
					getCalls += 1;
					return { isVisible: true, isFocused: true, isMinimized: false };
				},
				listenWindowState: () => listen.promise,
			},
		});
		const unsubscribe = adapter.subscribe(() => {});
		if (cleanupMode === "unsubscribe") unsubscribe();
		else adapter.dispose();
		listen.resolve(() => { unlistenCalls += 1; });
		await Promise.resolve();
		await Promise.resolve();
		expect(unlistenCalls).toBe(1);
		expect(getCalls).toBe(0);
	}
});

test("late native unlisten cleanup finishes before a reentrant lifecycle starts", async () => {
	const documentTarget = createListenerTarget();
	const windowTarget = createListenerTarget();
	const firstListen = deferred<() => void>();
	let listenCalls = 0;
	let browserListenersInsideLateCleanup = -1;
	let nestedUnsubscribe: (() => void) | null = null;
	let adapter!: ReturnType<typeof createVisualEnvironmentAdapter>;
	adapter = createVisualEnvironmentAdapter({
		document: { ...documentTarget, visibilityState: "visible", hasFocus: () => true },
		window: windowTarget,
		nativeSource: {
			getWindowState: async () => ({ isVisible: true, isFocused: true, isMinimized: false }),
			listenWindowState: () => {
				listenCalls += 1;
				if (listenCalls === 1) return firstListen.promise;
				return Promise.resolve(() => {});
			},
		},
	});
	const unsubscribeFirst = adapter.subscribe(() => {});
	unsubscribeFirst();
	firstListen.resolve(() => {
		nestedUnsubscribe = adapter.subscribe(() => {});
		browserListenersInsideLateCleanup = documentTarget.count("visibilitychange");
	});
	await Promise.resolve();
	await Promise.resolve();

	expect(browserListenersInsideLateCleanup).toBe(0);
	expect(documentTarget.count("visibilitychange")).toBe(1);
	expect(listenCalls).toBe(2);
	if (nestedUnsubscribe) (nestedUnsubscribe as () => void)();
});

test("Web fallback never calls an implicit native source", async () => {
	const documentTarget = createListenerTarget();
	const windowTarget = createListenerTarget();
	let nativeCalls = 0;
	const adapter = createVisualEnvironmentAdapter({
		document: { ...documentTarget, visibilityState: "visible", hasFocus: () => false },
		window: windowTarget,
		isNativeRuntime: () => true,
		defaultNativeSource: {
			getWindowState: async () => {
				nativeCalls += 1;
				return { isVisible: false, isFocused: false, isMinimized: false };
			},
			listenWindowState: async () => {
				nativeCalls += 1;
				return () => {};
			},
		},
	});
	const snapshots: unknown[] = [];
	const unsubscribe = adapter.subscribe((snapshot) => snapshots.push(snapshot));
	await Promise.resolve();
	expect(nativeCalls).toBe(0);
	expect(snapshots.at(-1)).toEqual({
		documentVisible: true,
		windowVisible: true,
		windowFocused: false,
		windowMinimized: false,
	});
	unsubscribe();
});
