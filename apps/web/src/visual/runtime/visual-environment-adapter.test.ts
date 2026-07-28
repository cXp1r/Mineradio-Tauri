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
	expect(documentTarget.count("visibilitychange")).toBe(2);
	expect(windowTarget.count("focus")).toBe(2);
	expect(windowTarget.count("blur")).toBe(2);
	expect(reducedMotionQuery.listenerCount()).toBe(2);

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

test("synchronous native listener setup failure rolls back the browser subscription", () => {
	const documentTarget = createListenerTarget();
	const windowTarget = createListenerTarget();
	const reducedMotionQuery = createReducedMotionQuery(false);
	const adapter = createVisualEnvironmentAdapter({
		document: { ...documentTarget, visibilityState: "visible", hasFocus: () => true },
		window: windowTarget,
		reducedMotionMediaQuery: reducedMotionQuery,
		nativeSource: {
			getWindowState: async () => ({ isVisible: true, isFocused: true, isMinimized: false }),
			listenWindowState: () => { throw new Error("native setup failure"); },
		},
	});
	let caught: unknown = null;
	try {
		adapter.subscribe(() => {});
	} catch (error) {
		caught = error;
	}

	expect((caught as Error).message).toBe("native setup failure");
	expect(documentTarget.count("visibilitychange")).toBe(0);
	expect(windowTarget.count("focus")).toBe(0);
	expect(windowTarget.count("blur")).toBe(0);
	expect(reducedMotionQuery.listenerCount()).toBe(0);
});

test("rejected native listener setup cleans the subscription without leaking listeners", async () => {
	const documentTarget = createListenerTarget();
	const windowTarget = createListenerTarget();
	const reducedMotionQuery = createReducedMotionQuery(false);
	const adapter = createVisualEnvironmentAdapter({
		document: { ...documentTarget, visibilityState: "visible", hasFocus: () => true },
		window: windowTarget,
		reducedMotionMediaQuery: reducedMotionQuery,
		nativeSource: {
			getWindowState: async () => ({ isVisible: true, isFocused: true, isMinimized: false }),
			listenWindowState: () => Promise.reject(new Error("native setup rejection")),
		},
	});
	adapter.subscribe(() => {});
	await Promise.resolve();
	await Promise.resolve();

	expect(documentTarget.count("visibilitychange")).toBe(0);
	expect(windowTarget.count("focus")).toBe(0);
	expect(windowTarget.count("blur")).toBe(0);
	expect(reducedMotionQuery.listenerCount()).toBe(0);
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

test("one native unlisten failure does not block dispose from cleaning other subscriptions", async () => {
	const documentTarget = createListenerTarget();
	const windowTarget = createListenerTarget();
	let registration = 0;
	let secondUnlistenCalls = 0;
	const adapter = createVisualEnvironmentAdapter({
		document: { ...documentTarget, visibilityState: "visible", hasFocus: () => true },
		window: windowTarget,
		nativeSource: {
			getWindowState: async () => ({ isVisible: true, isFocused: true, isMinimized: false }),
			listenWindowState: async () => {
				registration += 1;
				if (registration === 1) return () => { throw new Error("first unlisten failure"); };
				return () => { secondUnlistenCalls += 1; };
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
	expect(secondUnlistenCalls).toBe(1);
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
